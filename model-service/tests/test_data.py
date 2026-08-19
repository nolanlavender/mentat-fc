import pandas as pd
import pytest

from app.data import blend_shots_on_target_into_scores


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
