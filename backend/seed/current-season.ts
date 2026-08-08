import { pool } from '../src/db/pool.js';
import { seedCurrentSeasonFixtureLists } from './index.js';

// Standalone entry point for just the current-season fixture-list pull --
// the rest of `npm run db:seed` (historical CSVs, FPL bootstrap/gameweek
// backfill, FA Cup, lineup backfill) is either a one-time historical load
// already done or its own slow throttled job, and none of it needs to
// rerun just to pick up newly scheduled or newly finished current-season
// fixtures. Safe to run as often as you like -- every step it calls is an
// idempotent upsert.
async function main(): Promise<void> {
  await seedCurrentSeasonFixtureLists();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
