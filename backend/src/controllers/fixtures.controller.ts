import type { Request, Response } from 'express';
import { listFixtures, getFixtureById } from '../services/fixtures.service.js';
import { NotFoundError } from '../lib/errors.js';
import { parseIdParam } from '../lib/validation.js';

export async function getFixtures(req: Request, res: Response): Promise<void> {
  const { competition, teamId, from, to, limit } = req.query;
  res.json(
    await listFixtures({
      competitionName: typeof competition === 'string' ? competition : undefined,
      teamId: typeof teamId === 'string' ? parseIdParam(teamId, 'team') : undefined,
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      limit: typeof limit === 'string' ? Number(limit) : undefined,
    }),
  );
}

export async function getFixture(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req.params.id, 'fixture');
  const fixture = await getFixtureById(id);
  if (!fixture) throw new NotFoundError('Fixture', id);
  res.json(fixture);
}
