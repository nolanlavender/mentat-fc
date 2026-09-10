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

    def test_diagnose_player_runs(self, monkeypatch, capsys):
        import psycopg

        import app.diagnose_player as module

        monkeypatch.setattr(module, "get_connection", lambda: psycopg.connect(SMOKE_DATABASE_URL))
        # A needle chosen to match nothing, rather than a real surname that
        # happens to match nothing today. This asserted "Isak" until
        # 2026-09-10, when the backend seed-writer specs started running
        # against this same database earlier in the job and left an
        # "Alexander Isak Ramirez" fixture row behind. The specs were wrong
        # to leak it, and this was wrong to depend on them not doing so:
        # the point here is that the query executes against the real
        # schema, which an unmatchable needle proves just as well.
        monkeypatch.setattr(module.sys, "argv", ["app.diagnose_player", "zzz-no-such-player-zzz"])
        module.main()
        assert "No player matching" in capsys.readouterr().out

    def test_diagnose_coverage_runs(self, monkeypatch):
        import psycopg

        import app.diagnose_coverage as module

        monkeypatch.setattr(module, "get_connection", lambda: psycopg.connect(SMOKE_DATABASE_URL))
        monkeypatch.setattr(module.sys, "argv", ["app.diagnose_coverage"])
        module.main()  # must not raise


class TestDepartedPlayersAreDropped:
    """
    The 2026-08-22 Salah bug, pinned against a real schema because it is a
    SQL-shaped bug and no amount of Python-level mocking would have caught
    it. clearStaleTeamRoster had already worked out he had left Liverpool;
    load_player_squad_appearances put him back via
    COALESCE(current_team_id, most_recent_appearance_team).
    """

    @pytest.fixture
    def seeded(self, conn):
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO competitions (id,name,type) VALUES (900,'Premier League','league')
                  ON CONFLICT (id) DO NOTHING;
                INSERT INTO seasons (id,label,start_date,end_date)
                  VALUES (900,'2098/99','2098-08-01','2099-05-31') ON CONFLICT (id) DO NOTHING;
                INSERT INTO competition_seasons (id,competition_id,season_id,external_season_year)
                  VALUES (900,900,900,2098) ON CONFLICT (id) DO NOTHING;
                INSERT INTO teams (id,name,roster_synced_at) VALUES
                  (901,'Verified FC',now()), (902,'Other FC',now()), (903,'Unverified FC',NULL)
                  ON CONFLICT (id) DO NOTHING;
                INSERT INTO players (id,full_name,current_team_id) VALUES
                  (901,'Departed Player',NULL), (902,'Present Player',902), (903,'Uncovered Player',NULL)
                  ON CONFLICT (id) DO NOTHING;
                INSERT INTO fixtures (id,competition_season_id,home_team_id,away_team_id,
                                      kickoff_at,kickoff_date,status,home_score,away_score)
                  VALUES (901,900,901,902,'2098-08-01 15:00Z','2098-08-01','finished',2,1),
                         (902,900,903,902,'2098-08-02 15:00Z','2098-08-02','finished',1,1)
                  ON CONFLICT (id) DO NOTHING;
                INSERT INTO fixture_lineups (fixture_id,team_id,player_id,is_starting) VALUES
                  (901,901,901,true),(901,902,902,true),(902,903,903,true)
                  ON CONFLICT (fixture_id, player_id) DO NOTHING;
            """)
        conn.commit()
        yield conn
        with conn.cursor() as cur:
            cur.execute("DELETE FROM fixture_lineups WHERE fixture_id IN (901,902);"
                        "DELETE FROM fixtures WHERE id IN (901,902);"
                        "DELETE FROM players WHERE id IN (901,902,903);"
                        "DELETE FROM teams WHERE id IN (901,902,903);"
                        "DELETE FROM competition_seasons WHERE id = 900;"
                        "DELETE FROM seasons WHERE id = 900;"
                        "DELETE FROM competitions WHERE id = 900;")
        conn.commit()

    def test_a_verified_departure_is_dropped_entirely(self, seeded):
        from app.data import load_player_squad_appearances

        frame = load_player_squad_appearances(seeded, ["Premier League"])
        assert 901 not in set(frame["player_id"]), (
            "a player absent from his last club's VERIFIED roster must not be predicted for it"
        )

    def test_a_player_still_on_the_roster_is_kept(self, seeded):
        from app.data import load_player_squad_appearances

        frame = load_player_squad_appearances(seeded, ["Premier League"])
        assert set(frame[frame["player_id"] == 902]["team_id"]) == {902}

    def test_an_unverified_club_still_falls_back_to_appearances(self, seeded):
        # The reason the fallback exists at all -- a club we have never
        # synced tells us nothing, so a NULL current_team_id there is
        # "unknown", not "departed". Removing this would silently delete
        # every player at any club the roster sync has not reached.
        from app.data import load_player_squad_appearances

        frame = load_player_squad_appearances(seeded, ["Premier League"])
        assert set(frame[frame["player_id"] == 903]["team_id"]) == {903}

    def test_the_diagnostic_agrees_with_the_loader(self, seeded):
        # app.diagnose_player re-implements the effective_club CASE rather
        # than importing it, on purpose (see resolve_club's docstring): a
        # diagnostic that shares the code under test can never report a
        # disagreement. The cost of that choice is that the copy can drift
        # silently, so this pins the two to the same answer against a real
        # database, on the exact three cases the CASE exists to separate.
        from app.data import load_player_squad_appearances
        from app.diagnose_player import load_player_chain, resolve_club

        actual = load_player_squad_appearances(seeded, ["Premier League"])
        club_by_player = {
            int(player_id): frame["team_id"].iloc[0]
            for player_id, frame in actual.groupby("player_id")
        }
        names = {"Verified FC": 901, "Other FC": 902, "Unverified FC": 903}

        chain = load_player_chain(seeded, "Player")
        seen = set()
        for row in chain.itertuples():
            if row.player_id not in (901, 902, 903):
                continue  # a real database may hold other "...Player..." names
            seen.add(row.player_id)
            club, why = resolve_club(row)
            predicted = names[club] if club else None
            assert predicted == club_by_player.get(row.player_id), (
                f"diagnostic says {club} for player {row.player_id} ({why}), "
                f"loader says {club_by_player.get(row.player_id)}"
            )
        assert seen == {901, 902, 903}, "the seeded rows must all be reachable by name"

    def test_the_backtest_path_is_untouched(self, seeded):
        # With a cutoff we must use only what the appearance history said
        # at the time -- current_team_id and roster_synced_at are both live
        # signals and would leak the future into the measurement.
        from datetime import date

        from app.data import load_player_squad_appearances

        frame = load_player_squad_appearances(seeded, ["Premier League"], as_of=date(2099, 1, 1))
        assert 901 in set(frame["player_id"]), "a backtest must not apply today's transfers retroactively"
