import { pool } from '../src/db/pool.js';
import { parseAbbreviatedName, namesLikelyMatch } from './lib/db.js';

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
 * + initial+surname logic as below). This script is the one-time cleanup
 * for orphans that already exist in production, in two passes:
 *
 * 1. Abbreviated names ("M. Caicedo"), matched globally against the current
 *    roster by initial + ANY surname word (not just the last one -- real
 *    bug found 2026-08-16: Hispanic two-surname names like "Moisés Caicedo
 *    Corozo" only ever matched on "Corozo", never "Caicedo", the surname
 *    people actually call him by). Deliberately narrow: only merges into a
 *    *currently rostered* player (external_fpl_id IS NOT NULL) when the
 *    match is unique.
 * 2. Full-name mismatches that AREN'T abbreviated at all -- FPL sometimes
 *    stores a player's full legal name ("João Pedro Junqueira de Jesus")
 *    while API-Football uses their common football name ("João Pedro"),
 *    confirmed for real the same day for several Chelsea attackers
 *    (Estêvão, Pedro Neto, and others). A global fuzzy match here would be
 *    too risky (many real players share a first name), so this pass
 *    derives which real team an orphan most likely played for from its own
 *    fixture_lineups rows, then only fuzzy-matches against THAT team's
 *    current roster -- same safety rule as upsertPlayerGoldenRecord's own
 *    team-scoped fuzzy tier, just reconstructing the team context from the
 *    orphan's existing data instead of a live API call.
 *
 * Either way: an orphan with no current-squad match (a historical or
 * lower-league player, most of the corpus) or an ambiguous collision (two
 * rostered players matching) is left alone rather than guessed at --
 * printed to the log either way so nothing is silently skipped.
 *
 * Idempotent: rerunning after a partial run or a fresh backfill just finds
 * fewer (or zero) orphans left to merge.
 */

interface MergeCounts {
  merged: number;
  skippedAmbiguous: number;
  skippedNoMatch: number;
}

async function mergeOrphan(orphanId: number, targetId: number, orphanFullName: string, preferOrphanName: boolean): Promise<void> {
  const { rows } = await pool.query<{ external_api_football_id: number | null; photo_url: string | null }>(
    `SELECT external_api_football_id, photo_url FROM players WHERE id = $1`,
    [orphanId],
  );
  const orphan = rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Neither of these can conflict with an existing row on the target
    // player -- the target never had any API-Football data linked (that's
    // the whole bug), so it has zero fixture_lineups/fixture_player_stats
    // rows to collide with.
    await client.query(`UPDATE fixture_lineups SET player_id = $1 WHERE player_id = $2`, [targetId, orphanId]);
    await client.query(`UPDATE fixture_player_stats SET player_id = $1 WHERE player_id = $2`, [targetId, orphanId]);
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
      [targetId, orphanId],
    );
    await client.query(`DELETE FROM player_goal_predictions WHERE player_id = $1`, [orphanId]);
    // Delete the orphan row (now safe -- nothing FKs to it anymore) BEFORE
    // freeing its external_api_football_id onto the target: that column is
    // UNIQUE, so doing this the other way round collides with the orphan's
    // own still-live value.
    await client.query(`DELETE FROM players WHERE id = $1`, [orphanId]);
    await client.query(
      `UPDATE players SET
         external_api_football_id = COALESCE(external_api_football_id, $2),
         full_name = CASE WHEN $3 THEN $4 ELSE full_name END,
         photo_url = COALESCE(photo_url, $5)
       WHERE id = $1`,
      [targetId, orphan?.external_api_football_id ?? null, preferOrphanName, orphanFullName, orphan?.photo_url ?? null],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function repairAbbreviatedOrphans(): Promise<MergeCounts> {
  const { rows: orphans } = await pool.query<{ id: number; full_name: string }>(
    `SELECT id, full_name
     FROM players
     WHERE current_team_id IS NULL
       AND external_fpl_id IS NULL
       AND external_api_football_id IS NOT NULL`,
  );

  console.log(`Pass 1 (abbreviated names): checking ${orphans.length} orphan row(s)...`);

  const counts: MergeCounts = { merged: 0, skippedAmbiguous: 0, skippedNoMatch: 0 };
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
         AND $2 = ANY((string_to_array(lower(full_name), ' '))[2:])`,
      [abbreviated.initial, abbreviated.surname],
    );

    if (candidates.length === 0) {
      counts.skippedNoMatch++;
      continue;
    }
    if (candidates.length > 1) {
      counts.skippedAmbiguous++;
      console.log(`  Ambiguous: "${orphan.full_name}" (id ${orphan.id}) matches ${candidates.length} rostered players -- skipped.`);
      continue;
    }

    try {
      await mergeOrphan(orphan.id, candidates[0].id, orphan.full_name, false);
      counts.merged++;
    } catch (err) {
      console.error(`  Failed to merge "${orphan.full_name}" (id ${orphan.id}):`, err);
    }
  }

  console.log(
    `Pass 1 done: merged ${counts.merged}, ${counts.skippedAmbiguous} ambiguous, ${counts.skippedNoMatch} no current-squad match, ` +
      `${skippedNotAbbreviated} weren't in "X. Surname" form.`,
  );
  return counts;
}

async function repairFuzzyNameOrphans(): Promise<MergeCounts> {
  // Re-queried fresh -- pass 1 may have already resolved some of these.
  const { rows: orphans } = await pool.query<{ id: number; full_name: string }>(
    `SELECT id, full_name
     FROM players
     WHERE current_team_id IS NULL
       AND external_fpl_id IS NULL
       AND external_api_football_id IS NOT NULL
       AND full_name !~ '^[A-Za-z]\\.\\s*\\S'`, // excludes the abbreviated form pass 1 already handled
  );

  console.log(`\nPass 2 (full-name mismatches): checking ${orphans.length} orphan row(s)...`);

  const counts: MergeCounts = { merged: 0, skippedAmbiguous: 0, skippedNoMatch: 0 };
  let skippedNoTeamSignal = 0;

  for (const orphan of orphans) {
    // Which real team did this orphan most likely play for? Derived from
    // its own fixture_lineups rows (falls back to fixture_player_stats if
    // it somehow has stats but no lineup rows) -- a dominant team (more
    // than half the appearances) is required, not just a plurality, so a
    // player who's genuinely bounced between loan spells doesn't get
    // pinned to whichever club happens to have one more row.
    const { rows: teamCounts } = await pool.query<{ team_id: number; appearances: string }>(
      `SELECT team_id, count(*) AS appearances FROM (
         SELECT team_id FROM fixture_lineups WHERE player_id = $1
         UNION ALL
         SELECT team_id FROM fixture_player_stats WHERE player_id = $1
       ) combined
       GROUP BY team_id
       ORDER BY appearances DESC`,
      [orphan.id],
    );
    const totalAppearances = teamCounts.reduce((sum, r) => sum + Number(r.appearances), 0);
    const dominant = teamCounts[0];
    if (!dominant || Number(dominant.appearances) <= totalAppearances / 2) {
      skippedNoTeamSignal++;
      continue;
    }

    const { rows: roster } = await pool.query<{ id: number; full_name: string }>(
      `SELECT id, full_name FROM players WHERE current_team_id = $1`,
      [dominant.team_id],
    );
    const fuzzyMatches = roster.filter((r) => namesLikelyMatch(r.full_name, orphan.full_name));

    if (fuzzyMatches.length === 0) {
      counts.skippedNoMatch++;
      continue;
    }
    if (fuzzyMatches.length > 1) {
      counts.skippedAmbiguous++;
      console.log(
        `  Ambiguous: "${orphan.full_name}" (id ${orphan.id}) fuzzy-matches ${fuzzyMatches.length} players on team ${dominant.team_id} -- skipped.`,
      );
      continue;
    }

    const match = fuzzyMatches[0];
    const preferOrphanName = orphan.full_name.trim().split(/\s+/).length < match.full_name.trim().split(/\s+/).length;
    try {
      await mergeOrphan(orphan.id, match.id, orphan.full_name, preferOrphanName);
      counts.merged++;
      console.log(`  Merged "${orphan.full_name}" (id ${orphan.id}) into "${match.full_name}" (id ${match.id}).`);
    } catch (err) {
      console.error(`  Failed to merge "${orphan.full_name}" (id ${orphan.id}):`, err);
    }
  }

  console.log(
    `Pass 2 done: merged ${counts.merged}, ${counts.skippedAmbiguous} ambiguous, ${counts.skippedNoMatch} no fuzzy match, ` +
      `${skippedNoTeamSignal} had no dominant team to scope against.`,
  );
  return counts;
}

async function main(): Promise<void> {
  await repairAbbreviatedOrphans();
  await repairFuzzyNameOrphans();

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
  console.log(`\nBackfilled lineups_checked_at on ${rowCount} fixture(s) that already had full data but were never marked.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
