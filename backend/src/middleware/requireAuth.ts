import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.service.js';
import { AppError } from '../lib/errors.js';

// Module augmentation, not a custom request type threaded through every
// controller signature -- req.userId just needs to exist on the same
// Request object Express already passes everywhere.
declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) throw new AppError('Missing Authorization header', 401);

  req.userId = verifyToken(token).userId;
  next();
}
