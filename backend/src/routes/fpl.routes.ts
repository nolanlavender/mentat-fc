import { Router } from 'express';
import { getMyTeamHandler } from '../controllers/fpl.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const fplRouter = Router();

// My Team is one person's actual FPL squad -- was public with no auth check
// at all, meaning anyone with the URL could see it. Same requireAuth
// pattern bets.routes.ts uses.
fplRouter.use(requireAuth);

fplRouter.get('/my-team', getMyTeamHandler);
