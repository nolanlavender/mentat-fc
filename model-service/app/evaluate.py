"""
Backtest: split every competition's finished matches by date using one
global cutoff, then -- matching app.train's real architecture (see its
2026-08-15 revision note for why) -- fit three separate models on the
earlier portion: Premier League alone, Championship alone, and one joint
fit across all three competitions used only for FA Cup, since that's the
only one of the three where cross-league comparability is actually needed.
Predict the held-out later portion with the matching model, score against
what actually happened -- and against the market's own closing-odds-
implied probabilities as a baseline, per competition. See
docs/learning-log.md's Phase 5 entry for why "beat the market" isn't
really the bar here; this is about finding out honestly where the model
actually stands, which is the real point of this step.

Also the sandbox for trying a candidate SHOTS_ON_TARGET_BLEND_WEIGHT (see
that constant's own comment, and
app.data.blend_shots_on_target_into_scores) -- edit the constant, rerun,
compare the Brier/log-loss numbers against a 0.0 baseline run, same
process HALF_LIFE_DAYS already went through.

Usage: python -m app.evaluate
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from app.data import blend_shots_on_target_into_scores, load_closing_match_winner_probabilities, load_finished_matches
from app.db import get_connection
from app.dixon_coles import DixonColesModel

FIT_COMPETITIONS = ["Premier League", "Championship", "FA Cup"]

TEST_FRACTION = 0.2
MIN_MATCHES_FOR_BACKTEST = 100

# Kept in sync with app.train.HALF_LIFE_DAYS by hand, not imported from a
# shared module -- deliberately duplicated, not a shared constant, since
# this file doubles as an experimentation sandbox (try a value here, compare
# the backtest, only then change train.py's deployed value to match). If
# you're evaluating a candidate half-life, this is the one to edit.
#
# 120 and 60 were both tried against real 3-season data and both measured
# worse than 180 in both leagues, monotonically (see docs/learning-log.md's
# Phase 5 entry for the full table) -- back to 180 as the best of what's
# been tested so far.
HALF_LIFE_DAYS = 180

# How much of the fit's "goals" for a match is that side's own goals-
# scaled shots on target instead of the actual final score -- see
# app.data.blend_shots_on_target_into_scores. Real xG isn't available
# from any current data source (confirmed 2026-08-19 against a real
# API-Football /fixtures/statistics response -- no expected-goals field
# at all), so this is the closest real signal actually sitting in the DB.
# 0.0 = today's deployed behavior, completely unchanged. Not yet
# validated against real data (no blended value has been promoted to
# app.train's deployed constant), so this starts at 0.0 rather than
# guessing a plausible-sounding nonzero default -- try 0.25/0.5/0.75/1.0
# here and compare the backtest, same process HALF_LIFE_DAYS went
# through above.
SHOTS_ON_TARGET_BLEND_WEIGHT = 0.0


def brier_score(probs: np.ndarray, outcomes: np.ndarray) -> float:
    """Mean squared error between predicted probability vectors and one-hot actual outcomes.
    0 = perfect. Always predicting the (home, draw, away) base rates scores better than
    guessing uniformly, so there's no single universal "good" number -- compare model vs.
    market on the same matches, not against an absolute threshold."""
    return float(np.mean(np.sum((probs - outcomes) ** 2, axis=1)))


def log_loss(probs: np.ndarray, outcomes: np.ndarray) -> float:
    """Average negative log-likelihood of the actual outcome under the predicted probabilities.
    Lower is better; punishes confident wrong predictions much harder than Brier score does."""
    eps = 1e-15
    clipped = np.clip(probs, eps, 1 - eps)
    return float(-np.mean(np.sum(outcomes * np.log(clipped), axis=1)))


def _outcome_one_hot(home_score: int, away_score: int) -> list[int]:
    if home_score > away_score:
        return [1, 0, 0]
    if home_score == away_score:
        return [0, 1, 0]
    return [0, 0, 1]


def _predict_and_score(model: DixonColesModel, conn, competition_name: str, test_matches: pd.DataFrame, trained_on: int) -> None:
    rows = []
    for m in test_matches.itertuples():
        try:
            pred = model.predict(m.home_team, m.away_team)
        except ValueError:
            continue  # team wasn't in the training window -- can't predict it fairly
        rows.append(
            {
                "fixture_id": m.fixture_id,
                "model_home": pred.prob_home_win,
                "model_draw": pred.prob_draw,
                "model_away": pred.prob_away_win,
                "actual_home_score": m.home_score,
                "actual_away_score": m.away_score,
            }
        )
    pred_df = pd.DataFrame(rows)
    if pred_df.empty:
        print(f"{competition_name}: no predictable held-out matches (teams outside the training window).")
        return

    outcomes = np.array([_outcome_one_hot(r.actual_home_score, r.actual_away_score) for r in pred_df.itertuples()])
    model_probs = pred_df[["model_home", "model_draw", "model_away"]].to_numpy()

    print(f"{competition_name}: backtest on {len(pred_df)} held-out matches (joint model trained on {trained_on})")
    print(f"  Model  -- Brier: {brier_score(model_probs, outcomes):.4f}  Log-loss: {log_loss(model_probs, outcomes):.4f}")

    market = load_closing_match_winner_probabilities(conn, pred_df["fixture_id"].tolist())
    merged = pred_df.merge(market, on="fixture_id", how="inner")
    if merged.empty:
        # Expected for FA Cup: football-data.co.uk has no cup coverage and
        # The Odds API integration is deliberately deferred (see Phase 6's
        # learning-log entry) -- there's no market baseline for it at all yet.
        print("  No closing odds available for these matches -- can't compare to a market baseline.")
        return

    merged_outcomes = np.array(
        [_outcome_one_hot(r.actual_home_score, r.actual_away_score) for r in merged.itertuples()]
    )
    model_probs_comparable = merged[["model_home", "model_draw", "model_away"]].to_numpy()
    market_probs = merged[["prob_home_win", "prob_draw", "prob_away_win"]].to_numpy()

    print(f"  Comparable to market on {len(merged)} of those matches:")
    print(
        f"    Model  -- Brier: {brier_score(model_probs_comparable, merged_outcomes):.4f}  "
        f"Log-loss: {log_loss(model_probs_comparable, merged_outcomes):.4f}"
    )
    print(
        f"    Market -- Brier: {brier_score(market_probs, merged_outcomes):.4f}  "
        f"Log-loss: {log_loss(market_probs, merged_outcomes):.4f}"
    )


def main() -> None:
    conn = get_connection()
    try:
        matches = load_finished_matches(conn, FIT_COMPETITIONS)
        if len(matches) < MIN_MATCHES_FOR_BACKTEST:
            print(f"Only {len(matches)} matches across {FIT_COMPETITIONS}, not enough for a meaningful backtest, skipping.")
            return
        print(f"HALF_LIFE_DAYS={HALF_LIFE_DAYS}  SHOTS_ON_TARGET_BLEND_WEIGHT={SHOTS_ON_TARGET_BLEND_WEIGHT}")

        # One global date cutoff across the joint dataset, not a separate
        # per-competition split -- matches came back ordered by kickoff_date
        # from the query, so this is genuinely chronological. Using one
        # cutoff keeps the train/test boundary the same real-world date
        # across all three competitions' backtests, even though each now
        # gets its own model fit below.
        split_idx = int(len(matches) * (1 - TEST_FRACTION))
        cutoff_date = matches.iloc[split_idx]["kickoff_date"]
        train_matches = matches[matches["kickoff_date"] < cutoff_date]
        test_matches = matches[matches["kickoff_date"] >= cutoff_date]

        # Shots-on-target blending (if SHOTS_ON_TARGET_BLEND_WEIGHT != 0)
        # only ever applies to what gets fit on -- test_matches, used below
        # for the actual held-out outcomes, must stay real scores
        # untouched, or the backtest would be scoring the model against a
        # distorted version of what really happened instead of reality.
        pl_train = blend_shots_on_target_into_scores(
            train_matches[train_matches["competition_name"] == "Premier League"], SHOTS_ON_TARGET_BLEND_WEIGHT
        )
        pl_model = DixonColesModel()
        pl_model.fit(pl_train, half_life_days=HALF_LIFE_DAYS)
        print(f"Premier League fit on {pl_model.fitted_on} matches, {len(pl_model.teams)} teams, cutoff {cutoff_date}")
        _predict_and_score(
            pl_model, conn, "Premier League", test_matches[test_matches["competition_name"] == "Premier League"], len(pl_train)
        )

        championship_train = blend_shots_on_target_into_scores(
            train_matches[train_matches["competition_name"] == "Championship"], SHOTS_ON_TARGET_BLEND_WEIGHT
        )
        championship_model = DixonColesModel()
        championship_model.fit(championship_train, half_life_days=HALF_LIFE_DAYS)
        print(f"Championship fit on {championship_model.fitted_on} matches, {len(championship_model.teams)} teams, cutoff {cutoff_date}")
        _predict_and_score(
            championship_model,
            conn,
            "Championship",
            test_matches[test_matches["competition_name"] == "Championship"],
            len(championship_train),
        )

        # Joint fit -- all three competitions' pre-cutoff matches -- used
        # only for FA Cup, the one competition that actually needs
        # cross-league comparability. See app.train's 2026-08-15 note.
        joint_model = DixonColesModel()
        joint_model.fit(blend_shots_on_target_into_scores(train_matches, SHOTS_ON_TARGET_BLEND_WEIGHT), half_life_days=HALF_LIFE_DAYS)
        print(
            f"Joint fit (for FA Cup) on {joint_model.fitted_on} matches across {', '.join(FIT_COMPETITIONS)}, "
            f"{len(joint_model.teams)} teams, cutoff {cutoff_date}"
        )
        _predict_and_score(
            joint_model, conn, "FA Cup", test_matches[test_matches["competition_name"] == "FA Cup"], len(train_matches)
        )
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
