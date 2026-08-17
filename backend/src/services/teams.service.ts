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

export async function listTeams(filters: { competitionName?: string } = {}): Promise<Team[]> {
  // A single bad competitionName (typo, or a competition outside the
  // dashboard's scope like FA Cup) should mean "no results," not "ignore
  // the filter" -- narrowed against DASHBOARD_COMPETITIONS rather than
  // passed through raw, so /api/teams?competition=FA%20Cup can't be used
  // to pull FA-Cup-only minnows into a page that's only ever meant to show
  // Premier League/Championship sides.
  const competitions = filters.competitionName
    ? DASHBOARD_COMPETITIONS.filter((c) => c === filters.competitionName)
    : DASHBOARD_COMPETITIONS;

  // Scoped to each competition's most recent season, not "ever played a
  // fixture in this competition" -- real bug, found on the live site: a
  // team relegated out of the Premier League in an earlier stored season
  // (3 years of historical data are kept for model training, see
  // docs/CLAUDE.md) still showed up under "Premier League" here, since the
  // old unscoped join only checked competition, never season. is_current on
  // competition_seasons isn't reliably set yet (see getTablePosition's own
  // note below), so most-recent-by-start_date is the same stand-in already
  // used there, applied per competition independently via the correlated
  // subquery (Premier League and Championship don't necessarily share a
  // "most recent" season row).
  const { rows } = await pool.query<{ id: number; name: string; short_name: string | null; logo_url: string | null }>(
    `SELECT DISTINCT t.id, t.name, t.short_name, t.logo_url
     FROM teams t
     JOIN fixtures f ON f.home_team_id = t.id OR f.away_team_id = t.id
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     WHERE c.name = ANY($1)
       AND s.start_date = (
         SELECT max(s2.start_date)
         FROM competition_seasons cs2
         JOIN seasons s2 ON s2.id = cs2.season_id
         WHERE cs2.competition_id = c.id
       )
     ORDER BY t.name`,
    [competitions],
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
  homeTeam: { id: number; name: string; shortName: string | null; logoUrl: string | null };
  awayTeam: { id: number; name: string; shortName: string | null; logoUrl: string | null };
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
       ht.id AS home_team_id, ht.name AS home_team_name, ht.short_name AS home_team_short_name, ht.logo_url AS home_team_logo_url,
       at.id AS away_team_id, at.name AS away_team_name, at.short_name AS away_team_short_name, at.logo_url AS away_team_logo_url
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
    homeTeam: { id: fixture.home_team_id, name: fixture.home_team_name, shortName: fixture.home_team_short_name, logoUrl: fixture.home_team_logo_url },
    awayTeam: { id: fixture.away_team_id, name: fixture.away_team_name, shortName: fixture.away_team_short_name, logoUrl: fixture.away_team_logo_url },
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

export interface StandingsRow {
  position: number;
  team: Team;
  played: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
}

export interface Standings {
  competitionName: string;
  seasonLabel: string;
  rows: StandingsRow[];
}

// The whole-table sibling of getTablePosition above -- same "most recent
// season by start_date" stand-in (competition_seasons.is_current isn't
// wired up yet, see docs/erd.md) and the same team_fixture_results view,
// just grouped by every team in the season instead of filtered to one.
export async function getStandings(competitionName: string): Promise<Standings | undefined> {
  if (!DASHBOARD_COMPETITIONS.includes(competitionName)) return undefined;

  const relevantSeason = await pool.query(
    `SELECT cs.id AS competition_season_id, c.name AS competition_name, s.label AS season_label
     FROM competition_seasons cs
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     WHERE c.name = $1
     ORDER BY s.start_date DESC
     LIMIT 1`,
    [competitionName],
  );
  const season = relevantSeason.rows[0];
  if (!season) return undefined;

  const { rows } = await pool.query(
    `SELECT tfr.team_id, t.name, t.short_name, t.logo_url,
       count(*) AS played, sum(points) AS points,
       sum(goals_for) AS goals_for, sum(goals_against) AS goals_against,
       row_number() OVER (
         ORDER BY sum(points) DESC, sum(goals_for) - sum(goals_against) DESC, sum(goals_for) DESC
       ) AS position
     FROM team_fixture_results tfr
     JOIN teams t ON t.id = tfr.team_id
     WHERE tfr.competition_season_id = $1 AND tfr.result IS NOT NULL
     GROUP BY tfr.team_id, t.name, t.short_name, t.logo_url
     ORDER BY position`,
    [season.competition_season_id],
  );

  return {
    competitionName: season.competition_name,
    seasonLabel: season.season_label,
    rows: rows.map((r) => ({
      position: Number(r.position),
      team: { id: r.team_id, name: r.name, shortName: r.short_name, logoUrl: r.logo_url },
      played: Number(r.played),
      points: Number(r.points),
      goalsFor: Number(r.goals_for),
      goalsAgainst: Number(r.goals_against),
      goalDifference: Number(r.goals_for) - Number(r.goals_against),
    })),
  };
}

export interface TeamFormMatch {
  fixtureId: number;
  kickoffDate: string;
  competitionName: string;
  opponent: { id: number; name: string; logoUrl: string | null };
  isHome: boolean;
  goalsFor: number;
  goalsAgainst: number;
  result: 'W' | 'D' | 'L';
}

export interface TeamForm {
  matches: TeamFormMatch[]; // most recent first
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
}

const FORM_MATCHES = 5;

// Across every competition the team's played, not just its current
// league season -- "form" in the everyday football sense means the last
// few results regardless of competition (a cup match still tells you
// something about how a team's playing right now), unlike tablePosition
// above which is deliberately scoped to one league table.
async function getTeamForm(teamId: number): Promise<TeamForm> {
  const { rows } = await pool.query(
    `SELECT tfr.fixture_id, tfr.kickoff_date, c.name AS competition_name,
       tfr.opponent_team_id, o.name AS opponent_name, o.logo_url AS opponent_logo_url,
       tfr.is_home, tfr.goals_for, tfr.goals_against, tfr.result
     FROM team_fixture_results tfr
     JOIN teams o ON o.id = tfr.opponent_team_id
     JOIN competition_seasons cs ON cs.id = tfr.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     WHERE tfr.team_id = $1 AND tfr.result IS NOT NULL
     ORDER BY tfr.kickoff_date DESC
     LIMIT $2`,
    [teamId, FORM_MATCHES],
  );

  const matches: TeamFormMatch[] = rows.map((r) => ({
    fixtureId: r.fixture_id,
    kickoffDate: r.kickoff_date,
    competitionName: r.competition_name,
    opponent: { id: r.opponent_team_id, name: r.opponent_name, logoUrl: r.opponent_logo_url },
    isHome: r.is_home,
    goalsFor: r.goals_for,
    goalsAgainst: r.goals_against,
    result: r.result,
  }));

  return {
    matches,
    wins: matches.filter((m) => m.result === 'W').length,
    draws: matches.filter((m) => m.result === 'D').length,
    losses: matches.filter((m) => m.result === 'L').length,
    goalsFor: matches.reduce((acc, m) => acc + m.goalsFor, 0),
    goalsAgainst: matches.reduce((acc, m) => acc + m.goalsAgainst, 0),
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

export interface TeamStatLeader {
  playerId: number;
  fullName: string;
  photoUrl: string | null;
  value: number;
}

export interface TeamTopStats {
  seasonLabel: string;
  topScorers: TeamStatLeader[];
  topAssisters: TeamStatLeader[];
}

const TOP_STATS_LEADERS_SHOWN = 3;

// fixture_player_stats.team_id (not players.current_team_id) is the
// source of "played for this team" here -- it records who a player
// actually turned out for in each specific match, so a mid-season
// transfer's stats split correctly between old and new club instead of
// all landing on whichever team they're on today. Same reasoning as the
// "most recent club" fix in model-service/app/data.py the same week: team
// attribution should come from the appearance record itself, not a
// current-roster pointer.
async function getTeamTopStats(teamId: number): Promise<TeamTopStats | undefined> {
  const relevantSeason = await pool.query(
    `SELECT cs.id AS competition_season_id, s.label AS season_label
     FROM competition_seasons cs
     JOIN seasons s ON s.id = cs.season_id
     JOIN competitions c ON c.id = cs.competition_id
     JOIN fixtures f ON f.competition_season_id = cs.id AND (f.home_team_id = $1 OR f.away_team_id = $1)
     WHERE c.name = ANY($2)
     ORDER BY s.start_date DESC
     LIMIT 1`,
    [teamId, DASHBOARD_COMPETITIONS],
  );
  const season = relevantSeason.rows[0];
  if (!season) return undefined;

  const { rows } = await pool.query<{
    player_id: number;
    full_name: string;
    photo_url: string | null;
    goals: string;
    assists: string;
  }>(
    `SELECT p.id AS player_id, p.full_name, p.photo_url,
       coalesce(sum(fps.goals), 0) AS goals,
       coalesce(sum(fps.assists), 0) AS assists
     FROM fixture_player_stats fps
     JOIN fixtures f ON f.id = fps.fixture_id
     JOIN players p ON p.id = fps.player_id
     WHERE fps.team_id = $1 AND f.competition_season_id = $2 AND f.status = 'finished'
     GROUP BY p.id, p.full_name, p.photo_url`,
    [teamId, season.competition_season_id],
  );

  const toLeader = (r: (typeof rows)[number], value: number): TeamStatLeader => ({
    playerId: r.player_id,
    fullName: r.full_name,
    photoUrl: r.photo_url,
    value,
  });

  const topScorers = rows
    .map((r) => toLeader(r, Number(r.goals)))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_STATS_LEADERS_SHOWN);
  const topAssisters = rows
    .map((r) => toLeader(r, Number(r.assists)))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_STATS_LEADERS_SHOWN);

  return { seasonLabel: season.season_label, topScorers, topAssisters };
}

export interface TeamDashboard {
  team: Team;
  nextMatch: NextMatch | undefined;
  tablePosition: TablePosition | undefined;
  form: TeamForm;
  squad: SquadPlayer[];
  topStats: TeamTopStats | undefined;
}

export async function getTeamDashboard(id: number): Promise<TeamDashboard | undefined> {
  const team = await getTeamById(id);
  if (!team) return undefined;

  const [nextMatch, tablePosition, form, squad, topStats] = await Promise.all([
    getNextMatch(id),
    getTablePosition(id),
    getTeamForm(id),
    getSquad(id),
    getTeamTopStats(id),
  ]);
  return { team, nextMatch, tablePosition, form, squad, topStats };
}
