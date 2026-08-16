import { pool } from '../src/db/pool.js';
import { parseAbbreviatedName } from './lib/db.js';

/**
 * One-time repair for a real production bug: upsertPlayerGoldenRecord used
 * to only match an incoming API-Football sighting against an existing
 * player by an exact case-insensitive full_name compare. API-Football
 * routinely serves current top-flight squad players under an abbreviated
 * "R. James" form (confirmed for real 2026-08-16 -- Reece James, a Chelsea
 * player with a genuine FPL-seeded row, id 144, had his real lineup/stats
 * data attached instead to a completely separate orphan row, id 1333,
 * "R. James"). That exact-match miss meant nearly every API-Football call
 * for a rostered player fell through to INSERT: 5,845 orphan rows in
 * production (current_team_id NULL, since only the FPL bootstrap ever sets
 * that column) against just 12 players correctly linked.
 *
 * db.ts's upsertPlayerGoldenRecord now resolves this going forward (see the
 * abbreviated-name match step added there, using the same parseAbbreviatedName
 * + unique initial+surname logic as below). This script is the one-time
 * cleanup for orphans that already exist in production. Scope is
 * deliberately narrow, matching the ongoing fix's own safety rule: only
 * merges an orphan into a *currently rostered* player (external_fpl_id IS
 * NOT NULL) when the initial+surname match is unique. An orphan with no
 * current-squad match (a historical or lower-league player, most of the
 * 5,845) or an ambiguous initial+surname collision (two rostered players
 * sharing both) is left alone rather than guessed at -- printed to the log
 * either way so nothing is silently skipped.
 *
 * Idempotent: rerunning after a partial run or a fresh backfill just finds
 * fewer (or zero) orphans left to merge.
 */
async function main(): Promise<void> {
  const { rows: orphans } = await pool.query<{
    id: number;
    full_name: string;
    external_api_football_id: number;
    photo_url: string | null;
  }>(
    `SELECT id, full_name, external_api_football_id, photo_url
     FROM players
     WHERE current_team_id IS NULL
       AND external_fpl_id IS NULL
       AND external_api_football_id IS NOT NULL`,
  );

  console.log(`Checking ${orphans.length} orphan player row(s) for an abbreviated-name match against this season's roster...`);

  let merged = 0;
  let skippedAmbiguous = 0;
  let skippedNoMatch = 0;
  let skippedNotAbbreviated = 0;

  for (const orphan of orphans) {
    const abbreviated = parseAbbreviatedName(orphan.full_name);
    if (!abbreviated) {
      skippedNotAbbreviated++;
      continue;
    }

    const { rows: candidates } = await pool.query<{ id: number }>(
      `SELECT id FROM players
       WHERE external_fpl_id IS NOT NULL
         AND external_api_football_id IS NULL
         AND lower(left(full_name, 1)) = $1
         AND lower(split_part(full_name, ' ', -1)) = $2`,
      [abbreviated.initial, abbreviated.surname],
    );

    if (candidates.length === 0) {
      skippedNoMatch++;
      continue;
    }
    if (candidates.length > 1) {
      skippedAmbiguous++;
      console.log(`  Ambiguous: "${orphan.full_name}" (id ${orphan.id}) matches ${candidates.length} rostered players -- skipped.`);
      continue;
    }

    const targetId = candidates[0].id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Neither of these can conflict with an existing row on the target
      // player -- the target never had any API-Football data linked (that's
      // the whole bug), so it has zero fixture_lineups/fixture_player_stats
      // rows to collide with.
      await client.query(`UPDATE fixture_lineups SET player_id = $1 WHERE player_id = $2`, [targetId, orphan.id]);
      await client.query(`UPDATE fixture_player_stats SET player_id = $1 WHERE player_id = $2`, [targetId, orphan.id]);
      // player_goal_predictions CAN collide (UNIQUE fixture_id, player_id,
      // model_version) if the model ever predicted for both identities on
      // the same fixture/run -- move what doesn't conflict, drop the rest
      // rather than guess which prediction is "right".
      await client.query(
        `UPDATE player_goal_predictions target_upd SET player_id = $1
         WHERE player_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM player_goal_predictions existing
             WHERE existing.player_id = $1
               AND existing.fixture_id = target_upd.fixture_id
               AND existing.model_version = target_upd.model_version
           )`,
        [targetId, orphan.id],
      );
      await client.query(`DELETE FROM player_goal_predictions WHERE player_id = $1`, [orphan.id]);
      // Delete the orphan row (now safe -- nothing FKs to it anymore)
      // BEFORE freeing its external_api_football_id onto the target: that
      // column is UNIQUE, so doing this the other way round collides with
      // the orphan's own still-live value (caught for real by this
      // script's own scratch-Postgres verification pass before ever being
      // run against production).
      await client.query(`DELETE FROM players WHERE id = $1`, [orphan.id]);
      await client.query(
        `UPDATE players SET
           external_api_football_id = $2,
           photo_url = COALESCE(photo_url, $3)
         WHERE id = $1`,
        [targetId, orphan.external_api_football_id, orphan.photo_url],
      );
      await client.query('COMMIT');
      merged++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  Failed to merge "${orphan.full_name}" (id ${orphan.id}) into id ${targetId}:`, err);
    } finally {
      client.release();
    }
  }

  console.log(
    `Merged ${merged} duplicate row(s) into their real FPL-seeded player. ` +
      `${skippedAmbiguous} ambiguous, ${skippedNoMatch} had no current-squad match, ${skippedNotAbbreviated} weren't in "X. Surname" form -- all left alone.`,
  );

  // Closes the loop on a second, related symptom: some fixtures already
  // have real fixture_lineups/fixture_player_stats rows (often written
  // under the orphan ids just merged above) but lineups_checked_at was
  // never set on them -- backfillLineupsForCompetitionSeason correctly
  // reports them as "not a candidate" (it checks for existing data, not
  // just the checked flag) but the flag itself stays stale/misleading.
  // Safe and idempotent: only touches fixtures that genuinely already have
  // both.
  const { rowCount } = await pool.query(
    `UPDATE fixtures f SET lineups_checked_at = now()
     WHERE f.lineups_checked_at IS NULL
       AND f.status = 'finished'
       AND EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id)
       AND EXISTS (SELECT 1 FROM fixture_player_stats fps WHERE fps.fixture_id = f.id)`,
  );
  console.log(`Backfilled lineups_checked_at on ${rowCount} fixture(s) that already had full data but were never marked.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
