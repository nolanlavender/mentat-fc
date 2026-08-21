from datetime import date

import numpy as np
import pandas as pd
import pytest

from app.data import (
    blend_goal_proxies_into_scores,
    blend_shot_location_into_scores,
    blend_shots_on_target_into_scores,
    estimate_shot_location_conversion,
)


def _match(home_score, away_score, home_sot, away_sot):
    return {
        "home_score": home_score,
        "away_score": away_score,
        "home_shots_on_target": home_sot,
        "away_shots_on_target": away_sot,
    }


class TestBlendShotsOnTargetIntoScores:
    def test_zero_weight_leaves_scores_completely_unchanged(self):
        matches = pd.DataFrame([_match(2, 1, 6, 3)])
        blended = blend_shots_on_target_into_scores(matches, blend_weight=0.0)
        assert blended["home_score"].iloc[0] == pytest.approx(2)
        assert blended["away_score"].iloc[0] == pytest.approx(1)

    def test_full_weight_rescales_shots_on_target_to_the_conversion_rate(self):
        # Two matches, so the pooled conversion rate is derivable by hand:
        # total goals (2+1+0+3=6) / total shots on target (6+3+2+9=20) = 0.3.
        matches = pd.DataFrame([_match(2, 1, 6, 3), _match(0, 3, 2, 9)])
        blended = blend_shots_on_target_into_scores(matches, blend_weight=1.0)
        conversion_rate = 6 / 20
        assert blended["home_score"].iloc[0] == pytest.approx(6 * conversion_rate)
        assert blended["away_score"].iloc[0] == pytest.approx(3 * conversion_rate)
        assert blended["home_score"].iloc[1] == pytest.approx(2 * conversion_rate)
        assert blended["away_score"].iloc[1] == pytest.approx(9 * conversion_rate)

    def test_partial_weight_interpolates(self):
        matches = pd.DataFrame([_match(2, 1, 6, 3), _match(0, 3, 2, 9)])
        conversion_rate = 6 / 20
        blended = blend_shots_on_target_into_scores(matches, blend_weight=0.5)
        assert blended["home_score"].iloc[0] == pytest.approx(0.5 * 2 + 0.5 * 6 * conversion_rate)
        assert blended["away_score"].iloc[1] == pytest.approx(0.5 * 3 + 0.5 * 9 * conversion_rate)

    def test_missing_shots_on_target_falls_back_to_the_real_score_untouched(self):
        # Real production shape: a match with no shots-on-target data (no
        # CSV coverage for that competition/season) should never have its
        # actual score altered.
        matches = pd.DataFrame([_match(2, 1, 6, 3), _match(3, 0, None, None)])
        blended = blend_shots_on_target_into_scores(matches, blend_weight=1.0)
        assert blended["home_score"].iloc[1] == pytest.approx(3)
        assert blended["away_score"].iloc[1] == pytest.approx(0)

    def test_one_side_missing_shots_on_target_blends_only_the_side_that_has_it(self):
        matches = pd.DataFrame([_match(2, 1, 6, 3), _match(1, 1, 4, None)])
        blended = blend_shots_on_target_into_scores(matches, blend_weight=1.0)
        # away side of the second match has no shots-on-target -- untouched.
        assert blended["away_score"].iloc[1] == pytest.approx(1)
        # home side does -- rescaled, not left at the raw shot count.
        assert blended["home_score"].iloc[1] != pytest.approx(4)

    def test_no_rows_with_shots_on_target_is_a_complete_no_op(self):
        # No conversion rate can be derived at all -- must not divide by
        # zero or invent a rate, just leave everything as the real score.
        matches = pd.DataFrame([_match(2, 1, None, None), _match(0, 0, None, None)])
        blended = blend_shots_on_target_into_scores(matches, blend_weight=1.0)
        assert blended["home_score"].tolist() == pytest.approx([2, 0])
        assert blended["away_score"].tolist() == pytest.approx([1, 0])

    def test_does_not_mutate_the_input_dataframe(self):
        matches = pd.DataFrame([_match(2, 1, 6, 3)])
        blend_shots_on_target_into_scores(matches, blend_weight=1.0)
        assert matches["home_score"].iloc[0] == 2
        assert matches["away_score"].iloc[0] == 1


class TestShotLocationBlend:
    """
    The shot-location proxy learns per-location conversion rates from the
    data rather than being told them (see
    app.data.estimate_shot_location_conversion). These pin the properties
    that actually matter: the rates are recovered from known data, the
    combination is what's reliable, and partial coverage never invents a
    value for a match that has none.
    """

    @staticmethod
    def _synthetic(rate_inside: float, rate_outside: float, seed: int = 7, n: int = 600):
        rng = np.random.default_rng(seed)
        inside = rng.integers(2, 14, n)
        outside = rng.integers(1, 10, n)
        goals = rng.poisson(inside * rate_inside + outside * rate_outside)
        half = n // 2
        return pd.DataFrame({
            "kickoff_date": [date(2026, 1, 1)] * half,
            "home_score": goals[:half], "away_score": goals[half:],
            "home_shots_inside_box": inside[:half], "away_shots_inside_box": inside[half:],
            "home_shots_outside_box": outside[:half], "away_shots_outside_box": outside[half:],
        })

    def test_recovers_known_conversion_rates(self):
        matches = self._synthetic(0.13, 0.035)
        rate_inside, rate_outside = estimate_shot_location_conversion(matches)
        # Generous tolerances on purpose: the point is that it lands in the
        # right region and gets the ORDERING right, not that a noisy
        # coefficient hits a decimal place (see the function's own note).
        assert 0.09 < rate_inside < 0.17
        assert 0.0 <= rate_outside < 0.08
        assert rate_inside > rate_outside, "an inside-box shot must be worth more than one from distance"

    def test_returns_none_without_enough_data(self):
        assert estimate_shot_location_conversion(self._synthetic(0.13, 0.035, n=20)) is None

    def test_returns_none_when_the_design_is_degenerate(self):
        # Every shot from inside, none from outside -- the second rate is
        # simply not estimable, and inventing one would be worse than
        # declining to blend.
        matches = self._synthetic(0.13, 0.035)
        matches["home_shots_outside_box"] = 0
        matches["away_shots_outside_box"] = 0
        assert estimate_shot_location_conversion(matches) is None

    def test_zero_weight_is_a_no_op(self):
        matches = self._synthetic(0.13, 0.035)
        blended = blend_shot_location_into_scores(matches, 0.0)
        assert (blended["home_score"] == matches["home_score"].astype(float)).all()

    def test_full_weight_is_smoother_than_real_goals(self):
        # The entire reason to blend a proxy in: it should carry the same
        # average signal with less match-to-match noise than the goal count.
        matches = self._synthetic(0.13, 0.035)
        blended = blend_shot_location_into_scores(matches, 1.0)
        assert blended["home_score"].var() < matches["home_score"].astype(float).var()
        assert blended["home_score"].mean() == pytest.approx(matches["home_score"].mean(), abs=0.15)

    def test_missing_location_keeps_the_real_score(self):
        matches = self._synthetic(0.13, 0.035)
        matches.loc[:9, "home_shots_inside_box"] = None
        blended = blend_shot_location_into_scores(matches, 1.0)
        assert (blended.loc[:9, "home_score"] == matches.loc[:9, "home_score"].astype(float)).all()
        # ...while rows that DO have coverage still get blended.
        assert not (blended.loc[10:, "home_score"] == matches.loc[10:, "home_score"].astype(float)).all()


class TestCombinedGoalProxies:
    """
    Precedence: shot location where available, shots on target where not,
    real score where neither. Pinned because getting this wrong is silent
    -- a real 2026-08-21 comparison ran the location blend over a frame
    with ~48% coverage and left the other half on raw unsmoothed goals,
    then reported a confident verdict that was partly measuring coverage.
    """

    @staticmethod
    def _partial_coverage(n: int = 400):
        rng = np.random.default_rng(3)
        inside = rng.integers(2, 14, n).astype(float)
        outside = rng.integers(1, 10, n).astype(float)
        sot = rng.integers(1, 12, n)
        goals = rng.poisson(inside * 0.13 + outside * 0.035)
        half = n // 2
        frame = pd.DataFrame({
            "home_score": goals[:half], "away_score": goals[half:],
            "home_shots_on_target": sot[:half], "away_shots_on_target": sot[half:],
            "home_shots_inside_box": inside[:half], "away_shots_inside_box": inside[half:],
            "home_shots_outside_box": outside[:half], "away_shots_outside_box": outside[half:],
        })
        # Half the rows have no location data at all.
        frame.loc[: half // 2, ["home_shots_inside_box", "home_shots_outside_box"]] = None
        return frame

    def test_rows_without_location_still_get_shots_on_target(self):
        # THE regression test: uncovered rows must not silently fall back
        # to raw goals when the location weight is on.
        matches = self._partial_coverage()
        blended = blend_goal_proxies_into_scores(matches, shots_on_target_weight=0.75, shot_location_weight=1.0)
        uncovered = matches["home_shots_inside_box"].isna()
        assert not np.allclose(blended.loc[uncovered, "home_score"], matches.loc[uncovered, "home_score"].astype(float))

    def test_rows_with_location_use_the_location_proxy(self):
        matches = self._partial_coverage()
        both = blend_goal_proxies_into_scores(matches, shots_on_target_weight=0.75, shot_location_weight=1.0)
        sot_only = blend_goal_proxies_into_scores(matches, shots_on_target_weight=0.75, shot_location_weight=0.0)
        covered = matches["home_shots_inside_box"].notna()
        # Location takes precedence, so covered rows must differ from the
        # shots-on-target-only result.
        assert not np.allclose(both.loc[covered, "home_score"], sot_only.loc[covered, "home_score"])

    def test_both_weights_zero_is_an_exact_no_op(self):
        matches = self._partial_coverage()
        blended = blend_goal_proxies_into_scores(matches, 0.0, 0.0)
        assert np.allclose(blended["home_score"], matches["home_score"].astype(float))

    def test_blending_reduces_variance(self):
        matches = self._partial_coverage()
        blended = blend_goal_proxies_into_scores(matches, 0.75, 1.0)
        assert blended["home_score"].var() < matches["home_score"].astype(float).var()
