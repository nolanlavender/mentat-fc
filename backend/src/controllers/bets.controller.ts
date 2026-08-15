import type { Request, Response } from 'express';
import {
  createBet,
  listBets,
  getBetById,
  settleLeg,
  deleteBet,
  getRoiSummary,
  type BetResult,
  type LegResult,
} from '../services/bets.service.js';
import { AppError, NotFoundError } from '../lib/errors.js';
import { parseIdParam } from '../lib/validation.js';

const VALID_RESULTS: LegResult[] = ['pending', 'won', 'lost', 'void'];

function requireUserId(req: Request): number {
  // requireAuth (mounted ahead of this router) guarantees this is set --
  // asserted here rather than re-checked, since a request reaching the
  // controller without it means the middleware itself is misconfigured.
  return req.userId!;
}

function parseFilters(query: Request['query']): { season?: string; competitionName?: string; teamId?: number } {
  const { season, competition, teamId } = query;
  return {
    season: typeof season === 'string' ? season : undefined,
    competitionName: typeof competition === 'string' ? competition : undefined,
    teamId: typeof teamId === 'string' ? parseIdParam(teamId, 'team') : undefined,
  };
}

export async function postBet(req: Request, res: Response): Promise<void> {
  const { stake, legs } = req.body ?? {};
  const bet = await createBet(requireUserId(req), {
    stake: Number(stake),
    legs: Array.isArray(legs)
      ? legs.map((l: any) => ({
          fixtureId: Number(l?.fixtureId),
          market: l?.market,
          selection: l?.selection,
          oddsDecimal: Number(l?.oddsDecimal),
        }))
      : [],
  });
  res.status(201).json(bet);
}

export async function getBets(req: Request, res: Response): Promise<void> {
  const { result } = req.query;

  let resultFilter: BetResult | undefined;
  if (typeof result === 'string') {
    if (!VALID_RESULTS.includes(result as BetResult)) {
      throw new AppError(`result must be one of ${VALID_RESULTS.join(', ')}`, 400);
    }
    resultFilter = result as BetResult;
  }

  res.json(await listBets(requireUserId(req), { ...parseFilters(req.query), result: resultFilter }));
}

export async function getBet(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req.params.id, 'bet');
  const bet = await getBetById(requireUserId(req), id);
  if (!bet) throw new NotFoundError('Bet', id);
  res.json(bet);
}

export async function getBetsSummary(req: Request, res: Response): Promise<void> {
  res.json(await getRoiSummary(requireUserId(req), parseFilters(req.query)));
}

export async function patchLeg(req: Request, res: Response): Promise<void> {
  const betId = parseIdParam(req.params.id, 'bet');
  const legId = parseIdParam(req.params.legId, 'bet leg');
  const { result } = req.body ?? {};
  if (typeof result !== 'string' || !VALID_RESULTS.includes(result as LegResult)) {
    throw new AppError(`result must be one of ${VALID_RESULTS.join(', ')}`, 400);
  }
  res.json(await settleLeg(requireUserId(req), betId, legId, result as LegResult));
}

export async function removeBet(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req.params.id, 'bet');
  await deleteBet(requireUserId(req), id);
  res.status(204).end();
}
