import type { Request, Response } from 'express';
import { createBet, listBets, settleBet, deleteBet, getRoiSummary, type BetResult } from '../services/bets.service.js';
import { AppError } from '../lib/errors.js';
import { parseIdParam } from '../lib/validation.js';

const VALID_RESULTS: BetResult[] = ['pending', 'won', 'lost', 'void'];

export async function postBet(req: Request, res: Response): Promise<void> {
  const { fixtureId, market, selection, oddsDecimal, stake } = req.body ?? {};
  const bet = await createBet({
    fixtureId: Number(fixtureId),
    market,
    selection,
    oddsDecimal: Number(oddsDecimal),
    stake: Number(stake),
  });
  res.status(201).json(bet);
}

export async function getBets(req: Request, res: Response): Promise<void> {
  const { result, fixtureId } = req.query;

  let resultFilter: BetResult | undefined;
  if (typeof result === 'string') {
    if (!VALID_RESULTS.includes(result as BetResult)) {
      throw new AppError(`result must be one of ${VALID_RESULTS.join(', ')}`, 400);
    }
    resultFilter = result as BetResult;
  }

  res.json(
    await listBets({
      result: resultFilter,
      fixtureId: typeof fixtureId === 'string' ? parseIdParam(fixtureId, 'fixture') : undefined,
    }),
  );
}

export async function getBetsSummary(_req: Request, res: Response): Promise<void> {
  res.json(await getRoiSummary());
}

export async function patchBet(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req.params.id, 'bet');
  const { result } = req.body ?? {};
  if (typeof result !== 'string' || !VALID_RESULTS.includes(result as BetResult)) {
    throw new AppError(`result must be one of ${VALID_RESULTS.join(', ')}`, 400);
  }
  res.json(await settleBet(id, result as BetResult));
}

export async function removeBet(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req.params.id, 'bet');
  await deleteBet(id);
  res.status(204).end();
}
