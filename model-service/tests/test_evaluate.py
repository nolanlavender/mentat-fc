import numpy as np
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
