import { Router } from 'express';
import { postBet, getBets, getBet, getBetsSummary, patchLeg, removeBet } from '../controllers/bets.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const betsRouter = Router();

// Every bet is somebody's personal record -- the whole router requires auth.
betsRouter.use(requireAuth);

// Static path before the :id param route -- otherwise "/summary" would be
// parsed as an id and fail parseIdParam's numeric check.
betsRouter.get('/summary', getBetsSummary);

betsRouter.post('/', postBet);
betsRouter.get('/', getBets);
betsRouter.get('/:id', getBet);
betsRouter.patch('/:id/legs/:legId', patchLeg);
betsRouter.delete('/:id', removeBet);
