import { Router } from 'express';
import { getMyTeamHandler } from '../controllers/fpl.controller.js';

export const fplRouter = Router();

fplRouter.get('/my-team', getMyTeamHandler);
