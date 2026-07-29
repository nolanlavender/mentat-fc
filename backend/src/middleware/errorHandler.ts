import type { ErrorRequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

// Express 5 auto-forwards rejected promises from async route handlers here
// (no express-async-errors package, no manual try/catch-and-next needed in
// every controller like Express 4 required) -- this is the single place
// that decides what an error actually looks like to the client.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
