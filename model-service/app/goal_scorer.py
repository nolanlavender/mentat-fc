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

Penalty takers get their own carve-out in allocate_team_goals, separate
from the goal_share/minutes_share math above, because a penalty isn't
allocated by playing-time or finishing rate the way open-play goals
are -- it's almost always one specific player's job. Folding penalty
goals into the same blended per-90 rate goal_share already uses would
misattribute them twice over: a player's rate stays inflated by
penalties he took for a PREVIOUS club (or a spell where he, not the
CURRENT taker, had the job), and the actual current taker doesn't get
credited any more than his open-play scoring alone would suggest. See
compute_primary_penalty_taker and allocate_team_goals for the mechanism.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from math import exp

import numpy as np
import pandas as pd

from app.dixon_coles import time_weight

# Whether allocate_team_goals normalises its open-play weights so the
# allocated expected goals actually sum back to the team's expected goals.
#
# False is the shipped behaviour, and it leaks. Two separate causes, both
# arithmetic rather than data:
#
#   1. goal_share is normalised across ALL of a team's players and the
#      MIN_PLAYER_MATCHES filter is applied afterwards, so the shares that
#      survive sum to less than 1 by construction.
#   2. goal_share is a share of the team's per-90 RATE. Multiplying it by
#      minutes_share (always < 1) discounts a second time, so the total is
#      a weighted average of numbers below 1 -- always short. Measured at
#      roughly 0.76 of the team's expected goals.
#
# True fixes both at once by dividing each weight by the sum of the
# weights actually being allocated. It also fixes a third thing that was
# never the point: when a player is confirmed out, his share currently
# vanishes into nothing, and under normalisation the remaining players
# absorb it -- which is correct, because compute_team_availability has
# already reduced the team's expected goals for his absence, so whatever
# is left really is going to be scored by whoever is playing.
#
# Defaults False so production behaviour is unchanged until measured.
# app.evaluate_scorers reports both settings side by side; flip this only
# once that run says to. The fix raises every scorer probability by
# roughly 1/0.76, and until the backtest existed there was no way to know
# whether that moves us toward the truth or past it.
NORMALIZE_ALLOCATION = False

MIN_PLAYER_MATCHES = 5  # raw (unweighted) squad-appearance count -- below this, shares are too noisy to trust
MIN_PENALTY_ATTEMPTS = 2  # raw (unweighted) penalty attempts (scored + missed) -- below this, don't trust anyone as "the taker"


@dataclass
class PlayerGoalPrediction:
    player_id: int
    expected_goals: float
    prob_scores: float


def compute_player_shares(appearances: pd.DataFrame, as_of: date, half_life_days: float = 180) -> pd.DataFrame:
    """
    appearances: app.data.load_player_squad_appearances's output (team_id,
    player_id, kickoff_date, minutes_played, goals, penalties_scored,
    penalties_missed, rating, is_starting -- one row per squad appearance).
    Returns one row per (team_id, player_id) with matches (raw count, for
    the reliability threshold), minutes_share, goal_share (normalized to
    sum to 1 within each team), avg_rating (weighted mean of rating, NaN
    if this player has no rated appearances -- see
    app.goal_scorer.compute_team_availability for why it exists), and
    avg_minutes_when_starting / avg_minutes_when_benched -- minutes_share
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

    Also returns non_penalty_goal_share (goal_share recomputed from
    goals minus penalties_scored, so a player's OPEN-PLAY scoring share
    isn't inflated by penalty history that belongs to a specific role, not
    general ability), penalty_attempts (weighted count of penalties_scored
    + penalties_missed -- attempts, not just conversions, since even a
    missed penalty confirms who currently gets picked to take one), and
    penalty_goal_fraction -- what fraction of the TEAM's own weighted
    goals (not this player's) have come from penalties, the same value
    repeated on every row for that team. See allocate_team_goals and
    compute_primary_penalty_taker for how these combine.
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
        "non_penalty_goal_share",
        "penalty_attempts",
        "penalty_goal_fraction",
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
    non_penalty_goals = appearances["goals"] - appearances["penalties_scored"]
    penalty_attempts = appearances["penalties_scored"] + appearances["penalties_missed"]
    df = appearances.assign(
        weight=weight,
        weighted_minutes=appearances["minutes_played"] * weight,
        weighted_goals=appearances["goals"] * weight,
        weighted_non_penalty_goals=non_penalty_goals * weight,
        weighted_penalty_goals=appearances["penalties_scored"] * weight,
        raw_penalty_attempts=penalty_attempts,
        weighted_penalty_attempts=penalty_attempts * weight,
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
            weighted_non_penalty_goals=("weighted_non_penalty_goals", "sum"),
            weighted_penalty_goals=("weighted_penalty_goals", "sum"),
            weighted_penalty_attempts=("weighted_penalty_attempts", "sum"),
            penalty_attempts_raw=("raw_penalty_attempts", "sum"),
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
    grouped["non_penalty_goals_per_90"] = np.where(
        grouped["weighted_minutes"] > 0,
        grouped["weighted_non_penalty_goals"] / (grouped["weighted_minutes"] / 90),
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
    # Raw (unweighted) attempt count feeds MIN_PENALTY_ATTEMPTS's reliability
    # gate; the recency-weighted count is what actually ranks "who's the
    # current taker" once a player clears that gate -- an old, expired
    # penalty-taking spell shouldn't outrank someone who's taken (or even
    # missed) one more recently.
    grouped["penalty_attempts"] = np.where(
        grouped["penalty_attempts_raw"] >= MIN_PENALTY_ATTEMPTS, grouped["weighted_penalty_attempts"], 0.0
    )

    team_totals = grouped.groupby("team_id")["goals_per_90"].transform("sum")
    grouped["goal_share"] = np.where(team_totals > 0, grouped["goals_per_90"] / team_totals, 0.0)

    non_penalty_team_totals = grouped.groupby("team_id")["non_penalty_goals_per_90"].transform("sum")
    grouped["non_penalty_goal_share"] = np.where(
        non_penalty_team_totals > 0, grouped["non_penalty_goals_per_90"] / non_penalty_team_totals, 0.0
    )

    team_goal_totals = grouped.groupby("team_id")["weighted_goals"].transform("sum")
    team_penalty_goal_totals = grouped.groupby("team_id")["weighted_penalty_goals"].transform("sum")
    grouped["penalty_goal_fraction"] = np.where(
        team_goal_totals > 0, np.clip(team_penalty_goal_totals / team_goal_totals, 0.0, 1.0), 0.0
    )

    reliable = grouped[grouped["matches"] >= MIN_PLAYER_MATCHES]
    return reliable[columns].reset_index(drop=True)


def _mean_rating(shares: pd.DataFrame) -> float | None:
    """Plain (unweighted) mean of already-weighted avg_rating across a set of players -- None if none of them have rating data."""
    ratings = shares["avg_rating"].dropna()
    if ratings.empty:
        return None
    return float(ratings.mean())


def compute_primary_penalty_taker(team_id: int, player_shares: pd.DataFrame) -> int | None:
    """
    The team's current penalty taker, if there's a confident answer --
    None otherwise, which callers should treat as "no attribution," not
    "this team never gets penalties" (see allocate_team_goals).

    Ranked by recency-weighted penalty_attempts (scored + missed), not
    just conversions -- a missed penalty still confirms who currently
    gets picked to take one, and using attempts rather than conversions
    alone avoids quietly erasing a poor penalty-taker's record by
    ignoring his misses. compute_player_shares already zeroed
    penalty_attempts out for anyone below MIN_PENALTY_ATTEMPTS raw
    attempts, so picking the max
    here is safe -- a team with no one over that bar has every player's
    penalty_attempts at 0, and this returns None rather than crowning
    whichever reliable player happens to be first in the frame.
    """
    team_players = player_shares[player_shares["team_id"] == team_id]
    if team_players.empty:
        return None

    top = team_players.loc[team_players["penalty_attempts"].idxmax()]
    if top["penalty_attempts"] <= 0:
        return None
    return int(top["player_id"])


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
    normalize_shares: bool = NORMALIZE_ALLOCATION,
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

    Penalty goals are carved out of team_expected_goals before the
    goal_share/minutes_share split runs, using the team's own
    penalty_goal_fraction (see compute_player_shares), and handed
    (almost) entirely to compute_primary_penalty_taker's pick instead of
    being spread by playing time like open-play goals are -- penalties
    are one specific player's job, not a shared rate. The remaining
    open-play portion is allocated using non_penalty_goal_share, not
    goal_share, so the primary taker's own penalty history doesn't also
    inflate his open-play share and get counted twice. Only carved out
    when a confident taker exists (compute_primary_penalty_taker doesn't
    return None) AND he isn't himself confirmed out of the squad -- with
    no confident taker at all, or the usual taker confirmed absent this
    fixture and no reliable second-choice to fall back to,
    team_expected_goals is left whole and allocated the old way (via
    non_penalty_goal_share, which degrades to ordinary goal_share
    whenever penalty_goal_fraction is 0), rather than quietly discarding
    a real chunk of expected goals into thin air.
    """
    team_players = player_shares[player_shares["team_id"] == team_id]
    primary_taker_id = compute_primary_penalty_taker(team_id, player_shares)
    taker_confirmed_out = confirmed_squad and primary_taker_id is not None and primary_taker_id not in confirmed_squad

    if primary_taker_id is not None and not taker_confirmed_out and not team_players.empty:
        penalty_goal_fraction = float(team_players["penalty_goal_fraction"].iloc[0])
        penalty_expected_goals = team_expected_goals * penalty_goal_fraction
        open_play_expected_goals = team_expected_goals - penalty_expected_goals
    else:
        penalty_expected_goals = 0.0
        open_play_expected_goals = team_expected_goals

    # Two passes: the open-play weights have to all exist before any of
    # them can be normalised, since the divisor is their own sum over
    # exactly the players being allocated for THIS fixture. That set
    # depends on the confirmed squad, so it can't be precomputed once in
    # compute_player_shares.
    weights: list[tuple[int, float]] = []
    for row in team_players.itertuples():
        if confirmed_squad and row.player_id not in confirmed_squad:
            continue  # confirmed out of the matchday squad -- no real chance to score

        minutes_share = row.minutes_share
        if confirmed_squad:
            role_share = row.avg_minutes_when_starting if row.player_id in confirmed_starting else row.avg_minutes_when_benched
            if not pd.isna(role_share):
                minutes_share = role_share

        weights.append((int(row.player_id), row.non_penalty_goal_share * minutes_share))

    divisor = 1.0
    if normalize_shares:
        total = sum(weight for _, weight in weights)
        if total > 0:
            divisor = total
        # total == 0 means nobody being allocated has any scoring history.
        # Dividing would be 0/0; leaving the divisor at 1 gives every
        # player a lambda of 0, which is the honest answer rather than an
        # invented one.

    predictions = []
    for player_id, weight in weights:
        lambda_player = open_play_expected_goals * weight / divisor
        if player_id == primary_taker_id:
            lambda_player += penalty_expected_goals

        predictions.append(
            PlayerGoalPrediction(player_id=player_id, expected_goals=lambda_player, prob_scores=1 - exp(-lambda_player))
        )
    return predictions
