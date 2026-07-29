import { AppError } from './errors.js';

// Express 5 types a route param as string | string[] (a param can repeat in
// a wildcard match) even for a plain ":id" segment that will only ever be a
// single string in practice -- normalize before validating.
export function parseIdParam(raw: string | string[], resource: string): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(`Invalid ${resource} id: ${value}`, 400);
  }
  return id;
}
