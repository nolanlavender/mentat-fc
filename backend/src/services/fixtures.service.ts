import { pool } from '../db/pool.js';

export interface PredictionSummary {
  modelVersion: string;
  probHomeWin: number;
  probDraw: number;
  probAwayWin: number;
  predictedHomeGoals: number | null;
  predictedAwayGoals: number | null;
}

export interface ScorerPrediction {
  playerId: number;
  playerName: string;
  teamId: number;
  expectedGoals: number;
  probScores: number;
}

const TOP_SCORERS_PER_FIXTURE = 5;

export interface FixtureSummary {
  id: number;
  kickoffAt: string;
  status: string;
  round: string | null;
  homeScore: number | null;
  awayScore: number | null;
  competitionName: string;
  seasonLabel: string;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  // null whenever no model has run for this fixture yet -- e.g. FA Cup
  // (deliberately unmodeled, see docs/CLAUDE.md) or a newly-seeded
  // current-season fixture app.train hasn't predicted yet. Degrade
  // gracefully, same pattern as the rest of the app, not an error state.
  prediction: PredictionSummary | null;
  // Empty, not null, when nothing's been predicted (a player-shares model
  // that ran before both teams had enough appearance data, or app.train
  // simply hasn't run for this fixture yet) -- there's no meaningful
  // "no scorers exist" state to distinguish from "not predicted yet", so
  // both just render as an empty list rather than needing a null check.
  topScorers: ScorerPrediction[];
}

export interface ListFixturesFilters {
  competitionName?: string;
  teamId?: number;
  from?: string;
  to?: string;
  limit?: number;
}

const MAX_LIMIT = 200;

export async function listFixtures(filters: ListFixturesFilters): Promise<FixtureSummary[]> {
  const limit = Math.min(filters.limit ?? 50, MAX_LIMIT);

  const { rows } = await pool.query(
    `SELECT f.id, f.kickoff_at, f.status, f.round, f.home_score, f.away_score,
       c.name AS competition_name, s.label AS season_label,
       ht.id AS home_team_id, ht.name AS home_team_name,
       at.id AS away_team_id, at.name AS away_team_name,
       mp.model_version, mp.prob_home_win, mp.prob_draw, mp.prob_away_win,
       mp.predicted_home_goals, mp.predicted_away_goals,
       COALESCE(scorers.top_scorers, '[]') AS top_scorers
     FROM fixtures f
     JOIN teams ht ON ht.id = f.home_team_id
     JOIN teams at ON at.id = f.away_team_id
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     LEFT JOIN LATERAL (
       SELECT model_version, prob_home_win, prob_draw, prob_away_win, predicted_home_goals, predicted_away_goals
       FROM model_predictions mp2
       WHERE mp2.fixture_id = f.id
       ORDER BY predicted_at DESC
       LIMIT 1
     ) mp ON true
     LEFT JOIN LATERAL (
       SELECT json_agg(top ORDER BY (top ->> 'probScores')::numeric DESC) AS top_scorers
       FROM (
         SELECT json_build_object(
           'playerId', pgp.player_id, 'playerName', p.full_name, 'teamId', pgp.team_id,
           'expectedGoals', pgp.expected_goals, 'probScores', pgp.prob_scores
         ) AS top
         FROM player_goal_predictions pgp
         JOIN players p ON p.id = pgp.player_id
         WHERE pgp.fixture_id = f.id
         ORDER BY pgp.prob_scores DESC
         LIMIT ${TOP_SCORERS_PER_FIXTURE}
       ) ranked
     ) scorers ON true
     WHERE ($1::text IS NULL OR c.name = $1)
       AND ($2::int IS NULL OR f.home_team_id = $2 OR f.away_team_id = $2)
       AND ($3::timestamptz IS NULL OR f.kickoff_at >= $3)
       AND ($4::timestamptz IS NULL OR f.kickoff_at <= $4)
     ORDER BY f.kickoff_at ASC
     LIMIT $5`,
    [filters.competitionName ?? null, filters.teamId ?? null, filters.from ?? null, filters.to ?? null, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    kickoffAt: r.kickoff_at,
    status: r.status,
    round: r.round,
    homeScore: r.home_score,
    awayScore: r.away_score,
    competitionName: r.competition_name,
    seasonLabel: r.season_label,
    homeTeam: { id: r.home_team_id, name: r.home_team_name },
    awayTeam: { id: r.away_team_id, name: r.away_team_name },
    prediction:
      r.prob_home_win === null
        ? null
        : {
            modelVersion: r.model_version,
            probHomeWin: Number(r.prob_home_win),
            probDraw: Number(r.prob_draw),
            probAwayWin: Number(r.prob_away_win),
            predictedHomeGoals: r.predicted_home_goals === null ? null : Number(r.predicted_home_goals),
            predictedAwayGoals: r.predicted_away_goals === null ? null : Number(r.predicted_away_goals),
          },
    topScorers: mapTopScorers(r.top_scorers),
  }));
}

function mapTopScorers(raw: unknown): ScorerPrediction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: any) => ({
    playerId: s.playerId,
    playerName: s.playerName,
    teamId: s.teamId,
    expectedGoals: Number(s.expectedGoals),
    probScores: Number(s.probScores),
  }));
}

export interface FixtureOdds {
  bookmaker: string;
  market: string;
  outcome: string;
  line: number;
  price: number;
  snapshotType: string;
}

export interface FixtureTeamStats {
  teamId: number;
  isHome: boolean;
  shots: number | null;
  shotsOnTarget: number | null;
  corners: number | null;
  fouls: number | null;
  yellowCards: number | null;
  redCards: number | null;
  xg: number | null;
}

export interface FixtureDetail extends FixtureSummary {
  venue: string | null;
  referee: string | null;
  teamStats: FixtureTeamStats[];
  odds: FixtureOdds[];
}

export async function getFixtureById(id: number): Promise<FixtureDetail | undefined> {
  const fixtureResult = await pool.query(
    `SELECT f.id, f.kickoff_at, f.status, f.round, f.home_score, f.away_score, f.venue, f.referee,
       c.name AS competition_name, s.label AS season_label,
       ht.id AS home_team_id, ht.name AS home_team_name,
       at.id AS away_team_id, at.name AS away_team_name
     FROM fixtures f
     JOIN teams ht ON ht.id = f.home_team_id
     JOIN teams at ON at.id = f.away_team_id
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     WHERE f.id = $1`,
    [id],
  );
  const f = fixtureResult.rows[0];
  if (!f) return undefined;

  const [statsResult, oddsResult, predictionResult, scorersResult] = await Promise.all([
    pool.query(
      `SELECT team_id, is_home, shots, shots_on_target, corners, fouls, yellow_cards, red_cards, xg
       FROM fixture_team_stats WHERE fixture_id = $1`,
      [id],
    ),
    pool.query(
      `SELECT bookmaker, market, outcome, line, price, snapshot_type
       FROM fixture_odds WHERE fixture_id = $1
       ORDER BY market, bookmaker, snapshot_type`,
      [id],
    ),
    pool.query(
      `SELECT model_version, prob_home_win, prob_draw, prob_away_win, predicted_home_goals, predicted_away_goals
       FROM model_predictions WHERE fixture_id = $1
       ORDER BY predicted_at DESC LIMIT 1`,
      [id],
    ),
    pool.query(
      `SELECT pgp.player_id, p.full_name, pgp.team_id, pgp.expected_goals, pgp.prob_scores
       FROM player_goal_predictions pgp
       JOIN players p ON p.id = pgp.player_id
       WHERE pgp.fixture_id = $1
       ORDER BY pgp.prob_scores DESC
       LIMIT ${TOP_SCORERS_PER_FIXTURE}`,
      [id],
    ),
  ]);

  const p = predictionResult.rows[0];

  return {
    id: f.id,
    kickoffAt: f.kickoff_at,
    status: f.status,
    round: f.round,
    homeScore: f.home_score,
    awayScore: f.away_score,
    venue: f.venue,
    referee: f.referee,
    competitionName: f.competition_name,
    seasonLabel: f.season_label,
    homeTeam: { id: f.home_team_id, name: f.home_team_name },
    awayTeam: { id: f.away_team_id, name: f.away_team_name },
    teamStats: statsResult.rows.map((r) => ({
      teamId: r.team_id,
      isHome: r.is_home,
      shots: r.shots,
      shotsOnTarget: r.shots_on_target,
      corners: r.corners,
      fouls: r.fouls,
      yellowCards: r.yellow_cards,
      redCards: r.red_cards,
      xg: r.xg === null ? null : Number(r.xg),
    })),
    odds: oddsResult.rows.map((r) => ({
      bookmaker: r.bookmaker,
      market: r.market,
      outcome: r.outcome,
      line: Number(r.line),
      price: Number(r.price),
      snapshotType: r.snapshot_type,
    })),
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
    topScorers: scorersResult.rows.map((r) => ({
      playerId: r.player_id,
      playerName: r.full_name,
      teamId: r.team_id,
      expectedGoals: Number(r.expected_goals),
      probScores: Number(r.prob_scores),
    })),
  };
}
