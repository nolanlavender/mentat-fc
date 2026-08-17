import type { Request, Response } from 'express';
import { listTeams, getTeamById, getTeamDashboard, getStandings } from '../services/teams.service.js';
import { AppError, NotFoundError } from '../lib/errors.js';
import { parseIdParam } from '../lib/validation.js';

export async function getTeams(req: Request, res: Response): Promise<void> {
  const { competition } = req.query;
  res.json(await listTeams({ competitionName: typeof competition === 'string' ? competition : undefined }));
}

export async function getStandingsHandler(req: Request, res: Response): Promise<void> {
  const { competition } = req.query;
  if (typeof competition !== 'string' || !competition) {
    throw new AppError('competition query param is required', 400);
  }
  const standings = await getStandings(competition);
  if (!standings) throw new NotFoundError('Standings', competition);
  res.json(standings);
}

export async function getTeam(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req.params.id, 'team');
  const team = await getTeamById(id);
  if (!team) throw new NotFoundError('Team', id);
  res.json(team);
}

export async function getTeamDashboardHandler(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req.params.id, 'team');
  const dashboard = await getTeamDashboard(id);
  if (!dashboard) throw new NotFoundError('Team', id);
  res.json(dashboard);
}
