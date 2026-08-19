import pandas as pd
import pytest

from app.data import blend_xg_into_scores


def _match(home_score, away_score, home_xg, away_xg):
    return {"home_score": home_score, "away_score": away_score, "home_xg": home_xg, "away_xg": away_xg}


class TestBlendXgIntoScores:
    def test_zero_weight_leaves_scores_completely_unchanged(self):
        matches = pd.DataFrame([_match(2, 1, 0.8, 2.4)])
        blended = blend_xg_into_scores(matches, xg_weight=0.0)
        assert blended["home_score"].iloc[0] == pytest.approx(2)
        assert blended["away_score"].iloc[0] == pytest.approx(1)

    def test_full_weight_uses_pure_xg(self):
        matches = pd.DataFrame([_match(2, 1, 0.8, 2.4)])
        blended = blend_xg_into_scores(matches, xg_weight=1.0)
        assert blended["home_score"].iloc[0] == pytest.approx(0.8)
        assert blended["away_score"].iloc[0] == pytest.approx(2.4)

    def test_partial_weight_interpolates(self):
        matches = pd.DataFrame([_match(2, 1, 0.8, 2.4)])
        blended = blend_xg_into_scores(matches, xg_weight=0.5)
        assert blended["home_score"].iloc[0] == pytest.approx(0.5 * 2 + 0.5 * 0.8)
        assert blended["away_score"].iloc[0] == pytest.approx(0.5 * 1 + 0.5 * 2.4)

    def test_missing_xg_falls_back_to_the_real_score_untouched(self):
        # Real production shape: xG coverage isn't complete (older fixtures,
        # lower-tier competitions) -- a match with no xG on one or both
        # sides should never have its actual score altered or dropped.
        matches = pd.DataFrame([_match(3, 0, None, None)])
        blended = blend_xg_into_scores(matches, xg_weight=1.0)
        assert blended["home_score"].iloc[0] == pytest.approx(3)
        assert blended["away_score"].iloc[0] == pytest.approx(0)

    def test_one_side_missing_xg_blends_only_the_side_that_has_it(self):
        matches = pd.DataFrame([_match(1, 1, 1.5, None)])
        blended = blend_xg_into_scores(matches, xg_weight=1.0)
        assert blended["home_score"].iloc[0] == pytest.approx(1.5)
        assert blended["away_score"].iloc[0] == pytest.approx(1)  # no away xG -- untouched

    def test_does_not_mutate_the_input_dataframe(self):
        matches = pd.DataFrame([_match(2, 1, 0.8, 2.4)])
        blend_xg_into_scores(matches, xg_weight=1.0)
        assert matches["home_score"].iloc[0] == 2
        assert matches["away_score"].iloc[0] == 1

    def test_multiple_rows_blended_independently(self):
        matches = pd.DataFrame(
            [
                _match(2, 1, 0.8, 2.4),
                _match(0, 0, None, None),
                _match(1, 3, 1.9, 2.1),
            ]
        )
        blended = blend_xg_into_scores(matches, xg_weight=1.0)
        assert blended["home_score"].tolist() == pytest.approx([0.8, 0, 1.9])
        assert blended["away_score"].tolist() == pytest.approx([2.4, 0, 2.1])
