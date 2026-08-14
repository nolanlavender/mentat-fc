import { Router } from 'express';
import { postBet, getBets, getBetsSummary, patchBet, removeBet } from '../controllers/bets.controller.js';

export const betsRouter = Router();

// Static path before the :id param route -- otherwise "/summary" would be
// parsed as an id and fail parseIdParam's numeric check.
betsRouter.get('/summary', getBetsSummary);

betsRouter.post('/', postBet);
betsRouter.get('/', getBets);
betsRouter.patch('/:id', patchBet);
betsRouter.delete('/:id', removeBet);
