import type { Request, Response } from 'express';
import { registerUser, loginUser } from '../services/auth.service.js';

export async function postRegister(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body ?? {};
  const result = await registerUser(email, password);
  res.status(201).json(result);
}

export async function postLogin(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body ?? {};
  const result = await loginUser(email, password);
  res.json(result);
}
