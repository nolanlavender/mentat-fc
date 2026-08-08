import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: requireEnv('DATABASE_URL'),
  // Optional, unlike DATABASE_URL: the app boots fine without it, only
  // /api/fpl/my-team needs it. Not everyone running this backend has (or
  // wants to expose) a personal FPL team.
  fplEntryId: process.env.FPL_ENTRY_ID ? Number(process.env.FPL_ENTRY_ID) : undefined,
};
