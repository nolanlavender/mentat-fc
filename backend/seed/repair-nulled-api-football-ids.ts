/**
 * One-off repair for the 2026-09-05 null-external-id bug.
 *
 * While that bug was live, every crashed run of the daily refresh or the
 * matchday lineup check un-linked exactly one player before it died:
 * claimPlayerExternalId's collision check is
 * `WHERE external_api_football_id = $1`, which matches nothing when $1 is
 * NULL, so it fell through to `UPDATE players SET
 * external_api_football_id = NULL`. That statement autocommits on its own
 * (these are pool.query calls on a Pool, not a transaction), so it stuck
 * even though the very next statement threw.
 *
 * Why it is worth repairing rather than shrugging at. players.
 * external_api_football_id is read in exactly one place --
 * upsertPlayerGoldenRecord's abbreviated-name tier, whose candidate query
 * requires `external_api_football_id IS NULL`. That condition exists to
 * mean "this player is not linked to API-Football yet", so a wiped player
 * silently becomes eligible for a name-based matcher they were correctly
 * excluded from, where a stray "A. Surname" sighting could resolve onto
 * them. Small blast radius, but it is the misattribution class of bug this
 * file spends most of its comments defending against.
 *
 * The value is recoverable because only the players row was damaged: the
 * link that failed was the INSERT into player_external_ids, so the
 * pre-existing api_football row for that player is untouched and still
 * holds the right id. This restores from it, and only where doing so is
 * unambiguous:
 *
 *   - exactly one api_football link row for the player, and
 *   - no OTHER player already holding that id (the column is UNIQUE, and
 *     a collision here would mean a genuine duplicate to reconcile with
 *     repair-duplicate-players.ts, not something to guess at).
 *
 * Read-only unless --apply is passed. Safe to run repeatedly; once every
 * recoverable row is restored it reports nothing to do.
 *
 * Usage: npm run db:repair-nulled-api-football-ids [-- --apply]
 */
import { pool } from '../src/db/pool.js';

const CANDIDATES = `
  SELECT p.id, p.full_name, min(pei.external_id) AS external_id, count(*) AS link_rows
  FROM players p
  JOIN player_external_ids pei ON pei.player_id = p.id AND pei.source = 'api_football'
  WHERE p.external_api_football_id IS NULL
  GROUP BY p.id, p.full_name
  HAVING count(*) = 1
     AND NOT EXISTS (
       SELECT 1 FROM players other
       WHERE other.external_api_football_id = min(pei.external_id) AND other.id <> p.id
     )
  ORDER BY p.id
`;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const { rows } = await pool.query<{ id: number; full_name: string; external_id: number }>(CANDIDATES);
  if (rows.length === 0) {
    console.log('Nothing to repair: every api_football-linked player already has external_api_football_id set.');
    return;
  }

  console.log(`${rows.length} player(s) have an api_football link but a NULL external_api_football_id:\n`);
  for (const r of rows) console.log(`  ${r.id.toString().padStart(6)}  ${r.full_name}  -> ${r.external_id}`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to restore these.');
    return;
  }

  let repaired = 0;
  for (const r of rows) {
    // Re-check inside the loop rather than trusting the snapshot: the
    // UNIQUE constraint is what makes this safe, and a concurrent seed run
    // could have claimed the id since the SELECT above.
    const { rowCount } = await pool.query(
      `UPDATE players SET external_api_football_id = $2
       WHERE id = $1
         AND external_api_football_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM players other WHERE other.external_api_football_id = $2 AND other.id <> $1)`,
      [r.id, r.external_id],
    );
    if (rowCount === 1) repaired += 1;
    else console.warn(`  skipped player ${r.id} (${r.full_name}) -- ${r.external_id} was claimed in the meantime.`);
  }
  console.log(`\nRestored ${repaired} of ${rows.length}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
