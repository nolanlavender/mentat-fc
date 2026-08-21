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

Reads only. Usage: python -m app.compare
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from app.data import blend_shot_proxies_with_fallback, blend_shots_on_target_into_scores, load_finished_matches
from app.db import get_connection
from app.dixon_coles import DixonColesModel
from app.evaluate import (
    FIT_COMPETITIONS,
    HALF_LIFE_DAYS,
    MIN_MATCHES_FOR_BACKTEST,
    SHOTS_ON_TARGET_BLEND_WEIGHT,
    SHRINKAGE,
    SHRINK_TOWARD_JOINT,
    TEST_FRACTION,
    _outcome_one_hot,
)

# --- What this run compares -------------------------------------------
#
# THIS is the block to edit to point the comparison at a different
# question. A and B are just two configurations; everything below is
# generic. Keep the labels honest -- they're what the verdict is
# reported against.
#
# --- What this run compares -------------------------------------------
#
# One baseline, several candidates, all scored on the SAME held-out
# fixtures so every candidate is paired against the baseline match by
# match. Edit CANDIDATES and _blend to ask a different question;
# everything below is generic.
#
# Current question (2026-08-21): shot location was rejected on a test
# that compared shots-on-target at its TUNED weight (0.75 / 0.25 / 1.0,
# picked from a five-value sweep) against location at a flat 1.0, which
# was never tuned at all. That was not a fair fight, and the Premier
# League -- the one competition at 97% coverage -- leaned positive. This
# sweeps the location weight properly before the rejection stands.
#
# Note this reports a confidence interval per weight, which the original
# shots-on-target sweep never had: those values were chosen from point
# estimates alone, so "0.75 is the Premier League optimum" has never
# actually been shown to be distinguishable from 0.5 or 1.0.
LOCATION_SIGNALS = ["inside_box", "outside_box"]
FALLBACK_SIGNALS = ["shots_on_target"]

BASELINE_LABEL = "shots on target only (current)"
CANDIDATE_WEIGHTS = [0.25, 0.5, 0.75, 1.0]


def _blend(matches: pd.DataFrame, competition: str, location_weight: float | None) -> pd.DataFrame:
    """location_weight None = the baseline, shots on target at its tuned weight."""
    sot_weight = SHOTS_ON_TARGET_BLEND_WEIGHT[competition]
    if location_weight is None:
        return blend_shots_on_target_into_scores(matches, sot_weight)
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
        model = DixonColesModel()
        model.fit(
            _blend(train_matches[train_matches["competition_name"] == competition], competition, location_weight),
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


def main() -> None:
    conn = get_connection()
    try:
        matches = load_finished_matches(conn, FIT_COMPETITIONS)
        if len(matches) < MIN_MATCHES_FOR_BACKTEST:
            print(f"Only {len(matches)} matches, not enough for a meaningful comparison.")
            return

        split_idx = int(len(matches) * (1 - TEST_FRACTION))
        cutoff_date = matches.iloc[split_idx]["kickoff_date"]
        train_matches = matches[matches["kickoff_date"] < cutoff_date]
        test_matches = matches[matches["kickoff_date"] >= cutoff_date]

        print(f"Paired sweep on held-out matches after {cutoff_date}")
        print(f"  baseline = {BASELINE_LABEL}")
        print(f"  candidates = shot location at weight {CANDIDATE_WEIGHTS}, shots on target where uncovered")
        for competition in FIT_COMPETITIONS:
            rows = matches[matches["competition_name"] == competition]
            if rows.empty:
                continue
            covered = rows["home_shots_inside_box"].notna().sum()
            print(f"  shot-location coverage, {competition}: {covered}/{len(rows)} ({covered / len(rows):.0%})")
        print()

        baseline = _fit_all(train_matches, location_weight=None)
        baseline_scores = {
            competition: _per_match_brier(baseline[competition], test_matches[test_matches["competition_name"] == competition])
            for competition in FIT_COMPETITIONS
        }

        for weight in CANDIDATE_WEIGHTS:
            candidate = _fit_all(train_matches, location_weight=weight)
            print(f"--- location weight {weight} ---")
            for competition in FIT_COMPETITIONS:
                competition_test = test_matches[test_matches["competition_name"] == competition]
                a = baseline_scores[competition]
                b = _per_match_brier(candidate[competition], competition_test)

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
