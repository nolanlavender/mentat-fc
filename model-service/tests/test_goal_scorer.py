from datetime import date

import pandas as pd
import pytest

from app.goal_scorer import (
    MIN_PENALTY_ATTEMPTS,
    MIN_PLAYER_MATCHES,
    allocate_team_goals,
    compute_player_shares,
    compute_primary_penalty_taker,
    compute_team_availability,
)

AS_OF = date(2026, 8, 1)


def _appearance(
    team_id, player_id, day, minutes, goals, rating=None, is_starting=True, penalties_scored=0, penalties_missed=0
):
    return {
        "team_id": team_id,
        "player_id": player_id,
        "kickoff_date": date(2026, 1, 1 + day),
        "minutes_played": minutes,
        "goals": goals,
        "rating": rating,
        "is_starting": is_starting,
        "penalties_scored": penalties_scored,
        "penalties_missed": penalties_missed,
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
        shares = compute_player_shares(
            pd.DataFrame(
                columns=[
                    "team_id",
                    "player_id",
                    "kickoff_date",
                    "minutes_played",
                    "goals",
                    "rating",
                    "is_starting",
                    "penalties_scored",
                    "penalties_missed",
                ]
            ),
            AS_OF,
        )
        assert list(shares.columns) == [
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
        assert shares.empty

    def test_avg_rating_is_the_weighted_mean_of_rated_appearances(self):
        appearances = pd.DataFrame(
            [*[_appearance(1, 100, i, 90, 0, rating=7.0) for i in range(5)], *[_appearance(1, 100, i + 5, 90, 0, rating=8.0) for i in range(5)]]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        player = shares[shares["player_id"] == 100].iloc[0]
        # Equal weight decay isn't quite equal across the two halves (more
        # recent appearances count slightly more), but with only 5 days of
        # spread and a 180-day half-life it should land very close to the
        # simple average of 7.5.
        assert player["avg_rating"] == pytest.approx(7.5, abs=0.05)

    def test_avg_rating_is_nan_when_no_appearance_has_a_rating(self):
        appearances = pd.DataFrame([_appearance(1, 100, i, 90, 0, rating=None) for i in range(MIN_PLAYER_MATCHES)])
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        player = shares[shares["player_id"] == 100].iloc[0]
        assert pd.isna(player["avg_rating"])

    def test_avg_rating_excludes_unrated_appearances_rather_than_treating_them_as_zero(self):
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 0, rating=8.0) for i in range(5)],
                *[_appearance(1, 100, i + 5, 90, 0, rating=None) for i in range(5)],  # unrated -- should not drag the mean down
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        player = shares[shares["player_id"] == 100].iloc[0]
        assert player["avg_rating"] == pytest.approx(8.0, abs=0.01)

    def test_avg_minutes_split_by_role_not_blended(self):
        # A player who's a nailed-on 90 when he starts, but only ever a
        # brief 15-minute cameo off the bench otherwise -- the single
        # blended minutes_share should sit between those two, but the
        # role-specific averages should each reflect their own role only.
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 0, is_starting=True) for i in range(5)],
                *[_appearance(1, 100, i + 5, 15, 0, is_starting=False) for i in range(5)],
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        player = shares[shares["player_id"] == 100].iloc[0]

        assert player["avg_minutes_when_starting"] == pytest.approx(1.0, abs=0.01)  # 90/90
        assert player["avg_minutes_when_benched"] == pytest.approx(15 / 90, abs=0.01)
        assert player["avg_minutes_when_benched"] < player["minutes_share"] < player["avg_minutes_when_starting"]

    def test_avg_minutes_when_starting_is_nan_for_a_player_who_never_started(self):
        appearances = pd.DataFrame([_appearance(1, 100, i, 10, 0, is_starting=False) for i in range(MIN_PLAYER_MATCHES)])
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        player = shares[shares["player_id"] == 100].iloc[0]
        assert pd.isna(player["avg_minutes_when_starting"])
        assert not pd.isna(player["avg_minutes_when_benched"])

    def test_non_penalty_goal_share_excludes_penalty_goals(self):
        # Player 100: 5 goals, all from penalties -- zero open-play threat.
        # Player 101: 5 open-play goals, no penalties -- same raw total, but
        # non_penalty_goal_share should treat them very differently, unlike
        # plain goal_share which can't tell them apart.
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 1, penalties_scored=1) for i in range(5)],
                *[_appearance(1, 101, i, 90, 1) for i in range(5)],
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        penalty_taker = shares[shares["player_id"] == 100].iloc[0]
        open_play_scorer = shares[shares["player_id"] == 101].iloc[0]

        # Plain goal_share can't distinguish them -- same raw goals, same minutes.
        assert penalty_taker["goal_share"] == pytest.approx(open_play_scorer["goal_share"])
        # non_penalty_goal_share should.
        assert penalty_taker["non_penalty_goal_share"] < open_play_scorer["non_penalty_goal_share"]
        assert penalty_taker["non_penalty_goal_share"] == pytest.approx(0.0)

    def test_penalty_attempts_below_the_reliability_threshold_are_zeroed(self):
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 1, penalties_scored=1 if i < MIN_PENALTY_ATTEMPTS else 0) for i in range(5)],
                *[_appearance(1, 101, i, 90, 1, penalties_scored=1 if i < 1 else 0) for i in range(5)],  # only 1 attempt
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        reliable_taker = shares[shares["player_id"] == 100].iloc[0]
        unreliable_taker = shares[shares["player_id"] == 101].iloc[0]

        assert reliable_taker["penalty_attempts"] > 0
        assert unreliable_taker["penalty_attempts"] == 0

    def test_penalty_attempts_counts_misses_too(self):
        appearances = pd.DataFrame(
            [_appearance(1, 100, i, 90, 0, penalties_scored=0, penalties_missed=1 if i < MIN_PENALTY_ATTEMPTS else 0) for i in range(5)]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        player = shares[shares["player_id"] == 100].iloc[0]
        assert player["penalty_attempts"] > 0

    def test_penalty_goal_fraction_reflects_the_teams_own_share_of_goals_from_penalties(self):
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 1, penalties_scored=1) for i in range(5)],  # 5 penalty goals
                *[_appearance(1, 101, i, 90, 1) for i in range(5)],  # 5 open-play goals
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        # 5 of the team's 10 total goals came from penalties.
        assert shares["penalty_goal_fraction"].iloc[0] == pytest.approx(0.5, abs=0.01)
        # Same value on every row for that team.
        assert shares["penalty_goal_fraction"].nunique() == 1


class TestComputePrimaryPenaltyTaker:
    def test_identifies_the_player_with_the_most_penalty_attempts(self):
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 1, penalties_scored=1 if i < 4 else 0) for i in range(5)],  # 4 attempts
                *[_appearance(1, 101, i, 90, 1, penalties_scored=1 if i < 2 else 0) for i in range(5)],  # 2 attempts
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        assert compute_primary_penalty_taker(1, shares) == 100

    def test_attempts_count_more_than_conversion_rate(self):
        # 100: 3 attempts, only 1 scored (poor conversion). 101: 2 attempts,
        # both scored (perfect conversion). 100 should still win -- he's
        # the one actually getting picked to take them.
        appearances = pd.DataFrame(
            [
                *[
                    _appearance(1, 100, i, 90, 1, penalties_scored=1 if i == 0 else 0, penalties_missed=1 if 0 < i < 3 else 0)
                    for i in range(5)
                ],
                *[_appearance(1, 101, i, 90, 1, penalties_scored=1 if i < 2 else 0) for i in range(5)],
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        assert compute_primary_penalty_taker(1, shares) == 100

    def test_returns_none_when_no_one_clears_the_reliability_threshold(self):
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 1, penalties_scored=1 if i == 0 else 0) for i in range(5)],  # 1 attempt only
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        assert compute_primary_penalty_taker(1, shares) is None

    def test_returns_none_for_a_team_with_no_data(self):
        appearances = pd.DataFrame([_appearance(1, 100, i, 90, 1) for i in range(5)])
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        assert compute_primary_penalty_taker(999, shares) is None


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

    def _mixed_squad_shares(self):
        # A team's top scorer (id 9), who's usually a nailed-on 90-minute
        # starter but occasionally only a bench cameo, plus a rarely-used
        # fringe player (id 77) who still clears MIN_PLAYER_MATCHES and has
        # a small but nonzero goal_share of his own.
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 9, i, 90, 2, is_starting=True) for i in range(8)],
                *[_appearance(1, 9, i + 8, 15, 0, is_starting=False) for i in range(2)],
                *[_appearance(1, 77, i, 20, 1 if i == 0 else 0, is_starting=False) for i in range(10)],
            ]
        )
        return compute_player_shares(appearances, AS_OF, half_life_days=180)

    def test_no_confirmed_squad_uses_blended_minutes_share_for_everyone(self):
        shares = self._mixed_squad_shares()
        predictions = allocate_team_goals(team_expected_goals=2.0, team_id=1, player_shares=shares)
        by_player = {p.player_id: p for p in predictions}
        assert set(by_player) == {9, 77}

    def test_player_confirmed_out_of_the_squad_is_omitted(self):
        shares = self._mixed_squad_shares()
        # Only 77 is confirmed in the squad -- 9 (the top scorer) is
        # confirmed OUT entirely, and shouldn't appear at all.
        predictions = allocate_team_goals(
            team_expected_goals=2.0, team_id=1, player_shares=shares, confirmed_squad={77}, confirmed_starting=set()
        )
        assert {p.player_id for p in predictions} == {77}

    def test_confirmed_starting_uses_the_higher_starting_minutes_average(self):
        shares = self._mixed_squad_shares()
        no_confirmation = {p.player_id: p for p in allocate_team_goals(2.0, 1, shares)}
        confirmed_starting = {
            p.player_id: p
            for p in allocate_team_goals(2.0, 1, shares, confirmed_squad={9, 77}, confirmed_starting={9})
        }
        # Confirmed starting uses avg_minutes_when_starting (higher than the
        # season-blended minutes_share, since he's usually a starter but
        # this pulls in his occasional bench cameos too) -- expected_goals
        # should go up relative to the no-confirmation baseline.
        assert confirmed_starting[9].expected_goals > no_confirmation[9].expected_goals

    def test_confirmed_benched_uses_the_lower_bench_minutes_average(self):
        shares = self._mixed_squad_shares()
        no_confirmation = {p.player_id: p for p in allocate_team_goals(2.0, 1, shares)}
        confirmed_benched = {
            p.player_id: p
            for p in allocate_team_goals(2.0, 1, shares, confirmed_squad={9, 77}, confirmed_starting=set())
        }
        # Confirmed on the bench (not starting) uses the much lower
        # avg_minutes_when_benched -- the whole point of this feature, so a
        # team's biggest scorer doesn't top that fixture's odds on a
        # confirmed 15-minute cameo.
        assert confirmed_benched[9].expected_goals < no_confirmation[9].expected_goals

    def test_falls_back_to_blended_minutes_share_when_role_has_no_data(self):
        # 77 has never once started -- avg_minutes_when_starting is NaN for
        # him, so confirming him as a (surprise) starter should fall back
        # to his blended minutes_share rather than producing a NaN lambda.
        shares = self._mixed_squad_shares()
        predictions = {
            p.player_id: p
            for p in allocate_team_goals(2.0, 1, shares, confirmed_squad={9, 77}, confirmed_starting={9, 77})
        }
        assert predictions[77].expected_goals > 0
        assert not pd.isna(predictions[77].expected_goals)


class TestAllocateTeamGoalsPenalties:
    def _shares_with_a_penalty_taker(self):
        # Team's designated taker (100): 5 penalty goals (half his 10
        # total) plus open-play scoring. Teammate (101): pure open-play,
        # never taken a penalty.
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 2, penalties_scored=1) for i in range(5)],  # 5 goals, all penalties
                *[_appearance(1, 101, i, 90, 1) for i in range(5)],  # 5 open-play goals
            ]
        )
        return compute_player_shares(appearances, AS_OF, half_life_days=180)

    def test_primary_taker_gets_a_boost_beyond_his_open_play_share(self):
        shares = self._shares_with_a_penalty_taker()
        predictions = {p.player_id: p for p in allocate_team_goals(2.0, 1, shares)}
        # 100's non_penalty_goal_share is 0 (all his goals were penalties),
        # so without the penalty carve-out he'd get nothing -- the boost is
        # the only thing giving him any expected goals at all here.
        assert predictions[100].expected_goals > 0

    def test_penalty_carve_out_does_not_change_the_teams_total_expected_goals(self):
        shares = self._shares_with_a_penalty_taker()
        predictions = allocate_team_goals(2.0, 1, shares)
        # goal_share (not non_penalty_goal_share) sums to 1 across the
        # team, and the penalty carve-out plus open-play split together
        # should still roughly conserve the team's total expected goals --
        # a sanity bound, not an exact identity (same reasoning as the
        # pre-existing combined-share conservation test above).
        assert sum(p.expected_goals for p in predictions) <= 2.0 + 1e-9

    def test_non_taker_teammates_no_longer_get_credit_for_his_penalties(self):
        shares = self._shares_with_a_penalty_taker()
        predictions = {p.player_id: p for p in allocate_team_goals(2.0, 1, shares)}
        # 101 is pure open-play and should be allocated from the (smaller,
        # after the penalty carve-out) open-play pool only -- still > 0,
        # but shouldn't be inflated by 100's penalty goals.
        assert 0 < predictions[101].expected_goals < 2.0

    def test_no_reliable_taker_leaves_team_expected_goals_whole(self):
        # No player here ever took a penalty -- compute_primary_penalty_taker
        # returns None, so allocation should behave exactly like the
        # pre-penalty-tracking version (full team_expected_goals via
        # non_penalty_goal_share, which equals goal_share when there are no
        # penalties at all).
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 2) for i in range(5)],
                *[_appearance(1, 101, i, 90, 1) for i in range(5)],
            ]
        )
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        predictions = {p.player_id: p for p in allocate_team_goals(2.0, 1, shares)}
        assert sum(p.expected_goals for p in predictions.values()) <= 2.0 + 1e-9
        assert predictions[100].expected_goals > predictions[101].expected_goals

    def test_taker_confirmed_out_of_the_squad_is_omitted_and_his_penalty_share_is_not_discarded(self):
        shares = self._shares_with_a_penalty_taker()
        # Only 101 confirmed in the squad -- 100 (the penalty taker) is out.
        predictions = {p.player_id: p for p in allocate_team_goals(2.0, 1, shares, confirmed_squad={101}, confirmed_starting={101})}
        assert set(predictions) == {101}
        # 101 should get the FULL team_expected_goals via his non-penalty
        # share (no carve-out, since there's no one left to attribute the
        # penalty share to) -- not just his usual smaller open-play slice.
        no_confirmation = {p.player_id: p for p in allocate_team_goals(2.0, 1, shares)}
        assert predictions[101].expected_goals > no_confirmation[101].expected_goals


class TestComputeTeamAvailability:
    def _shares(self):
        # A three-player reliable pool: a star (most of the scoring, highly
        # rated), a regular, and a low-rated squad option -- enough shape
        # to test "star missing, replaced by someone comparable" vs.
        # "star missing, replaced by someone clearly worse."
        appearances = pd.DataFrame(
            [
                *[_appearance(1, 100, i, 90, 2, rating=8.5) for i in range(10)],  # star
                *[_appearance(1, 101, i, 90, 1, rating=7.0) for i in range(10)],  # regular
                *[_appearance(1, 102, i, 90, 1, rating=6.8) for i in range(10)],  # comparable backup to the regular
                *[_appearance(1, 103, i, 90, 0, rating=5.5) for i in range(10)],  # weak fill-in option
            ]
        )
        return compute_player_shares(appearances, AS_OF, half_life_days=180)

    def test_no_confirmed_squad_means_no_adjustment(self):
        shares = self._shares()
        assert compute_team_availability(1, set(), shares) == 1.0

    def test_full_strength_confirmed_squad_means_no_adjustment(self):
        shares = self._shares()
        assert compute_team_availability(1, {100, 101, 102, 103}, shares) == 1.0

    def test_team_with_no_reliable_players_on_record_defaults_to_no_adjustment(self):
        shares = self._shares()
        assert compute_team_availability(999, {1, 2, 3}, shares) == 1.0

    def test_missing_star_with_only_weak_replacements_lowers_availability(self):
        shares = self._shares()
        # Star (100) missing; confirmed squad is the two weakest-rated players.
        availability = compute_team_availability(1, {102, 103}, shares)
        assert availability < 1.0

    def test_missing_low_share_player_has_less_impact_than_missing_the_star(self):
        shares = self._shares()
        missing_weak_fill_in = compute_team_availability(1, {100, 101, 102}, shares)
        missing_star = compute_team_availability(1, {101, 102, 103}, shares)
        assert missing_weak_fill_in > missing_star

    def test_availability_never_drops_below_zero(self):
        # Every reliable player missing, confirmed squad is empty player
        # IDs -- treated as "no confirmed squad" per the empty-set guard,
        # so use a confirmed squad of players with no rating data instead
        # to exercise the full-loss, zero-compensation path.
        appearances = pd.DataFrame([_appearance(1, 100, i, 90, 5, rating=9.0) for i in range(10)])
        shares = compute_player_shares(appearances, AS_OF, half_life_days=180)
        availability = compute_team_availability(1, {999}, shares)
        assert 0.0 <= availability <= 1.0


class TestAllocationNormalization:
    """
    The ~24% leak and its fix. Two causes, both arithmetic:
    goal_share is normalised before the MIN_PLAYER_MATCHES filter drops
    fringe players, and a per-90 RATE share is then multiplied by a
    minutes share (< 1), discounting a second time.

    See app.goal_scorer.NORMALIZE_ALLOCATION. These tests pin both the
    shipped behaviour and the candidate, because until the backtest says
    which is closer to reality both have to keep working.
    """

    @staticmethod
    def _shares():
        # Four reliable squad players plus one fringe player who will be
        # filtered out -- the fringe player is what makes goal_share sum
        # to less than 1 across the survivors.
        appearances = []
        for day in range(12):
            appearances.append(_appearance(1, 100, day, 90, 1 if day % 2 == 0 else 0, rating=7.2))
            appearances.append(_appearance(1, 101, day, 90, 1 if day % 4 == 0 else 0, rating=7.0))
            appearances.append(_appearance(1, 102, day, 45, 1 if day % 6 == 0 else 0, rating=6.8, is_starting=False))
            appearances.append(_appearance(1, 103, day, 20, 0, rating=6.5, is_starting=False))
        for day in range(2):  # below MIN_PLAYER_MATCHES, dropped after normalising
            appearances.append(_appearance(1, 104, day, 90, 2, rating=7.5))
        return compute_player_shares(pd.DataFrame(appearances), AS_OF, half_life_days=180)

    def test_shipped_allocation_leaks(self):
        shares = self._shares()
        allocated = sum(p.expected_goals for p in allocate_team_goals(2.0, 1, shares, normalize_shares=False))
        assert allocated < 2.0 * 0.95, f"expected a visible shortfall, allocated {allocated:.3f} of 2.0"

    def test_normalized_allocation_conserves_the_team_total(self):
        shares = self._shares()
        allocated = sum(p.expected_goals for p in allocate_team_goals(2.0, 1, shares, normalize_shares=True))
        assert allocated == pytest.approx(2.0)

    def test_normalization_preserves_the_ranking(self):
        # It is a monotone rescale, so it must not reorder anybody -- this
        # is why AUC in the backtest cannot distinguish the two settings
        # and calibration is the number that decides it.
        shares = self._shares()
        shipped = allocate_team_goals(2.0, 1, shares, normalize_shares=False)
        normalized = allocate_team_goals(2.0, 1, shares, normalize_shares=True)
        order = lambda ps: [p.player_id for p in sorted(ps, key=lambda p: -p.expected_goals)]  # noqa: E731
        assert order(shipped) == order(normalized)

    def test_a_missing_player_has_his_share_absorbed(self):
        # Under the shipped behaviour a confirmed-out player's share simply
        # vanishes. Normalising hands it to whoever is actually playing,
        # which is right: compute_team_availability has already reduced the
        # team's expected goals for his absence, so what remains really is
        # going to be scored by someone on the pitch.
        shares = self._shares()
        squad = {101, 102, 103}  # 100, the top scorer, is out
        without_top = allocate_team_goals(
            2.0, 1, shares, confirmed_squad=squad, confirmed_starting=squad, normalize_shares=True
        )
        assert sum(p.expected_goals for p in without_top) == pytest.approx(2.0)

    def test_no_division_by_zero_when_nobody_has_a_scoring_history(self):
        appearances = [_appearance(1, 200, day, 90, 0, rating=6.5) for day in range(8)]
        shares = compute_player_shares(pd.DataFrame(appearances), AS_OF, half_life_days=180)
        predictions = allocate_team_goals(1.5, 1, shares, normalize_shares=True)
        assert all(p.expected_goals == 0 for p in predictions)
        assert all(p.prob_scores == 0 for p in predictions)

    def test_penalties_are_added_on_top_of_the_normalized_open_play(self):
        # The penalty portion is carved out before normalisation and handed
        # to one player whole. If it were swept into the normalised pool the
        # taker would lose most of it to his team-mates.
        appearances = []
        for day in range(10):
            appearances.append(
                _appearance(1, 100, day, 90, 1, rating=7.2, penalties_scored=1 if day < 4 else 0)
            )
            appearances.append(_appearance(1, 101, day, 90, 1 if day % 3 == 0 else 0, rating=7.0))
        shares = compute_player_shares(pd.DataFrame(appearances), AS_OF, half_life_days=180)
        allocated = sum(p.expected_goals for p in allocate_team_goals(2.0, 1, shares, normalize_shares=True))
        assert allocated == pytest.approx(2.0), "open play + penalties must still add back to the team total"
