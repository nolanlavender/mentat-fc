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

// Teams' golden-record key (natural_key, a generated column hashing the
// normalized name -- see migration 1701000000013) makes this a single
// upsert instead of a select-then-insert: any source computes the same key
// for "Manchester United" and lands on the same row, as long as
// canonicalTeamName() has already resolved source-specific short names to
// the canonical one before this is called.
export async function getOrCreateTeam(pool: Pool, name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO teams (name) VALUES ($1)
     ON CONFLICT (natural_key) DO UPDATE SET name = teams.name
     RETURNING id`,
    [name],
  );
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
 * between them). players.natural_key (full name + date of birth, generated
 * column) is the merge target when we know a DOB.
 *
 * When we don't know a DOB -- the normal case for a player only seen via
 * API-Football's lineup endpoint, which gives a name and shirt number but
 * not a birth date -- we reconcile by name against an existing row (e.g.
 * one FPL already seeded with a real DOB) before falling back to inserting
 * under the DOB-less natural_key. That fallback isn't perfect: two
 * genuinely different real players sharing an exact name and both missing
 * a DOB would incorrectly merge. Acceptable at Premier League/Championship
 * scale; revisit if FA Cup's lower-tier entrants make that collision
 * observably real.
 */
export async function upsertPlayerGoldenRecord(pool: Pool, p: PlayerInput): Promise<number> {
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
