import { Router } from 'express';
import { getTeams, getTeam, getTeamDashboardHandler } from '../controllers/teams.controller.js';

export const teamsRouter = Router();

teamsRouter.get('/', getTeams);
teamsRouter.get('/:id', getTeam);
teamsRouter.get('/:id/dashboard', getTeamDashboardHandler);
