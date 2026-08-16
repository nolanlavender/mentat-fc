from datetime import date

import pandas as pd
import pytest

from app.goal_scorer import MIN_PLAYER_MATCHES, allocate_team_goals, compute_player_shares

AS_OF = date(2026, 8, 1)


def _appearance(team_id, player_id, day, minutes, goals):
    return {
        "team_id": team_id,
        "player_id": player_id,
        "kickoff_date": date(2026, 1, 1 + day),
        "minutes_played": minutes,
        "goals": goals,
    }


class TestComputePlayerShares:
    def test_a_prolific_full_time_starter_outranks_a_rarely_used_sub(self):
        appearances = pd.DataFrame(
            [
                # Starman: every match, full 90, scores at a healthy 0.8/90 rate.
                *[_appearance(1, 100, i, 90, 1 if i < 8 else 0) for i in range(10)],
                # Fringe: named every match, but rarely gets on, and scores at
                # a genuinely lower rate too (not just a lower total) --
                # 1 goal across 300 minutes = 0.3/90.
                *[_appearance(1, 101, i, 30, 1 if i == 5 else 0) for i in range(10)],
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)

        starman = shares[shares["player_id"] == 100].iloc[0]
        fringe = shares[shares["player_id"] == 101].iloc[0]

        assert starman["minutes_share"] > fringe["minutes_share"]
        assert starman["goal_share"] > fringe["goal_share"]

    def test_excludes_players_below_the_reliability_threshold(self):
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 1) for i in range(MIN_PLAYER_MATCHES)],  # exactly at the threshold
                *[_appearance(1, 200, i, 90, 1) for i in range(MIN_PLAYER_MATCHES - 1)],  # one short
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)

        assert 100 in shares["player_id"].values
        assert 200 not in shares["player_id"].values

    def test_goal_share_is_a_per_90_rate_not_a_raw_total(self):
        # Two players with the SAME total goals, but one played far fewer
        # minutes to get there -- their goal_share should reflect the rate,
        # not tie, since goal_share is meant to answer "if they played
        # equal minutes, what share of scoring would each account for."
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 1) for i in range(10)],  # 10 goals in 900 minutes
                *[_appearance(1, 200, i, 20, 1) for i in range(10)],  # 10 goals in 200 minutes -- much higher rate
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)

        rate_player = shares[shares["player_id"] == 200].iloc[0]
        volume_player = shares[shares["player_id"] == 100].iloc[0]
        assert rate_player["goal_share"] > volume_player["goal_share"]

    def test_goal_shares_within_a_team_sum_to_one(self):
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 2) for i in range(10)],
                *[_appearance(1, 101, i, 90, 1) for i in range(10)],
                *[_appearance(1, 102, i, 90, 0) for i in range(10)],
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        assert shares["goal_share"].sum() == pytest.approx(1.0, abs=1e-9)

    def test_empty_input_returns_empty_frame_with_expected_columns(self):
        shares = compute_player_shares(pd.DataFrame(columns=["team_id", "player_id", "kickoff_date", "minutes_played", "goals"]), AS_OF)
        assert list(shares.columns) == ["team_id", "player_id", "matches", "minutes_share", "goal_share"]
        assert shares.empty


class TestAllocateTeamGoals:
    def test_splits_team_expected_goals_by_combined_share(self):
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 2) for i in range(10)],  # full minutes, scores a lot
                *[_appearance(1, 101, i, 10, 0) for i in range(10)],  # rarely plays, never scores
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        predictions = allocate_team_goals(team_expected_goals=1.8, team_id=1, player_shares=shares)

        by_player = {p.player_id: p for p in predictions}
        assert by_player[100].expected_goals > by_player[101].expected_goals
        # A team's total expected goals should roughly conserve across its
        # (reliable) players' shares -- goal_share sums to 1, minutes_share
        # doesn't, so this isn't an exact identity, just a sanity bound
        # (with a small epsilon for floating-point rounding).
        assert sum(p.expected_goals for p in predictions) <= 1.8 + 1e-9

    def test_scoring_probability_derives_from_poisson_lambda(self):
        appearances = pd.DataFrame([*[_appearance(1, 100, i, 90, 1) for i in range(10)]])
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        predictions = allocate_team_goals(team_expected_goals=2.0, team_id=1, player_shares=shares)

        pred = predictions[0]
        assert pred.prob_scores == pytest.approx(1 - pow(2.718281828459045, -pred.expected_goals), rel=1e-6)
        assert 0 <= pred.prob_scores <= 1

    def test_returns_nothing_for_a_team_with_no_reliable_players(self):
        appearances = pd.DataFrame([_appearance(1, 100, 0, 90, 1)])  # single appearance, below MIN_PLAYER_MATCHES
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        predictions = allocate_team_goals(team_expected_goals=1.5, team_id=1, player_shares=shares)
        assert predictions == []

    def test_returns_nothing_for_a_different_team_id(self):
        appearances = pd.DataFrame([*[_appearance(1, 100, i, 90, 1) for i in range(10)]])
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        predictions = allocate_team_goals(team_expected_goals=1.5, team_id=999, player_shares=shares)
        assert predictions == []
