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


def _two_division_prior() -> DixonColesModel:
    """
    A joint fit spanning a strong and a weak division, connected by cup
    ties -- the shape app.train's real joint model has, and the thing that
    makes a cross-division prior meaningful at all.
    """
    strong = ["Alpha", "Bravo", "Charlie"]
    weak = ["Xray", "Yankee", "Zulu"]
    rows = []
    for teams, home_goals, away_goals in ((strong, 3, 1), (weak, 1, 1)):
        for h in teams:
            for a in teams:
                if h != a:
                    rows.append({"kickoff_date": date(2026, 1, 1), "home_team": h, "away_team": a,
                                 "home_score": home_goals, "away_score": away_goals})
    # Cup ties: the strong division wins these, which is what puts both
    # divisions on one comparable scale.
    for h, a in zip(strong, weak):
        rows.append({"kickoff_date": date(2026, 2, 1), "home_team": h, "away_team": a,
                     "home_score": 4, "away_score": 0})
    model = DixonColesModel()
    model.fit(pd.DataFrame(rows), half_life_days=180, shrinkage=1.0)
    return model


class TestPriorShrinkage:
    def test_no_prior_is_unchanged(self):
        # Regression safety: the default path must be bit-for-bit what it
        # was before prior_model existed.
        without = DixonColesModel()
        without.fit(_round_robin_matches(), half_life_days=180, shrinkage=1.0)
        explicit_none = DixonColesModel()
        explicit_none.fit(_round_robin_matches(), half_life_days=180, shrinkage=1.0, prior_model=None)

        assert without.attack == pytest.approx(explicit_none.attack)
        assert without.defense == pytest.approx(explicit_none.defense)

    def test_a_relegated_team_keeps_its_pedigree_instead_of_collapsing_to_average(self):
        prior = _two_division_prior()
        # "Alpha" drops into the weak division and plays a single match there.
        weak_division = pd.DataFrame(
            [{"kickoff_date": date(2026, 3, 1), "home_team": h, "away_team": a, "home_score": 1, "away_score": 1}
             for h in ["Xray", "Yankee", "Zulu"] for a in ["Xray", "Yankee", "Zulu"] if h != a]
            + [{"kickoff_date": date(2026, 8, 1), "home_team": "Alpha", "away_team": "Xray",
                "home_score": 4, "away_score": 0}]
        )

        to_mean = DixonColesModel()
        to_mean.fit(weak_division, half_life_days=180, shrinkage=5.0)
        to_prior = DixonColesModel()
        to_prior.fit(weak_division, half_life_days=180, shrinkage=5.0, prior_model=prior)

        # Shrinking toward the league mean pulls Alpha to ~average; the
        # cross-division prior knows they are genuinely stronger than that.
        assert to_prior.attack["Alpha"] > to_mean.attack["Alpha"]
        assert to_prior.predict("Alpha", "Xray").prob_home_win > to_mean.predict("Alpha", "Xray").prob_home_win

    def test_a_team_absent_from_the_prior_falls_back_to_league_average(self):
        prior = _two_division_prior()
        matches = _round_robin_matches()  # "Strong"/"Weak" appear nowhere in the prior
        with_prior = DixonColesModel()
        with_prior.fit(matches, half_life_days=180, shrinkage=1.0, prior_model=prior)
        without = DixonColesModel()
        without.fit(matches, half_life_days=180, shrinkage=1.0)

        # No prior information for these teams, so the target stays 0 and
        # the result is identical to plain league-average shrinkage.
        assert with_prior.attack == pytest.approx(without.attack)

    def test_probabilities_stay_valid_with_a_prior(self):
        prior = _two_division_prior()
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180, shrinkage=1.0, prior_model=prior)
        pred = model.predict("Strong", "Weak")
        assert pred.prob_home_win + pred.prob_draw + pred.prob_away_win == pytest.approx(1.0, abs=1e-6)


class TestPathologicalRho:
    """
    predict() applies tau to four low-score cells, and tau goes negative for
    a large enough rho (it is 1 - rho at 1-1). fit()'s likelihood already
    clipped for this; predict() did not, so a negative cell survived
    normalization and the triangle sums could return a "probability"
    outside [0, 1] -- seen as a draw probability of -0.048 on a small,
    poorly-constrained fit. Real fits land near rho ~= 0.07, but the joint
    fit now backstops other competitions (see app.train), so this is
    pinned rather than left to well-behaved data.
    """

    def test_probabilities_stay_in_range_for_a_rho_that_makes_tau_negative(self):
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)
        model.rho = 5.0  # far past where tau at 1-1 (= 1 - rho) turns negative

        pred = model.predict("Strong", "Weak")
        for name, value in [
            ("home", pred.prob_home_win),
            ("draw", pred.prob_draw),
            ("away", pred.prob_away_win),
        ]:
            assert 0.0 <= value <= 1.0, f"{name} probability out of range: {value}"
        assert pred.prob_home_win + pred.prob_draw + pred.prob_away_win == pytest.approx(1.0, abs=1e-6)

    def test_a_normal_rho_is_left_alone_by_the_guard(self):
        # The guard must not disturb the ordinary case -- tau stays positive
        # for a realistic rho, so clamping at zero should be a no-op.
        model = DixonColesModel()
        model.fit(_round_robin_matches(), half_life_days=180)
        model.rho = 0.07

        pred = model.predict("Strong", "Weak")
        assert pred.prob_home_win > pred.prob_away_win
        assert pred.prob_home_win + pred.prob_draw + pred.prob_away_win == pytest.approx(1.0, abs=1e-6)


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


def _giant_league_and_joint() -> tuple[DixonColesModel, DixonColesModel]:
    """
    The Hull-vs-Man-U shape (real production bug, 2026-08-22): a top
    division containing a genuine giant, a second division whose best side
    is promoted into it with ZERO top-division matches, and a joint fit
    across both, connected by cup ties and flattened by FA-Cup-level
    shrinkage -- exactly what app.train's fallback has to work with.
    """
    top = ["Giant", "Alpha", "Bravo", "Charlie", "Delta", "Echo"]
    second = ["Promoted", "Xray", "Yankee", "Zulu", "Quebec", "Tango"]
    rows = []
    for round_number, (teams, strong) in enumerate(((top, "Giant"), (second, "Promoted"))):
        for h in teams:
            for a in teams:
                if h == a:
                    continue
                home_goals = 3 if h == strong else 1
                away_goals = 3 if a == strong else 1
                rows.append({"kickoff_date": date(2026, 1, 10 + round_number), "home_team": h,
                             "away_team": a, "home_score": home_goals, "away_score": away_goals})
    for h, a in zip(top, second):  # cup ties put the divisions on one scale
        rows.append({"kickoff_date": date(2026, 2, 1), "home_team": h, "away_team": a,
                     "home_score": 3, "away_score": 0})

    joint = DixonColesModel()
    joint.fit(pd.DataFrame(rows), half_life_days=180, shrinkage=10.0)

    top_only = DixonColesModel()
    top_only.fit(
        pd.DataFrame([r for r in rows if r["home_team"] in top and r["away_team"] in top]),
        half_life_days=180,
        shrinkage=1.0,
    )
    return top_only, joint


class TestImputeTeamFrom:
    def test_adds_the_missing_team_on_the_local_scale(self):
        top_only, joint = _giant_league_and_joint()
        assert "Promoted" not in top_only.attack
        top_only.impute_team_from("Promoted", joint)
        assert "Promoted" in top_only.attack
        assert "Promoted" in top_only.teams
        # The best side of a weaker division must not import as a top-flight
        # powerhouse: below the giant, on the top division's own scale.
        assert top_only.attack["Promoted"] < top_only.attack["Giant"]

    def test_the_giant_stays_favourite_against_a_promoted_home_side(self):
        # The regression itself. The old fallback predicted this fixture
        # entirely with the joint fit, whose flattened ratings and inflated
        # home advantage picked the promoted club at home over the giant.
        top_only, joint = _giant_league_and_joint()
        old_way = joint.predict("Promoted", "Giant")

        top_only.impute_team_from("Promoted", joint)
        new_way = top_only.predict("Promoted", "Giant")

        assert new_way.prob_away_win > old_way.prob_away_win, (
            "imputation should recover confidence in the established side"
        )
        assert new_way.prob_away_win > new_way.prob_home_win, (
            "a top-division giant away to a just-promoted side should be the favourite"
        )

    def test_translation_is_invariant_to_the_priors_ridge_position(self):
        # The prior's own scale is arbitrary along (attack+c, defense-c).
        # Sliding it must not change what gets imputed -- if it did, the
        # imputed rating would depend on an accident of centring.
        top_only_a, joint = _giant_league_and_joint()
        top_only_b = DixonColesModel()
        top_only_b.fit(
            pd.DataFrame([{"kickoff_date": date(2026, 1, 10), "home_team": h, "away_team": a,
                           "home_score": 3 if h == "Giant" else 1, "away_score": 3 if a == "Giant" else 1}
                          for h in ["Giant", "Alpha", "Bravo", "Charlie", "Delta", "Echo"]
                          for a in ["Giant", "Alpha", "Bravo", "Charlie", "Delta", "Echo"] if h != a]),
            half_life_days=180,
            shrinkage=1.0,
        )
        shifted = DixonColesModel(
            teams=joint.teams,
            attack={t: v * 2.0 for t, v in joint.attack.items()},
            defense={t: v / 2.0 for t, v in joint.defense.items()},
            home_advantage=joint.home_advantage,
            rho=joint.rho,
        )
        top_only_a.impute_team_from("Promoted", joint)
        top_only_b.impute_team_from("Promoted", shifted)
        assert top_only_a.attack["Promoted"] == pytest.approx(top_only_b.attack["Promoted"])
        assert top_only_a.defense["Promoted"] == pytest.approx(top_only_b.defense["Promoted"])

    def test_never_overwrites_a_fitted_rating(self):
        # A real rating estimated from this competition's own matches beats
        # a translated one -- imputing an existing team must be a no-op.
        top_only, joint = _giant_league_and_joint()
        before = top_only.attack["Giant"]
        top_only.impute_team_from("Giant", joint)
        assert top_only.attack["Giant"] == before

    def test_unknown_everywhere_still_raises(self):
        top_only, joint = _giant_league_and_joint()
        with pytest.raises(ValueError, match="prior model"):
            top_only.impute_team_from("Narnia", joint)


class TestImputeStrengthPenalty:
    def test_default_is_a_no_op(self):
        a, joint = _giant_league_and_joint()
        b, _ = _giant_league_and_joint()
        a.impute_team_from("Promoted", joint)
        b.impute_team_from("Promoted", joint, strength_penalty=1.0)
        assert a.attack["Promoted"] == pytest.approx(b.attack["Promoted"])
        assert a.defense["Promoted"] == pytest.approx(b.defense["Promoted"])

    def test_a_penalty_genuinely_weakens_not_just_recentres(self):
        # attack down AND defense up is deliberately the opposite shape
        # from the (attack+c, defense-c) ridge the model is invariant to.
        # If a penalty were accidentally implemented as a ridge move, the
        # predictions would not change at all and the knob would be dead.
        plain, joint = _giant_league_and_joint()
        penalised, _ = _giant_league_and_joint()
        plain.impute_team_from("Promoted", joint)
        penalised.impute_team_from("Promoted", joint, strength_penalty=0.8)

        p_plain = plain.predict("Promoted", "Giant")
        p_penalised = penalised.predict("Promoted", "Giant")
        assert p_penalised.prob_home_win < p_plain.prob_home_win
        assert p_penalised.predicted_home_goals < p_plain.predicted_home_goals
        assert p_penalised.predicted_away_goals > p_plain.predicted_away_goals

    def test_rejects_a_nonpositive_penalty(self):
        top_only, joint = _giant_league_and_joint()
        with pytest.raises(ValueError, match="positive"):
            top_only.impute_team_from("Promoted", joint, strength_penalty=0.0)
