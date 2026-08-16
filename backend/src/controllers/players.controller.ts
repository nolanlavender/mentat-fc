import type { Request, Response } from 'express';
import { listPlayers, getPlayerDetail } from '../services/players.service.js';
import { NotFoundError } from '../lib/errors.js';
import { parseIdParam } from '../lib/validation.js';

export async function getPlayers(req: Request, res: Response): Promise<void> {
  const { teamId, limit } = req.query;
  res.json(
    await listPlayers({
      teamId: typeof teamId === 'string' ? parseIdParam(teamId, 'team') : undefined,
      limit: typeof limit === 'string' ? Number(limit) : undefined,
    }),
  );
}

export async function getPlayer(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req.params.id, 'player');
  const player = await getPlayerDetail(id);
  if (!player) throw new NotFoundError('Player', id);
  res.json(player);
}
