import { pool } from '../src/db/pool.js';
import { seedUpcomingOdds } from './sources/api-football.js';

// Pre-match 1X2 odds for fixtures kicking off in the next few days --
// consumed by model-service/app/check_market_divergence.py, and run as the
// first step of .github/workflows/market-divergence.yml so the check always
// compares against a fresh price rather than yesterday's.
const LOOKAHEAD_DAYS = 4;

async function main(): Promise<void> {
  if (!process.env.API_FOOTBALL_KEY) {
    console.log('Skipping upcoming-odds seed (API_FOOTBALL_KEY not set).');
    return;
  }
  const result = await seedUpcomingOdds(pool, LOOKAHEAD_DAYS);
  console.log(
    `Upcoming odds: fetched for ${result.checked} fixture(s) in the next ${LOOKAHEAD_DAYS} days, ` +
      `${result.withOdds} had bookmaker prices.` +
      (result.stoppedOnBudget ? ' Stopped early -- daily API-Football budget exhausted.' : ''),
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
