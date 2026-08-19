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
  playerPhotoUrl: string | null;
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
  homeTeam: { id: number; name: string; shortName: string | null; logoUrl: string | null };
  awayTeam: { id: number; name: string; shortName: string | null; logoUrl: string | null };
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
  // Exact kickoff_date match (YYYY-MM-DD) -- the Europe/London calendar
  // day the seed scripts already assign each fixture (see migration
  // 1701000000006's comment), not a kickoff_at range. A day-browser needs
  // "which fixtures happened on this real calendar day," which kickoff_date
  // already answers directly -- computing that from a timezone-aware
  // kickoff_at range at query time would just be re-deriving what this
  // column already stores.
  date?: string;
  limit?: number;
}

const MAX_LIMIT = 200;

export async function listFixtures(filters: ListFixturesFilters): Promise<FixtureSummary[]> {
  const limit = Math.min(filters.limit ?? 50, MAX_LIMIT);

  const { rows } = await pool.query(
    `SELECT f.id, f.kickoff_at, f.status, f.round, f.home_score, f.away_score,
       c.name AS competition_name, s.label AS season_label,
       ht.id AS home_team_id, ht.name AS home_team_name, ht.short_name AS home_team_short_name, ht.logo_url AS home_team_logo_url,
       at.id AS away_team_id, at.name AS away_team_name, at.short_name AS away_team_short_name, at.logo_url AS away_team_logo_url,
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
           'playerId', pgp.player_id, 'playerName', p.full_name, 'playerPhotoUrl', p.photo_url, 'teamId', pgp.team_id,
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
       AND ($6::date IS NULL OR f.kickoff_date = $6)
     ORDER BY f.kickoff_at ASC
     LIMIT $5`,
    [filters.competitionName ?? null, filters.teamId ?? null, filters.from ?? null, filters.to ?? null, limit, filters.date ?? null],
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
    homeTeam: { id: r.home_team_id, name: r.home_team_name, shortName: r.home_team_short_name, logoUrl: r.home_team_logo_url },
    awayTeam: { id: r.away_team_id, name: r.away_team_name, shortName: r.away_team_short_name, logoUrl: r.away_team_logo_url },
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
    playerPhotoUrl: s.playerPhotoUrl ?? null,
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

export interface FixtureLineupPlayer {
  playerId: number;
  playerName: string;
  playerPhotoUrl: string | null;
  teamId: number;
  isStarting: boolean;
  shirtNumber: number | null;
  position: string | null;
  // The four below are only populated once fixture_player_stats has been
  // backfilled for this match (post-match, see backfillLineupsForCompetitionSeason)
  // -- a pre-match/matchday-only lineup (seedTodaysLineups) has real
  // players and positions but no performance numbers yet, same
  // "null means not known yet, not zero" convention used everywhere else.
  minutesPlayed: number | null;
  goals: number | null;
  assists: number | null;
  rating: number | null;
  yellowCards: number | null;
  redCards: number | null;
}

export interface FixtureDetail extends FixtureSummary {
  venue: string | null;
  referee: string | null;
  teamStats: FixtureTeamStats[];
  odds: FixtureOdds[];
  // Empty (not null) whenever no lineup has been captured for this fixture
  // yet -- either it's more than a few hours from kickoff (see
  // seedTodaysLineups's lookahead window) or API-Football simply has
  // nothing for it. One flat list carrying each player's teamId, same
  // shape as topScorers above, rather than pre-split into home/away --
  // the frontend already knows which id is which team.
  lineup: FixtureLineupPlayer[];
}

export async function getFixtureById(id: number): Promise<FixtureDetail | undefined> {
  const fixtureResult = await pool.query(
    `SELECT f.id, f.kickoff_at, f.status, f.round, f.home_score, f.away_score, f.venue, f.referee,
       c.name AS competition_name, s.label AS season_label,
       ht.id AS home_team_id, ht.name AS home_team_name, ht.short_name AS home_team_short_name, ht.logo_url AS home_team_logo_url,
       at.id AS away_team_id, at.name AS away_team_name, at.short_name AS away_team_short_name, at.logo_url AS away_team_logo_url
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

  const [statsResult, oddsResult, predictionResult, scorersResult, lineupResult] = await Promise.all([
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
      `SELECT pgp.player_id, p.full_name, p.photo_url, pgp.team_id, pgp.expected_goals, pgp.prob_scores
       FROM player_goal_predictions pgp
       JOIN players p ON p.id = pgp.player_id
       WHERE pgp.fixture_id = $1
       ORDER BY pgp.prob_scores DESC
       LIMIT ${TOP_SCORERS_PER_FIXTURE}`,
      [id],
    ),
    pool.query(
      `SELECT fl.player_id, p.full_name, p.photo_url, fl.team_id, fl.is_starting, fl.shirt_number, fl.position,
         fps.minutes_played, fps.goals, fps.assists, fps.rating, fps.yellow_cards, fps.red_cards
       FROM fixture_lineups fl
       JOIN players p ON p.id = fl.player_id
       LEFT JOIN fixture_player_stats fps ON fps.fixture_id = fl.fixture_id AND fps.player_id = fl.player_id
       WHERE fl.fixture_id = $1
       ORDER BY fl.is_starting DESC, fl.shirt_number ASC NULLS LAST, p.full_name ASC`,
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
    homeTeam: { id: f.home_team_id, name: f.home_team_name, shortName: f.home_team_short_name, logoUrl: f.home_team_logo_url },
    awayTeam: { id: f.away_team_id, name: f.away_team_name, shortName: f.away_team_short_name, logoUrl: f.away_team_logo_url },
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
      playerPhotoUrl: r.photo_url,
      teamId: r.team_id,
      expectedGoals: Number(r.expected_goals),
      probScores: Number(r.prob_scores),
    })),
    lineup: lineupResult.rows.map((r) => ({
      playerId: r.player_id,
      playerName: r.full_name,
      playerPhotoUrl: r.photo_url,
      teamId: r.team_id,
      isStarting: r.is_starting,
      shirtNumber: r.shirt_number,
      position: r.position,
      minutesPlayed: r.minutes_played,
      goals: r.goals,
      assists: r.assists,
      rating: r.rating === null ? null : Number(r.rating),
      yellowCards: r.yellow_cards,
      redCards: r.red_cards,
    })),
  };
}
