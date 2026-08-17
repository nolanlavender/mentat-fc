import { Router } from 'express';
import { getTeams, getTeam, getTeamDashboardHandler, getStandingsHandler } from '../controllers/teams.controller.js';

export const teamsRouter = Router();

teamsRouter.get('/', getTeams);
// Must come before /:id -- otherwise Express matches "standings" as an :id param.
teamsRouter.get('/standings', getStandingsHandler);
teamsRouter.get('/:id', getTeam);
teamsRouter.get('/:id/dashboard', getTeamDashboardHandler);
