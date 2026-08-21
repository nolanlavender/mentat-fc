import numpy as np
import pandas as pd
import pytest

from app.evaluate import _outcome_one_hot, brier_score, log_loss


class TestOutcomeOneHot:
    def test_home_win(self):
        assert _outcome_one_hot(2, 1) == [1, 0, 0]

    def test_draw(self):
        assert _outcome_one_hot(1, 1) == [0, 1, 0]

    def test_away_win(self):
        assert _outcome_one_hot(0, 2) == [0, 0, 1]


class TestBrierScore:
    def test_perfect_prediction_scores_zero(self):
        probs = np.array([[1.0, 0.0, 0.0]])
        outcomes = np.array([[1, 0, 0]])
        assert brier_score(probs, outcomes) == pytest.approx(0.0)

    def test_maximally_wrong_prediction_scores_two(self):
        # Predicting the away win with certainty when home actually won:
        # sum((1-0)^2 + (0-0)^2 + (0-1)^2) = 2, the worst possible Brier
        # score for a 3-outcome one-hot target.
        probs = np.array([[0.0, 0.0, 1.0]])
        outcomes = np.array([[1, 0, 0]])
        assert brier_score(probs, outcomes) == pytest.approx(2.0)

    def test_uniform_guessing_baseline(self):
        probs = np.array([[1 / 3, 1 / 3, 1 / 3]])
        outcomes = np.array([[1, 0, 0]])
        # (1/3-1)^2 + (1/3)^2 + (1/3)^2 = 4/9 + 1/9 + 1/9 = 6/9
        assert brier_score(probs, outcomes) == pytest.approx(6 / 9)

    def test_averages_across_multiple_matches(self):
        probs = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
        outcomes = np.array([[1, 0, 0], [1, 0, 0]])  # one perfect, one maximally wrong
        assert brier_score(probs, outcomes) == pytest.approx((0.0 + 2.0) / 2)


class TestLogLoss:
    def test_confident_correct_prediction_scores_near_zero(self):
        probs = np.array([[0.99, 0.005, 0.005]])
        outcomes = np.array([[1, 0, 0]])
        assert log_loss(probs, outcomes) == pytest.approx(-np.log(0.99), abs=1e-6)

    def test_punishes_confident_wrong_predictions_harder_than_brier_does(self):
        # Same maximally-wrong case as Brier's test above, but log-loss
        # should be a much larger relative penalty (clipped near -log(eps))
        # than Brier's fixed cap of 2.0 -- that's the whole point of using
        # both metrics together.
        probs = np.array([[1e-15, 1e-15, 1.0 - 2e-15]])
        outcomes = np.array([[1, 0, 0]])
        assert log_loss(probs, outcomes) > 30  # -log(1e-15) ~= 34.5

    def test_clips_probabilities_away_from_exact_zero_to_avoid_log_of_zero(self):
        probs = np.array([[0.0, 0.0, 1.0]])
        outcomes = np.array([[1, 0, 0]])
        # Should not raise or return inf/nan.
        result = log_loss(probs, outcomes)
        assert np.isfinite(result)


class TestDeployedBlendConfiguration:
    """
    Executes app.train's and app.evaluate's real blend paths on a synthetic
    frame. Importing a module proves almost nothing about whether it runs
    (see tests/test_compare.py's note -- that lesson cost a production
    crash), and these two _blend helpers are the only code between a
    weights dict and what every model actually trains on.
    """

    @staticmethod
    def _frame():
        rng = np.random.default_rng(11)
        n = 200
        inside = rng.integers(2, 15, n).astype(float)
        outside = rng.integers(1, 11, n).astype(float)
        sot = (rng.binomial(inside.astype(int), 0.4) + rng.binomial(outside.astype(int), 0.25)).astype(float)
        return pd.DataFrame({
            "home_score": rng.poisson(sot * 0.22), "away_score": rng.poisson(sot * 0.18),
            "home_shots_inside_box": inside, "away_shots_inside_box": inside,
            "home_shots_outside_box": outside, "away_shots_outside_box": outside,
            "home_shots_on_target": sot, "away_shots_on_target": sot,
        })

    @pytest.mark.parametrize("competition", ["Premier League", "Championship", "FA Cup"])
    def test_both_modules_blend_every_competition_identically(self, competition):
        import app.evaluate as evaluate_module
        import app.train as train_module

        frame = self._frame()
        assert np.allclose(
            train_module._blend(frame, competition)["home_score"],
            evaluate_module._blend(frame, competition)["home_score"],
        ), "the sandbox and the deployed job must blend the same way for the backtest to mean anything"

    def test_the_two_weight_dicts_are_in_sync(self):
        # Hand-synced by design (see either constant's comment), which is
        # exactly why it needs a test rather than trust.
        import app.evaluate as evaluate_module
        import app.train as train_module

        assert train_module.SHOT_LOCATION_BLEND_WEIGHT == evaluate_module.SHOT_LOCATION_BLEND_WEIGHT
        assert train_module.SHOTS_ON_TARGET_BLEND_WEIGHT == evaluate_module.SHOTS_ON_TARGET_BLEND_WEIGHT
        assert train_module.SHRINKAGE == evaluate_module.SHRINKAGE
        assert train_module.HALF_LIFE_DAYS == evaluate_module.HALF_LIFE_DAYS
