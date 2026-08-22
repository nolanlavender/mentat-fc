"""
Execute every read query against a REAL, migrated Postgres schema.

Why this file exists, specifically. app.estimate_promotion_penalty shipped
with SQL that referenced `home_stats.shots_on_target` without the LEFT JOIN
that defines `home_stats` -- copied from load_finished_matches' SELECT list
but not its FROM clause. It passed code review, passed CI, passed a
nine-test suite including an end-to-end run of main(), and then failed on
its first production run with "missing FROM-clause entry for table
home_stats". The end-to-end test monkeypatched the loader, so the query
never executed anywhere except production.

That is the same shape as the app.compare NameError two days earlier: a
module that can only be exercised against the production database is
untested by default, and every unit test around it provides false comfort.
The rest of the suite deliberately avoids needing a database, which is
right for logic -- but it means nothing at all validates that the SQL
matches the schema.

These tests close that gap by executing each query against a database
built from the actual migrations. The tables are empty, and that is fine:
an empty result proves the SQL is valid, the tables and columns exist, and
the joins resolve -- which is exactly the class of bug that keeps reaching
production. Assertions on the returned COLUMNS also pin the contract each
caller depends on.

Skipped entirely unless SMOKE_DATABASE_URL is set, so the normal local and
CI runs stay database-free. The `database` CI job sets it (see
.github/workflows/ci.yml) after running the migrations.
"""

from __future__ import annotations

import os
from datetime import date

import pytest

SMOKE_DATABASE_URL = os.environ.get("SMOKE_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not SMOKE_DATABASE_URL,
    reason="SMOKE_DATABASE_URL not set -- these need a migrated Postgres (see the CI 'database' job)",
)

COMPETITIONS = ["Premier League", "Championship", "FA Cup"]


@pytest.fixture
def conn():
    import psycopg

    with psycopg.connect(SMOKE_DATABASE_URL) as connection:
        yield connection


class TestDataLoaders:
    def test_load_finished_matches(self, conn):
        from app.data import load_finished_matches

        frame = load_finished_matches(conn, COMPETITIONS)
        for column in (
            "fixture_id", "kickoff_date", "competition_name",
            "home_team", "away_team", "home_score", "away_score",
            "home_shots_on_target", "away_shots_on_target",
            "home_shots_inside_box", "away_shots_outside_box",
        ):
            assert column in frame.columns

    def test_load_upcoming_fixtures(self, conn):
        from app.data import load_upcoming_fixtures

        frame = load_upcoming_fixtures(conn, "Premier League")
        assert {"fixture_id", "home_team_id", "away_team", "kickoff_date"} <= set(frame.columns)

    def test_load_fixture_player_goals(self, conn):
        from app.data import load_fixture_player_goals

        frame = load_fixture_player_goals(conn, COMPETITIONS)
        assert {"fixture_id", "team_id", "player_id", "kickoff_date", "goals"} <= set(frame.columns)

    def test_load_player_squad_appearances(self, conn):
        from app.data import load_player_squad_appearances

        frame = load_player_squad_appearances(conn, COMPETITIONS)
        assert {"team_id", "player_id", "kickoff_date", "minutes_played", "goals", "is_starting"} <= set(frame.columns)

    def test_load_player_squad_appearances_with_a_cutoff(self, conn):
        # The as_of branch takes a different path through the CTE (and
        # switches off current_team_id), so it needs its own execution.
        from app.data import load_player_squad_appearances

        frame = load_player_squad_appearances(conn, COMPETITIONS, as_of=date(2026, 1, 1))
        assert "player_id" in frame.columns

    def test_load_confirmed_lineups(self, conn):
        from app.data import load_confirmed_lineups

        # Non-empty id list: the empty-list path returns early without
        # touching the database and would prove nothing here.
        frame = load_confirmed_lineups(conn, [1, 2, 3])
        assert {"fixture_id", "team_id", "player_id", "is_starting", "pre_match_captured_at"} <= set(frame.columns)

    def test_load_closing_match_winner_probabilities(self, conn):
        from app.data import load_closing_match_winner_probabilities

        frame = load_closing_match_winner_probabilities(conn, [1, 2, 3])
        assert "fixture_id" in frame.columns


class TestModuleQueries:
    """
    Queries that live inside a module's own main()/loader rather than in
    app.data -- the ones with no other coverage at all, and the ones that
    have actually broken.
    """

    def test_estimate_promotion_penalty_loader(self, conn):
        # The exact regression: this raised UndefinedTable in production.
        from app.estimate_promotion_penalty import load_matches_with_season

        frame = load_matches_with_season(conn)
        assert "season_label" in frame.columns
        assert "home_shots_inside_box" in frame.columns, (
            "the shot-stat LEFT JOINs must survive -- their absence is the bug this file exists for"
        )

    def test_market_divergence_check_runs(self, monkeypatch, capsys):
        import psycopg

        import app.check_market_divergence as module

        monkeypatch.setattr(module, "get_connection", lambda: psycopg.connect(SMOKE_DATABASE_URL))
        assert module.main() == 0  # empty schema: nothing to flag
        assert "nothing to check" in capsys.readouterr().out.lower()

    def test_diagnose_lineups_runs(self, monkeypatch, capsys):
        import psycopg

        import app.diagnose_lineups as module

        monkeypatch.setattr(module, "get_connection", lambda: psycopg.connect(SMOKE_DATABASE_URL))
        monkeypatch.setattr(module.sys, "argv", ["app.diagnose_lineups"])
        module.main()
        assert "Nothing in range" in capsys.readouterr().out

    def test_diagnose_coverage_runs(self, monkeypatch):
        import psycopg

        import app.diagnose_coverage as module

        monkeypatch.setattr(module, "get_connection", lambda: psycopg.connect(SMOKE_DATABASE_URL))
        monkeypatch.setattr(module.sys, "argv", ["app.diagnose_coverage"])
        module.main()  # must not raise
