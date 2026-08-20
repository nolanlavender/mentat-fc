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
    player_id, kickoff_date, minutes_played, goals, rating, is_starting --
    one row per squad appearance). Returns one row per (team_id, player_id)
    with matches (raw count, for the reliability threshold), minutes_share,
    goal_share (normalized to sum to 1 within each team), avg_rating
    (weighted mean of rating, NaN if this player has no rated appearances
    -- see app.goal_scorer.compute_team_availability for why it exists),
    and avg_minutes_when_starting / avg_minutes_when_benched -- minutes_share
    split by the role the player actually had that match, instead of one
    number blending both. A squad player who's a nailed-on 90-minute
    starter when he starts but only ever a late substitute otherwise looks
    like a "rotation risk" under the single blended minutes_share; the
    split lets a caller with a confirmed role for one specific fixture (see
    allocate_team_goals) use the right number instead of the blend. Both
    are NaN wherever a player has zero appearances in that role on record
    -- e.g. a player who has never once started -- so a caller has to
    explicitly decide the fallback rather than this function silently
    picking 0.
    """
    columns = [
        "team_id",
        "player_id",
        "matches",
        "minutes_share",
        "goal_share",
        "avg_rating",
        "avg_minutes_when_starting",
        "avg_minutes_when_benched",
    ]
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
    is_starting = appearances["is_starting"].astype(bool)
    df = appearances.assign(
        weight=weight,
        weighted_minutes=appearances["minutes_played"] * weight,
        weighted_goals=appearances["goals"] * weight,
        rating_weight=np.where(has_rating, weight, 0.0),
        weighted_rating=np.where(has_rating, rating * weight, 0.0),
        starting_weight=np.where(is_starting, weight, 0.0),
        weighted_minutes_starting=np.where(is_starting, appearances["minutes_played"] * weight, 0.0),
        benched_weight=np.where(~is_starting, weight, 0.0),
        weighted_minutes_benched=np.where(~is_starting, appearances["minutes_played"] * weight, 0.0),
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
            starting_weight=("starting_weight", "sum"),
            weighted_minutes_starting=("weighted_minutes_starting", "sum"),
            benched_weight=("benched_weight", "sum"),
            weighted_minutes_benched=("weighted_minutes_benched", "sum"),
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
    grouped["avg_minutes_when_starting"] = np.where(
        grouped["starting_weight"] > 0,
        grouped["weighted_minutes_starting"] / (90 * grouped["starting_weight"]),
        np.nan,
    )
    grouped["avg_minutes_when_benched"] = np.where(
        grouped["benched_weight"] > 0,
        grouped["weighted_minutes_benched"] / (90 * grouped["benched_weight"]),
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


def allocate_team_goals(
    team_expected_goals: float,
    team_id: int,
    player_shares: pd.DataFrame,
    confirmed_squad: set[int] = frozenset(),
    confirmed_starting: set[int] = frozenset(),
) -> list[PlayerGoalPrediction]:
    """
    player_shares: compute_player_shares's output. Returns one prediction
    per reliable player on this team -- except when a confirmed matchday
    squad is passed (see app.data.load_confirmed_lineups), in which case a
    reliable player NOT in confirmed_squad is skipped entirely rather than
    predicted: a player who isn't even named for the squad has no real
    chance to score, and shouldn't show up in scorer odds just because his
    season-long share still clears MIN_PLAYER_MATCHES.

    confirmed_squad empty (the default) means "no confirmed lineup for
    this fixture yet" -- every reliable player gets predicted using their
    normal season-blended minutes_share, unchanged from before this
    parameter existed. This is the common case (most fixtures, most of the
    week), so the empty-set default keeps existing callers' behavior
    identical.

    Once a squad IS confirmed, each player's role-specific minutes average
    (avg_minutes_when_starting or avg_minutes_when_benched, whichever
    matches whether he's in confirmed_starting) replaces minutes_share for
    that one fixture -- this is specifically why a squad player who's
    confirmed on the bench shouldn't out-rank a nailed-on starter in that
    fixture's scorer odds just because his season-long blended share
    doesn't distinguish "usually starts" from "usually a late sub." Falls
    back to the normal blended minutes_share when the player has no
    recorded appearances in that specific role yet (e.g. a squad player
    who has never once started) -- there's nothing role-specific to use,
    so falling back is more honest than guessing 0.
    """
    team_players = player_shares[player_shares["team_id"] == team_id]
    predictions = []
    for row in team_players.itertuples():
        if confirmed_squad and row.player_id not in confirmed_squad:
            continue  # confirmed out of the matchday squad -- no real chance to score

        minutes_share = row.minutes_share
        if confirmed_squad:
            role_share = row.avg_minutes_when_starting if row.player_id in confirmed_starting else row.avg_minutes_when_benched
            if not pd.isna(role_share):
                minutes_share = role_share

        lambda_player = team_expected_goals * row.goal_share * minutes_share
        predictions.append(
            PlayerGoalPrediction(player_id=int(row.player_id), expected_goals=lambda_player, prob_scores=1 - exp(-lambda_player))
        )
    return predictions
