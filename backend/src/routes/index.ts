import { Router } from 'express';
import { teamsRouter } from './teams.routes.js';
import { fixturesRouter } from './fixtures.routes.js';
import { playersRouter } from './players.routes.js';

export const apiRouter = Router();

apiRouter.use('/teams', teamsRouter);
apiRouter.use('/fixtures', fixturesRouter);
apiRouter.use('/players', playersRouter);
