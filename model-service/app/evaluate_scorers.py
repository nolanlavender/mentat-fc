"""
Backtest for the goal-scorer model -- the first one it has ever had.

Why this exists. Every team-level change in this project went through a
real held-out comparison before shipping. The goal-scorer model shipped on
plausibility alone: the maths is reasonable, the outputs looked sane, and
nobody ever scored it against what actually happened. That is the largest
untested surface in the codebase, and it is the one the app displays most
prominently.

What it measures, in priority order:

1. CALIBRATION -- do the probabilities mean what they say? If we assign
   0.20 to a hundred player-fixtures, about twenty of those players should
   score. This is the headline number, because a scorer probability is
   read directly as a price. Reported as predicted-scorers / actual-
   scorers: 1.0 is perfect, below 1.0 means we systematically under-call.
2. DISCRIMINATION -- given that the overall level is right, do we rank the
   right players higher? Measured by AUC, which is invariant to any
   monotone rescaling and therefore says nothing about calibration. The
   two failures are independent and need separate numbers.
3. Brier and log loss, which mix the two, for comparability with
   app.evaluate.

Every one of those is reported against a BASE-RATE baseline: the same
probability for everyone, equal to the historical rate of a squad player
scoring. That baseline is perfectly calibrated by construction and has
zero discrimination (AUC 0.5), which makes it exactly the right thing to
beat -- if our model can't beat it, the per-player machinery is adding
nothing over "someone scores sometimes."

Two prediction modes, because production runs in both:
  - "no lineup": how a fixture looks days ahead, on the Predictions page.
    Every reliable player is predicted using his season-blended minutes.
  - "confirmed lineup": how it looks an hour before kickoff, once
    fixture_lineups is populated. Players not named are dropped; starters
    and bench get their role-specific minutes.

Reads only. Usage: python -m app.evaluate_scorers
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from app.data import (
    load_confirmed_lineups,
    load_finished_matches,
    load_fixture_player_goals,
    load_player_squad_appearances,
)
from app.db import get_connection
from app.dixon_coles import DixonColesModel
from app.evaluate import (
    FIT_COMPETITIONS,
    HALF_LIFE_DAYS,
    MIN_MATCHES_FOR_BACKTEST,
    SHRINKAGE,
    TEST_FRACTION,
    _blend,
)
from app.goal_scorer import allocate_team_goals, compute_player_shares

MIN_PREDICTIONS_TO_REPORT = 200
EPSILON = 1e-9  # log-loss guard; probabilities can legitimately reach 0 for a zero-share player


def _auc(probabilities: np.ndarray, outcomes: np.ndarray) -> float | None:
    """
    Probability that a randomly chosen scorer was ranked above a randomly
    chosen non-scorer. 0.5 is coin-flip ranking, 1.0 is perfect.

    Computed by the rank-sum identity rather than by sweeping thresholds --
    same number, no ROC curve to build. Ties get average ranks, which is
    what makes a model that outputs one constant score exactly 0.5 instead
    of accidentally winning or losing on tie-break order.
    """
    positives = outcomes == 1
    n_pos = int(positives.sum())
    n_neg = int(len(outcomes) - n_pos)
    if n_pos == 0 or n_neg == 0:
        return None
    ranks = pd.Series(probabilities).rank(method="average").to_numpy()
    return float((ranks[positives].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def _score(label: str, probabilities: np.ndarray, outcomes: np.ndarray) -> dict:
    clipped = np.clip(probabilities, EPSILON, 1 - EPSILON)
    predicted_scorers = float(probabilities.sum())
    actual_scorers = float(outcomes.sum())
    return {
        "label": label,
        "n": len(outcomes),
        "predicted_scorers": predicted_scorers,
        "actual_scorers": actual_scorers,
        "calibration": predicted_scorers / actual_scorers if actual_scorers > 0 else float("nan"),
        "brier": float(np.mean((probabilities - outcomes) ** 2)),
        "log_loss": float(-np.mean(outcomes * np.log(clipped) + (1 - outcomes) * np.log(1 - clipped))),
        "auc": _auc(probabilities, outcomes),
    }


def _print_scores(rows: list[dict]) -> None:
    print(f"  {'':<26} {'n':>7} {'pred':>8} {'actual':>8} {'calib':>7} {'Brier':>8} {'logloss':>8} {'AUC':>6}")
    for row in rows:
        auc = f"{row['auc']:.3f}" if row["auc"] is not None else "   -- "
        print(
            f"  {row['label']:<26} {row['n']:>7} {row['predicted_scorers']:>8.1f} {row['actual_scorers']:>8.0f} "
            f"{row['calibration']:>7.3f} {row['brier']:>8.5f} {row['log_loss']:>8.5f} {auc:>6}"
        )


def _predict_fixtures(
    test_matches: pd.DataFrame,
    models: dict[str, DixonColesModel],
    joint_model: DixonColesModel,
    player_shares: pd.DataFrame,
    lineups: pd.DataFrame,
    use_confirmed_lineup: bool,
    normalize_shares: bool,
) -> pd.DataFrame:
    """One row per (fixture, player) predicted, with the probability we'd have shown."""
    predictions = []
    for match in test_matches.itertuples():
        model = models.get(match.competition_name, joint_model)
        try:
            prediction = model.predict(match.home_team, match.away_team)
        except ValueError:
            try:
                prediction = joint_model.predict(match.home_team, match.away_team)
            except ValueError:
                continue  # no fitted parameters anywhere -- same skip production makes

        fixture_lineup = lineups[lineups["fixture_id"] == match.fixture_id]
        for team_id, team_expected_goals in (
            (match.home_team_id, prediction.predicted_home_goals),
            (match.away_team_id, prediction.predicted_away_goals),
        ):
            confirmed_squad: set[int] = set()
            confirmed_starting: set[int] = set()
            if use_confirmed_lineup:
                team_rows = fixture_lineup[fixture_lineup["team_id"] == team_id]
                confirmed_squad = set(team_rows["player_id"])
                confirmed_starting = set(team_rows[team_rows["is_starting"]]["player_id"])
                if not confirmed_squad:
                    continue  # no recorded lineup for this side -- nothing to score
            for player_prediction in allocate_team_goals(
                team_expected_goals,
                team_id,
                player_shares,
                confirmed_squad=confirmed_squad,
                confirmed_starting=confirmed_starting,
                normalize_shares=normalize_shares,
            ):
                predictions.append(
                    {
                        "fixture_id": int(match.fixture_id),
                        "competition_name": match.competition_name,
                        "player_id": player_prediction.player_id,
                        "prob_scores": player_prediction.prob_scores,
                    }
                )
    return pd.DataFrame(predictions)


def _attach_outcomes(predictions: pd.DataFrame, actual_goals: pd.DataFrame) -> pd.DataFrame:
    """
    Joins on what actually happened. A predicted player with no ground-truth
    row did not appear in that match's squad at all and therefore scored
    zero -- filled in rather than dropped, because dropping him would only
    ever remove a confident prediction that turned out wrong, which is the
    single most flattering thing a backtest can do to itself.
    """
    truth = actual_goals[["fixture_id", "player_id", "goals"]]
    merged = predictions.merge(truth, on=["fixture_id", "player_id"], how="left")
    merged["goals"] = merged["goals"].fillna(0)
    merged["scored"] = (merged["goals"] > 0).astype(float)
    return merged


def main() -> None:
    conn = get_connection()
    try:
        matches = load_finished_matches(conn, FIT_COMPETITIONS)
        if len(matches) < MIN_MATCHES_FOR_BACKTEST:
            print(f"Only {len(matches)} matches, not enough for a meaningful backtest.")
            return

        split_idx = int(len(matches) * (1 - TEST_FRACTION))
        cutoff_date = matches.iloc[split_idx]["kickoff_date"]
        train_matches = matches[matches["kickoff_date"] < cutoff_date]
        test_matches = matches[matches["kickoff_date"] >= cutoff_date]
        print(f"Goal-scorer backtest, held-out matches from {cutoff_date} ({len(test_matches)} fixtures)\n")

        joint_model = DixonColesModel()
        joint_model.fit(
            _blend(train_matches, "FA Cup"), half_life_days=HALF_LIFE_DAYS, shrinkage=SHRINKAGE["FA Cup"]
        )
        models: dict[str, DixonColesModel] = {"FA Cup": joint_model}
        for competition in ("Premier League", "Championship"):
            competition_matches = train_matches[train_matches["competition_name"] == competition]
            if len(competition_matches) < MIN_MATCHES_FOR_BACKTEST:
                continue
            model = DixonColesModel()
            model.fit(
                _blend(competition_matches, competition),
                half_life_days=HALF_LIFE_DAYS,
                shrinkage=SHRINKAGE[competition],
            )
            models[competition] = model

        # as_of=cutoff_date is the whole reason this is a backtest and not a
        # description of the past: shares built from appearances the model
        # could not have seen would be scoring itself on its own answers.
        appearances = load_player_squad_appearances(conn, FIT_COMPETITIONS, as_of=cutoff_date)
        player_shares = compute_player_shares(appearances, cutoff_date, half_life_days=HALF_LIFE_DAYS)
        print(
            f"Player shares from {len(appearances)} pre-cutoff appearances: "
            f"{player_shares['player_id'].nunique()} reliable players across "
            f"{player_shares['team_id'].nunique()} teams."
        )

        actual_goals = load_fixture_player_goals(conn, FIT_COMPETITIONS)
        actual_goals = actual_goals[actual_goals["kickoff_date"] >= cutoff_date]

        # Same loader production uses on matchday, so "starting" here means
        # exactly what it means live. Note these lineups are the one thing
        # in this backtest that genuinely IS from the future -- which is
        # correct, because by the time production allocates with them they
        # are the present. That's what separates the two modes below.
        lineups = load_confirmed_lineups(conn, test_matches["fixture_id"].tolist())
        print(f"Confirmed lineup rows for held-out fixtures: {len(lineups)}\n")

        for use_confirmed_lineup, mode in ((False, "no lineup (days ahead)"), (True, "confirmed lineup (matchday)")):
            # Both allocation settings scored on the SAME held-out
            # player-fixtures, so the shipped behaviour and the candidate
            # fix are read off one run rather than two. See
            # app.goal_scorer.NORMALIZE_ALLOCATION for what differs.
            variants = {}
            for normalize_shares, name in ((False, "model (shipped)"), (True, "model (normalized)")):
                predictions = _predict_fixtures(
                    test_matches, models, joint_model, player_shares, lineups, use_confirmed_lineup, normalize_shares
                )
                if not predictions.empty:
                    variants[name] = _attach_outcomes(predictions, actual_goals)
            if not variants:
                print(f"--- {mode} --- no predictions produced.\n")
                continue

            reference = next(iter(variants.values()))
            print(f"--- {mode} --- {len(reference)} player-fixtures")
            for competition in FIT_COMPETITIONS + ["ALL"]:
                mask = reference["competition_name"] == competition
                if competition != "ALL" and int(mask.sum()) < MIN_PREDICTIONS_TO_REPORT:
                    continue
                rows = []
                for name, scored in variants.items():
                    subset = scored if competition == "ALL" else scored[scored["competition_name"] == competition]
                    rows.append(
                        _score(name, subset["prob_scores"].to_numpy(dtype=float), subset["scored"].to_numpy(dtype=float))
                    )
                # The baseline every number here has to beat: one constant
                # probability for everybody, set to the observed rate. It is
                # perfectly calibrated by construction and ranks nobody.
                outcomes = (reference if competition == "ALL" else reference[mask])["scored"].to_numpy(dtype=float)
                rows.append(_score("base rate (constant)", np.full(len(outcomes), float(outcomes.mean())), outcomes))
                print(f"\n {competition}")
                _print_scores(rows)
            print()
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
