import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { env } from '../src/config/env.js';

// This is the fast path for "don't hit the API again to seed a local
// environment" -- seed/raw/ (gitignored) protects the API budget *during*
// the weeks-long backfill itself, but a fresh machine still has to run the
// whole seed pipeline (parsing + thousands of upserts) from scratch. This
// snapshot is a restorable copy of the actual seeded database, taken once
// the backfill is in a good state, so a new environment can skip straight
// to a working DB in seconds -- no network, no re-parsing, no rate limit.
//
// Unlike seed/raw/, this file is NOT gitignored: it's compact relational
// data (no media), and committing it means every clone of this repo has a
// known-good dev database available immediately. If it ever grows large
// enough that committing it stops being reasonable, move to a GitHub
// Release asset instead -- same idea as the team_aliases-table escalation
// path, don't build that until the plain version actually hurts.
const outputPath = new URL('./snapshot/mentat_fc_seed.dump', import.meta.url).pathname;
mkdirSync(new URL('./snapshot/', import.meta.url).pathname, { recursive: true });

// Custom format (-Fc): compressed, and the only format pg_restore can use
// --clean --if-exists with -- a plain SQL dump can't selectively drop
// existing objects before restoring the way this can.
const result = spawnSync('pg_dump', ['--format=custom', '--file', outputPath, env.databaseUrl], {
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.error('pg_dump failed -- is Postgres running and DATABASE_URL correct?');
  process.exit(result.status ?? 1);
}
console.log(`Wrote ${outputPath}`);
