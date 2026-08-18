import type { Request, Response } from 'express';
import { getMyTeamForUser, linkFplEntry } from '../services/fpl.service.js';
import { AppError } from '../lib/errors.js';

export async function getMyTeamHandler(req: Request, res: Response): Promise<void> {
  res.json(await getMyTeamForUser(req.userId!));
}

export async function postLinkFplEntry(req: Request, res: Response): Promise<void> {
  const { fplEntryId } = req.body ?? {};
  const parsed = Number(fplEntryId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError('fplEntryId must be a positive integer', 400);
  }
  await linkFplEntry(req.userId!, parsed);
  res.status(204).end();
}
