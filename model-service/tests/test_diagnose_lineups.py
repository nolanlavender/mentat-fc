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
    monkeypatch.setattr(module, "_query_df", lambda conn, query, params: pd.DataFrame(rows))
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
