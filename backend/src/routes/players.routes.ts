import { Router } from 'express';
import { getPlayers, getPlayer } from '../controllers/players.controller.js';

export const playersRouter = Router();

playersRouter.get('/', getPlayers);
playersRouter.get('/:id', getPlayer);
