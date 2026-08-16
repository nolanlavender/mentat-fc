import { pool } from '../src/db/pool.js';
import { seedFplBootstrap } from './sources/fpl.js';

// Standalone entry point for just re-running the FPL bootstrap-static pull
// (teams, players, current_team_id, gameweeks) -- one cheap call, not the
// full npm run db:seed. Exists specifically so the 2026-08-16
// canonicalTeamName fix (see lib/team-aliases.ts) can be applied without a
// full reseed: rerunning this re-resolves every FPL player's team against
// the corrected alias map.
async function main(): Promise<void> {
  await seedFplBootstrap(pool);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
