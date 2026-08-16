import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../lib/errors.js';

export type LegResult = 'pending' | 'won' | 'lost' | 'void';
export type BetResult = LegResult; // same closed set -- overall result is derived from legs, never stored

const VALID_RESULTS: LegResult[] = ['pending', 'won', 'lost', 'void'];

export interface CreateLegInput {
  fixtureId: number;
  market: string;
  selection: string;
  oddsDecimal: number;
}

export interface CreateBetInput {
  stake: number;
  legs: CreateLegInput[];
}

export interface BetLeg {
  id: number;
  fixtureId: number;
  market: string;
  selection: string;
  oddsDecimal: number;
  result: LegResult;
  settledAt: string | null;
  fixture: {
    kickoffAt: string;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    competitionName: string;
    seasonLabel: string;
    homeTeam: { id: number; name: string };
    awayTeam: { id: number; name: string };
  };
  // The model's probability for this exact leg's selection, only populated
  // for market='match_winner' with an existing prediction -- see
  // docs/CLAUDE.md's prediction model scope.
  modelProbability: number | null;
}

export interface Bet {
  id: number;
  stake: number;
  placedAt: string;
  legs: BetLeg[];
  isParlay: boolean;
  // Derived, never stored -- see migration 1701000000018's comment.
  result: BetResult;
  settledAt: string | null;
  // Product of every non-void leg's odds -- a void leg is dropped from the
  // price and the remaining legs still have to win, the standard
  // real-world accumulator/parlay void-leg rule.
  combinedOdds: number;
  yourImpliedProbability: number;
  // Product of each non-void leg's own modelProbability, assuming the legs'
  // outcomes are independent -- a simplifying assumption, not strictly true
  // for correlated fixtures (e.g. two matches on the same day), but the
  // standard approach and worth being explicit about. null unless every
  // non-void leg has its own modelProbability.
  modelProbability: number | null;
  edge: number | null;
  payout: number | null; // null while result is 'pending' -- not yet knowable
}

export function assertValidLeg(leg: CreateLegInput): void {
  if (!Number.isInteger(leg.fixtureId) || leg.fixtureId <= 0) {
    throw new AppError('Each leg needs a valid fixtureId', 400);
  }
  if (!leg.market || typeof leg.market !== 'string') {
    throw new AppError('Each leg needs a market', 400);
  }
  if (!leg.selection || typeof leg.selection !== 'string') {
    throw new AppError('Each leg needs a selection', 400);
  }
  if (typeof leg.oddsDecimal !== 'number' || !(leg.oddsDecimal > 1)) {
    throw new AppError('Each leg needs oddsDecimal greater than 1', 400);
  }
}

export function assertValidCreateInput(input: CreateBetInput): void {
  if (typeof input.stake !== 'number' || !(input.stake > 0)) {
    throw new AppError('stake must be a positive number', 400);
  }
  if (!Array.isArray(input.legs) || input.legs.length === 0) {
    throw new AppError('At least one leg is required', 400);
  }
  input.legs.forEach(assertValidLeg);
}

export async function createBet(userId: number, input: CreateBetInput): Promise<Bet> {
  assertValidCreateInput(input);

  const fixtureIds = input.legs.map((l) => l.fixtureId);
  const existing = await pool.query<{ id: number }>('SELECT id FROM fixtures WHERE id = ANY($1)', [fixtureIds]);
  const existingIds = new Set(existing.rows.map((r) => r.id));
  const missing = fixtureIds.find((id) => !existingIds.has(id));
  if (missing !== undefined) throw new NotFoundError('Fixture', missing);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO bets (user_id, stake) VALUES ($1, $2) RETURNING id`,
      [userId, input.stake],
    );
    const betId = rows[0].id;

    for (const leg of input.legs) {
      await client.query(
        `INSERT INTO bet_legs (bet_id, fixture_id, market, selection, odds_decimal)
         VALUES ($1, $2, $3, $4, $5)`,
        [betId, leg.fixtureId, leg.market, leg.selection, leg.oddsDecimal],
      );
    }
    await client.query('COMMIT');

    const created = await getBetById(userId, betId);
    if (!created) throw new Error('Bet vanished immediately after insert');
    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface BetLegRow {
  bet_id: number;
  stake: string;
  placed_at: string;
  leg_id: number;
  fixture_id: number;
  market: string;
  selection: string;
  odds_decimal: string;
  leg_result: LegResult;
  leg_settled_at: string | null;
  kickoff_at: string;
  status: string;
  home_score: number | null;
  away_score: number | null;
  competition_name: string;
  season_label: string;
  home_team_id: number;
  home_team_name: string;
  away_team_id: number;
  away_team_name: string;
  prob_home_win: string | null;
  prob_draw: string | null;
  prob_away_win: string | null;
}

export function legModelProbability(row: BetLegRow): number | null {
  if (row.market !== 'match_winner' || row.prob_home_win === null) return null;
  if (row.selection === 'home') return Number(row.prob_home_win);
  if (row.selection === 'draw') return Number(row.prob_draw);
  if (row.selection === 'away') return Number(row.prob_away_win);
  return null;
}

export function rowsToBet(rows: BetLegRow[]): Bet {
  const first = rows[0];
  const legs: BetLeg[] = rows.map((r) => ({
    id: r.leg_id,
    fixtureId: r.fixture_id,
    market: r.market,
    selection: r.selection,
    oddsDecimal: Number(r.odds_decimal),
    result: r.leg_result,
    settledAt: r.leg_settled_at,
    fixture: {
      kickoffAt: r.kickoff_at,
      status: r.status,
      homeScore: r.home_score,
      awayScore: r.away_score,
      competitionName: r.competition_name,
      seasonLabel: r.season_label,
      homeTeam: { id: r.home_team_id, name: r.home_team_name },
      awayTeam: { id: r.away_team_id, name: r.away_team_name },
    },
    modelProbability: legModelProbability(r),
  }));

  const nonVoidLegs = legs.filter((l) => l.result !== 'void');

  let result: BetResult;
  if (legs.some((l) => l.result === 'lost')) result = 'lost';
  else if (legs.some((l) => l.result === 'pending')) result = 'pending';
  else if (nonVoidLegs.length === 0) result = 'void';
  else result = 'won';

  const combinedOdds = nonVoidLegs.reduce((acc, l) => acc * l.oddsDecimal, 1);
  const yourImpliedProbability = 1 / combinedOdds;

  const modelProbabilities = nonVoidLegs.map((l) => l.modelProbability);
  const modelProbability = modelProbabilities.every((p) => p !== null)
    ? (modelProbabilities as number[]).reduce((acc, p) => acc * p, 1)
    : null;

  const stake = Number(first.stake);
  let payout: number | null;
  if (result === 'pending') payout = null;
  else if (result === 'lost') payout = 0;
  else if (result === 'void') payout = stake;
  else payout = stake * combinedOdds;

  const settledAt =
    result === 'pending' ? null : legs.reduce<string | null>((latest, l) => (!latest || (l.settledAt ?? '') > latest ? l.settledAt ?? latest : latest), null);

  return {
    id: first.bet_id,
    stake,
    placedAt: first.placed_at,
    legs,
    isParlay: legs.length > 1,
    result,
    settledAt,
    combinedOdds,
    yourImpliedProbability,
    modelProbability,
    edge: modelProbability === null ? null : modelProbability - yourImpliedProbability,
    payout,
  };
}

const BET_LEG_SELECT = `
  SELECT b.id AS bet_id, b.stake, b.placed_at,
    bl.id AS leg_id, bl.fixture_id, bl.market, bl.selection, bl.odds_decimal,
    bl.result AS leg_result, bl.settled_at AS leg_settled_at,
    f.kickoff_at, f.status, f.home_score, f.away_score,
    c.name AS competition_name, s.label AS season_label,
    ht.id AS home_team_id, ht.name AS home_team_name,
    at.id AS away_team_id, at.name AS away_team_name,
    mp.prob_home_win, mp.prob_draw, mp.prob_away_win
  FROM bets b
  JOIN bet_legs bl ON bl.bet_id = b.id
  JOIN fixtures f ON f.id = bl.fixture_id
  JOIN teams ht ON ht.id = f.home_team_id
  JOIN teams at ON at.id = f.away_team_id
  JOIN competition_seasons cs ON cs.id = f.competition_season_id
  JOIN competitions c ON c.id = cs.competition_id
  JOIN seasons s ON s.id = cs.season_id
  LEFT JOIN LATERAL (
    SELECT prob_home_win, prob_draw, prob_away_win
    FROM model_predictions mp2
    WHERE mp2.fixture_id = f.id
    ORDER BY predicted_at DESC
    LIMIT 1
  ) mp ON true
`;

export interface BetFilters {
  season?: string;
  competitionName?: string;
  teamId?: number;
}

// "Involves" a team means backed it in at least one leg -- home_team_id if
// that leg's selection was 'home', away_team_id if 'away'. A draw pick
// backs no specific team and never matches a team filter.
async function qualifyingBetIds(userId: number, filters: BetFilters): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT DISTINCT b.id
     FROM bets b
     JOIN bet_legs bl ON bl.bet_id = b.id
     JOIN fixtures f ON f.id = bl.fixture_id
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     WHERE b.user_id = $1
       AND ($2::text IS NULL OR s.label = $2)
       AND ($3::text IS NULL OR c.name = $3)
       AND (
         $4::int IS NULL OR
         (CASE bl.selection WHEN 'home' THEN f.home_team_id WHEN 'away' THEN f.away_team_id END) = $4
       )`,
    [userId, filters.season ?? null, filters.competitionName ?? null, filters.teamId ?? null],
  );
  return rows.map((r) => r.id);
}

async function hydrateBets(userId: number, betIds: number[]): Promise<Bet[]> {
  if (betIds.length === 0) return [];
  const { rows } = await pool.query<BetLegRow>(
    `${BET_LEG_SELECT} WHERE b.user_id = $1 AND b.id = ANY($2) ORDER BY b.placed_at DESC, bl.id ASC`,
    [userId, betIds],
  );

  const byBet = new Map<number, BetLegRow[]>();
  for (const row of rows) {
    const group = byBet.get(row.bet_id) ?? [];
    group.push(row);
    byBet.set(row.bet_id, group);
  }
  // Preserve placed_at DESC ordering from the query rather than Map insertion order.
  const orderedBetIds = [...new Set(rows.map((r) => r.bet_id))];
  return orderedBetIds.map((id) => rowsToBet(byBet.get(id)!));
}

export async function getBetById(userId: number, id: number): Promise<Bet | undefined> {
  const bets = await hydrateBets(userId, [id]);
  return bets[0];
}

export interface ListBetsFilters extends BetFilters {
  result?: BetResult;
}

export async function listBets(userId: number, filters: ListBetsFilters): Promise<Bet[]> {
  const ids = await qualifyingBetIds(userId, filters);
  const bets = await hydrateBets(userId, ids);
  return filters.result ? bets.filter((b) => b.result === filters.result) : bets;
}

export async function settleLeg(userId: number, betId: number, legId: number, result: LegResult): Promise<Bet> {
  if (!VALID_RESULTS.includes(result)) {
    throw new AppError(`result must be one of ${VALID_RESULTS.join(', ')}`, 400);
  }

  const { rowCount } = await pool.query(
    `UPDATE bet_legs SET result = $3, settled_at = CASE WHEN $3 = 'pending' THEN NULL ELSE now() END
     WHERE id = $2 AND bet_id = $1
       AND bet_id IN (SELECT id FROM bets WHERE user_id = $4)`,
    [betId, legId, result, userId],
  );
  if (!rowCount) throw new NotFoundError('Bet leg', legId);

  const updated = await getBetById(userId, betId);
  if (!updated) throw new Error('Bet vanished immediately after leg update');
  return updated;
}

export async function deleteBet(userId: number, id: number): Promise<void> {
  const { rowCount } = await pool.query('DELETE FROM bets WHERE id = $1 AND user_id = $2', [id, userId]);
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

export async function getRoiSummary(userId: number, filters: BetFilters): Promise<BetsRoiSummary> {
  const ids = await qualifyingBetIds(userId, filters);
  const bets = await hydrateBets(userId, ids);

  const settled = bets.filter((b) => b.result !== 'pending');
  const won = settled.filter((b) => b.result === 'won').length;
  const lost = settled.filter((b) => b.result === 'lost').length;
  const voided = settled.filter((b) => b.result === 'void').length;

  const totalStakedSettled = settled.reduce((acc, b) => acc + b.stake, 0);
  const totalReturnedSettled = settled.reduce((acc, b) => acc + (b.payout ?? 0), 0);
  const netProfitSettled = totalReturnedSettled - totalStakedSettled;
  const decided = won + lost;

  return {
    totalBets: bets.length,
    pending: bets.length - settled.length,
    won,
    lost,
    void: voided,
    totalStakedSettled,
    totalReturnedSettled,
    netProfitSettled,
    roiPercent: totalStakedSettled > 0 ? (netProfitSettled / totalStakedSettled) * 100 : null,
    winRatePercent: decided > 0 ? (won / decided) * 100 : null,
  };
}
