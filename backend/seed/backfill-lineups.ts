import { pool } from '../src/db/pool.js';
import { backfillLineups } from './index.js';

// Standalone entry point for just the lineup + player-stats backfill --
// the slowest, most crash-prone stage of `npm run db:seed` (real API-
// Football data quirks and a dropped DB connection have all interrupted it
// mid-run). The other stages (historical CSVs, FPL bootstrap/gameweek
// history, FA Cup fixture lists) are either a one-time historical load
// already done or cheap to rerun on their own -- none of them need to
// happen again just to keep making progress on the backfill.
//
// No resume flag or saved position needed: backfillLineups ->
// backfillLineupsForCompetitionSeason always re-queries the DB for
// fixtures still missing lineups/player stats before doing any work, so
// running this again after any crash picks up exactly where the last run
// left off. Safe to run as often as you like.
async function main(): Promise<void> {
  await backfillLineups();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
