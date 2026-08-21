import { appendFile } from 'node:fs/promises';

import { pool } from '../src/db/pool.js';
import { MATCHDAY_LOOKAHEAD_HOURS, MATCHDAY_LOOKBACK_HOURS, seedTodaysLineups } from './sources/api-football.js';

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
      (result.alreadyCaptured > 0 ? ` ${result.alreadyCaptured} already had one and were skipped.` : '') +
      (result.stoppedOnBudget ? ' Stopped early -- daily API-Football budget exhausted.' : ''),
  );
  // Per-fixture detail, because the summary above is ambiguous on its own:
  // "checked 1, 0 confirmed" reads identically whether the fixture you
  // care about was the one checked or was never in the window at all. That
  // ambiguity cost a real debugging session on 2026-08-21.
  for (const outcome of result.outcomes) {
    const when =
      outcome.hoursToKickoff >= 0
        ? `kickoff in ${outcome.hoursToKickoff.toFixed(1)}h`
        : `kicked off ${Math.abs(outcome.hoursToKickoff).toFixed(1)}h ago`;
    console.log(
      `  ${outcome.label} -- ${when} -- ` +
        (outcome.announced ? 'lineup confirmed' : 'nothing published yet (normal until ~1h before kickoff)'),
    );
  }
  if (result.checked === 0 && result.alreadyCaptured === 0) {
    console.log(
      `  Nothing in the +/-${MATCHDAY_LOOKBACK_HOURS}h/${MATCHDAY_LOOKAHEAD_HOURS}h window. A fixture further out ` +
        'than that is not checked at all, so re-running now will not help it.',
    );
  }

  // Signals the workflow whether it is worth spending a retrain. Nothing
  // changed means nothing to apply, and the previous version of this job
  // rebuilt every prediction in the database hourly regardless -- which is
  // what exhausted the account's Actions minutes on 2026-08-20.
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `announced=${result.announced}\n`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
