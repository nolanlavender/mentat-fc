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

    Labeled by each player's CURRENT club, not the club each individual
    appearance was actually for: real bug chain found in production
    2026-08-16. First found for Joao Pedro (transferred Brighton ->
    Chelsea) -- his old Brighton appearances alone cleared goal_scorer's
    MIN_PLAYER_MATCHES threshold and nothing checked whether he still
    played there, so he kept showing up as a "reliable" Brighton
    goalscorer pick indefinitely. Original fix derived "current club" from
    this same appearance data (whichever team_id a player's most recent
    finished-match appearance was for), since players.current_team_id is
    FPL-only (Premier League) and null for Championship. That had its own
    gap, found the same day: Harry Wilson's current_team_id already
    pointed at Leeds United (FPL's bootstrap-static is live -- it reflects
    a transfer instantly), but he had zero recorded appearances there yet,
    so the appearance-derived logic still landed on Fulham and confidently
    predicted him to score there.

    Deliberate design, not just a bug fix, after both of those: a
    transferred player's OLD appearances still count toward his personal
    scoring rate -- excluding them entirely meant he vanished from
    predictions for weeks after a transfer, which is worse than an
    estimate built partly on old-club data. What changes is which team
    that rate gets compared against. Every appearance a player has ever
    made (any team, any competition) is labeled here with their CURRENT
    effective club (current_team_id, falling back to their own most-recent
    appearance's team for Championship players FPL doesn't cover) rather
    than filtered down to only appearances for that club. app.goal_scorer's
    existing recency half-life (see compute_player_shares) does the actual
    blending with no extra code needed: an old club's appearances count
    less as time passes and don't get replaced by anything, so a player's
    rate is old-club-dominated the day after a transfer and shifts toward
    new-club data automatically as he actually plays there -- the exact
    "average with his old team, weighted toward what's real" behavior a
    hard cutoff couldn't give. goal_share still normalizes against
    whichever teammates share that same effective club, so the comparison
    set is always his real current squad, not a mix of two rosters.
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
        ),
        effective_club AS (
            SELECT mrc.player_id, COALESCE(p.current_team_id, mrc.team_id) AS team_id
            FROM most_recent_club mrc
            JOIN players p ON p.id = mrc.player_id
        )
        SELECT ec.team_id, a.player_id, a.kickoff_date, a.minutes_played, a.goals
        FROM appearances a
        JOIN effective_club ec ON ec.player_id = a.player_id
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
