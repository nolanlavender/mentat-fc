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
    player_id, kickoff_date, minutes_played, goals -- one row per squad
    appearance). Returns one row per (team_id, player_id) with matches
    (raw count, for the reliability threshold), minutes_share, and
    goal_share (goal_share normalized to sum to 1 within each team).
    """
    columns = ["team_id", "player_id", "matches", "minutes_share", "goal_share"]
    if appearances.empty:
        return pd.DataFrame(columns=columns)

    weight = appearances["kickoff_date"].apply(lambda d: time_weight(d, as_of, half_life_days))
    df = appearances.assign(
        weight=weight,
        weighted_minutes=appearances["minutes_played"] * weight,
        weighted_goals=appearances["goals"] * weight,
    )

    grouped = (
        df.groupby(["team_id", "player_id"])
        .agg(
            matches=("weight", "size"),
            weighted_squad_appearances=("weight", "sum"),
            weighted_minutes=("weighted_minutes", "sum"),
            weighted_goals=("weighted_goals", "sum"),
        )
        .reset_index()
    )

    grouped["minutes_share"] = grouped["weighted_minutes"] / (90 * grouped["weighted_squad_appearances"])
    grouped["goals_per_90"] = np.where(
        grouped["weighted_minutes"] > 0,
        grouped["weighted_goals"] / (grouped["weighted_minutes"] / 90),
        0.0,
    )

    team_totals = grouped.groupby("team_id")["goals_per_90"].transform("sum")
    grouped["goal_share"] = np.where(team_totals > 0, grouped["goals_per_90"] / team_totals, 0.0)

    reliable = grouped[grouped["matches"] >= MIN_PLAYER_MATCHES]
    return reliable[columns].reset_index(drop=True)


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
