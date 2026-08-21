from datetime import date

import numpy as np
import pandas as pd
import pytest

from app.data import (
    blend_fitting_signals,
    blend_learned_shot_proxy_into_scores,
    blend_shot_proxies_with_fallback,
    blend_shots_on_target_into_scores,
    estimate_goal_weights,
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


class TestLearnedShotProxy:
    """
    The proxy learns goals-per-shot weights by regression rather than being
    told them, because the data never records WHICH shots became goals.
    These pin the properties that matter; the question of WHICH signals to
    use is settled in docs/learning-log.md (shots on target wins).
    """

    @staticmethod
    def _synthetic(n: int = 1200, seed: int = 11):
        rng = np.random.default_rng(seed)
        inside = rng.integers(2, 15, n)
        outside = rng.integers(1, 11, n)
        # On target is a SUBSET of total shots -- the structural fact that
        # makes shots-on-target strictly more informative than location.
        sot = rng.binomial(inside, 0.40) + rng.binomial(outside, 0.25)
        goals = rng.poisson(sot * 0.22)
        half = n // 2
        return pd.DataFrame({
            "home_score": goals[:half], "away_score": goals[half:],
            "home_shots_inside_box": inside[:half].astype(float), "away_shots_inside_box": inside[half:].astype(float),
            "home_shots_outside_box": outside[:half].astype(float), "away_shots_outside_box": outside[half:].astype(float),
            "home_shots_on_target": sot[:half].astype(float), "away_shots_on_target": sot[half:].astype(float),
        })

    def test_learns_a_positive_weight_for_a_real_signal(self):
        weights = estimate_goal_weights(self._synthetic(), ["shots_on_target"])
        # Truth is 0.22 goals per shot on target.
        assert 0.15 < weights["shots_on_target"] < 0.30

    def test_returns_none_without_enough_data(self):
        assert estimate_goal_weights(self._synthetic(n=20), ["shots_on_target"]) is None

    def test_returns_none_on_a_degenerate_design(self):
        matches = self._synthetic()
        # Two identical signals leave the system rank-deficient.
        matches["home_shots_outside_box"] = matches["home_shots_inside_box"]
        matches["away_shots_outside_box"] = matches["away_shots_inside_box"]
        assert estimate_goal_weights(matches, ["inside_box", "outside_box"]) is None

    def test_zero_weight_is_a_no_op(self):
        matches = self._synthetic()
        blended = blend_learned_shot_proxy_into_scores(matches, 0.0, ["shots_on_target"])
        assert np.allclose(blended["home_score"], matches["home_score"].astype(float))

    def test_blending_reduces_variance(self):
        matches = self._synthetic()
        blended = blend_learned_shot_proxy_into_scores(matches, 1.0, ["shots_on_target"])
        assert blended["home_score"].var() < matches["home_score"].astype(float).var()

    def test_missing_a_signal_keeps_the_real_score(self):
        matches = self._synthetic()
        matches.loc[:9, "home_shots_on_target"] = None
        blended = blend_learned_shot_proxy_into_scores(matches, 1.0, ["shots_on_target"])
        assert np.allclose(blended.loc[:9, "home_score"], matches.loc[:9, "home_score"].astype(float))
        assert not np.allclose(blended.loc[10:, "home_score"], matches.loc[10:, "home_score"].astype(float))


class TestProxyFallback:
    """
    Preferred proxy where its signals exist, fallback proxy everywhere
    else. Pinned because both failure modes here are silent and have both
    actually happened: a partial-coverage proxy leaving half the matches
    unsmoothed (which produced a confident wrong verdict on 2026-08-21),
    and the primary-weight-zero boundary stripping smoothing from exactly
    the best-covered rows.
    """

    @staticmethod
    def _partial(n: int = 800, seed: int = 5):
        rng = np.random.default_rng(seed)
        inside = rng.integers(2, 15, n)
        outside = rng.integers(1, 11, n)
        sot = rng.binomial(inside, 0.40) + rng.binomial(outside, 0.25)
        goals = rng.poisson(sot * 0.22)
        half = n // 2
        frame = pd.DataFrame({
            "home_score": goals[:half], "away_score": goals[half:],
            "home_shots_inside_box": inside[:half].astype(float), "away_shots_inside_box": inside[half:].astype(float),
            "home_shots_outside_box": outside[:half].astype(float), "away_shots_outside_box": outside[half:].astype(float),
            "home_shots_on_target": sot[:half].astype(float), "away_shots_on_target": sot[half:].astype(float),
        })
        frame.loc[: half * 2 // 5, ["home_shots_inside_box", "home_shots_outside_box"]] = None
        return frame

    def test_uncovered_rows_get_the_fallback_not_raw_goals(self):
        matches = self._partial()
        blended = blend_shot_proxies_with_fallback(matches, ["inside_box", "outside_box"], 0.5, ["shots_on_target"], 0.75)
        fallback_only = blend_learned_shot_proxy_into_scores(matches, 0.75, ["shots_on_target"])
        uncovered = matches["home_shots_inside_box"].isna()
        assert np.allclose(blended.loc[uncovered, "home_score"], fallback_only.loc[uncovered, "home_score"])
        assert not np.allclose(blended.loc[uncovered, "home_score"], matches.loc[uncovered, "home_score"].astype(float))

    def test_covered_rows_prefer_the_primary_proxy(self):
        matches = self._partial()
        blended = blend_shot_proxies_with_fallback(matches, ["inside_box", "outside_box"], 0.5, ["shots_on_target"], 0.75)
        fallback_only = blend_learned_shot_proxy_into_scores(matches, 0.75, ["shots_on_target"])
        covered = matches["home_shots_inside_box"].notna()
        assert not np.allclose(blended.loc[covered, "home_score"], fallback_only.loc[covered, "home_score"])

    def test_primary_weight_zero_equals_pure_fallback(self):
        # The boundary that broke: at weight 0 the primary blend returns the
        # ORIGINAL scores, so overriding covered rows with it would strip
        # the fallback's smoothing from the best-covered matches.
        matches = self._partial()
        blended = blend_shot_proxies_with_fallback(matches, ["inside_box", "outside_box"], 0.0, ["shots_on_target"], 0.75)
        fallback_only = blend_learned_shot_proxy_into_scores(matches, 0.75, ["shots_on_target"])
        assert np.allclose(blended["home_score"], fallback_only["home_score"])


class TestBlendFittingSignals:
    """
    The single entry point app.train and app.evaluate both fit through.
    What's pinned here is mostly the location_weight == 0 branch, which
    looks like a redundant special case and is not: the two paths rescale
    shots on target to goals by different methods, and only one of them
    has been backtested for the competitions that ship at 0.
    """

    def test_zero_location_weight_keeps_the_backtested_calibration(self):
        matches = TestProxyFallback._partial()
        assert np.allclose(
            blend_fitting_signals(matches, 0.0, 0.75)["home_score"],
            blend_shots_on_target_into_scores(matches, 0.75)["home_score"],
        )

    def test_zero_location_weight_is_not_the_least_squares_path(self):
        # If these ever coincided the branch would be dead code and the
        # comment explaining it would be wrong -- worth knowing.
        matches = TestProxyFallback._partial()
        assert not np.allclose(
            blend_fitting_signals(matches, 0.0, 0.75)["home_score"],
            blend_shot_proxies_with_fallback(matches, ["inside_box", "outside_box"], 0.0, ["shots_on_target"], 0.75)["home_score"],
        )

    def test_nonzero_location_weight_uses_location_with_fallback(self):
        matches = TestProxyFallback._partial()
        assert np.allclose(
            blend_fitting_signals(matches, 0.75, 0.5)["home_score"],
            blend_shot_proxies_with_fallback(matches, ["inside_box", "outside_box"], 0.75, ["shots_on_target"], 0.5)["home_score"],
        )

    def test_location_actually_changes_covered_rows(self):
        # Guards the whole promotion being a silent no-op -- the exact
        # failure the `xg` column had, where a feature looked wired up and
        # touched nothing.
        matches = TestProxyFallback._partial()
        covered = matches["home_shots_inside_box"].notna()
        assert not np.allclose(
            blend_fitting_signals(matches, 0.75, 0.75).loc[covered, "home_score"],
            blend_fitting_signals(matches, 0.0, 0.75).loc[covered, "home_score"],
        )
