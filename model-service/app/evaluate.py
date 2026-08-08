"""
Backtest: split finished matches by date, fit on the earlier portion, predict
the held-out later portion, score the model's predictions against what
actually happened -- and against the market's own closing-odds-implied
probabilities as a baseline. See docs/learning-log.md's Phase 5 entry for why
"beat the market" isn't really the bar here; this is about finding out
honestly where the model actually stands, which is the real point of this
step.

Usage: python -m app.evaluate
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from app.data import load_closing_match_winner_probabilities, load_finished_matches
from app.db import get_connection
from app.dixon_coles import DixonColesModel

TEST_FRACTION = 0.2
MIN_MATCHES_FOR_BACKTEST = 100

# Kept in sync with app.train.HALF_LIFE_DAYS by hand, not imported from a
# shared module -- deliberately duplicated, not a shared constant, since
# this file doubles as an experimentation sandbox (try a value here, compare
# the backtest, only then change train.py's deployed value to match). If
# you're evaluating a candidate half-life, this is the one to edit.
HALF_LIFE_DAYS = 60


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


def run_for_competition(conn, competition_name: str) -> None:
    matches = load_finished_matches(conn, competition_name)
    if len(matches) < MIN_MATCHES_FOR_BACKTEST:
        print(f"{competition_name}: only {len(matches)} matches, not enough for a meaningful backtest, skipping.")
        return

    split_idx = int(len(matches) * (1 - TEST_FRACTION))
    train_matches = matches.iloc[:split_idx]
    test_matches = matches.iloc[split_idx:]

    model = DixonColesModel()
    model.fit(train_matches, half_life_days=HALF_LIFE_DAYS)

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

    print(f"{competition_name}: backtest on {len(pred_df)} held-out matches (trained on {len(train_matches)})")
    print(f"  Model  -- Brier: {brier_score(model_probs, outcomes):.4f}  Log-loss: {log_loss(model_probs, outcomes):.4f}")

    market = load_closing_match_winner_probabilities(conn, pred_df["fixture_id"].tolist())
    merged = pred_df.merge(market, on="fixture_id", how="inner")
    if merged.empty:
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
        for competition_name in ["Premier League", "Championship"]:
            run_for_competition(conn, competition_name)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
