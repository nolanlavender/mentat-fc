"""
Goal scorer prediction: allocates a team's Dixon-Coles-predicted expected
goals across its individual players, rather than training a separate
scorer-prediction model. lambda_player = team_xg * goal_share *
minutes_share, converted to a scoring probability via the same Poisson
math dixon_coles.py already uses for match outcomes: P(scores >= 1) =
1 - e^(-lambda_player).

Genuinely harder than match-outcome prediction, and worth being honest
about rather than glossing over:
- A team always "appears" for roughly a full match; an individual player
  might be rested, injured, or subbed early, and there's no real-time
  squad-news feed here -- minutes_share is a historical-average proxy for
  playing-time involvement, not actual team news for the upcoming match.
- Per-player goal samples are far smaller and noisier than team-level
  ones. MIN_PLAYER_MATCHES exists so a player with almost no data doesn't
  get a confident-looking prediction built on nothing.

goal_share and minutes_share answer two different, non-redundant
questions, which matters because multiplying two things that both
secretly encode "how much this player plays" would double-count it:
- goal_share is computed on a per-90 RATE basis (goals per 90 minutes
  played), normalized against teammates' rates -- "if everyone played
  equal minutes, what fraction of the scoring would this player account
  for." This does NOT already reflect their actual playing time.
- minutes_share is "how much of a full match does this player typically
  get, given they're rested/rotated sometimes" -- computed across every
  match they were named in the squad for, not just ones they played in.

See docs/learning-log.md's Phase 7 entry for the full reasoning.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from math import exp

import numpy as np
import pandas as pd

from app.dixon_coles import time_weight

MIN_PLAYER_MATCHES = 5  # raw (unweighted) squad-appearance count -- below this, shares are too noisy to trust


@dataclass
class PlayerGoalPrediction:
    player_id: int
    expected_goals: float
    prob_scores: float


def compute_player_shares(appearances: pd.DataFrame, as_of: date, half_life_days: float = 180) -> pd.DataFrame:
    """
    appearances: app.data.load_player_squad_appearances's output (team_id,
    player_id, kickoff_date, minutes_played, goals, rating -- one row per
    squad appearance). Returns one row per (team_id, player_id) with
    matches (raw count, for the reliability threshold), minutes_share,
    goal_share (normalized to sum to 1 within each team), and avg_rating
    (weighted mean of rating, NaN if this player has no rated appearances
    -- rating isn't recorded for every match, so this is deliberately not
    coalesced to 0, which would understate a real player as unrated-bad
    instead of just unknown). See app.goal_scorer.compute_team_availability
    for why avg_rating exists: comparing a confirmed matchday squad's
    average against this "normal" average is how a missing star gets
    partially or fully compensated for by a comparably-rated replacement,
    instead of always counting as pure lost share.
    """
    columns = ["team_id", "player_id", "matches", "minutes_share", "goal_share", "avg_rating"]
    if appearances.empty:
        return pd.DataFrame(columns=columns)

    weight = appearances["kickoff_date"].apply(lambda d: time_weight(d, as_of, half_life_days))
    # .astype(float) matters here even though the column is already numeric
    # -- an all-null rating column (every appearance unrated) infers as
    # object dtype, not float64, and object-dtype arithmetic against 0.0
    # raises a real ZeroDivisionError instead of producing NaN the way
    # float64 does. Same class of strict-dtype gotcha app.data's
    # blend_shots_on_target_into_scores hit with an all-null shots column.
    rating = appearances["rating"].astype(float)
    has_rating = rating.notna()
    df = appearances.assign(
        weight=weight,
        weighted_minutes=appearances["minutes_played"] * weight,
        weighted_goals=appearances["goals"] * weight,
        rating_weight=np.where(has_rating, weight, 0.0),
        weighted_rating=np.where(has_rating, rating * weight, 0.0),
    )

    grouped = (
        df.groupby(["team_id", "player_id"])
        .agg(
            matches=("weight", "size"),
            weighted_squad_appearances=("weight", "sum"),
            weighted_minutes=("weighted_minutes", "sum"),
            weighted_goals=("weighted_goals", "sum"),
            weighted_rating=("weighted_rating", "sum"),
            rating_weight=("rating_weight", "sum"),
        )
        .reset_index()
    )

    grouped["minutes_share"] = grouped["weighted_minutes"] / (90 * grouped["weighted_squad_appearances"])
    grouped["goals_per_90"] = np.where(
        grouped["weighted_minutes"] > 0,
        grouped["weighted_goals"] / (grouped["weighted_minutes"] / 90),
        0.0,
    )
    grouped["avg_rating"] = np.where(
        grouped["rating_weight"] > 0,
        grouped["weighted_rating"] / grouped["rating_weight"],
        np.nan,
    )

    team_totals = grouped.groupby("team_id")["goals_per_90"].transform("sum")
    grouped["goal_share"] = np.where(team_totals > 0, grouped["goals_per_90"] / team_totals, 0.0)

    reliable = grouped[grouped["matches"] >= MIN_PLAYER_MATCHES]
    return reliable[columns].reset_index(drop=True)


def _mean_rating(shares: pd.DataFrame) -> float | None:
    """Plain (unweighted) mean of already-weighted avg_rating across a set of players -- None if none of them have rating data."""
    ratings = shares["avg_rating"].dropna()
    if ratings.empty:
        return None
    return float(ratings.mean())


def compute_team_availability(team_id: int, confirmed_player_ids: set[int], player_shares: pd.DataFrame) -> float:
    """
    Scales a team's Dixon-Coles expected goals for one specific fixture
    based on which of its usual reliable-share players actually appear in
    the confirmed matchday squad (starting XI or bench -- see
    app.data.load_confirmed_lineups; bench presence still counts as
    "available" here, since this is a team-level strength adjustment, not
    the separate starting-vs-bench per-player minutes question). Returns
    1.0 (no adjustment) whenever there's no confirmed squad yet, or the
    team has no reliable-share players on record -- both mean "no
    confident answer," not "full strength."

    Every reliable player NOT in confirmed_player_ids is "missing," and
    their goal_share is lost -- but only partially counted, scaled down by
    a compensation_factor comparing the confirmed squad's own average
    historical rating against the team's normal reliable-pool average. A
    team fielding its usual-quality replacements barely loses anything; a
    team missing its highest-rated players for genuinely weaker fill-ins
    loses close to the full share. compensation_factor falls back to 0.0
    (no compensation -- the conservative case) whenever there isn't enough
    rating data on either side to compute a meaningful ratio.
    """
    team_players = player_shares[player_shares["team_id"] == team_id]
    if team_players.empty or not confirmed_player_ids:
        return 1.0

    missing = team_players[~team_players["player_id"].isin(confirmed_player_ids)]
    if missing.empty:
        return 1.0

    missing_share = float(missing["goal_share"].sum())
    if missing_share <= 0:
        return 1.0

    normal_rating = _mean_rating(team_players)
    confirmed_rating = _mean_rating(team_players[team_players["player_id"].isin(confirmed_player_ids)])
    if normal_rating is None or confirmed_rating is None or normal_rating <= 0:
        compensation_factor = 0.0
    else:
        compensation_factor = min(1.0, max(0.0, confirmed_rating / normal_rating))

    uncompensated_loss = missing_share * (1 - compensation_factor)
    return max(0.0, 1 - uncompensated_loss)


def allocate_team_goals(team_expected_goals: float, team_id: int, player_shares: pd.DataFrame) -> list[PlayerGoalPrediction]:
    """player_shares: compute_player_shares's output. Returns one prediction per reliable player on this team."""
    team_players = player_shares[player_shares["team_id"] == team_id]
    predictions = []
    for row in team_players.itertuples():
        lambda_player = team_expected_goals * row.goal_share * row.minutes_share
        predictions.append(
            PlayerGoalPrediction(player_id=int(row.player_id), expected_goals=lambda_player, prob_scores=1 - exp(-lambda_player))
        )
    return predictions
