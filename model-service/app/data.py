import pandas as pd
import psycopg


def _query_df(conn: psycopg.Connection, query: str, params: dict | None = None) -> pd.DataFrame:
    """pandas.read_sql only officially supports SQLAlchemy connections; using it directly with a
    raw psycopg connection works but prints a UserWarning on every call. Cursor + fetchall avoids
    that without pulling in SQLAlchemy for a project that otherwise has no use for an ORM."""
    with conn.cursor() as cur:
        cur.execute(query, params)
        columns = [desc.name for desc in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=columns)


def load_finished_matches(conn: psycopg.Connection, competition_names: list[str]) -> pd.DataFrame:
    """
    One row per completed match: who played, when, final score, and which
    competition it was -- across every competition passed in. Takes a list,
    not a single name, specifically so a joint fit (e.g. Premier League +
    Championship + FA Cup together, see app.train) can be built from one
    query instead of three separately-fetched frames stitched together by
    the caller.
    """
    query = """
        SELECT f.id AS fixture_id, f.kickoff_date, c.name AS competition_name,
               f.home_team_id, ht.name AS home_team,
               f.away_team_id, at.name AS away_team,
               f.home_score, f.away_score
        FROM fixtures f
        JOIN teams ht ON ht.id = f.home_team_id
        JOIN teams at ON at.id = f.away_team_id
        JOIN competition_seasons cs ON cs.id = f.competition_season_id
        JOIN competitions c ON c.id = cs.competition_id
        WHERE c.name = ANY(%(competition_names)s)
          AND f.home_score IS NOT NULL
          AND f.away_score IS NOT NULL
        ORDER BY f.kickoff_date
    """
    return _query_df(conn, query, {"competition_names": competition_names})


def load_upcoming_fixtures(conn: psycopg.Connection, competition_name: str) -> pd.DataFrame:
    """Fixtures with no result yet -- the ones we actually want predictions for."""
    query = """
        SELECT f.id AS fixture_id, f.kickoff_date,
               f.home_team_id, ht.name AS home_team,
               f.away_team_id, at.name AS away_team
        FROM fixtures f
        JOIN teams ht ON ht.id = f.home_team_id
        JOIN teams at ON at.id = f.away_team_id
        JOIN competition_seasons cs ON cs.id = f.competition_season_id
        JOIN competitions c ON c.id = cs.competition_id
        WHERE c.name = %(competition_name)s
          AND (f.home_score IS NULL OR f.away_score IS NULL)
        ORDER BY f.kickoff_date
    """
    return _query_df(conn, query, {"competition_name": competition_name})


def load_player_squad_appearances(conn: psycopg.Connection, competition_names: list[str]) -> pd.DataFrame:
    """
    One row per (team, player, fixture) where the player was named in the
    matchday squad -- starting XI or substitute -- for a finished match,
    including appearances with 0 minutes played (an unused substitute).
    That last part matters for app.goal_scorer's minutes-share calculation:
    averaging only over matches a player actually got on the pitch would
    make a rotated squad player look like a nailed-on starter. Deliberately
    not filtered to one competition the way load_finished_matches is for
    the match-outcome fits -- a player's rotation pattern and scoring rate
    for their team is the same real thing whether it happened in a league
    game or an FA Cup tie, so goal_scorer always uses the full cross-
    competition appearance history regardless of which team-strength model
    (single-competition or joint) is being allocated for that fixture.

    Restricted to each player's most-recent club: real bug found in
    production 2026-08-16 -- Joao Pedro (transferred Brighton -> Chelsea)
    kept showing up as a "reliable" Brighton goalscorer pick indefinitely,
    because his old Brighton appearances alone cleared goal_scorer's
    MIN_PLAYER_MATCHES threshold and nothing here checked whether he still
    played there. players.current_team_id can't fix this generally -- it's
    only ever populated from the FPL bootstrap, i.e. Premier League only
    (see teams.service.ts), so it goes NULL for every Championship player
    and would silently zero out Championship (and the FA Cup joint fit's
    Championship side) goal-scorer predictions entirely. Deriving "current
    club" from this same appearance data instead -- whichever team_id a
    player's most recent finished-match appearance was for -- needs no
    extra data source and works uniformly across every competition. A
    just-transferred player may have too few appearances for their new
    club yet to clear MIN_PLAYER_MATCHES and simply won't get a scorer
    prediction for a while; that's the correct outcome (no confident data
    yet), not a confident wrong-team one.
    """
    query = """
        WITH appearances AS (
            SELECT fl.team_id, fl.player_id, f.kickoff_date,
                   COALESCE(fps.minutes_played, 0) AS minutes_played,
                   COALESCE(fps.goals, 0) AS goals
            FROM fixture_lineups fl
            JOIN fixtures f ON f.id = fl.fixture_id
            LEFT JOIN fixture_player_stats fps ON fps.fixture_id = fl.fixture_id AND fps.player_id = fl.player_id
            JOIN competition_seasons cs ON cs.id = f.competition_season_id
            JOIN competitions c ON c.id = cs.competition_id
            WHERE c.name = ANY(%(competition_names)s)
              AND f.status = 'finished'
        ),
        most_recent_club AS (
            SELECT DISTINCT ON (player_id) player_id, team_id
            FROM appearances
            ORDER BY player_id, kickoff_date DESC
        )
        SELECT a.team_id, a.player_id, a.kickoff_date, a.minutes_played, a.goals
        FROM appearances a
        JOIN most_recent_club mrc ON mrc.player_id = a.player_id AND mrc.team_id = a.team_id
        ORDER BY a.kickoff_date
    """
    return _query_df(conn, query, {"competition_names": competition_names})


def load_closing_match_winner_probabilities(conn: psycopg.Connection, fixture_ids: list[int]) -> pd.DataFrame:
    """
    Market-implied win/draw/loss probabilities from closing odds, for use as an
    evaluation baseline -- never as a model input (see docs/learning-log.md's
    Phase 5 entry for why). Uses the "market_avg" bookmaker (an average across
    real bookmakers, not a real one itself) since it's less noisy than any
    single bookmaker's line. Decimal odds -> raw implied probability is
    1/price; those three don't sum to 1 because bookmakers build in a margin
    (the "overround"), so they're renormalized to sum to 1 -- a fair
    probability estimate, not the bookmaker's actual take.
    """
    empty = pd.DataFrame(columns=["fixture_id", "prob_home_win", "prob_draw", "prob_away_win"])
    if not fixture_ids:
        return empty

    query = """
        SELECT fixture_id, outcome, price
        FROM fixture_odds
        WHERE fixture_id = ANY(%(fixture_ids)s)
          AND bookmaker = 'market_avg'
          AND market = 'match_winner'
          AND snapshot_type = 'closing'
    """
    odds = _query_df(conn, query, {"fixture_ids": fixture_ids})
    if odds.empty:
        return empty
    odds["price"] = odds["price"].astype(float)  # psycopg returns Postgres numeric as decimal.Decimal, not float

    wide = odds.pivot(index="fixture_id", columns="outcome", values="price")
    implied = 1.0 / wide[["home", "draw", "away"]]
    normalized = implied.div(implied.sum(axis=1), axis=0)
    normalized.columns = ["prob_home_win", "prob_draw", "prob_away_win"]
    return normalized.reset_index()
