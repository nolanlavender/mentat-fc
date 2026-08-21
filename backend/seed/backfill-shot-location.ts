import { pool } from '../src/db/pool.js';
import { backfillShotLocationForCompetitionSeason } from './sources/api-football.js';

// Standalone entry point for the shot-location backfill (inside vs outside
// the box, from GET /fixtures/statistics). Kept separate from
// backfill-lineups.ts because it's a different endpoint with a different
// cost profile: one API call per fixture with no bulk form, so a full
// three-season catch-up is a few thousand calls and will usually take more
// than one day's budget.
//
// Resumable with no flags or saved position: every run re-queries for
// fixtures that still have no shots_inside_box, so stopping on budget and
// rerunning tomorrow continues exactly where it left off. Safe to run as
// often as you like.
//
// Oldest season first on purpose -- see
// backfillShotLocationForCompetitionSeason's own note. The real open
// question is whether OLD fixtures carry this data or only recent ones,
// and going oldest-first surfaces that in the first handful of calls
// rather than after thousands.
//
// Usage: npm run db:seed:shot-location
async function main(): Promise<void> {
  const { rows } = await pool.query<{ id: number; competition: string; season: string }>(
    `SELECT cs.id, c.name AS competition, s.label AS season
     FROM competition_seasons cs
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     ORDER BY s.start_date ASC, c.name ASC`,
  );

  let grandTotal = 0;
  let grandWithData = 0;
  for (const row of rows) {
    console.log(`${row.competition} ${row.season}:`);
    const result = await backfillShotLocationForCompetitionSeason(pool, row.id);
    grandTotal += result.done;
    grandWithData += result.withData;

    if (result.done === 0 && result.remaining === 0) {
      console.log('  nothing left to backfill.');
    }
    if (result.stoppedOnBudget) {
      console.log(
        `\nStopped: today's API-Football budget is used up (${result.remaining} fixtures left in this season, plus any later ones). Rerun tomorrow to continue.`,
      );
      break;
    }
  }

  if (grandTotal > 0) {
    const pct = Math.round((grandWithData / grandTotal) * 100);
    console.log(`\nTotal this run: ${grandWithData}/${grandTotal} fixtures had shot-location data (${pct}%).`);
    if (pct < 50) {
      console.log(
        'Coverage is low -- worth checking whether the older seasons carry this data at all before relying on it for model training.',
      );
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
