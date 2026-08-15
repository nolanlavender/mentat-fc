import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

const BCRYPT_ROUNDS = 12;
const TOKEN_EXPIRY = '30d'; // personal app, no refresh-token flow -- a long-lived token traded for not having to log back in constantly

export interface AuthResult {
  token: string;
  user: { id: number; email: string };
}

function issueToken(userId: number): string {
  return jwt.sign({ userId }, env.jwtSecret, { expiresIn: TOKEN_EXPIRY });
}

export async function registerUser(email: string, password: string): Promise<AuthResult> {
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new AppError('A valid email is required', 400);
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new AppError('Password must be at least 8 characters', 400);
  }

  const existing = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) {
    throw new AppError('An account with this email already exists', 409);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const { rows } = await pool.query<{ id: number; email: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
    [email, passwordHash],
  );

  return { token: issueToken(rows[0].id), user: rows[0] };
}

export async function loginUser(email: string, password: string): Promise<AuthResult> {
  const { rows } = await pool.query<{ id: number; email: string; password_hash: string }>(
    `SELECT id, email, password_hash FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];

  // Same error either way (bad email vs. bad password) -- distinguishing
  // them tells an attacker which emails have accounts.
  const invalidCredentials = () => new AppError('Invalid email or password', 401);
  if (!user) throw invalidCredentials();

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw invalidCredentials();

  return { token: issueToken(user.id), user: { id: user.id, email: user.email } };
}

export function verifyToken(token: string): { userId: number } {
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    if (typeof payload === 'string' || typeof payload.userId !== 'number') {
      throw new Error('Malformed token payload');
    }
    return { userId: payload.userId };
  } catch {
    throw new AppError('Invalid or expired token', 401);
  }
}
