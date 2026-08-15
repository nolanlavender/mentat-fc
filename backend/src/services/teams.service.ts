import { pool } from '../db/pool.js';

// Team dashboards cover Premier League + Championship (see docs/CLAUDE.md's
// "Data scope vs. app scope") -- this is the one constant every team-listing
// query in this service filters against.
const DASHBOARD_COMPETITIONS = ['Premier League', 'Championship'];

export interface Team {
  id: number;
  name: string;
  shortName: string | null;
  logoUrl: string | null;
}

export async function listTeams(): Promise<Team[]> {
  const { rows } = await pool.query<{ id: number; name: string; short_name: string | null; logo_url: string | null }>(
    `SELECT DISTINCT t.id, t.name, t.short_name, t.logo_url
     FROM teams t
     JOIN fixtures f ON f.home_team_id = t.id OR f.away_team_id = t.id
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     WHERE c.name = ANY($1)
     ORDER BY t.name`,
    [DASHBOARD_COMPETITIONS],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, shortName: r.short_name, logoUrl: r.logo_url }));
}

export async function getTeamById(id: number): Promise<Team | undefined> {
  const { rows } = await pool.query<{ id: number; name: string; short_name: string | null; logo_url: string | null }>(
    `SELECT id, name, short_name, logo_url FROM teams WHERE id = $1`,
    [id],
  );
  if (!rows[0]) return undefined;
  return { id: rows[0].id, name: rows[0].name, shortName: rows[0].short_name, logoUrl: rows[0].logo_url };
}

export interface NextMatch {
  fixtureId: number;
  kickoffAt: string;
  status: string;
  round: string | null;
  competitionName: string;
  homeTeam: { id: number; name: string; logoUrl: string | null };
  awayTeam: { id: number; name: string; logoUrl: string | null };
  prediction: {
    modelVersion: string;
    probHomeWin: number;
    probDraw: number;
    probAwayWin: number;
    predictedHomeGoals: number | null;
    predictedAwayGoals: number | null;
  } | null;
}

async function getNextMatch(teamId: number): Promise<NextMatch | undefined> {
  // Not filtered to PL/Championship: an FA Cup tie against an eligible
  // opponent still gets shown (and, once Phase 5 exists, a prediction) --
  // an FA Cup tie against a lower-tier opponent still shows as the next
  // match, it just naturally has no prediction row to join against yet.
  // See docs/CLAUDE.md's "Data scope vs. app scope."
  const { rows } = await pool.query(
    `SELECT f.id, f.kickoff_at, f.status, f.round, c.name AS competition_name,
       ht.id AS home_team_id, ht.name AS home_team_name, ht.logo_url AS home_team_logo_url,
       at.id AS away_team_id, at.name AS away_team_name, at.logo_url AS away_team_logo_url
     FROM fixtures f
     JOIN teams ht ON ht.id = f.home_team_id
     JOIN teams at ON at.id = f.away_team_id
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     WHERE (f.home_team_id = $1 OR f.away_team_id = $1)
       AND f.kickoff_at > now()
     ORDER BY f.kickoff_at ASC
     LIMIT 1`,
    [teamId],
  );
  const fixture = rows[0];
  if (!fixture) return undefined;

  const prediction = await pool.query(
    `SELECT model_version, prob_home_win, prob_draw, prob_away_win, predicted_home_goals, predicted_away_goals
     FROM model_predictions
     WHERE fixture_id = $1
     ORDER BY predicted_at DESC
     LIMIT 1`,
    [fixture.id],
  );
  const p = prediction.rows[0];

  return {
    fixtureId: fixture.id,
    kickoffAt: fixture.kickoff_at,
    status: fixture.status,
    round: fixture.round,
    competitionName: fixture.competition_name,
    homeTeam: { id: fixture.home_team_id, name: fixture.home_team_name, logoUrl: fixture.home_team_logo_url },
    awayTeam: { id: fixture.away_team_id, name: fixture.away_team_name, logoUrl: fixture.away_team_logo_url },
    prediction: p
      ? {
          modelVersion: p.model_version,
          probHomeWin: Number(p.prob_home_win),
          probDraw: Number(p.prob_draw),
          probAwayWin: Number(p.prob_away_win),
          predictedHomeGoals: p.predicted_home_goals === null ? null : Number(p.predicted_home_goals),
          predictedAwayGoals: p.predicted_away_goals === null ? null : Number(p.predicted_away_goals),
        }
      : null,
  };
}

export interface TablePosition {
  competitionName: string;
  seasonLabel: string;
  position: number;
  played: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
}

async function getTablePosition(teamId: number): Promise<TablePosition | undefined> {
  // "Current" competition-season isn't reliably flagged yet (is_current on
  // competition_seasons is designed but nothing sets it -- see
  // docs/erd.md); most-recent-by-season-start-date is a safe stand-in until
  // that's wired up.
  const relevantSeason = await pool.query(
    `SELECT cs.id AS competition_season_id, c.name AS competition_name, s.label AS season_label
     FROM competition_seasons cs
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     JOIN fixtures f ON f.competition_season_id = cs.id AND (f.home_team_id = $1 OR f.away_team_id = $1)
     WHERE c.name = ANY($2)
     ORDER BY s.start_date DESC
     LIMIT 1`,
    [teamId, DASHBOARD_COMPETITIONS],
  );
  const season = relevantSeason.rows[0];
  if (!season) return undefined;

  const standings = await pool.query(
    `SELECT team_id, count(*) AS played, sum(points) AS points,
       sum(goals_for) AS goals_for, sum(goals_against) AS goals_against,
       row_number() OVER (
         ORDER BY sum(points) DESC, sum(goals_for) - sum(goals_against) DESC, sum(goals_for) DESC
       ) AS position
     FROM team_fixture_results
     WHERE competition_season_id = $1 AND result IS NOT NULL
     GROUP BY team_id`,
    [season.competition_season_id],
  );
  const row = standings.rows.find((r) => r.team_id === teamId);
  if (!row) return undefined;

  return {
    competitionName: season.competition_name,
    seasonLabel: season.season_label,
    position: Number(row.position),
    played: Number(row.played),
    points: Number(row.points),
    goalsFor: Number(row.goals_for),
    goalsAgainst: Number(row.goals_against),
  };
}

export interface SquadPlayer {
  id: number;
  fullName: string;
  position: string | null;
  photoUrl: string | null;
}

async function getSquad(teamId: number): Promise<SquadPlayer[]> {
  // Populated from FPL (players.current_team_id), Premier League only --
  // FPL has no Championship data. Championship team dashboards get an empty
  // squad until fixture_lineups is backfilled and becomes the real source
  // for this. See docs/erd.md's note on players.current_team_id.
  const { rows } = await pool.query<{ id: number; full_name: string; position: string | null; photo_url: string | null }>(
    `SELECT id, full_name, position, photo_url FROM players WHERE current_team_id = $1 ORDER BY position, full_name`,
    [teamId],
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, position: r.position, photoUrl: r.photo_url }));
}

export interface TeamDashboard {
  team: Team;
  nextMatch: NextMatch | undefined;
  tablePosition: TablePosition | undefined;
  squad: SquadPlayer[];
}

export async function getTeamDashboard(id: number): Promise<TeamDashboard | undefined> {
  const team = await getTeamById(id);
  if (!team) return undefined;

  const [nextMatch, tablePosition, squad] = await Promise.all([getNextMatch(id), getTablePosition(id), getSquad(id)]);
  return { team, nextMatch, tablePosition, squad };
}
