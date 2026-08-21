import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../lib/errors.js';

export type LegResult = 'pending' | 'won' | 'lost' | 'void';
export type BetResult = LegResult; // same closed set -- overall result is derived from legs, never stored

const VALID_RESULTS: LegResult[] = ['pending', 'won', 'lost', 'void'];

export const ANYTIME_SCORER_MARKET = 'anytime_scorer';
export const SPREAD_MARKET = 'spread';

/**
 * A spread leg's line is added to the SELECTED side's goals before the two
 * are compared: "Arsenal -2.5" is selection 'home' (if Arsenal are home)
 * with line -2.5, and wins only if Arsenal win by 3 or more.
 *
 * Quarter lines (-2.25, splitting the stake across -2 and -2.5) are
 * rejected rather than silently mishandled. Settling one correctly means
 * grading a single leg as half-won, which the result column
 * ('won'/'lost'/'void') genuinely cannot express -- supporting them needs
 * a stake-splitting model, not a rounding rule. Half and whole lines cover
 * every spread a US book offers on soccer.
 */
export function assertSettleableLine(line: number): void {
  if (!Number.isFinite(line)) throw new AppError('A spread leg needs a numeric line', 400);
  if (Math.abs(line * 2 - Math.round(line * 2)) > 1e-9) {
    throw new AppError('Only half and whole lines are supported (e.g. -2.5, -2, +1.5), not quarter lines', 400);
  }
}

export interface CreateLegInput {
  fixtureId: number;
  market: string;
  selection: string;
  /** Goal handicap on the selected side, spread markets only. Omitted elsewhere. */
  line?: number;
  oddsDecimal: number;
}

export interface CreateBetInput {
  stake: number;
  legs: CreateLegInput[];
  // The book's own quoted price for the whole parlay, when it differs from
  // the pure product of each leg's own odds. Only meaningful with 2+ legs
  // -- see migration 1701000000024's comment.
  oddsOverrideDecimal?: number;
}

export interface BetLeg {
  id: number;
  fixtureId: number;
  market: string;
  selection: string;
  /** 0 for markets with no line -- see migration 1701000000028. */
  line: number;
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
  // The model's probability for this exact leg's selection: prob_home_win/
  // draw/away_win for market='match_winner', prob_scores for
  // market='anytime_scorer' -- see docs/CLAUDE.md's prediction model scope.
  modelProbability: number | null;
  // Only populated for market='anytime_scorer', where selection is a
  // player_id stored as text (free-text market/selection design, see
  // migration 1701000000019) -- resolved here so the frontend never has to
  // look a player up itself just to show a name.
  player: { id: number; name: string } | null;
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
  // Only set for parlays where you entered the book's own quoted total --
  // see migration 1701000000024. null means combinedOdds below is the
  // plain product of the legs' own odds.
  oddsOverrideDecimal: number | null;
  // The book's quoted total (oddsOverrideDecimal) when one was entered AND
  // no leg is void; otherwise the product of every non-void leg's own
  // odds -- a void leg is dropped from the price and the remaining legs
  // still have to win, the standard real-world accumulator/parlay
  // void-leg rule. Falling back to the product once any leg voids is
  // deliberate: there's no way to know how the book's own total would
  // have been repriced for that specific leg voiding, but the per-leg
  // product still gives a real, defensible number.
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
  if (leg.market === ANYTIME_SCORER_MARKET && !(Number.isInteger(Number(leg.selection)) && Number(leg.selection) > 0)) {
    throw new AppError(`An ${ANYTIME_SCORER_MARKET} leg's selection must be a player id`, 400);
  }
  if (leg.market === SPREAD_MARKET) {
    if (leg.selection !== 'home' && leg.selection !== 'away') {
      throw new AppError(`A ${SPREAD_MARKET} leg's selection must be 'home' or 'away'`, 400);
    }
    if (leg.line === undefined) {
      throw new AppError(`A ${SPREAD_MARKET} leg needs a line (e.g. -2.5)`, 400);
    }
    assertSettleableLine(leg.line);
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
  if (input.oddsOverrideDecimal !== undefined) {
    if (typeof input.oddsOverrideDecimal !== 'number' || !(input.oddsOverrideDecimal > 1)) {
      throw new AppError('oddsOverrideDecimal must be a number greater than 1', 400);
    }
    if (input.legs.length < 2) {
      throw new AppError('oddsOverrideDecimal only applies to a parlay (2+ legs)', 400);
    }
  }
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
      `INSERT INTO bets (user_id, stake, odds_override_decimal) VALUES ($1, $2, $3) RETURNING id`,
      [userId, input.stake, input.oddsOverrideDecimal ?? null],
    );
    const betId = rows[0].id;

    for (const leg of input.legs) {
      await client.query(
        `INSERT INTO bet_legs (bet_id, fixture_id, market, selection, odds_decimal, line)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [betId, leg.fixtureId, leg.market, leg.selection, leg.oddsDecimal, leg.line ?? 0],
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
  odds_override_decimal: string | null;
  leg_id: number;
  fixture_id: number;
  market: string;
  selection: string;
  line: string;
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
  predicted_home_goals: string | null;
  predicted_away_goals: string | null;
  scorer_prob_scores: string | null;
  scorer_player_id: number | null;
  scorer_player_name: string | null;
}

export function legModelProbability(row: BetLegRow): number | null {
  if (row.market === 'match_winner') {
    if (row.prob_home_win === null) return null;
    if (row.selection === 'home') return Number(row.prob_home_win);
    if (row.selection === 'draw') return Number(row.prob_draw);
    if (row.selection === 'away') return Number(row.prob_away_win);
    return null;
  }
  if (row.market === SPREAD_MARKET) {
    // Rebuilt from the stored expected goals rather than read off a
    // column, because model_predictions only stores the three match-winner
    // probabilities and the two lambdas -- not the scoreline grid a spread
    // needs. Two independent Poissons reproduce that grid closely, but NOT
    // exactly: this omits the Dixon-Coles low-score correction (see
    // docs/models.md section 2), which perturbs only the 0-0/1-0/0-1/1-1
    // cells. That matters least for the handicaps anyone actually bets and
    // most for a line near zero, so treat this as indicative rather than
    // as the model's own number. Storing rho alongside the prediction
    // would make it exact.
    const lambdaHome = row.predicted_home_goals === null ? null : Number(row.predicted_home_goals);
    const lambdaAway = row.predicted_away_goals === null ? null : Number(row.predicted_away_goals);
    if (lambdaHome === null || lambdaAway === null) return null;
    const line = Number(row.line);
    const forHome = row.selection === 'home';
    return spreadCoverProbability(forHome ? lambdaHome : lambdaAway, forHome ? lambdaAway : lambdaHome, line);
  }
  if (row.market === ANYTIME_SCORER_MARKET) {
    return row.scorer_prob_scores === null ? null : Number(row.scorer_prob_scores);
  }
  return null;
}

const MAX_GOALS = 10; // matches DixonColesModel's own grid bound; the tail beyond is negligible

function poissonPmf(k: number, lambda: number): number {
  let logFactorial = 0;
  for (let i = 2; i <= k; i++) logFactorial += Math.log(i);
  return Math.exp(k * Math.log(lambda) - lambda - logFactorial);
}

/**
 * P(selected side's goals + line > opponent's goals) under two independent
 * Poissons. A push (exact equality on a whole line) is excluded from the
 * "cover" probability, matching how the leg settles: void, not won.
 */
export function spreadCoverProbability(lambdaFor: number, lambdaAgainst: number, line: number): number {
  const forProbs = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poissonPmf(k, lambdaFor));
  const againstProbs = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poissonPmf(k, lambdaAgainst));
  let cover = 0;
  for (let scored = 0; scored <= MAX_GOALS; scored++) {
    for (let conceded = 0; conceded <= MAX_GOALS; conceded++) {
      if (scored + line > conceded) cover += forProbs[scored] * againstProbs[conceded];
    }
  }
  // The grid is truncated at MAX_GOALS, so it sums to slightly under 1.
  // Renormalising keeps this a probability rather than a number that
  // drifts low for high-scoring fixtures.
  const total = forProbs.reduce((a, b) => a + b, 0) * againstProbs.reduce((a, b) => a + b, 0);
  return cover / total;
}

export function rowsToBet(rows: BetLegRow[]): Bet {
  const first = rows[0];
  const legs: BetLeg[] = rows.map((r) => ({
    id: r.leg_id,
    fixtureId: r.fixture_id,
    market: r.market,
    selection: r.selection,
    line: Number(r.line),
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
    player: r.scorer_player_id === null ? null : { id: r.scorer_player_id, name: r.scorer_player_name! },
  }));

  const nonVoidLegs = legs.filter((l) => l.result !== 'void');

  let result: BetResult;
  if (legs.some((l) => l.result === 'lost')) result = 'lost';
  else if (legs.some((l) => l.result === 'pending')) result = 'pending';
  else if (nonVoidLegs.length === 0) result = 'void';
  else result = 'won';

  const productOdds = nonVoidLegs.reduce((acc, l) => acc * l.oddsDecimal, 1);
  const oddsOverrideDecimal = first.odds_override_decimal === null ? null : Number(first.odds_override_decimal);
  const hasVoidLeg = legs.some((l) => l.result === 'void');
  // See the Bet.combinedOdds comment: the override is only trusted while
  // every leg is still live -- once one voids, fall back to the per-leg
  // product, which is the only number we can actually justify.
  const combinedOdds = oddsOverrideDecimal !== null && !hasVoidLeg ? oddsOverrideDecimal : productOdds;
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
    oddsOverrideDecimal,
    combinedOdds,
    yourImpliedProbability,
    modelProbability,
    edge: modelProbability === null ? null : modelProbability - yourImpliedProbability,
    payout,
  };
}

// bl.selection is free text (see migration 1701000000019) -- for
// market='anytime_scorer' it's a player_id stored as a string, so both
// lateral joins below only attempt the ::int cast on that branch via CASE.
// Postgres never evaluates the other branch's expression, so a
// non-numeric selection from a different market (e.g. 'home') can't blow
// up the cast.
const BET_LEG_SELECT = `
  SELECT b.id AS bet_id, b.stake, b.placed_at, b.odds_override_decimal,
    bl.id AS leg_id, bl.fixture_id, bl.market, bl.selection, bl.line, bl.odds_decimal,
    bl.result AS leg_result, bl.settled_at AS leg_settled_at,
    f.kickoff_at, f.status, f.home_score, f.away_score,
    c.name AS competition_name, s.label AS season_label,
    ht.id AS home_team_id, ht.name AS home_team_name,
    at.id AS away_team_id, at.name AS away_team_name,
    mp.prob_home_win, mp.prob_draw, mp.prob_away_win,
    mp.predicted_home_goals, mp.predicted_away_goals,
    sp.prob_scores AS scorer_prob_scores,
    sp_player.id AS scorer_player_id, sp_player.full_name AS scorer_player_name
  FROM bets b
  JOIN bet_legs bl ON bl.bet_id = b.id
  JOIN fixtures f ON f.id = bl.fixture_id
  JOIN teams ht ON ht.id = f.home_team_id
  JOIN teams at ON at.id = f.away_team_id
  JOIN competition_seasons cs ON cs.id = f.competition_season_id
  JOIN competitions c ON c.id = cs.competition_id
  JOIN seasons s ON s.id = cs.season_id
  LEFT JOIN LATERAL (
    SELECT prob_home_win, prob_draw, prob_away_win, predicted_home_goals, predicted_away_goals
    FROM model_predictions mp2
    WHERE mp2.fixture_id = f.id
    ORDER BY predicted_at DESC
    LIMIT 1
  ) mp ON true
  LEFT JOIN players sp_player ON sp_player.id = (
    CASE WHEN bl.market = '${ANYTIME_SCORER_MARKET}' THEN NULLIF(bl.selection, '')::int END
  )
  LEFT JOIN LATERAL (
    SELECT prob_scores
    FROM player_goal_predictions pgp
    WHERE pgp.fixture_id = f.id AND pgp.player_id = sp_player.id
    ORDER BY predicted_at DESC
    LIMIT 1
  ) sp ON bl.market = '${ANYTIME_SCORER_MARKET}'
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

// Grades every still-pending leg of this user's bets whose fixture has
// actually finished, against the real recorded result -- no separate
// "refresh"/"settle" action needed, since it runs on every read. Only
// covers the two markets we can grade unambiguously from stored data:
//   - match_winner: the actual home/draw/away outcome vs. the leg's pick.
//   - anytime_scorer: whether fixture_player_stats has >=1 goal for that
//     player in that fixture. A player who never took the pitch at all
//     grades as a loss, not a void -- a deliberate call (see
//     docs/learning-log.md's Bets-overhaul entry): the bet is "did he
//     score", and an unused sub or an unselected squad player didn't.
//   - spread: the selected side's goals PLUS its line, against the other
//     side's goals. This is the first market here that can genuinely tie:
//     a whole line (Arsenal -2 winning by exactly 2) is a push, graded
//     'void' so the stake comes back and the bet's own result derivation
//     already excludes it from the parlay product. Half lines (-2.5)
//     cannot tie, which is the whole reason books quote them.
// Any other market (or a match_winner leg whose fixture is finished but
// missing a score, e.g. abandoned) is left pending for a manual Won/Lost/
// Void call via settleLeg -- there's no stored data to grade it from.
async function autoSettleFinishedLegs(userId: number): Promise<void> {
  await pool.query(
    `UPDATE bet_legs bl
     SET result = graded.new_result, settled_at = now()
     FROM (
       SELECT bl2.id,
         CASE
           WHEN bl2.market = 'match_winner' THEN
             CASE
               WHEN (
                 CASE
                   WHEN f.home_score > f.away_score THEN 'home'
                   WHEN f.home_score < f.away_score THEN 'away'
                   ELSE 'draw'
                 END
               ) = bl2.selection THEN 'won'
               ELSE 'lost'
             END
           WHEN bl2.market = '${ANYTIME_SCORER_MARKET}' THEN
             CASE
               WHEN COALESCE(
                 (SELECT fps.goals FROM fixture_player_stats fps
                  WHERE fps.fixture_id = f.id AND fps.player_id = NULLIF(bl2.selection, '')::int),
                 0
               ) >= 1 THEN 'won'
               ELSE 'lost'
             END
           WHEN bl2.market = '${SPREAD_MARKET}' THEN
             CASE
               WHEN (
                 CASE bl2.selection WHEN 'home' THEN f.home_score ELSE f.away_score END + bl2.line
               ) > (
                 CASE bl2.selection WHEN 'home' THEN f.away_score ELSE f.home_score END
               ) THEN 'won'
               WHEN (
                 CASE bl2.selection WHEN 'home' THEN f.home_score ELSE f.away_score END + bl2.line
               ) = (
                 CASE bl2.selection WHEN 'home' THEN f.away_score ELSE f.home_score END
               ) THEN 'void'
               ELSE 'lost'
             END
         END AS new_result
       FROM bet_legs bl2
       JOIN bets b2 ON b2.id = bl2.bet_id
       JOIN fixtures f ON f.id = bl2.fixture_id
       WHERE b2.user_id = $1
         AND bl2.result = 'pending'
         AND f.status = 'finished'
         AND bl2.market IN ('match_winner', '${ANYTIME_SCORER_MARKET}', '${SPREAD_MARKET}')
         -- Both score-derived markets need a real scoreline. An abandoned
         -- fixture marked finished with NULL scores stays pending for a
         -- manual call rather than grading against NULL.
         AND (bl2.market = '${ANYTIME_SCORER_MARKET}' OR (f.home_score IS NOT NULL AND f.away_score IS NOT NULL))
     ) graded
     WHERE bl.id = graded.id`,
    [userId],
  );
}

async function hydrateBets(userId: number, betIds: number[]): Promise<Bet[]> {
  if (betIds.length === 0) return [];
  await autoSettleFinishedLegs(userId);
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
