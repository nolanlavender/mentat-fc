import { pool } from '../src/db/pool.js';
import { backfillTeamLogos } from './index.js';

// Standalone entry point for just pulling team crest URLs -- see
// backfillTeamLogos's own comment in index.ts for why this is fast (no new
// API calls on a machine that's already seeded once) instead of needing the
// full, hour-plus `npm run db:seed` run.
async function main(): Promise<void> {
  await backfillTeamLogos();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
