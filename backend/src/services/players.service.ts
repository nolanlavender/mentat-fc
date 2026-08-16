import { pool } from '../db/pool.js';

export interface Player {
  id: number;
  fullName: string;
  dateOfBirth: string | null;
  nationality: string | null;
  position: string | null;
  photoUrl: string | null;
  currentTeam: { id: number; name: string; logoUrl: string | null } | null;
}

const MAX_LIMIT = 200;

function mapPlayerRow(r: {
  id: number;
  full_name: string;
  date_of_birth: string | null;
  nationality: string | null;
  position: string | null;
  photo_url: string | null;
  team_id: number | null;
  team_name: string | null;
  team_logo_url: string | null;
}): Player {
  return {
    id: r.id,
    fullName: r.full_name,
    dateOfBirth: r.date_of_birth,
    nationality: r.nationality,
    position: r.position,
    photoUrl: r.photo_url,
    currentTeam: r.team_id ? { id: r.team_id, name: r.team_name!, logoUrl: r.team_logo_url } : null,
  };
}

const PLAYER_SELECT = `
  SELECT p.id, p.full_name, p.date_of_birth, p.nationality, p.position, p.photo_url,
    t.id AS team_id, t.name AS team_name, t.logo_url AS team_logo_url
  FROM players p
  LEFT JOIN teams t ON t.id = p.current_team_id
`;

export async function listPlayers(filters: { teamId?: number; limit?: number }): Promise<Player[]> {
  const limit = Math.min(filters.limit ?? 50, MAX_LIMIT);

  const { rows } = await pool.query(
    `${PLAYER_SELECT}
     WHERE ($1::int IS NULL OR p.current_team_id = $1)
     ORDER BY p.full_name
     LIMIT $2`,
    [filters.teamId ?? null, limit],
  );

  return rows.map(mapPlayerRow);
}

export async function getPlayerById(id: number): Promise<Player | undefined> {
  const { rows } = await pool.query(`${PLAYER_SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? mapPlayerRow(rows[0]) : undefined;
}

export interface PlayerGameLogEntry {
  fixtureId: number;
  kickoffAt: string;
  competitionName: string;
  seasonLabel: string;
  isHome: boolean;
  opponent: { id: number; name: string; logoUrl: string | null };
  homeScore: number | null;
  awayScore: number | null;
  minutesPlayed: number | null;
  goals: number | null;
  assists: number | null;
  rating: number | null;
  yellowCards: number | null;
  redCards: number | null;
}

export interface PlayerFormSummary {
  matches: number;
  goals: number;
  assists: number;
  minutesPlayed: number;
  avgRating: number | null;
}

export interface PlayerSeasonStats extends PlayerFormSummary {
  seasonLabel: string;
  yellowCards: number;
  redCards: number;
}

export interface PlayerDetail extends Player {
  seasonStats: PlayerSeasonStats | null;
  last5Form: PlayerFormSummary | null;
  last30DaysForm: PlayerFormSummary | null;
  gameLog: PlayerGameLogEntry[];
}

const GAME_LOG_LIMIT = 5;

// Most-recent season this player actually has a stats row in, not "the
// current calendar season" -- a player with no recent appearances (injury,
// out of the squad, moved leagues) still gets *a* real season's totals
// rather than an empty one just because today's date rolled over.
async function getSeasonStats(playerId: number): Promise<PlayerSeasonStats | null> {
  const { rows } = await pool.query(
    `SELECT s.label AS season_label,
       count(*) AS matches,
       coalesce(sum(fps.goals), 0) AS goals,
       coalesce(sum(fps.assists), 0) AS assists,
       coalesce(sum(fps.minutes_played), 0) AS minutes_played,
       avg(fps.rating) AS avg_rating,
       coalesce(sum(fps.yellow_cards), 0) AS yellow_cards,
       coalesce(sum(fps.red_cards), 0) AS red_cards
     FROM fixture_player_stats fps
     JOIN fixtures f ON f.id = fps.fixture_id
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN seasons s ON s.id = cs.season_id
     WHERE fps.player_id = $1 AND f.status = 'finished'
     GROUP BY s.id, s.label, s.start_date
     ORDER BY s.start_date DESC
     LIMIT 1`,
    [playerId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    seasonLabel: r.season_label,
    matches: Number(r.matches),
    goals: Number(r.goals),
    assists: Number(r.assists),
    minutesPlayed: Number(r.minutes_played),
    avgRating: r.avg_rating === null ? null : Number(r.avg_rating),
    yellowCards: Number(r.yellow_cards),
    redCards: Number(r.red_cards),
  };
}

async function getLast30DaysForm(playerId: number): Promise<PlayerFormSummary | null> {
  const { rows } = await pool.query(
    `SELECT count(*) AS matches,
       coalesce(sum(fps.goals), 0) AS goals,
       coalesce(sum(fps.assists), 0) AS assists,
       coalesce(sum(fps.minutes_played), 0) AS minutes_played,
       avg(fps.rating) AS avg_rating
     FROM fixture_player_stats fps
     JOIN fixtures f ON f.id = fps.fixture_id
     WHERE fps.player_id = $1 AND f.status = 'finished' AND f.kickoff_at >= now() - interval '30 days'`,
    [playerId],
  );
  const r = rows[0];
  if (!r || Number(r.matches) === 0) return null;
  return {
    matches: Number(r.matches),
    goals: Number(r.goals),
    assists: Number(r.assists),
    minutesPlayed: Number(r.minutes_played),
    avgRating: r.avg_rating === null ? null : Number(r.avg_rating),
  };
}

async function getGameLog(playerId: number): Promise<PlayerGameLogEntry[]> {
  const { rows } = await pool.query(
    `SELECT f.id AS fixture_id, f.kickoff_at, c.name AS competition_name, s.label AS season_label,
       f.home_score, f.away_score,
       (fps.team_id = f.home_team_id) AS is_home,
       CASE WHEN fps.team_id = f.home_team_id THEN at.id ELSE ht.id END AS opponent_id,
       CASE WHEN fps.team_id = f.home_team_id THEN at.name ELSE ht.name END AS opponent_name,
       CASE WHEN fps.team_id = f.home_team_id THEN at.logo_url ELSE ht.logo_url END AS opponent_logo_url,
       fps.minutes_played, fps.goals, fps.assists, fps.rating, fps.yellow_cards, fps.red_cards
     FROM fixture_player_stats fps
     JOIN fixtures f ON f.id = fps.fixture_id
     JOIN teams ht ON ht.id = f.home_team_id
     JOIN teams at ON at.id = f.away_team_id
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     WHERE fps.player_id = $1 AND f.status = 'finished'
     ORDER BY f.kickoff_at DESC
     LIMIT $2`,
    [playerId, GAME_LOG_LIMIT],
  );

  return rows.map((r) => ({
    fixtureId: r.fixture_id,
    kickoffAt: r.kickoff_at,
    competitionName: r.competition_name,
    seasonLabel: r.season_label,
    isHome: r.is_home,
    opponent: { id: r.opponent_id, name: r.opponent_name, logoUrl: r.opponent_logo_url },
    homeScore: r.home_score,
    awayScore: r.away_score,
    minutesPlayed: r.minutes_played,
    goals: r.goals,
    assists: r.assists,
    rating: r.rating === null ? null : Number(r.rating),
    yellowCards: r.yellow_cards,
    redCards: r.red_cards,
  }));
}

// "Last 5 matches" form is derived from the game log's own rows (it's
// already the last 5, no separate query needed) -- "last 30 days" needs
// its own query since that window can hold a different number of matches
// entirely, not just a shorter/longer prefix of the same 5.
function summarizeLast5(gameLog: PlayerGameLogEntry[]): PlayerFormSummary | null {
  if (gameLog.length === 0) return null;
  const ratedMatches = gameLog.filter((g) => g.rating !== null);
  return {
    matches: gameLog.length,
    goals: gameLog.reduce((acc, g) => acc + (g.goals ?? 0), 0),
    assists: gameLog.reduce((acc, g) => acc + (g.assists ?? 0), 0),
    minutesPlayed: gameLog.reduce((acc, g) => acc + (g.minutesPlayed ?? 0), 0),
    avgRating: ratedMatches.length > 0 ? ratedMatches.reduce((acc, g) => acc + g.rating!, 0) / ratedMatches.length : null,
  };
}

export async function getPlayerDetail(id: number): Promise<PlayerDetail | undefined> {
  const player = await getPlayerById(id);
  if (!player) return undefined;

  const [seasonStats, last30DaysForm, gameLog] = await Promise.all([
    getSeasonStats(id),
    getLast30DaysForm(id),
    getGameLog(id),
  ]);

  return {
    ...player,
    seasonStats,
    last30DaysForm,
    last5Form: summarizeLast5(gameLog),
    gameLog,
  };
}
