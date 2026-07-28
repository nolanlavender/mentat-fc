import type { Pool } from 'pg';

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

export async function getOrCreateTeam(pool: Pool, name: string): Promise<number> {
  const existing = await pool.query<{ id: number }>(`SELECT id FROM teams WHERE name = $1`, [name]);
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await pool.query<{ id: number }>(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [name]);
  return inserted.rows[0].id;
}

export async function setTeamExternalFplId(pool: Pool, teamId: number, externalFplId: number): Promise<void> {
  await pool.query(`UPDATE teams SET external_fpl_id = $2 WHERE id = $1`, [teamId, externalFplId]);
}

export interface PlayerInput {
  externalFplId?: number;
  externalApiFootballId?: number;
  fullName: string;
  dateOfBirth?: string;
  nationality?: string;
  position?: string;
}

export async function upsertPlayerByFplId(pool: Pool, p: PlayerInput & { externalFplId: number }): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO players (external_fpl_id, full_name, date_of_birth, nationality, position)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (external_fpl_id) DO UPDATE SET
       full_name = EXCLUDED.full_name,
       date_of_birth = COALESCE(EXCLUDED.date_of_birth, players.date_of_birth),
       position = COALESCE(EXCLUDED.position, players.position)
     RETURNING id`,
    [p.externalFplId, p.fullName, p.dateOfBirth ?? null, p.nationality ?? null, p.position ?? null],
  );
  return rows[0].id;
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

export async function upsertPlayerByApiFootballId(
  pool: Pool,
  p: PlayerInput & { externalApiFootballId: number },
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO players (external_api_football_id, full_name, date_of_birth, nationality, position)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (external_api_football_id) DO UPDATE SET
       full_name = EXCLUDED.full_name,
       date_of_birth = COALESCE(EXCLUDED.date_of_birth, players.date_of_birth),
       nationality = COALESCE(EXCLUDED.nationality, players.nationality),
       position = COALESCE(EXCLUDED.position, players.position)
     RETURNING id`,
    [p.externalApiFootballId, p.fullName, p.dateOfBirth ?? null, p.nationality ?? null, p.position ?? null],
  );
  return rows[0].id;
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
