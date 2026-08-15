import { Router } from 'express';
import { postRegister, postLogin } from '../controllers/auth.controller.js';

export const authRouter = Router();

authRouter.post('/register', postRegister);
authRouter.post('/login', postLogin);
