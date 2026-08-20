from datetime import date

import pandas as pd
import pytest

from app.goal_scorer import MIN_PLAYER_MATCHES, allocate_team_goals, compute_player_shares, compute_team_availability

AS_OF = date(2026, 8, 1)


def _appearance(team_id, player_id, day, minutes, goals, rating=None, is_starting=True):
    return {
        "team_id": team_id,
        "player_id": player_id,
        "kickoff_date": date(2026, 1, 1 + day),
        "minutes_played": minutes,
        "goals": goals,
        "rating": rating,
        "is_starting": is_starting,
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
            pd.DataFrame(columns=["team_id", "player_id", "kickoff_date", "minutes_played", "goals", "rating", "is_starting"]), AS_OF
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
