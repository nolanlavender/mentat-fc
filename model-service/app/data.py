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

    Also carries each side's own shots on target for the match
    (home_shots_on_target/away_shots_on_target, nullable) -- not used by
    DixonColesModel.fit() directly, which only ever reads
    home_score/away_score, but see blend_shots_on_target_into_scores below
    for how a caller opts into using it. Two separate LEFT JOINs (not
    one), since fixture_team_stats is one row per team per fixture, not
    one row per fixture with home/away columns.

    True xG would have been the more standard signal here, but it isn't
    available from any current data source -- checked directly against a
    real API-Football /fixtures/statistics response (2026-08-19): no
    expected-goals field anywhere in it, only shot/card/pass counts.
    Shots on target (football-data.co.uk's HST/AST CSV columns, already
    populated for every Premier League and Championship match) is the
    closest real signal actually sitting in the DB.
    """
    query = """
        SELECT f.id AS fixture_id, f.kickoff_date, c.name AS competition_name,
               f.home_team_id, ht.name AS home_team,
               f.away_team_id, at.name AS away_team,
               f.home_score, f.away_score,
               home_stats.shots_on_target AS home_shots_on_target,
               away_stats.shots_on_target AS away_shots_on_target
        FROM fixtures f
        JOIN teams ht ON ht.id = f.home_team_id
        JOIN teams at ON at.id = f.away_team_id
        JOIN competition_seasons cs ON cs.id = f.competition_season_id
        JOIN competitions c ON c.id = cs.competition_id
        LEFT JOIN fixture_team_stats home_stats ON home_stats.fixture_id = f.id AND home_stats.team_id = f.home_team_id
        LEFT JOIN fixture_team_stats away_stats ON away_stats.fixture_id = f.id AND away_stats.team_id = f.away_team_id
        WHERE c.name = ANY(%(competition_names)s)
          AND f.home_score IS NOT NULL
          AND f.away_score IS NOT NULL
        ORDER BY f.kickoff_date
    """
    return _query_df(conn, query, {"competition_names": competition_names})


def blend_shots_on_target_into_scores(matches: pd.DataFrame, blend_weight: float) -> pd.DataFrame:
    """
    Returns a copy of `matches` with home_score/away_score replaced by a
    blend of the actual final score and a goals-scaled version of that
    side's own shots on target for the match, wherever shots-on-target
    data is available. Like xG would have been, shots on target is a
    lower-variance read on a team's true underlying attacking performance
    than the actual goal count -- a team can rack up shots on target and
    still lose 0-1 to one save going the wrong way -- so blending it into
    what DixonColesModel.fit() sees as "goals" makes the fit less noisy
    without discarding what actually happened.

    Shots on target isn't on the same scale as goals, though -- a team
    typically has several times as many shots on target as actual goals
    in a match, so blending it in raw would badly inflate the fitted
    attack/defense parameters. Rescaled here by the training set's own
    mean goals-per-shot-on-target ratio (computed across whichever rows
    actually have both a real score and a real shots-on-target figure,
    home and away pooled together) rather than a hardcoded assumed
    conversion rate that might not hold for this specific
    dataset/competition -- self-calibrating to whatever `matches` is
    passed in, so a Premier League call and a Championship call (which
    may have genuinely different real conversion rates) each get their
    own correct scale.

    blend_weight is how much of the blend is the rescaled shots-on-target
    signal: 0.0 leaves scores completely unchanged (today's deployed
    behavior), 1.0 fits on pure rescaled shots-on-target, values in
    between interpolate. Falls back to the real score untouched wherever
    shots-on-target is missing for that side -- never invents a
    substitute value for a match that doesn't have one.

    Deliberately a separate opt-in step, not folded into
    load_finished_matches or DixonColesModel.fit() itself: app.evaluate is
    the sandbox for finding a good blend_weight (same role
    HALF_LIFE_DAYS already plays there) before app.train's deployed value
    gets updated to match.
    """
    blended = matches.copy()
    # A blended score is inherently fractional, so these columns need a
    # float dtype regardless of blend_weight -- real crash found building
    # the xG version of this: home_score/away_score come back int64 from
    # Postgres, and assigning float values into an int64 column raises
    # rather than silently upcasting on a recent pandas. Same fix applies
    # to the shots-on-target columns themselves (an all-null column, real
    # whenever a whole competition/season has no CSV coverage yet, infers
    # as object dtype and hits the identical issue).
    blended["home_score"] = blended["home_score"].astype(float)
    blended["away_score"] = blended["away_score"].astype(float)
    blended["home_shots_on_target"] = blended["home_shots_on_target"].astype(float)
    blended["away_shots_on_target"] = blended["away_shots_on_target"].astype(float)

    has_home_sot = blended["home_shots_on_target"].notna()
    has_away_sot = blended["away_shots_on_target"].notna()
    goals_with_sot = pd.concat(
        [blended.loc[has_home_sot, "home_score"], blended.loc[has_away_sot, "away_score"]]
    )
    sot = pd.concat(
        [blended.loc[has_home_sot, "home_shots_on_target"], blended.loc[has_away_sot, "away_shots_on_target"]]
    )
    if sot.empty or sot.sum() == 0:
        return blended  # nothing to blend with -- leave every score untouched

    conversion_rate = goals_with_sot.sum() / sot.sum()

    blended.loc[has_home_sot, "home_score"] = (1 - blend_weight) * blended.loc[
        has_home_sot, "home_score"
    ] + blend_weight * (blended.loc[has_home_sot, "home_shots_on_target"] * conversion_rate)
    blended.loc[has_away_sot, "away_score"] = (1 - blend_weight) * blended.loc[
        has_away_sot, "away_score"
    ] + blend_weight * (blended.loc[has_away_sot, "away_shots_on_target"] * conversion_rate)
    return blended


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
    Also carries penalties_scored/penalties_missed (real, populated
    API-Football data -- see app.goal_scorer's primary-penalty-taker
    mechanism for why attempts, not just conversions, matter for
    identifying who currently takes a team's penalties).
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
            SELECT fl.team_id, fl.player_id, f.kickoff_date, fl.is_starting,
                   COALESCE(fps.minutes_played, 0) AS minutes_played,
                   COALESCE(fps.goals, 0) AS goals,
                   COALESCE(fps.penalties_scored, 0) AS penalties_scored,
                   COALESCE(fps.penalties_missed, 0) AS penalties_missed,
                   fps.rating
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
        SELECT ec.team_id, a.player_id, a.kickoff_date, a.minutes_played, a.goals,
               a.penalties_scored, a.penalties_missed, a.rating, a.is_starting
        FROM appearances a
        JOIN effective_club ec ON ec.player_id = a.player_id
        ORDER BY a.kickoff_date
    """
    return _query_df(conn, query, {"competition_names": competition_names})


def load_confirmed_lineups(conn: psycopg.Connection, fixture_ids: list[int]) -> pd.DataFrame:
    """
    One row per (fixture_id, team_id, player_id, is_starting) for whichever
    of the given fixtures already have a confirmed matchday squad in
    fixture_lineups -- starting XI or bench, anyone actually named for
    that squad, not just starters (see app.goal_scorer.compute_team_availability
    for why bench presence still counts as "available" at the TEAM level --
    is_starting is what lets app.goal_scorer.allocate_team_goals tell a
    confirmed starter from a confirmed bench player for that same
    fixture's individual scorer odds). A fixture with no rows here simply
    has no confirmed squad yet -- the normal state for anything more than
    roughly an hour before kickoff (see backend/seed/sources/api-football.ts's
    seedTodaysLineups) -- callers treat that as "no confident answer yet",
    not an error, same as every other missing-data case in this app.
    """
    if not fixture_ids:
        return pd.DataFrame(columns=["fixture_id", "team_id", "player_id", "is_starting"])
    query = """
        SELECT fixture_id, team_id, player_id, is_starting
        FROM fixture_lineups
        WHERE fixture_id = ANY(%(fixture_ids)s)
    """
    return _query_df(conn, query, {"fixture_ids": fixture_ids})


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
