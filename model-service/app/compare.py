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

from app.data import blend_goal_proxies_into_scores, load_finished_matches
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
# Current question (2026-08-21): the shot-location proxy has been
# backfilled. Where it exists, is weighting shots by WHERE they were
# taken better than counting shots on target?
#
# Note what B is, because the first version of this comparison got it
# wrong and produced a confident, misleading verdict. B is NOT "location
# instead of shots on target" -- location coverage is only ~48%, so that
# configuration left half the matches with raw unsmoothed goals while A
# had shots-on-target smoothing everywhere, handicapping B on half the
# sample. B is "A, upgraded to location on the rows that have it", which
# is both the fair comparison and the only sane production design.
A_LABEL = "shots on target everywhere (current)"
B_LABEL = "shot location where available, shots on target elsewhere"


def _config(competition: str, use_shot_location: bool) -> tuple[float, float]:
    """Returns (shots_on_target_weight, shot_location_weight)."""
    return SHOTS_ON_TARGET_BLEND_WEIGHT[competition], 1.0 if use_shot_location else 0.0

BOOTSTRAP_SAMPLES = 5000
CONFIDENCE = 95


def _blend(matches: pd.DataFrame, competition: str, use_shot_location: bool) -> pd.DataFrame:
    sot_weight, location_weight = _config(competition, use_shot_location)
    return blend_goal_proxies_into_scores(matches, sot_weight, location_weight)


def _fit_all(train_matches: pd.DataFrame, use_shot_location: bool) -> dict[str, DixonColesModel]:
    """The same three fits app.evaluate builds, under one configuration."""
    joint = DixonColesModel()
    joint.fit(
        _blend(train_matches, "FA Cup", use_shot_location),
        half_life_days=HALF_LIFE_DAYS,
        shrinkage=SHRINKAGE["FA Cup"],
    )
    prior = joint if SHRINK_TOWARD_JOINT else None

    models: dict[str, DixonColesModel] = {"FA Cup": joint}
    for competition in ("Premier League", "Championship"):
        model = DixonColesModel()
        model.fit(
            _blend(train_matches[train_matches["competition_name"] == competition], competition, use_shot_location),
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

        print(f"Paired A/B on held-out matches after {cutoff_date}")
        print(f"  A = {A_LABEL}")
        print(f"  B = {B_LABEL}")
        # Per competition, not just overall: coverage is the most likely
        # confounder for any per-competition difference in the verdict, so
        # it belongs next to the verdict rather than as one global number.
        for competition in FIT_COMPETITIONS:
            rows = matches[matches["competition_name"] == competition]
            if rows.empty:
                continue
            covered = rows["home_shots_inside_box"].notna().sum()
            print(f"  shot-location coverage, {competition}: {covered}/{len(rows)} ({covered / len(rows):.0%})")
        print()

        baseline = _fit_all(train_matches, use_shot_location=False)
        candidate = _fit_all(train_matches, use_shot_location=True)

        for competition in FIT_COMPETITIONS:
            competition_test = test_matches[test_matches["competition_name"] == competition]
            a = _per_match_brier(baseline[competition], competition_test)
            b = _per_match_brier(candidate[competition], competition_test)

            # Only fixtures BOTH configurations could predict -- otherwise
            # the two samples aren't the same matches and pairing is void.
            shared = sorted(set(a) & set(b))
            if not shared:
                print(f"{competition}: no comparable held-out matches.\n")
                continue

            diffs = np.array([b[f] - a[f] for f in shared])  # negative = candidate better
            mean_diff = float(diffs.mean())
            low, high = _bootstrap_ci(diffs)
            changed = int(np.sum(diffs != 0))

            print(f"{competition}: {len(shared)} paired matches ({changed} scored differently)")
            print(f"  A Brier {np.mean([a[f] for f in shared]):.4f}   B Brier {np.mean([b[f] for f in shared]):.4f}")
            print(f"  mean difference (B - A): {mean_diff:+.5f}   {CONFIDENCE}% CI [{low:+.5f}, {high:+.5f}]")

            # The whole point: does the interval actually exclude zero?
            if changed == 0:
                # Not "inconclusive" -- this configuration provably does not
                # touch this fit at all, which makes it a control rather than
                # a result. Calling an untouched fit "not distinguishable from
                # noise" would be technically true and actively misleading.
                verdict = "UNCHANGED -- this configuration does not affect this fit (a control, not a null result)"
            elif low > 0:
                verdict = "A is better -- the interval excludes zero"
            elif high < 0:
                verdict = "B is better -- the interval excludes zero"
            else:
                verdict = (
                    "INCONCLUSIVE -- the interval spans zero, this difference is not distinguishable from noise. "
                    f"Anything smaller than about {max(abs(low), abs(high)):.4f} Brier is below what "
                    f"{len(shared)} held-out matches can resolve."
                )
            print(f"  -> {verdict}\n")
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
