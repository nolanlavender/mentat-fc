from datetime import date

import pandas as pd
import pytest

from app.dixon_coles import DixonColesModel, _tau, time_weight


class TestTimeWeight:
    def test_same_day_is_full_weight(self):
        d = date(2026, 1, 1)
        assert time_weight(d, d, half_life_days=180) == pytest.approx(1.0)

    def test_one_half_life_ago_is_half_weight(self):
        as_of = date(2026, 7, 1)
        match_date = date(2026, 1, 2)  # 180 days before as_of
        assert time_weight(match_date, as_of, half_life_days=180) == pytest.approx(0.5, abs=1e-3)

    def test_a_match_date_after_as_of_is_still_full_weight(self):
        # days_ago is clamped to >= 0 rather than going negative -- a match
        # "in the future" relative to as_of shouldn't count as *more*
        # relevant than one today.
        as_of = date(2026, 1, 1)
        future_match = date(2026, 2, 1)
        assert time_weight(future_match, as_of, half_life_days=180) == pytest.approx(1.0)


class TestTau:
    def test_perturbs_only_the_four_low_score_cells(self):
        lh, la, rho = 1.4, 1.1, -0.05
        assert _tau(0, 0, lh, la, rho) != 1.0
        assert _tau(0, 1, lh, la, rho) != 1.0
        assert _tau(1, 0, lh, la, rho) != 1.0
        assert _tau(1, 1, lh, la, rho) != 1.0
        # Anything outside those four scorelines is untouched.
        assert _tau(2, 0, lh, la, rho) == 1.0
        assert _tau(0, 2, lh, la, rho) == 1.0
        assert _tau(2, 2, lh, la, rho) == 1.0

    def test_zero_rho_means_no_adjustment_anywhere(self):
        for hg, ag in [(0, 0), (0, 1), (1, 0), (1, 1)]:
            assert _tau(hg, ag, 1.3, 1.1, rho=0.0) == pytest.approx(1.0)


def _round_robin_matches() -> pd.DataFrame:
    """Strong generally outscores Weak, but with real match-to-match
    variance (some low-scoring games, some high-scoring, a draw or two) --
    not a perfectly rigid, identical scoreline every time. A perfectly
    deterministic dataset is a genuine degenerate case for a Poisson MLE
    fit: with zero variance to explain, rho is unconstrained and the
    optimizer can drive it to a value that makes tau produce a negative
    "probability" cell -- a real numerical edge case, not something to
    paper over by only ever testing with tidy, unrealistic data."""
    strong_home = [3, 2, 4, 1, 2, 3, 1, 2, 3, 2, 1, 4, 2, 3, 2]
    weak_away = [1, 0, 1, 1, 1, 0, 0, 2, 1, 0, 0, 2, 1, 2, 0]
    weak_home = [0, 1, 0, 1, 2, 0, 1, 0, 1, 0, 2, 0, 1, 0, 1]
    strong_away = [2, 3, 1, 2, 3, 2, 1, 3, 2, 1, 2, 2, 3, 1, 2]

    d = date(2026, 1, 1)
    rows = [
        {"kickoff_date": d, "home_team": "Strong", "away_team": "Weak", "home_score": sh, "away_score": wa}
        for sh, wa in zip(strong_home, weak_away)
    ]
    rows += [
        {"kickoff_date": d, "home_team": "Weak", "away_team": "Strong", "home_score": wh, "away_score": sa}
        for wh, sa in zip(weak_home, strong_away)
    ]
    return pd.DataFrame(rows)


class TestDixonColesModel:
    def test_a_clearly_stronger_team_is_predicted_to_win_more_often(self):
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)

        pred = model.predict("Strong", "Weak")
        assert pred.prob_home_win > pred.prob_away_win
        assert pred.prob_home_win > 0.5

    def test_probabilities_form_a_valid_distribution(self):
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)

        pred = model.predict("Strong", "Weak")
        total = pred.prob_home_win + pred.prob_draw + pred.prob_away_win
        assert total == pytest.approx(1.0, abs=1e-6)
        assert pred.prob_home_win >= 0
        assert pred.prob_draw >= 0
        assert pred.prob_away_win >= 0

    def test_predicting_a_team_outside_the_training_data_raises(self):
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)

        with pytest.raises(ValueError):
            model.predict("Strong", "NeverSeenBefore")


def _league_with_a_newcomer() -> pd.DataFrame:
    """The established Strong/Weak round-robin, plus one extra team
    (Newcomer) with a SINGLE match on record -- a lopsided win, mirroring
    a newly-promoted/relegated side's real situation (see
    docs/learning-log.md's 2026-08-20 West Ham entry: exactly one
    Championship match on record, and that alone was enough to fit an
    extreme attack rating with no shrinkage in place). 5-2, not a
    shutout: a single match with 0 goals conceded is a genuine Poisson
    MLE degenerate case of its own (the away-goals term has no interior
    maximum, so the optimizer can drive that side's defense parameter
    toward an arbitrarily extreme value bounded only by its convergence
    tolerance) -- a real, separate pathology from the "sparse data lets a
    lopsided result dominate" one this test is actually after, so it's
    avoided here rather than conflating the two."""
    matches = _round_robin_matches()
    newcomer_row = pd.DataFrame(
        [{"kickoff_date": date(2026, 1, 1), "home_team": "Newcomer", "away_team": "Weak", "home_score": 5, "away_score": 2}]
    )
    return pd.concat([matches, newcomer_row], ignore_index=True)


class TestFitShrinkage:
    def test_default_shrinkage_of_zero_matches_omitting_the_argument(self):
        with_default = DixonColesModel()
        with_default.fit(_round_robin_matches(), half_life_days=180)

        with_explicit_zero = DixonColesModel()
        with_explicit_zero.fit(_round_robin_matches(), half_life_days=180, shrinkage=0.0)

        assert with_default.attack == pytest.approx(with_explicit_zero.attack)
        assert with_default.defense == pytest.approx(with_explicit_zero.defense)

    def test_shrinkage_pulls_a_sparse_data_team_toward_league_average(self):
        matches = _league_with_a_newcomer()

        unshrunk = DixonColesModel()
        unshrunk.fit(matches, half_life_days=180, shrinkage=0.0)

        shrunk = DixonColesModel()
        shrunk.fit(matches, half_life_days=180, shrinkage=0.1)

        # Newcomer's single 6-0 win pushes its unshrunk attack well above
        # league average (1.0) -- shrinkage should pull it measurably
        # closer to 1.0 without needing any per-team logic to know
        # Newcomer only has one match.
        assert abs(shrunk.attack["Newcomer"] - 1.0) < abs(unshrunk.attack["Newcomer"] - 1.0)

    def test_shrinkage_barely_moves_a_team_with_plenty_of_real_evidence(self):
        matches = _league_with_a_newcomer()

        unshrunk = DixonColesModel()
        unshrunk.fit(matches, half_life_days=180, shrinkage=0.0)

        shrunk = DixonColesModel()
        shrunk.fit(matches, half_life_days=180, shrinkage=0.1)

        # Strong has 15 real matches backing its rating -- the same
        # shrinkage strength that meaningfully pulls Newcomer's single-match
        # rating toward average should barely touch Strong's, since its
        # likelihood gradient dominates the fixed-size penalty.
        assert unshrunk.attack["Strong"] == pytest.approx(shrunk.attack["Strong"], rel=0.1)

    def test_probabilities_still_form_a_valid_distribution_with_shrinkage(self):
        model = DixonColesModel()
        model.fit(_league_with_a_newcomer(), half_life_days=180, shrinkage=0.1)

        pred = model.predict("Newcomer", "Weak")
        total = pred.prob_home_win + pred.prob_draw + pred.prob_away_win
        assert total == pytest.approx(1.0, abs=1e-6)


class TestPredictWithAvailability:
    def test_default_availability_of_one_matches_plain_predict(self):
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)

        plain = model.predict("Strong", "Weak")
        adjusted = model.predict_with_availability("Strong", "Weak")

        assert adjusted == plain

    def test_lowering_home_availability_lowers_home_expected_goals_and_win_probability(self):
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)

        plain = model.predict("Strong", "Weak")
        adjusted = model.predict_with_availability("Strong", "Weak", home_availability=0.5)

        assert adjusted.predicted_home_goals == pytest.approx(plain.predicted_home_goals * 0.5)
        assert adjusted.predicted_away_goals == pytest.approx(plain.predicted_away_goals)
        assert adjusted.prob_home_win < plain.prob_home_win

    def test_lowering_away_availability_lowers_away_expected_goals_and_win_probability(self):
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)

        plain = model.predict("Strong", "Weak")
        adjusted = model.predict_with_availability("Strong", "Weak", away_availability=0.5)

        assert adjusted.predicted_away_goals == pytest.approx(plain.predicted_away_goals * 0.5)
        assert adjusted.predicted_home_goals == pytest.approx(plain.predicted_home_goals)
        assert adjusted.prob_away_win < plain.prob_away_win

    def test_probabilities_still_form_a_valid_distribution_when_adjusted(self):
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)

        adjusted = model.predict_with_availability("Strong", "Weak", home_availability=0.6, away_availability=0.8)
        total = adjusted.prob_home_win + adjusted.prob_draw + adjusted.prob_away_win
        assert total == pytest.approx(1.0, abs=1e-6)

    def test_predicting_a_team_outside_the_training_data_raises(self):
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)

        with pytest.raises(ValueError):
            model.predict_with_availability("Strong", "NeverSeenBefore")
