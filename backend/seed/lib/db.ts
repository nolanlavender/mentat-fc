import type { Pool } from 'pg';

// Builds "($1, $2, ...), ($3, $4, ...), ..." for a multi-row INSERT --
// shared by the batch upserts below, which exist because seeding
// football-data.co.uk originally issued one INSERT per odds row (~30-60
// per fixture) and one per team-stats row (2 per fixture), each its own
// network round-trip to a remote Postgres. For ~2,800 fixtures across
// Premier League + Championship that's 100,000+ sequential round-trips --
// real, measured seed latency, not a hypothetical. Collapsing a whole
// fixture's odds/stats into one multi-row statement each cuts that to 2
// round-trips per fixture instead of ~35-65.
function buildValuesPlaceholders(rowCount: number, colCount: number): string {
  const rows: string[] = [];
  let paramIndex = 1;
  for (let r = 0; r < rowCount; r++) {
    const cols: string[] = [];
    for (let c = 0; c < colCount; c++) cols.push(`$${paramIndex++}`);
    rows.push(`(${cols.join(', ')})`);
  }
  return rows.join(', ');
}

export async function getOrCreateCompetition(
  pool: Pool,
  name: string,
  type: 'league' | 'cup',
  externalApiFootballLeagueId?: number,
): Promise<number> {
  // Matched by name, not an ON CONFLICT on external_api_football_league_id:
  // that column is nullable, and Postgres never treats NULL = NULL as a
  // conflict, so a naive upsert on it would silently insert a fresh row
  // every single run whenever the id isn't supplied (exactly what happened
  // here in testing -- competitions, then everything downstream of them,
  // doubled on a second seed run).
  const existing = await pool.query<{ id: number }>(`SELECT id FROM competitions WHERE name = $1`, [name]);
  if (existing.rows[0]) {
    if (externalApiFootballLeagueId !== undefined) {
      await pool.query(
        `UPDATE competitions SET external_api_football_league_id = $2 WHERE id = $1 AND external_api_football_league_id IS NULL`,
        [existing.rows[0].id, externalApiFootballLeagueId],
      );
    }
    return existing.rows[0].id;
  }
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO competitions (name, type, external_api_football_league_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, type, externalApiFootballLeagueId ?? null],
  );
  return inserted.rows[0].id;
}

export async function getOrCreateSeason(pool: Pool, label: string, startDate: string, endDate: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seasons (label, start_date, end_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (label) DO UPDATE SET start_date = EXCLUDED.start_date
     RETURNING id`,
    [label, startDate, endDate],
  );
  return rows[0].id;
}

export async function getOrCreateCompetitionSeason(
  pool: Pool,
  competitionId: number,
  seasonId: number,
  externalSeasonYear?: number,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO competition_seasons (competition_id, season_id, external_season_year)
     VALUES ($1, $2, $3)
     ON CONFLICT (competition_id, season_id) DO UPDATE SET external_season_year = COALESCE(EXCLUDED.external_season_year, competition_seasons.external_season_year)
     RETURNING id`,
    [competitionId, seasonId, externalSeasonYear ?? null],
  );
  return rows[0].id;
}

// Teams' golden-record key (natural_key, a generated column hashing the
// normalized name -- see migration 1701000000013) makes this a single
// upsert instead of a select-then-insert: any source computes the same key
// for "Manchester United" and lands on the same row, as long as
// canonicalTeamName() has already resolved source-specific short names to
// the canonical one before this is called.
// Module-level, not per-call -- lives for the process's lifetime, which is
// exactly one `npm run db:seed` run. Real seeding cost measured: getOrCreateTeam
// was called ~2x per fixture (home + away), so ~5,600 round-trips for PL +
// Championship alone, resolving the same ~50 distinct team names over and
// over. Team names don't change mid-run and nothing else writes to `teams`
// concurrently during a seed run, so caching here is safe, not just fast.
const teamIdCache = new Map<string, number>();

export async function getOrCreateTeam(pool: Pool, name: string): Promise<number> {
  const cached = teamIdCache.get(name);
  if (cached !== undefined) return cached;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO teams (name) VALUES ($1)
     ON CONFLICT (natural_key) DO UPDATE SET name = teams.name
     RETURNING id`,
    [name],
  );
  teamIdCache.set(name, rows[0].id);
  return rows[0].id;
}

export async function setTeamExternalFplId(pool: Pool, teamId: number, externalFplId: number): Promise<void> {
  await pool.query(`UPDATE teams SET external_fpl_id = $2 WHERE id = $1`, [teamId, externalFplId]);
}

// A direct overwrite, not a COALESCE-preserve-old upsert: FPL's
// bootstrap-static always reflects the current reality of a live fantasy
// game, so on a rerun it should win over whatever was there before (a
// transfer moved the player, and that stops being true, not something to
// preserve). Only FPL touches this column -- API-Football-sourced sightings
// (lineups, player-stats) know "this player played for this team in this
// match," not "this is the player's current team," so they don't call this.
export async function setPlayerCurrentTeam(pool: Pool, playerId: number, teamId: number): Promise<void> {
  await pool.query(`UPDATE players SET current_team_id = $2 WHERE id = $1`, [playerId, teamId]);
}

export interface PlayerInput {
  externalFplId?: number;
  externalApiFootballId?: number;
  fullName: string;
  dateOfBirth?: string;
  nationality?: string;
  position?: string;
}

/**
 * One golden-record entry point for both sources, instead of a separate
 * upsert per external ID (which is what let the same real player get two
 * disconnected rows -- one from FPL, one from API-Football -- with no link
 * between them). Match priority, most reliable identifier first:
 *
 * 1. external_api_football_id, if we have one -- a stable numeric id from
 *    the source itself, so it's checked before any name-based logic. Two
 *    different API-Football endpoints (lineups vs. player stats) don't
 *    always spell the same player's name identically, which is exactly
 *    what made this the right first check, not an optimization: without
 *    it, the same real player calling in with two name spellings across
 *    two endpoint calls for one fixture produced two INSERTs racing for
 *    the same external id and a unique-constraint violation.
 * 2. players.natural_key (full name + date of birth, generated column),
 *    the merge target when we know a DOB -- normally an FPL-sourced call.
 * 3. An exact case-insensitive name match against an existing row, for the
 *    common case of a player only seen via API-Football's lineup endpoint
 *    (a name and shirt number, no birth date) who's already in the table
 *    from FPL with a real DOB. Falls back to inserting under a DOB-less
 *    natural_key if nothing matches. Not perfect: two genuinely different
 *    real players sharing an exact name and both missing a DOB (and
 *    neither having an external_api_football_id yet) would incorrectly
 *    merge. Acceptable at Premier League/Championship scale; revisit if
 *    FA Cup's lower-tier entrants make that collision observably real.
 */
export async function upsertPlayerGoldenRecord(pool: Pool, p: PlayerInput): Promise<number> {
  // Check the reliable external id first, before any name-based matching.
  // Real bug this fixed: API-Football's lineups endpoint and its
  // fixtures/players (stats) endpoint don't always spell the same player's
  // name identically (accents, abbreviations) -- the lineup call inserts
  // the player under external_api_football_id X, then the stats call for
  // the same fixture fails the name match, falls through to INSERT, and
  // collides on players_external_api_football_id_key since it's genuinely
  // the same real player. A numeric id from the source is more trustworthy
  // than a name string from the same source, so it's checked first.
  if (p.externalApiFootballId !== undefined) {
    const existingById = await pool.query<{ id: number }>(`SELECT id FROM players WHERE external_api_football_id = $1`, [
      p.externalApiFootballId,
    ]);
    if (existingById.rows[0]) {
      const id = existingById.rows[0].id;
      await pool.query(
        // full_name intentionally left untouched -- whichever call created
        // this row first set the canonical spelling (and natural_key is
        // generated from it); a differently-formatted name from a later
        // call enriches other fields but never overwrites the name.
        `UPDATE players SET
           date_of_birth = COALESCE(date_of_birth, $2),
           nationality = COALESCE($3, nationality),
           position = COALESCE($4, position),
           external_fpl_id = COALESCE($5, external_fpl_id)
         WHERE id = $1`,
        [id, p.dateOfBirth ?? null, p.nationality ?? null, p.position ?? null, p.externalFplId ?? null],
      );
      return id;
    }
  }

  if (p.dateOfBirth) {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO players (full_name, date_of_birth, nationality, position, external_fpl_id, external_api_football_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (natural_key) DO UPDATE SET
         nationality = COALESCE(EXCLUDED.nationality, players.nationality),
         position = COALESCE(EXCLUDED.position, players.position),
         external_fpl_id = COALESCE(EXCLUDED.external_fpl_id, players.external_fpl_id),
         external_api_football_id = COALESCE(EXCLUDED.external_api_football_id, players.external_api_football_id)
       RETURNING id`,
      [p.fullName, p.dateOfBirth, p.nationality ?? null, p.position ?? null, p.externalFplId ?? null, p.externalApiFootballId ?? null],
    );
    return rows[0].id;
  }

  const existingByName = await pool.query<{ id: number }>(`SELECT id FROM players WHERE lower(full_name) = lower($1) LIMIT 1`, [
    p.fullName,
  ]);
  if (existingByName.rows[0]) {
    const id = existingByName.rows[0].id;
    await pool.query(
      `UPDATE players SET
         position = COALESCE($2, position),
         external_fpl_id = COALESCE($3, external_fpl_id),
         external_api_football_id = COALESCE($4, external_api_football_id)
       WHERE id = $1`,
      [id, p.position ?? null, p.externalFplId ?? null, p.externalApiFootballId ?? null],
    );
    return id;
  }

  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO players (full_name, nationality, position, external_fpl_id, external_api_football_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (natural_key) DO UPDATE SET
       position = COALESCE(EXCLUDED.position, players.position),
       external_fpl_id = COALESCE(EXCLUDED.external_fpl_id, players.external_fpl_id),
       external_api_football_id = COALESCE(EXCLUDED.external_api_football_id, players.external_api_football_id)
     RETURNING id`,
    [p.fullName, p.nationality ?? null, p.position ?? null, p.externalFplId ?? null, p.externalApiFootballId ?? null],
  );
  return inserted.rows[0].id;
}

export async function upsertFplGameweek(
  pool: Pool,
  gw: {
    gwNumber: number;
    deadlineTime: Date;
    isCurrent: boolean;
    isFinished: boolean;
    averageScore?: number;
    highestScore?: number;
  },
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO fpl_gameweeks (gw_number, deadline_time, is_current, is_finished, average_score, highest_score)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (gw_number) DO UPDATE SET
       is_current = EXCLUDED.is_current,
       is_finished = EXCLUDED.is_finished,
       average_score = EXCLUDED.average_score,
       highest_score = EXCLUDED.highest_score
     RETURNING id`,
    [gw.gwNumber, gw.deadlineTime, gw.isCurrent, gw.isFinished, gw.averageScore ?? null, gw.highestScore ?? null],
  );
  return rows[0].id;
}

export interface FixtureInput {
  competitionSeasonId: number;
  homeTeamId: number;
  awayTeamId: number;
  kickoffAt: Date;
  kickoffDate: string; // YYYY-MM-DD, the natural-key component
  status: string;
  round?: string;
  homeScore?: number;
  awayScore?: number;
  homeScoreHt?: number;
  awayScoreHt?: number;
  referee?: string;
  venue?: string;
  externalApiFootballId?: number;
}

export async function upsertFixture(pool: Pool, f: FixtureInput): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO fixtures (
       competition_season_id, home_team_id, away_team_id, kickoff_at, kickoff_date,
       status, round, home_score, away_score, home_score_ht, away_score_ht, referee,
       venue, external_api_football_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (competition_season_id, home_team_id, away_team_id, kickoff_date)
     DO UPDATE SET
       status = EXCLUDED.status,
       home_score = COALESCE(EXCLUDED.home_score, fixtures.home_score),
       away_score = COALESCE(EXCLUDED.away_score, fixtures.away_score),
       home_score_ht = COALESCE(EXCLUDED.home_score_ht, fixtures.home_score_ht),
       away_score_ht = COALESCE(EXCLUDED.away_score_ht, fixtures.away_score_ht),
       referee = COALESCE(EXCLUDED.referee, fixtures.referee),
       venue = COALESCE(EXCLUDED.venue, fixtures.venue),
       external_api_football_id = COALESCE(EXCLUDED.external_api_football_id, fixtures.external_api_football_id),
       updated_at = now()
     RETURNING id`,
    [
      f.competitionSeasonId,
      f.homeTeamId,
      f.awayTeamId,
      f.kickoffAt,
      f.kickoffDate,
      f.status,
      f.round ?? null,
      f.homeScore ?? null,
      f.awayScore ?? null,
      f.homeScoreHt ?? null,
      f.awayScoreHt ?? null,
      f.referee ?? null,
      f.venue ?? null,
      f.externalApiFootballId ?? null,
    ],
  );
  return rows[0].id;
}

export async function upsertFixtureTeamStats(
  pool: Pool,
  fixtureId: number,
  teamId: number,
  isHome: boolean,
  stats: {
    shots?: number;
    shotsOnTarget?: number;
    corners?: number;
    fouls?: number;
    yellowCards?: number;
    redCards?: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO fixture_team_stats (fixture_id, team_id, is_home, shots, shots_on_target, corners, fouls, yellow_cards, red_cards)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (fixture_id, team_id) DO UPDATE SET
       shots = EXCLUDED.shots,
       shots_on_target = EXCLUDED.shots_on_target,
       corners = EXCLUDED.corners,
       fouls = EXCLUDED.fouls,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards`,
    [
      fixtureId,
      teamId,
      isHome,
      stats.shots ?? null,
      stats.shotsOnTarget ?? null,
      stats.corners ?? null,
      stats.fouls ?? null,
      stats.yellowCards ?? null,
      stats.redCards ?? null,
    ],
  );
}

/** One multi-row INSERT for both a fixture's team-stats rows (home + away) instead of two separate round-trips. */
export async function upsertFixtureTeamStatsBatch(
  pool: Pool,
  entries: Array<{
    fixtureId: number;
    teamId: number;
    isHome: boolean;
    shots?: number;
    shotsOnTarget?: number;
    corners?: number;
    fouls?: number;
    yellowCards?: number;
    redCards?: number;
  }>,
): Promise<void> {
  if (entries.length === 0) return;
  const params = entries.flatMap((s) => [
    s.fixtureId,
    s.teamId,
    s.isHome,
    s.shots ?? null,
    s.shotsOnTarget ?? null,
    s.corners ?? null,
    s.fouls ?? null,
    s.yellowCards ?? null,
    s.redCards ?? null,
  ]);
  await pool.query(
    `INSERT INTO fixture_team_stats (fixture_id, team_id, is_home, shots, shots_on_target, corners, fouls, yellow_cards, red_cards)
     VALUES ${buildValuesPlaceholders(entries.length, 9)}
     ON CONFLICT (fixture_id, team_id) DO UPDATE SET
       shots = EXCLUDED.shots,
       shots_on_target = EXCLUDED.shots_on_target,
       corners = EXCLUDED.corners,
       fouls = EXCLUDED.fouls,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards`,
    params,
  );
}

export interface FixtureOddsInput {
  fixtureId: number;
  bookmaker: string;
  market: string;
  outcome: string;
  line: number;
  price: number;
  snapshotType: 'opening' | 'closing' | 'live';
  source: string;
}

export async function upsertFixtureOdds(pool: Pool, o: FixtureOddsInput): Promise<void> {
  await pool.query(
    `INSERT INTO fixture_odds (fixture_id, bookmaker, market, outcome, line, price, snapshot_type, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (fixture_id, bookmaker, market, outcome, line, snapshot_type) DO UPDATE SET
       price = EXCLUDED.price,
       recorded_at = now()`,
    [o.fixtureId, o.bookmaker, o.market, o.outcome, o.line, o.price, o.snapshotType, o.source],
  );
}

/**
 * One multi-row INSERT for an entire fixture's odds (~30-60 rows across 8
 * bookmakers x several markets x opening/closing) instead of one
 * round-trip per row. Safe against Postgres's "ON CONFLICT DO UPDATE
 * command cannot affect row a second time" error -- that fires only if two
 * rows in the same batch target the same conflict key
 * (fixture_id, bookmaker, market, outcome, line, snapshot_type). Every
 * bookmaker name is unique within its own market group in
 * football-data-co-uk.ts's bookmaker constants, and match_winner/
 * over_under/asian_handicap never share a market value with each other,
 * so no two rows built from one fixture's CSV row can ever collide.
 */
export async function upsertFixtureOddsBatch(pool: Pool, rows: FixtureOddsInput[]): Promise<void> {
  if (rows.length === 0) return;
  const params = rows.flatMap((o) => [o.fixtureId, o.bookmaker, o.market, o.outcome, o.line, o.price, o.snapshotType, o.source]);
  await pool.query(
    `INSERT INTO fixture_odds (fixture_id, bookmaker, market, outcome, line, price, snapshot_type, source)
     VALUES ${buildValuesPlaceholders(rows.length, 8)}
     ON CONFLICT (fixture_id, bookmaker, market, outcome, line, snapshot_type) DO UPDATE SET
       price = EXCLUDED.price,
       recorded_at = now()`,
    params,
  );
}

export async function upsertFixtureLineup(
  pool: Pool,
  entry: {
    fixtureId: number;
    teamId: number;
    playerId: number;
    isStarting: boolean;
    shirtNumber?: number;
    position?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO fixture_lineups (fixture_id, team_id, player_id, is_starting, shirt_number, position)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (fixture_id, player_id) DO UPDATE SET
       is_starting = EXCLUDED.is_starting,
       shirt_number = COALESCE(EXCLUDED.shirt_number, fixture_lineups.shirt_number),
       position = COALESCE(EXCLUDED.position, fixture_lineups.position)`,
    [entry.fixtureId, entry.teamId, entry.playerId, entry.isStarting, entry.shirtNumber ?? null, entry.position ?? null],
  );
}

/**
 * One multi-row INSERT for every lineup row (startXI + substitutes, both
 * teams) coming out of a single bulk /fixtures?ids=... call -- up to 20
 * fixtures' worth (~800 rows) in one round-trip instead of one per row.
 * Safe against the same-row-twice ON CONFLICT restriction the odds batch
 * above already reasons about: a real player is either in the startXI or
 * the substitutes for a match, never both, so (fixture_id, player_id) can't
 * repeat within one fixture's rows, and fixture_id itself differs across
 * fixtures in the batch.
 */
export async function upsertFixtureLineupsBatch(
  pool: Pool,
  entries: Array<{
    fixtureId: number;
    teamId: number;
    playerId: number;
    isStarting: boolean;
    shirtNumber?: number;
    position?: string;
  }>,
): Promise<void> {
  if (entries.length === 0) return;
  const params = entries.flatMap((e) => [e.fixtureId, e.teamId, e.playerId, e.isStarting, e.shirtNumber ?? null, e.position ?? null]);
  await pool.query(
    `INSERT INTO fixture_lineups (fixture_id, team_id, player_id, is_starting, shirt_number, position)
     VALUES ${buildValuesPlaceholders(entries.length, 6)}
     ON CONFLICT (fixture_id, player_id) DO UPDATE SET
       is_starting = EXCLUDED.is_starting,
       shirt_number = COALESCE(EXCLUDED.shirt_number, fixture_lineups.shirt_number),
       position = COALESCE(EXCLUDED.position, fixture_lineups.position)`,
    params,
  );
}

export interface FixturePlayerStatsInput {
  fixtureId: number;
  teamId: number;
  playerId: number;
  minutesPlayed?: number;
  rating?: number;
  goals?: number;
  assists?: number;
  shots?: number;
  shotsOnTarget?: number;
  passes?: number;
  passesAccuracy?: number;
  tackles?: number;
  interceptions?: number;
  dribblesAttempted?: number;
  dribblesCompleted?: number;
  foulsDrawn?: number;
  foulsCommitted?: number;
  yellowCards?: number;
  redCards?: number;
  penaltiesScored?: number;
  penaltiesMissed?: number;
  saves?: number;
}

export async function upsertFixturePlayerStats(pool: Pool, s: FixturePlayerStatsInput): Promise<void> {
  await pool.query(
    `INSERT INTO fixture_player_stats (
       fixture_id, team_id, player_id, minutes_played, rating, goals, assists,
       shots, shots_on_target, passes, passes_accuracy, tackles, interceptions,
       dribbles_attempted, dribbles_completed, fouls_drawn, fouls_committed,
       yellow_cards, red_cards, penalties_scored, penalties_missed, saves
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     ON CONFLICT (fixture_id, player_id) DO UPDATE SET
       minutes_played = EXCLUDED.minutes_played,
       rating = EXCLUDED.rating,
       goals = EXCLUDED.goals,
       assists = EXCLUDED.assists,
       shots = EXCLUDED.shots,
       shots_on_target = EXCLUDED.shots_on_target,
       passes = EXCLUDED.passes,
       passes_accuracy = EXCLUDED.passes_accuracy,
       tackles = EXCLUDED.tackles,
       interceptions = EXCLUDED.interceptions,
       dribbles_attempted = EXCLUDED.dribbles_attempted,
       dribbles_completed = EXCLUDED.dribbles_completed,
       fouls_drawn = EXCLUDED.fouls_drawn,
       fouls_committed = EXCLUDED.fouls_committed,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards,
       penalties_scored = EXCLUDED.penalties_scored,
       penalties_missed = EXCLUDED.penalties_missed,
       saves = EXCLUDED.saves`,
    [
      s.fixtureId,
      s.teamId,
      s.playerId,
      s.minutesPlayed ?? null,
      s.rating ?? null,
      s.goals ?? null,
      s.assists ?? null,
      s.shots ?? null,
      s.shotsOnTarget ?? null,
      s.passes ?? null,
      s.passesAccuracy ?? null,
      s.tackles ?? null,
      s.interceptions ?? null,
      s.dribblesAttempted ?? null,
      s.dribblesCompleted ?? null,
      s.foulsDrawn ?? null,
      s.foulsCommitted ?? null,
      s.yellowCards ?? null,
      s.redCards ?? null,
      s.penaltiesScored ?? null,
      s.penaltiesMissed ?? null,
      s.saves ?? null,
    ],
  );
}

/**
 * Same batching as upsertFixtureLineupsBatch, for the fixture_player_stats
 * side of one bulk /fixtures?ids=... call -- one INSERT for up to ~800
 * rows (20 fixtures x ~40 players) instead of one round-trip per player.
 * Same (fixture_id, player_id) uniqueness reasoning applies: API-Football's
 * players[] array has one entry per player per fixture.
 */
export async function upsertFixturePlayerStatsBatch(pool: Pool, entries: FixturePlayerStatsInput[]): Promise<void> {
  if (entries.length === 0) return;
  const params = entries.flatMap((s) => [
    s.fixtureId,
    s.teamId,
    s.playerId,
    s.minutesPlayed ?? null,
    s.rating ?? null,
    s.goals ?? null,
    s.assists ?? null,
    s.shots ?? null,
    s.shotsOnTarget ?? null,
    s.passes ?? null,
    s.passesAccuracy ?? null,
    s.tackles ?? null,
    s.interceptions ?? null,
    s.dribblesAttempted ?? null,
    s.dribblesCompleted ?? null,
    s.foulsDrawn ?? null,
    s.foulsCommitted ?? null,
    s.yellowCards ?? null,
    s.redCards ?? null,
    s.penaltiesScored ?? null,
    s.penaltiesMissed ?? null,
    s.saves ?? null,
  ]);
  await pool.query(
    `INSERT INTO fixture_player_stats (
       fixture_id, team_id, player_id, minutes_played, rating, goals, assists,
       shots, shots_on_target, passes, passes_accuracy, tackles, interceptions,
       dribbles_attempted, dribbles_completed, fouls_drawn, fouls_committed,
       yellow_cards, red_cards, penalties_scored, penalties_missed, saves
     ) VALUES ${buildValuesPlaceholders(entries.length, 22)}
     ON CONFLICT (fixture_id, player_id) DO UPDATE SET
       minutes_played = EXCLUDED.minutes_played,
       rating = EXCLUDED.rating,
       goals = EXCLUDED.goals,
       assists = EXCLUDED.assists,
       shots = EXCLUDED.shots,
       shots_on_target = EXCLUDED.shots_on_target,
       passes = EXCLUDED.passes,
       passes_accuracy = EXCLUDED.passes_accuracy,
       tackles = EXCLUDED.tackles,
       interceptions = EXCLUDED.interceptions,
       dribbles_attempted = EXCLUDED.dribbles_attempted,
       dribbles_completed = EXCLUDED.dribbles_completed,
       fouls_drawn = EXCLUDED.fouls_drawn,
       fouls_committed = EXCLUDED.fouls_committed,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards,
       penalties_scored = EXCLUDED.penalties_scored,
       penalties_missed = EXCLUDED.penalties_missed,
       saves = EXCLUDED.saves`,
    params,
  );
}

export interface FplPlayerGameweekStatsInput {
  playerId: number;
  gameweekId: number;
  nowCost?: number;
  totalPoints?: number;
  minutes?: number;
  goalsScored?: number;
  assists?: number;
  cleanSheets?: number;
  goalsConceded?: number;
  ownGoals?: number;
  penaltiesSaved?: number;
  penaltiesMissed?: number;
  yellowCards?: number;
  redCards?: number;
  saves?: number;
  bonus?: number;
  bps?: number;
  influence?: number;
  creativity?: number;
  threat?: number;
  ictIndex?: number;
}

// selected_by_percent is deliberately never set here -- FPL's per-gameweek
// element-summary endpoint only gives a raw ownership *count* at that point
// in time, not the percent bootstrap-static reports for the current
// snapshot. Left null for historical rows rather than faked from a count
// without knowing that gameweek's total manager count.
export async function upsertFplPlayerGameweekStats(pool: Pool, s: FplPlayerGameweekStatsInput): Promise<void> {
  await pool.query(
    `INSERT INTO fpl_player_gameweek_stats (
       player_id, gameweek_id, now_cost, total_points, minutes, goals_scored, assists,
       clean_sheets, goals_conceded, own_goals, penalties_saved, penalties_missed,
       yellow_cards, red_cards, saves, bonus, bps, influence, creativity, threat, ict_index
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (player_id, gameweek_id) DO UPDATE SET
       now_cost = EXCLUDED.now_cost,
       total_points = EXCLUDED.total_points,
       minutes = EXCLUDED.minutes,
       goals_scored = EXCLUDED.goals_scored,
       assists = EXCLUDED.assists,
       clean_sheets = EXCLUDED.clean_sheets,
       goals_conceded = EXCLUDED.goals_conceded,
       own_goals = EXCLUDED.own_goals,
       penalties_saved = EXCLUDED.penalties_saved,
       penalties_missed = EXCLUDED.penalties_missed,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards,
       saves = EXCLUDED.saves,
       bonus = EXCLUDED.bonus,
       bps = EXCLUDED.bps,
       influence = EXCLUDED.influence,
       creativity = EXCLUDED.creativity,
       threat = EXCLUDED.threat,
       ict_index = EXCLUDED.ict_index`,
    [
      s.playerId,
      s.gameweekId,
      s.nowCost ?? null,
      s.totalPoints ?? null,
      s.minutes ?? null,
      s.goalsScored ?? null,
      s.assists ?? null,
      s.cleanSheets ?? null,
      s.goalsConceded ?? null,
      s.ownGoals ?? null,
      s.penaltiesSaved ?? null,
      s.penaltiesMissed ?? null,
      s.yellowCards ?? null,
      s.redCards ?? null,
      s.saves ?? null,
      s.bonus ?? null,
      s.bps ?? null,
      s.influence ?? null,
      s.creativity ?? null,
      s.threat ?? null,
      s.ictIndex ?? null,
    ],
  );
}

export async function findFixtureId(
  pool: Pool,
  competitionSeasonId: number,
  homeTeamId: number,
  awayTeamId: number,
  kickoffDate: string,
): Promise<number | undefined> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM fixtures
     WHERE competition_season_id = $1 AND home_team_id = $2 AND away_team_id = $3 AND kickoff_date = $4`,
    [competitionSeasonId, homeTeamId, awayTeamId, kickoffDate],
  );
  return rows[0]?.id;
}
