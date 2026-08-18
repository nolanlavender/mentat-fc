import { pool } from '../src/db/pool.js';
import { seedTodaysLineups } from './sources/api-football.js';

// Standalone entry point, meant to run far more often than the once-daily
// refresh -- see .github/workflows/matchday-lineups.yml. Checks fixtures
// kicking off soon (or that kicked off recently but aren't 'finished' yet)
// for a confirmed starting lineup, independent of backfillLineups's
// finished-only path. Safe to run as often as you like: a fixture with
// nothing new to find just gets rechecked next time, at the cost of one
// live API call each time (never cached -- see seedTodaysLineups).
async function main(): Promise<void> {
  if (!process.env.API_FOOTBALL_KEY) {
    console.log('Skipping matchday lineup check (API_FOOTBALL_KEY not set).');
    return;
  }
  const result = await seedTodaysLineups(pool);
  console.log(
    `Matchday lineups: checked ${result.checked} fixture(s) kicking off soon, ${result.announced} had a confirmed lineup.` +
      (result.stoppedOnBudget ? ' Stopped early -- daily API-Football budget exhausted.' : ''),
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
