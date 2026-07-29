import { Router } from 'express';
import { getFixtures, getFixture } from '../controllers/fixtures.controller.js';

export const fixturesRouter = Router();

fixturesRouter.get('/', getFixtures);
fixturesRouter.get('/:id', getFixture);
