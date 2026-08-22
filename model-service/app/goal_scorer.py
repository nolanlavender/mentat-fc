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

# How allocate_team_goals scales each player's slice of the team's
# expected goals. Three modes, because the 2026-08-22 backtest measured
# the first two and found NEITHER is calibrated:
#
#   "none"       shipped until now. goal_share sums to 1 across a team's
#                players, then each is multiplied by minutes_share (< 1),
#                discounting a second time -- and the MIN_PLAYER_MATCHES
#                filter is applied AFTER the share is normalised, so the
#                survivors sum to under 1 to begin with. Measured
#                calibration 0.736 days ahead and 0.399 once a lineup is
#                confirmed: it under-calls every scorer, badly.
#
#   "allocated"  divide by the summed weights of the players actually
#                being allocated, so the total comes back to the team's
#                expected goals exactly. Fixes the arithmetic and then
#                overshoots: 1.391 and 1.268. Forcing 100% of a team's
#                goals onto its reliable players asserts that no goal is
#                ever scored by anyone else, and measured across three
#                competitions reliable players account for roughly 73%
#                (days ahead) to 79% (confirmed squad).
#
#   "expected"   divide by this team's whole expected open-play output
#                per match summed over EVERY player, fringe ones included
#                (compute_player_shares' open_play_allocation_denominator).
#                The reliable pool then receives exactly its historical
#                share, recovering the coverage the data already knows
#                rather than assuming it -- and with no new tuned
#                constant. Predicted to land near 1.0 in both modes.
#
# "allocated" as of 2026-08-22, paired with ALLOCATION_COVERAGE below --
# see app.train. The walk-forward backtest settled this in three rounds
# and each round moved the answer, so the reasoning is worth keeping:
#
#   round 1 (frozen cutoff)  "none" 0.736, "allocated" 1.391 -- flipping
#     to "allocated" would have made the days-ahead path WORSE, which is
#     why it did not ship on the arithmetic alone.
#   round 2  "expected" was built to withhold the fringe players'
#     share and predicted to land near 1.0. It landed at 1.326: fringe
#     players are only ~5% of the pool where 28% needed withholding.
#   round 3 (walk-forward)  the missing 23% was mostly the HARNESS -- a
#     frozen cutoff made a year of signings and debuts invisible.
#     Rebuilding shares per fold moved coverage 0.716 -> 0.794.
#
# What survives all three: "allocated" is the structurally right rule,
# because it renormalises over exactly the players being predicted --
# every reliable player days ahead, the named squad on matchday. What it
# gets wrong is only the LEVEL, and it gets that wrong by a single factor
# (goals scored by players outside the predicted set: those still under
# the appearance threshold, and own goals). That factor is
# ALLOCATION_COVERAGE, measured rather than derived -- structurally
# deriving it is impossible, since the players it accounts for are by
# definition not in the data yet.
ALLOCATION_MODE = "allocated"

ALLOCATION_MODES = ("none", "allocated", "expected")

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
        "open_play_allocation_denominator",
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

    # The denominator the "expected" allocation mode divides by: this
    # team's whole expected open-play goal output per match, summed over
    # EVERY player -- including the fringe ones the MIN_PLAYER_MATCHES
    # filter is about to drop.
    #
    # Why over everyone rather than over the players being allocated. The
    # 2026-08-22 backtest measured both alternatives and neither was
    # calibrated: allocating nothing extra under-called by 26%, while
    # normalising over the allocated players over-called by 39%. The
    # over-call is the informative one -- forcing the team's entire
    # expected goals onto the reliable pool asserts that reliable players
    # score 100% of a team's goals, and measured across three competitions
    # they score about 73% (days ahead) to 79% (with a confirmed squad).
    # Dividing by the all-player total reproduces that coverage from the
    # data instead of assuming it away, with no new tuned constant.
    non_penalty_team_totals = grouped.groupby("team_id")["non_penalty_goals_per_90"].transform("sum")
    grouped["non_penalty_goal_share"] = np.where(
        non_penalty_team_totals > 0, grouped["non_penalty_goals_per_90"] / non_penalty_team_totals, 0.0
    )

    team_goal_totals = grouped.groupby("team_id")["weighted_goals"].transform("sum")

    # Units matter here and cost a debugging round the first time: the
    # weights allocate_team_goals builds are non_penalty_goal_share *
    # minutes_share -- a normalised share, not a goals-per-match rate --
    # so this divisor has to be the sum of exactly that product, over
    # EVERY player including the ones MIN_PLAYER_MATCHES is about to drop.
    # Built from goals_per_90 instead, it is off by the team's total
    # scoring rate and silently under-allocates by a factor of ~4.
    grouped["open_play_expectation"] = grouped["non_penalty_goal_share"] * grouped["minutes_share"]
    grouped["open_play_allocation_denominator"] = grouped.groupby("team_id")["open_play_expectation"].transform("sum")
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
    normalization: str = ALLOCATION_MODE,
    coverage: float = 1.0,
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

    if normalization not in ALLOCATION_MODES:
        raise ValueError(f"normalization must be one of {ALLOCATION_MODES}, not {normalization!r}")

    divisor = 1.0
    if normalization == "allocated":
        total = sum(weight for _, weight in weights)
        if total > 0:
            divisor = total
    elif normalization == "expected" and not team_players.empty:
        # One value per team, so reading the first row is reading the
        # team's. Unlike "allocated" this divisor does NOT depend on which
        # players are being allocated, which is the whole point: a
        # confirmed squad that excludes half the fringe should receive a
        # LARGER share of the team's goals, not be renormalised back up to
        # all of them.
        total = float(team_players["open_play_allocation_denominator"].iloc[0])
        if total > 0:
            divisor = total
    # A zero total means nobody has any scoring history at all. Dividing
    # would be 0/0; leaving the divisor at 1 gives every player a lambda
    # of 0, which is the honest answer rather than an invented one.

    predictions = []
    for player_id, weight in weights:
        # coverage scales the whole allocation down to the share of a
        # team's goals the predicted players actually account for. Applied
        # here rather than to team_expected_goals so the penalty portion
        # below is scaled by it too -- a penalty taker who is not in our
        # pool is exactly as absent as any other scorer.
        lambda_player = coverage * open_play_expected_goals * weight / divisor
        if player_id == primary_taker_id:
            lambda_player += coverage * penalty_expected_goals

        predictions.append(
            PlayerGoalPrediction(player_id=player_id, expected_goals=lambda_player, prob_scores=1 - exp(-lambda_player))
        )
    return predictions
