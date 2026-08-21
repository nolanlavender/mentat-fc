import numpy as np
import pytest

from app.compare import BOOTSTRAP_SAMPLES, CANDIDATE_WEIGHTS, CONFIDENCE, _bootstrap_ci


class TestBootstrapCi:
    """
    These exist because app.compare had NO tests, and a refactor deleted
    BOOTSTRAP_SAMPLES while an `import app.compare` smoke check still
    passed -- the name is only referenced inside a function body, so
    importing the module never touches it. The failure surfaced only when
    a real workflow run against production crashed partway through.
    Importing a module proves almost nothing about whether it runs.
    """

    def test_executes_and_returns_an_ordered_interval(self):
        # The regression: this call is what NameError'd in production.
        low, high = _bootstrap_ci(np.random.default_rng(0).normal(0, 0.4, 200))
        assert low < high

    def test_pure_noise_interval_spans_zero(self):
        # The property the whole tool rests on -- no true effect must not
        # produce a verdict.
        low, high = _bootstrap_ci(np.random.default_rng(1).normal(0, 0.4, 400))
        assert low <= 0 <= high

    def test_a_real_effect_is_detected(self):
        low, high = _bootstrap_ci(np.random.default_rng(1).normal(-0.05, 0.4, 400))
        assert high < 0, "a genuine improvement should exclude zero"

    def test_an_all_zero_difference_collapses_to_zero(self):
        # A control (a configuration that changes nothing) must report
        # exactly zero rather than a spurious interval.
        low, high = _bootstrap_ci(np.zeros(100))
        assert low == 0.0 and high == 0.0

    def test_configuration_constants_are_sane(self):
        assert BOOTSTRAP_SAMPLES >= 1000, "too few resamples to trust a percentile interval"
        assert 0 < CONFIDENCE < 100
        assert CANDIDATE_WEIGHTS, "a sweep with no candidates would silently do nothing"
        assert all(0 < w <= 1 for w in CANDIDATE_WEIGHTS)
