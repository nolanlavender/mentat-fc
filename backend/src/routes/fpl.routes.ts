import { Router } from 'express';
import { getMyTeamHandler, postLinkFplEntry } from '../controllers/fpl.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const fplRouter = Router();

// My Team is one person's actual FPL squad -- was public with no auth check
// at all, meaning anyone with the URL could see it. Same requireAuth
// pattern bets.routes.ts uses. requireAuth alone isn't enough on its own to
// make this per-user, though -- see fpl.service.ts's getMyTeamForUser,
// which is what actually looks up *this* user's own linked entry id.
fplRouter.use(requireAuth);

fplRouter.get('/my-team', getMyTeamHandler);
fplRouter.post('/link', postLinkFplEntry);
