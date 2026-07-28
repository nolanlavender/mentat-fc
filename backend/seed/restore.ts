import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { env } from '../src/config/env.js';

const dumpPath = new URL('./snapshot/mentat_fc_seed.dump', import.meta.url).pathname;
if (!existsSync(dumpPath)) {
  console.error(`No snapshot at ${dumpPath} -- run \`npm run db:seed\` instead to build the database from scratch.`);
  process.exit(1);
}

// --clean --if-exists: drops existing objects first, so this is safe to run
// against a database that already has (older, or partial) data in it, not
// just a freshly created empty one. Requires migrations to have been run
// first -- pg_restore recreates the data and the schema objects the dump
// captured, but this project's migrations remain the source of truth for
// schema *changes* going forward.
const result = spawnSync(
  'pg_restore',
  ['--clean', '--if-exists', '--no-owner', '--dbname', env.databaseUrl, dumpPath],
  { stdio: 'inherit' },
);
if (result.status !== 0) {
  console.error('pg_restore failed -- is Postgres running and DATABASE_URL correct?');
  process.exit(result.status ?? 1);
}
console.log('Restored from snapshot.');
