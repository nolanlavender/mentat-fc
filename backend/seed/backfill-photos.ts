import { pool } from '../src/db/pool.js';
import { backfillPlayerPhotos } from './index.js';

// Standalone entry point for just pulling current-season player headshots --
// see backfillPlayerPhotos's own comment in index.ts for why this uses
// API-Football's whole-league-season /players endpoint (bounded, predictable
// call count) instead of looping every fixture the way the full lineup
// backfill does.
async function main(): Promise<void> {
  await backfillPlayerPhotos();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
