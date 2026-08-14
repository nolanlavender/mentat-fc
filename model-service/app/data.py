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


def load_finished_matches(conn: psycopg.Connection, competition_name: str) -> pd.DataFrame:
    """One row per completed match: who played, when, final score."""
    query = """
        SELECT f.id AS fixture_id, f.kickoff_date,
               f.home_team_id, ht.name AS home_team,
               f.away_team_id, at.name AS away_team,
               f.home_score, f.away_score
        FROM fixtures f
        JOIN teams ht ON ht.id = f.home_team_id
        JOIN teams at ON at.id = f.away_team_id
        JOIN competition_seasons cs ON cs.id = f.competition_season_id
        JOIN competitions c ON c.id = cs.competition_id
        WHERE c.name = %(competition_name)s
          AND f.home_score IS NOT NULL
          AND f.away_score IS NOT NULL
        ORDER BY f.kickoff_date
    """
    return _query_df(conn, query, {"competition_name": competition_name})


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
