import numpy as np
import pandas as pd
import pytest

from app.compare import (
    BOOTSTRAP_SAMPLES,
    CANDIDATE_WEIGHTS,
    CONFIDENCE,
    FOLD_FRACTION,
    FOLDS,
    _bootstrap_ci,
    _fold_frames,
    walk_forward_folds,
)


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
        # 0 is now a legitimate candidate: it asks whether the deployed
        # promotion should be reverted.
        assert all(0 <= w <= 1 for w in CANDIDATE_WEIGHTS)


class TestWalkForwardFolds:
    """
    The fold construction the whole walk-forward upgrade rests on. Wrong
    boundaries fail silently -- overlap double-counts matches into the
    bootstrap, and an index-based split can leak a same-day fixture into
    its twin's training set.
    """

    @staticmethod
    def _matches(n=200):
        from datetime import date, timedelta

        return pd.DataFrame({
            "kickoff_date": [date(2026, 1, 1) + timedelta(days=i) for i in range(n)],
            "fixture_id": range(n),
        })

    def test_windows_are_chronological_and_disjoint(self):
        folds = walk_forward_folds(self._matches())
        for (start_a, end_a), (start_b, _) in zip(folds, folds[1:]):
            assert end_a == start_b, "consecutive windows must share exactly a boundary"
            assert start_a < start_b

    def test_training_data_always_precedes_the_window(self):
        matches = self._matches()
        for start, end in walk_forward_folds(matches):
            train, test = _fold_frames(matches, start, end)
            assert train["kickoff_date"].max() < test["kickoff_date"].min()

    def test_every_held_out_match_is_scored_exactly_once(self):
        matches = self._matches()
        folds = walk_forward_folds(matches)
        seen: list[int] = []
        for start, end in folds:
            _, test = _fold_frames(matches, start, end)
            seen.extend(test["fixture_id"].tolist())
        assert len(seen) == len(set(seen)), "a match in two windows would be double-counted by the bootstrap"
        assert len(seen) == pytest.approx(len(matches) * FOLDS * FOLD_FRACTION, abs=FOLDS)

    def test_same_day_fixtures_never_straddle_the_boundary(self):
        # Two fixtures on one date: either both in a window or neither.
        from datetime import date

        matches = pd.DataFrame({
            "kickoff_date": [date(2026, 1, 1 + i // 2) for i in range(40)],
            "fixture_id": range(40),
        })
        for start, end in walk_forward_folds(matches):
            train, test = _fold_frames(matches, start, end)
            assert set(train["kickoff_date"]) & set(test["kickoff_date"]) == set()

    def test_degenerate_data_collapses_rather_than_overlaps(self):
        # All matches on one date: no valid window shape exists; the
        # helper must not return overlapping or empty windows.
        from datetime import date

        matches = pd.DataFrame({"kickoff_date": [date(2026, 1, 1)] * 30, "fixture_id": range(30)})
        folds = walk_forward_folds(matches)
        assert len(folds) <= 1
