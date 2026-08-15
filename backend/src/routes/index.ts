import { Router } from 'express';
import { teamsRouter } from './teams.routes.js';
import { fixturesRouter } from './fixtures.routes.js';
import { playersRouter } from './players.routes.js';
import { fplRouter } from './fpl.routes.js';
import { betsRouter } from './bets.routes.js';
import { authRouter } from './auth.routes.js';

export const apiRouter = Router();

apiRouter.use('/teams', teamsRouter);
apiRouter.use('/fixtures', fixturesRouter);
apiRouter.use('/players', playersRouter);
apiRouter.use('/fpl', fplRouter);
apiRouter.use('/bets', betsRouter);
apiRouter.use('/auth', authRouter);
