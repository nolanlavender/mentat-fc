"""
Paired A/B between two model configurations: is a change real, or noise?

Why this exists. app.evaluate prints one Brier/log-loss number per
competition per run, so comparing two configurations means eyeballing two
separate runs' summary numbers. That's fine when the gap is large (the
shots-on-target blend moved Premier League's Brier 0.6399 -> 0.6248,
which no amount of noise explains) but actively misleading when it's
small. The 2026-08-21 shrinkage-prior A/B came back at 0.6226 -> 0.6209,
a 0.27% gain, and there was no way to tell from those two numbers whether
it meant anything -- picking per-competition winners off differences that
size is how you overfit a backtest to its own test set.

What makes this different from running app.evaluate twice: it scores both
configurations on THE SAME held-out matches and compares them per match,
paired. Most of the variance in a Brier score is "some matches are just
harder to predict than others", and that variance is identical for both
configurations, so pairing cancels it. A bootstrap over fixtures then
gives a confidence interval on the mean per-match difference, which is
the actual question -- "would this hold up on a different sample of
matches?" -- rather than "is number A smaller than number B."

WALK-FORWARD (added 2026-08-22). Originally one 80/20 split: one fit, one
held-out window, ~350-500 scored matches, and a noise floor around 0.003
Brier that several real decisions have had to be made underneath -- the
Premier League shot-location weight was promoted with its interval
touching zero because a single split could not resolve it. Now the
held-out region is several consecutive windows walked forward in time:
for each fold, fit on everything strictly before the window, score the
window, pool the per-match paired differences across folds. Every fold is
still causal (no fixture is ever predicted by a model that saw it or
anything after it), the windows are disjoint so pooling never
double-counts a match, and the held-out sample roughly doubles -- which
tightens the interval by about 1/sqrt(2), directly attacking the noise
floor rather than working around it.

The cost is honest too: fits scale with folds x configurations, so a run
takes several times longer. That is what a manually-dispatched workflow
is for.

Reads only. Usage: python -m app.compare
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from app.data import blend_learned_shot_proxy_into_scores, blend_shot_proxies_with_fallback, load_finished_matches
from app.db import get_connection
from app.dixon_coles import DixonColesModel
from app.evaluate import (
    FIT_COMPETITIONS,
    FOLD_FRACTION,
    FOLDS,
    HALF_LIFE_DAYS,
    MIN_MATCHES_FOR_BACKTEST,
    SHOT_LOCATION_BLEND_WEIGHT,
    SHOTS_ON_TARGET_BLEND_WEIGHT,
    SHRINKAGE,
    SHRINK_TOWARD_JOINT,
    _fold_frames,
    _outcome_one_hot,
    walk_forward_folds,
)

BOOTSTRAP_SAMPLES = 5000
CONFIDENCE = 95

# Below this, a competition is skipped rather than fitted. Not just
# defensive tidiness: without it, a database holding only some of the
# three competitions (a partial local snapshot, say) crashes deep inside
# the optimizer with an unhelpful IndexError, which makes it impossible
# to smoke-test this module anywhere except production. That is precisely
# how a NameError in _bootstrap_ci reached a real run once -- the module
# imported fine and could not be executed locally to find out otherwise.
MIN_MATCHES_PER_COMPETITION = 50

# --- What this run compares -------------------------------------------
#
# One baseline, several candidates, all scored on the SAME held-out
# fixtures so every candidate is paired against the baseline match by
# match. Edit CANDIDATES and _blend to ask a different question;
# everything below is generic.
#
# Current question (2026-08-22): re-test the shot-location promotion with
# walk-forward power. The Premier League's 0.75 was promoted on 2026-08-21
# with its interval TOUCHING zero ([-0.01384, +0.00001]) -- a judgment
# call a single 80/20 split could not resolve. The baseline is now the
# DEPLOYED per-competition config; candidate 0.0 asks "should the
# promotion be reverted?", and 0.5 / 1.0 bracket the chosen value. With
# roughly double the held-out matches, an effect the old split left
# straddling zero should either clear it or collapse.
LOCATION_SIGNALS = ["inside_box", "outside_box"]
FALLBACK_SIGNALS = ["shots_on_target"]

BASELINE_LABEL = "deployed config (per-competition location weights)"
CANDIDATE_WEIGHTS = [0.0, 0.5, 1.0]


def _blend(matches: pd.DataFrame, competition: str, location_weight: float | None) -> pd.DataFrame:
    """
    location_weight None = the baseline, i.e. the DEPLOYED per-competition
    location weight; a number = that flat weight for every competition.
    """
    sot_weight = SHOTS_ON_TARGET_BLEND_WEIGHT[competition]
    if location_weight is None:
        location_weight = SHOT_LOCATION_BLEND_WEIGHT[competition]
    if location_weight == 0:
        # Deliberately blend_learned_shot_proxy_into_scores and NOT
        # app.data.blend_shots_on_target_into_scores, even though the latter
        # is what production runs. The two rescale shots on target to goals
        # by different methods (pooled mean ratio vs least squares), so
        # using one for the baseline and the other inside the candidate's
        # fallback would make every comparison a mixture of two questions:
        # "does location help?" and "which shots-on-target calibration is
        # better?".
        #
        # Caught by running this against a snapshot with 0% location
        # coverage, where the candidate MUST be identical to the baseline
        # and instead differed by a small, perfectly constant +0.00065 at
        # every weight. Holding the calibration fixed makes that difference
        # exactly zero, which is now the self-check that the comparison is
        # measuring only what it claims to.
        return blend_learned_shot_proxy_into_scores(matches, sot_weight, FALLBACK_SIGNALS)
    # Location where it exists, shots on target everywhere else -- so a
    # candidate is never handicapped by partial coverage.
    return blend_shot_proxies_with_fallback(
        matches, LOCATION_SIGNALS, location_weight, FALLBACK_SIGNALS, sot_weight
    )


def _fit_all(train_matches: pd.DataFrame, location_weight: float | None) -> dict[str, DixonColesModel]:
    """The same three fits app.evaluate builds, under one configuration."""
    joint = DixonColesModel()
    joint.fit(
        _blend(train_matches, "FA Cup", location_weight),
        half_life_days=HALF_LIFE_DAYS,
        shrinkage=SHRINKAGE["FA Cup"],
    )
    prior = joint if SHRINK_TOWARD_JOINT else None

    models: dict[str, DixonColesModel] = {"FA Cup": joint}
    for competition in ("Premier League", "Championship"):
        competition_matches = train_matches[train_matches["competition_name"] == competition]
        if len(competition_matches) < MIN_MATCHES_PER_COMPETITION:
            continue
        model = DixonColesModel()
        model.fit(
            _blend(competition_matches, competition, location_weight),
            half_life_days=HALF_LIFE_DAYS,
            shrinkage=SHRINKAGE[competition],
            prior_model=prior,
        )
        models[competition] = model
    return models


def _per_match_brier(model: DixonColesModel, test_matches: pd.DataFrame) -> dict[int, float]:
    """Brier score for each individually-predictable held-out match, keyed by fixture."""
    scores: dict[int, float] = {}
    for m in test_matches.itertuples():
        try:
            pred = model.predict(m.home_team, m.away_team)
        except ValueError:
            continue  # team outside the training window -- can't score it fairly
        probs = np.array([pred.prob_home_win, pred.prob_draw, pred.prob_away_win])
        outcome = np.array(_outcome_one_hot(m.home_score, m.away_score))
        scores[int(m.fixture_id)] = float(np.sum((probs - outcome) ** 2))
    return scores


def _bootstrap_ci(differences: np.ndarray) -> tuple[float, float]:
    """
    Percentile bootstrap over fixtures. Resampling whole matches (rather
    than assuming a normal distribution) keeps this honest for a metric
    whose per-match values are bounded and heavily skewed -- most matches
    score near the middle, a few confident-and-wrong ones score terribly.
    """
    rng = np.random.default_rng(seed=20260821)  # fixed, so the same data gives the same verdict
    n = len(differences)
    means = np.array([differences[rng.integers(0, n, n)].mean() for _ in range(BOOTSTRAP_SAMPLES)])
    tail = (100 - CONFIDENCE) / 2
    return float(np.percentile(means, tail)), float(np.percentile(means, 100 - tail))


def _score_config_walk_forward(
    matches: pd.DataFrame, folds: list[tuple[object, object]], location_weight: float | None
) -> dict[str, dict[int, float]]:
    """
    Per-competition {fixture_id: Brier} pooled across every fold, each
    fold scored by a model fitted only on matches before it. Fixture ids
    never collide across folds because the windows are disjoint.
    """
    scores: dict[str, dict[int, float]] = {competition: {} for competition in FIT_COMPETITIONS}
    for start, end in folds:
        train, test = _fold_frames(matches, start, end)
        models = _fit_all(train, location_weight)
        for competition in FIT_COMPETITIONS:
            if competition not in models:
                continue
            competition_test = test[test["competition_name"] == competition]
            scores[competition].update(_per_match_brier(models[competition], competition_test))
    return scores


def main() -> None:
    conn = get_connection()
    try:
        matches = load_finished_matches(conn, FIT_COMPETITIONS)
        if len(matches) < MIN_MATCHES_FOR_BACKTEST:
            print(f"Only {len(matches)} matches, not enough for a meaningful comparison.")
            return

        folds = walk_forward_folds(matches)
        print(
            f"Walk-forward paired sweep: {len(folds)} held-out windows from "
            f"{folds[0][0]}, each predicted by a model fitted only on earlier matches"
        )
        print(f"  baseline = {BASELINE_LABEL}")
        print(f"  candidates = shot location at flat weight {CANDIDATE_WEIGHTS}, shots on target where uncovered")
        for competition in FIT_COMPETITIONS:
            rows = matches[matches["competition_name"] == competition]
            if rows.empty:
                continue
            covered = rows["home_shots_inside_box"].notna().sum()
            print(f"  shot-location coverage, {competition}: {covered}/{len(rows)} ({covered / len(rows):.0%})")
        print()

        baseline_scores = _score_config_walk_forward(matches, folds, location_weight=None)
        empty = [c for c in FIT_COMPETITIONS if not baseline_scores[c]]
        if empty:
            print(f"No scorable held-out matches for: {', '.join(empty)}\n")

        for weight in CANDIDATE_WEIGHTS:
            candidate_scores = _score_config_walk_forward(matches, folds, location_weight=weight)
            print(f"--- location weight {weight} ---")
            for competition in FIT_COMPETITIONS:
                if not baseline_scores[competition]:
                    continue
                a = baseline_scores[competition]
                b = candidate_scores[competition]

                shared = sorted(set(a) & set(b))
                if not shared:
                    print(f"  {competition}: no comparable held-out matches.")
                    continue

                diffs = np.array([b[f] - a[f] for f in shared])
                changed = int(np.sum(diffs != 0))
                mean_diff = float(diffs.mean())
                low, high = _bootstrap_ci(diffs)

                if changed == 0:
                    verdict = "unchanged (control)"
                elif high < 0:
                    verdict = "BETTER than baseline"
                elif low > 0:
                    verdict = "WORSE than baseline"
                else:
                    verdict = "inconclusive"
                print(
                    f"  {competition:<15} Brier {np.mean([b[f] for f in shared]):.4f} "
                    f"(baseline {np.mean([a[f] for f in shared]):.4f})  "
                    f"diff {mean_diff:+.5f} CI [{low:+.5f}, {high:+.5f}]  -> {verdict}"
                )
            print()
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
