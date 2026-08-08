import type { Request, Response } from 'express';
import { getMyTeam } from '../services/fpl.service.js';

export async function getMyTeamHandler(_req: Request, res: Response): Promise<void> {
  res.json(await getMyTeam());
}
