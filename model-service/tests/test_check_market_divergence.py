import os
from datetime import datetime, timezone

import pandas as pd
import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused/for-import-only")

import app.check_market_divergence as module  # noqa: E402
from app.check_market_divergence import devig, flag, market_consensus  # noqa: E402


class TestDevig:
    def test_removes_the_overround(self):
        probs = devig(2.0, 3.4, 4.2)
        assert sum(probs) == pytest.approx(1.0)

    def test_preserves_ordering(self):
        home, draw, away = devig(1.5, 4.0, 7.0)
        assert home > draw > away

    def test_a_fair_book_is_unchanged(self):
        # Prices whose implied probabilities already sum to 1 (no margin)
        # must pass through untouched.
        home, draw, away = devig(2.0, 4.0, 4.0)
        assert (home, draw, away) == pytest.approx((0.5, 0.25, 0.25))


class TestMarketConsensus:
    @staticmethod
    def _odds(rows):
        return pd.DataFrame(rows, columns=["bookmaker", "outcome", "price"])

    def test_averages_across_bookmakers(self):
        odds = self._odds([
            ("A", "home", 2.0), ("A", "draw", 4.0), ("A", "away", 4.0),
            ("B", "home", 2.2), ("B", "draw", 3.8), ("B", "away", 3.6),
        ])
        consensus = market_consensus(odds)
        assert consensus is not None
        assert sum(consensus) == pytest.approx(1.0)

    def test_a_bookmaker_missing_an_outcome_is_dropped_entirely(self):
        # Partially counting a two-outcome book would de-vig against an
        # invisible margin. B has no away price, so only A counts.
        odds = self._odds([
            ("A", "home", 2.0), ("A", "draw", 4.0), ("A", "away", 4.0),
            ("B", "home", 1.1), ("B", "draw", 1.1),
        ])
        assert market_consensus(odds) == pytest.approx(devig(2.0, 4.0, 4.0))

    def test_no_complete_bookmaker_means_no_consensus(self):
        odds = self._odds([("A", "home", 2.0), ("A", "draw", 4.0)])
        assert market_consensus(odds) is None


class TestFlag:
    def test_reports_the_largest_gap(self):
        assert flag((0.6, 0.2, 0.2), (0.4, 0.3, 0.3)) == pytest.approx(0.2)

    def test_agreement_is_zero(self):
        assert flag((0.5, 0.3, 0.2), (0.5, 0.3, 0.2)) == 0.0


class TestMainEndToEnd:
    """
    Runs main() against a fake loader -- the alerting path especially must
    be executable without a database, because a checker that crashes in
    production fails the workflow for the wrong reason and teaches the
    reader to ignore red runs (see the app.compare NameError story).
    """

    KICKOFF = datetime(2026, 8, 23, 15, 0, tzinfo=timezone.utc)

    def _run(self, monkeypatch, capsys, rows):
        class _FakeConnection:
            def close(self):
                pass

        monkeypatch.setattr(module, "get_connection", lambda: _FakeConnection())
        monkeypatch.setattr(module, "_query_df", lambda conn, query, params: pd.DataFrame(rows))
        code = module.main()
        return code, capsys.readouterr().out

    def _row(self, **overrides):
        row = {
            "fixture_id": 1, "home_team": "Hull", "away_team": "ManU",
            "kickoff_at": self.KICKOFF, "competition_name": "Premier League",
            "prob_home_win": 0.5, "prob_draw": 0.25, "prob_away_win": 0.25,
            "bookmaker": "A", "outcome": "home", "price": 2.0,
        }
        row.update(overrides)
        return row

    def _fixture_rows(self, model, prices, fixture_id=1):
        return [
            self._row(fixture_id=fixture_id, prob_home_win=model[0], prob_draw=model[1], prob_away_win=model[2],
                      outcome=outcome, price=price)
            for outcome, price in zip(("home", "draw", "away"), prices)
        ]

    def test_the_hull_case_trips_the_alarm(self, monkeypatch, capsys):
        # Model says the promoted side wins; the market says 1.30 the
        # giant. This is the exact class of bug the check exists for, and
        # a nonzero exit is the alert.
        rows = self._fixture_rows(model=(0.45, 0.25, 0.30), prices=(9.0, 5.5, 1.30))
        code, out = self._run(monkeypatch, capsys, rows)
        assert code == 1
        assert "diverge" in out
        assert "Hull vs ManU" in out

    def test_agreement_exits_clean(self, monkeypatch, capsys):
        rows = self._fixture_rows(model=(0.48, 0.26, 0.26), prices=(2.0, 3.7, 3.7))
        code, out = self._run(monkeypatch, capsys, rows)
        assert code == 0
        assert "No fixture diverges" in out

    def test_missing_prediction_is_counted_not_flagged(self, monkeypatch, capsys):
        rows = [self._row(prob_home_win=None, prob_draw=None, prob_away_win=None)]
        code, out = self._run(monkeypatch, capsys, rows)
        assert code == 0
        assert "1 had no prediction" in out

    def test_mostly_blind_run_says_so(self, monkeypatch, capsys):
        # Two fixtures skipped, none compared: the output must warn that
        # green here does not mean checked.
        rows = [
            self._row(fixture_id=1, prob_home_win=None, prob_draw=None, prob_away_win=None),
            self._row(fixture_id=2, bookmaker=None, outcome=None, price=None),
        ]
        code, out = self._run(monkeypatch, capsys, rows)
        assert code == 0
        assert "blind" in out

    def test_empty_window_is_fine(self, monkeypatch, capsys):
        code, out = self._run(monkeypatch, capsys, [])
        assert code == 0
        assert "nothing to check" in out.lower()
