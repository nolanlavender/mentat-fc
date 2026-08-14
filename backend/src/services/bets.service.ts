import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../lib/errors.js';

export type BetResult = 'pending' | 'won' | 'lost' | 'void';

const VALID_RESULTS: BetResult[] = ['pending', 'won', 'lost', 'void'];

export interface CreateBetInput {
  fixtureId: number;
  market: string;
  selection: string;
  oddsDecimal: number;
  stake: number;
}

export interface BetSummary {
  id: number;
  fixtureId: number;
  market: string;
  selection: string;
  oddsDecimal: number;
  stake: number;
  result: BetResult;
  placedAt: string;
  settledAt: string | null;
  fixture: {
    kickoffAt: string;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    competitionName: string;
    homeTeam: string;
    awayTeam: string;
  };
  // Your own implied probability from the odds you got, 1/oddsDecimal --
  // what you were effectively betting the "true" chance was, at minimum,
  // for the bet to break even long-run.
  yourImpliedProbability: number;
  // The model's own probability for this exact selection, only populated
  // when market is 'match_winner' (the only market the model predicts --
  // see docs/CLAUDE.md's prediction model scope) and a prediction exists
  // for this fixture. null, not a guess, when either doesn't hold.
  modelProbability: number | null;
  // modelProbability - yourImpliedProbability. Positive means the model
  // thinks you got better odds than your true win chance -- a value bet,
  // per the Phase 6 explainer. Never computed from market odds; that's
  // the whole point of comparing an independent model to what you paid.
  edge: number | null;
}

function assertValidCreateInput(input: CreateBetInput): void {
  if (!Number.isInteger(input.fixtureId) || input.fixtureId <= 0) {
    throw new AppError('fixtureId must be a positive integer', 400);
  }
  if (!input.market || typeof input.market !== 'string') {
    throw new AppError('market is required', 400);
  }
  if (!input.selection || typeof input.selection !== 'string') {
    throw new AppError('selection is required', 400);
  }
  if (typeof input.oddsDecimal !== 'number' || !(input.oddsDecimal > 1)) {
    throw new AppError('oddsDecimal must be a number greater than 1', 400);
  }
  if (typeof input.stake !== 'number' || !(input.stake > 0)) {
    throw new AppError('stake must be a positive number', 400);
  }
}

function modelProbabilityForSelection(
  market: string,
  selection: string,
  prediction: { prob_home_win: string; prob_draw: string; prob_away_win: string } | undefined,
): number | null {
  if (market !== 'match_winner' || !prediction) return null;
  if (selection === 'home') return Number(prediction.prob_home_win);
  if (selection === 'draw') return Number(prediction.prob_draw);
  if (selection === 'away') return Number(prediction.prob_away_win);
  return null;
}

export async function createBet(input: CreateBetInput): Promise<BetSummary> {
  assertValidCreateInput(input);

  const fixtureExists = await pool.query('SELECT 1 FROM fixtures WHERE id = $1', [input.fixtureId]);
  if (!fixtureExists.rows[0]) throw new NotFoundError('Fixture', input.fixtureId);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO bets (fixture_id, market, selection, odds_decimal, stake)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.fixtureId, input.market, input.selection, input.oddsDecimal, input.stake],
  );

  const created = await getBetById(rows[0].id);
  if (!created) throw new Error('Bet vanished immediately after insert');
  return created;
}

const BET_SELECT = `
  SELECT b.id, b.fixture_id, b.market, b.selection, b.odds_decimal, b.stake, b.result, b.placed_at, b.settled_at,
    f.kickoff_at, f.status, f.home_score, f.away_score,
    c.name AS competition_name, ht.name AS home_team_name, at.name AS away_team_name,
    mp.prob_home_win, mp.prob_draw, mp.prob_away_win
  FROM bets b
  JOIN fixtures f ON f.id = b.fixture_id
  JOIN teams ht ON ht.id = f.home_team_id
  JOIN teams at ON at.id = f.away_team_id
  JOIN competition_seasons cs ON cs.id = f.competition_season_id
  JOIN competitions c ON c.id = cs.competition_id
  LEFT JOIN LATERAL (
    SELECT prob_home_win, prob_draw, prob_away_win
    FROM model_predictions mp2
    WHERE mp2.fixture_id = f.id
    ORDER BY predicted_at DESC
    LIMIT 1
  ) mp ON true
`;

function rowToBetSummary(r: any): BetSummary {
  const oddsDecimal = Number(r.odds_decimal);
  const yourImpliedProbability = 1 / oddsDecimal;
  const modelProbability = modelProbabilityForSelection(r.market, r.selection, r.prob_home_win !== null ? r : undefined);

  return {
    id: r.id,
    fixtureId: r.fixture_id,
    market: r.market,
    selection: r.selection,
    oddsDecimal,
    stake: Number(r.stake),
    result: r.result,
    placedAt: r.placed_at,
    settledAt: r.settled_at,
    fixture: {
      kickoffAt: r.kickoff_at,
      status: r.status,
      homeScore: r.home_score,
      awayScore: r.away_score,
      competitionName: r.competition_name,
      homeTeam: r.home_team_name,
      awayTeam: r.away_team_name,
    },
    yourImpliedProbability,
    modelProbability,
    edge: modelProbability === null ? null : modelProbability - yourImpliedProbability,
  };
}

export async function getBetById(id: number): Promise<BetSummary | undefined> {
  const { rows } = await pool.query(`${BET_SELECT} WHERE b.id = $1`, [id]);
  return rows[0] ? rowToBetSummary(rows[0]) : undefined;
}

export interface ListBetsFilters {
  result?: BetResult;
  fixtureId?: number;
}

export async function listBets(filters: ListBetsFilters): Promise<BetSummary[]> {
  const { rows } = await pool.query(
    `${BET_SELECT}
     WHERE ($1::text IS NULL OR b.result = $1)
       AND ($2::int IS NULL OR b.fixture_id = $2)
     ORDER BY b.placed_at DESC`,
    [filters.result ?? null, filters.fixtureId ?? null],
  );
  return rows.map(rowToBetSummary);
}

export async function settleBet(id: number, result: BetResult): Promise<BetSummary> {
  if (!VALID_RESULTS.includes(result)) {
    throw new AppError(`result must be one of ${VALID_RESULTS.join(', ')}`, 400);
  }

  const { rowCount } = await pool.query(
    `UPDATE bets SET result = $2, settled_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END WHERE id = $1`,
    [id, result],
  );
  if (!rowCount) throw new NotFoundError('Bet', id);

  const updated = await getBetById(id);
  if (!updated) throw new Error('Bet vanished immediately after update');
  return updated;
}

export async function deleteBet(id: number): Promise<void> {
  const { rowCount } = await pool.query('DELETE FROM bets WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError('Bet', id);
}

export interface BetsRoiSummary {
  totalBets: number;
  pending: number;
  won: number;
  lost: number;
  void: number;
  totalStakedSettled: number;
  totalReturnedSettled: number;
  netProfitSettled: number;
  roiPercent: number | null;
  winRatePercent: number | null;
}

export async function getRoiSummary(): Promise<BetsRoiSummary> {
  const { rows } = await pool.query(`
    SELECT
      count(*) AS total_bets,
      count(*) FILTER (WHERE result = 'pending') AS pending,
      count(*) FILTER (WHERE result = 'won') AS won,
      count(*) FILTER (WHERE result = 'lost') AS lost,
      count(*) FILTER (WHERE result = 'void') AS void,
      coalesce(sum(stake) FILTER (WHERE result != 'pending'), 0) AS total_staked_settled,
      coalesce(sum(
        CASE result
          WHEN 'won' THEN stake * odds_decimal
          WHEN 'void' THEN stake
          ELSE 0
        END
      ) FILTER (WHERE result != 'pending'), 0) AS total_returned_settled
    FROM bets
  `);

  const r = rows[0];
  const totalStakedSettled = Number(r.total_staked_settled);
  const totalReturnedSettled = Number(r.total_returned_settled);
  const netProfitSettled = totalReturnedSettled - totalStakedSettled;
  const won = Number(r.won);
  const lost = Number(r.lost);
  const decided = won + lost; // voids/pending excluded -- neither reflects a "correct pick"

  return {
    totalBets: Number(r.total_bets),
    pending: Number(r.pending),
    won,
    lost,
    void: Number(r.void),
    totalStakedSettled,
    totalReturnedSettled,
    netProfitSettled,
    roiPercent: totalStakedSettled > 0 ? (netProfitSettled / totalStakedSettled) * 100 : null,
    winRatePercent: decided > 0 ? (won / decided) * 100 : null,
  };
}
