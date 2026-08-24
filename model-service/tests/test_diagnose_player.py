"""
The diagnostic exists to tell three failure modes apart that all look
identical from the app -- a stale current_team_id, a verified departure,
and a split identity. If it labels them wrongly it is worse than nothing,
because it sends you to fix the wrong link with confidence. These tests
are about the labelling, not the formatting.
"""

import os

import pandas as pd
import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused/for-import-only")

import app.diagnose_player as module  # noqa: E402


def _row(**overrides):
    row = {
        "player_id": 1,
        "full_name": "Alexander Isak",
        "current_team_id": None,
        "current_team_name": None,
        "last_appearance_team_id": 10.0,
        "last_appearance_team_name": "Newcastle United",
        "last_appearance_date": "2026-08-16",
        "last_club_roster_synced_at": None,
        "appearances": 30,
        "external_ids": "api_football=1234",
    }
    row.update(overrides)
    return next(pd.DataFrame([row]).itertuples())


def _run(monkeypatch, capsys, rows, argv=("app.diagnose_player", "Isak")):
    class _FakeConnection:
        def close(self):
            pass

    monkeypatch.setattr(module, "get_connection", lambda: _FakeConnection())
    monkeypatch.setattr(module, "_query_df", lambda conn, query, params: pd.DataFrame(rows))
    monkeypatch.setattr(module.sys, "argv", list(argv))
    module.main()
    return capsys.readouterr().out


class TestClubResolution:
    def test_a_set_current_team_id_wins(self):
        club, why = module.resolve_club(
            _row(current_team_id=20.0, current_team_name="Liverpool", last_club_roster_synced_at=None)
        )
        assert club == "Liverpool"
        assert "current_team_id" in why

    def test_a_set_current_team_id_wins_even_against_a_verified_old_club(self):
        # The ordering matters: a player who moved between two tracked
        # clubs has BOTH a new current_team_id and a verified old roster.
        # Checking the roster first would drop him instead of moving him.
        club, _ = module.resolve_club(
            _row(current_team_id=20.0, current_team_name="Liverpool", last_club_roster_synced_at="2026-08-22")
        )
        assert club == "Liverpool"

    def test_no_club_plus_a_verified_roster_means_departed(self):
        club, why = module.resolve_club(_row(current_team_id=None, last_club_roster_synced_at="2026-08-22"))
        assert club is None
        assert "departed" in why

    def test_no_club_plus_an_unverified_roster_falls_back_to_appearances(self):
        club, why = module.resolve_club(_row(current_team_id=None, last_club_roster_synced_at=None))
        assert club == "Newcastle United"
        assert "never verified" in why

    def test_no_appearances_means_no_pool_regardless_of_club(self):
        club, why = module.resolve_club(
            _row(last_appearance_team_id=None, last_appearance_team_name=None,
                 current_team_id=20.0, current_team_name="Liverpool", appearances=0)
        )
        assert club is None
        assert "never reaches the pool" in why


class TestOutput:
    def test_it_names_the_club_the_model_will_use(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [dict(_row(current_team_id=20.0, current_team_name="Liverpool")._asdict())])
        assert "Liverpool" in out
        assert "1 player row(s)" in out

    def test_a_thin_appearance_record_is_called_out(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [dict(_row(appearances=1)._asdict())])
        assert f"below {module.MIN_PLAYER_MATCHES}" in out

    def test_a_healthy_record_is_not_called_out(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [dict(_row(appearances=30)._asdict())])
        assert "below" not in out

    def test_two_matching_rows_raise_the_split_identity_possibility(self, monkeypatch, capsys):
        # The case that motivated the whole module: a transfer between two
        # tracked clubs inserts a second player row instead of moving the
        # first, and each row then resolves correctly on its own -- so no
        # amount of staring at club resolution finds it.
        out = _run(monkeypatch, capsys, [
            dict(_row(player_id=1, current_team_id=None, last_appearance_team_name="Newcastle United")._asdict()),
            dict(_row(player_id=2, appearances=0, last_appearance_team_id=None,
                      last_appearance_team_name=None, current_team_id=20.0,
                      current_team_name="Liverpool")._asdict()),
        ])
        assert "MORE THAN ONE ROW" in out
        assert "2 player row(s)" in out

    def test_one_row_does_not_raise_it(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [dict(_row()._asdict())])
        assert "MORE THAN ONE ROW" not in out

    def test_no_match_says_so_rather_than_printing_an_empty_chain(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, [])
        assert "No player matching 'Isak'" in out

    @pytest.mark.parametrize("argv", [("app.diagnose_player",), ("app.diagnose_player", "   ")])
    def test_a_missing_name_prints_usage_instead_of_scanning_every_player(self, monkeypatch, capsys, argv):
        # ILIKE '%%' matches the entire players table. Printing a chain for
        # each of several thousand players is not a useful default.
        monkeypatch.setattr(module, "get_connection", _unreachable)
        monkeypatch.setattr(module.sys, "argv", list(argv))
        module.main()
        assert "Usage:" in capsys.readouterr().out


def _unreachable():
    raise AssertionError("must not open a connection without a name to search for")
