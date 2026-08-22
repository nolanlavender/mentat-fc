import os
from datetime import datetime, timedelta, timezone

import pandas as pd
import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused/for-import-only")

import app.diagnose_lineups as module  # noqa: E402

NOW = datetime(2026, 8, 21, 18, 30, tzinfo=timezone.utc)


def _fixture(**overrides):
    row = {
        "fixture_id": 1,
        "competition_name": "Premier League",
        "home_team": "Arsenal",
        "away_team": "Coventry City",
        "kickoff_at": NOW + timedelta(hours=1),
        "status": "scheduled",
        "external_api_football_id": 12345,
        "checked_at": NOW,
        "hours_until_kickoff": 1.0,
        "lineup_rows": 0,
        "starters": 0,
        "predicted_at": None,
        "scorer_picks": 0,
    }
    row.update(overrides)
    return row


def _run(monkeypatch, capsys, rows, argv=("app.diagnose_lineups",)):
    class _FakeConnection:
        def close(self):
            pass

    monkeypatch.setattr(module, "get_connection", lambda: _FakeConnection())
    # params defaults because report_capture_rate's first query takes none.
    def _query(conn, query, params=None):
        if "min(pre_match_captured_at)" in query:
            return pd.DataFrame([{"first_capture": None}])
        return pd.DataFrame(rows)

    monkeypatch.setattr(module, "_query_df", _query)
    monkeypatch.setattr(module.sys, "argv", list(argv))
    module.main()
    return capsys.readouterr().out


class TestStateClassification:
    """
    The whole value of this diagnostic is telling four situations apart
    that all look identical in the workflow log. If the classification is
    wrong it is worse than useless -- it sends you to fix the wrong thing
    with confidence.
    """

    def test_outside_the_window_is_not_reported_as_broken(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [_fixture(hours_until_kickoff=20.0)])
        assert "STATE 1" in out
        assert "never looked up" in out
        assert "becomes eligible 17.0h from now" in out

    def test_in_window_with_nothing_published_is_normal(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [_fixture(hours_until_kickoff=1.0)])
        assert "STATE 2" in out
        assert "Nothing is broken" in out

    def test_recently_kicked_off_still_counts_as_in_window(self, monkeypatch, capsys):
        # The lookback half of the window -- a fixture that started an hour
        # ago is still checked, and must not be reported as "never looked up".
        out = _run(monkeypatch, capsys, [_fixture(hours_until_kickoff=-1.0)])
        assert "STATE 2" in out
        assert "1.0h ago" in out

    def test_captured_lineup_with_stale_predictions(self, monkeypatch, capsys):
        # More scorer picks than players in the squad can only happen when
        # allocate_team_goals ran without the confirmed squad.
        out = _run(
            monkeypatch,
            capsys,
            [_fixture(lineup_rows=20, starters=11, predicted_at=NOW - timedelta(hours=6), scorer_picks=42)],
        )
        assert "STATE 3" in out
        assert "Re-run app.train" in out

    def test_captured_lineup_that_was_applied(self, monkeypatch, capsys):
        out = _run(
            monkeypatch,
            capsys,
            [_fixture(lineup_rows=20, starters=11, predicted_at=NOW, scorer_picks=14)],
        )
        assert "STATE 4" in out
        assert "API or the frontend" in out

    def test_captured_lineup_with_no_prediction_at_all(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [_fixture(lineup_rows=20, starters=11, predicted_at=None)])
        assert "STATE 3" in out
        assert "NO prediction at all" in out

    def test_missing_external_id_is_called_out_as_unlookupable(self, monkeypatch, capsys):
        # No external id means the lineup check can never find it, however
        # many times you run the workflow. Distinct from every other state.
        out = _run(monkeypatch, capsys, [_fixture(external_api_football_id=None, hours_until_kickoff=1.0)])
        assert "BLOCKED" in out
        assert "STATE" not in out


class TestFraming:
    def test_empty_input_is_not_reported_as_a_filter(self, monkeypatch, capsys):
        # The workflow always passes an argument; an unfilled optional
        # input arrives as "". It must not claim to be matching ''.
        out = _run(monkeypatch, capsys, [_fixture()], argv=("app.diagnose_lineups", ""))
        assert "matching ''" not in out

    def test_a_real_filter_is_echoed(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [_fixture()], argv=("app.diagnose_lineups", "Arsenal"))
        assert "matching 'Arsenal'" in out

    def test_no_rows_explains_itself(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [])
        assert "Nothing in range" in out

    def test_the_printed_window_matches_the_constants(self, monkeypatch, capsys):
        # These are hand-synced with api-football.ts. Printing them is the
        # only protection against them silently diverging, so the printed
        # values have to be the ones actually used.
        out = _run(monkeypatch, capsys, [_fixture()])
        assert f"now -{module.MATCHDAY_LOOKBACK_HOURS}h to now +{module.MATCHDAY_LOOKAHEAD_HOURS}h" in out


class TestCaptureRateReport:
    """
    The retrospective answer to "is pre-match capture working?".

    Exists because the raw 40/57,316 from the goal-scorer backtest cannot
    distinguish failure from not-yet-measured: pre_match_captured_at only
    exists since migration 1701000000027, so every earlier row is NULL by
    construction. Reading that as "capture is broken" would repeat the
    matchday log's original sin -- a number that looks like evidence and
    is not.
    """

    @staticmethod
    def _run(monkeypatch, capsys, first_capture, fixture_rows):
        class _FakeConnection:
            def close(self):
                pass

        calls = {"n": 0}

        def _query(conn, query, params=None):
            calls["n"] += 1
            if "min(pre_match_captured_at)" in query:
                return pd.DataFrame([{"first_capture": first_capture}])
            return pd.DataFrame(fixture_rows)

        monkeypatch.setattr(module, "_query_df", _query)
        module.report_capture_rate(_FakeConnection())
        return capsys.readouterr().out

    @staticmethod
    def _fixture(lead_minutes, captured=True, name="Arsenal"):
        return {
            "fixture_id": 1, "home_team": name, "away_team": "Coventry",
            "kickoff_at": NOW,
            "captured_at": NOW - timedelta(minutes=lead_minutes) if captured else None,
            "lead_minutes": lead_minutes if captured else None,
        }

    def test_never_captured_says_so_without_blaming_the_pipeline(self, monkeypatch, capsys):
        out = self._run(monkeypatch, capsys, None, [])
        assert "No lineup has EVER been captured pre-match" in out
        assert "before concluding" in out

    def test_column_live_but_nothing_kicked_off_is_not_a_failure(self, monkeypatch, capsys):
        out = self._run(monkeypatch, capsys, NOW, [])
        assert "Nothing to measure yet" in out
        assert "not a failure" in out

    def test_reports_a_rate_and_lead_time(self, monkeypatch, capsys):
        rows = [self._fixture(75), self._fixture(60), self._fixture(45)]
        out = self._run(monkeypatch, capsys, NOW, rows)
        assert "3 were captured pre-match (100%)" in out
        assert "median 60 min" in out

    def test_a_tiny_sample_is_flagged_rather_than_dressed_as_a_percentage(self, monkeypatch, capsys):
        out = self._run(monkeypatch, capsys, NOW, [self._fixture(60)])
        assert "far too small" in out

    def test_a_late_median_recommends_a_faster_cadence(self, monkeypatch, capsys):
        # The number that decides whether the hourly cron is the problem:
        # lineups publish ~60 min out, so catching them at ~10 min means we
        # are sampling too slowly, not that the data is missing.
        rows = [self._fixture(12), self._fixture(8), self._fixture(15),
                self._fixture(6), self._fixture(11)]
        out = self._run(monkeypatch, capsys, NOW, rows)
        assert "faster check cadence" in out

    def test_a_healthy_lead_does_not_recommend_anything(self, monkeypatch, capsys):
        rows = [self._fixture(75), self._fixture(65), self._fixture(80),
                self._fixture(70), self._fixture(60)]
        out = self._run(monkeypatch, capsys, NOW, rows)
        assert "faster check cadence" not in out

    def test_uncaptured_fixtures_are_listed_not_hidden(self, monkeypatch, capsys):
        rows = [self._fixture(60), self._fixture(0, captured=False, name="Leeds")]
        out = self._run(monkeypatch, capsys, NOW, rows)
        assert "1 were captured pre-match (50%)" in out
        assert "Leeds" in out and "NOT captured pre-match" in out
