/**
 * The 2026-09-05 outage, pinned against a real schema.
 *
 * API-Football serves player.id as null for someone it has not assigned a
 * player record to yet -- in practice a recent signing named in a lineup
 * before the player record catches up. The response types promised
 * `number`, PlayerInput accepted `number | undefined`, and every guard on
 * the way to the writes asked `!== undefined`. A null satisfies all of
 * that and arrives at the two id writers, where it did two different
 * things:
 *
 *   - linkPlayerExternalId hit player_external_ids.external_id's NOT NULL
 *     constraint and took the whole run down. Loud. Daily data refresh and
 *     the matchday lineup check both failed intermittently for a week.
 *   - claimPlayerExternalId got there first and was silent: its collision
 *     check is `WHERE external_api_football_id = $1`, which matches nothing
 *     when $1 is NULL, so it fell through to UPDATE ... SET
 *     external_api_football_id = NULL and un-linked a correctly-linked
 *     player. These are pool.query calls on a Pool, so that committed on
 *     its own before the crash that followed.
 *
 * Neither half is reachable by a database-free test: one is a NOT NULL
 * constraint, the other is SQL's NULL comparison semantics. Same reasoning
 * as model-service/tests/test_queries_against_schema.py -- these run in
 * CI's `database` job against a Postgres built from the real migrations,
 * and skip everywhere else.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { upsertPlayerForTeamRoster, upsertPlayerGoldenRecord } from './db.js';

const SMOKE_DATABASE_URL = process.env.SMOKE_DATABASE_URL;
const describeWithDb = SMOKE_DATABASE_URL ? describe : describe.skip;

// Well outside anything the seed scripts generate, so a stray row from a
// real database can never be mistaken for one of these.
const TEAM_ID = 990001;
const OTHER_TEAM_ID = 990002;
const PLAYER_ID = 990101;
const ABBREV_PLAYER_ID = 990102;
const REAL_API_FOOTBALL_ID = 990901;

describeWithDb('null external ids from API-Football', () => {
  const pool = new Pool({ connectionString: SMOKE_DATABASE_URL });

  afterAll(async () => {
    await pool.end();
  });

  // Rows the tests themselves create get serial ids, so they cannot be
  // cleaned up by id range like the seeded ones -- and they hold a
  // current_team_id FK to the test teams, so missing one breaks the next
  // run's teardown rather than its assertions. Matched by name instead.
  const CREATED_NAMES = ['Brand New Signing', 'Squad Player Without An Id'];

  beforeEach(async () => {
    const scope = `id >= $1 OR full_name = ANY($2)`;
    await pool.query(`DELETE FROM player_external_ids WHERE player_id IN (SELECT id FROM players WHERE ${scope})`, [
      PLAYER_ID,
      CREATED_NAMES,
    ]);
    await pool.query(`DELETE FROM players WHERE ${scope}`, [PLAYER_ID, CREATED_NAMES]);
    await pool.query(`DELETE FROM teams WHERE id >= $1`, [TEAM_ID]);
    await pool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Test United'), ($2, 'Test Rovers')`, [TEAM_ID, OTHER_TEAM_ID]);
    // Two seeded players because the two name-matching tiers have
    // deliberately different eligibility. The abbreviated tier only
    // considers rows that are FPL-linked and NOT yet API-Football-linked
    // (it exists to bridge that exact gap), so the already-linked player
    // below is invisible to it and lands in the roster-scoped fuzzy tier
    // instead -- which is the tier the production crash came through.
    await pool.query(
      `INSERT INTO players (id, full_name, current_team_id, external_api_football_id, external_fpl_id)
       VALUES ($1, 'Alexander Isak Ramirez', $2, $3, 555001),
              ($4, 'Bruno Guimaraes Rodriguez Moura', $2, NULL, 555002)`,
      [PLAYER_ID, TEAM_ID, REAL_API_FOOTBALL_ID, ABBREV_PLAYER_ID],
    );
    await pool.query(`INSERT INTO player_external_ids (player_id, source, external_id) VALUES ($1, 'api_football', $2)`, [
      PLAYER_ID,
      REAL_API_FOOTBALL_ID,
    ]);
  });

  async function apiFootballIdOf(playerId: number): Promise<number | null> {
    const { rows } = await pool.query<{ external_api_football_id: number | null }>(
      `SELECT external_api_football_id FROM players WHERE id = $1`,
      [playerId],
    );
    return rows[0].external_api_football_id;
  }

  it('ingests a lineup player the source has no id for, instead of crashing the run', async () => {
    // The exact failing shape: a lineup entry with player.id === null.
    const id = await upsertPlayerGoldenRecord(pool, {
      externalApiFootballId: null,
      fullName: 'Brand New Signing',
      position: 'F',
      teamId: TEAM_ID,
    });

    expect(id).toBeGreaterThan(0);
    const { rows } = await pool.query<{ full_name: string }>(`SELECT full_name FROM players WHERE id = $1`, [id]);
    expect(rows[0].full_name).toBe('Brand New Signing');
  });

  it('records no external-id link for a player it has no id for', async () => {
    const id = await upsertPlayerGoldenRecord(pool, {
      externalApiFootballId: null,
      fullName: 'Brand New Signing',
      teamId: TEAM_ID,
    });

    const { rows } = await pool.query(`SELECT 1 FROM player_external_ids WHERE player_id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it('leaves an already-linked player\'s external id alone when a null-id sighting resolves to them', async () => {
    // The silent half, through the tier production actually hit: the
    // source's shorter common name resolves by word-subsequence against
    // the roster, and the old code wrote NULL over the player's real,
    // correct external_api_football_id on the way past.
    const id = await upsertPlayerGoldenRecord(pool, {
      externalApiFootballId: null,
      fullName: 'Alexander Isak',
      teamId: TEAM_ID,
    });

    expect(id).toBe(PLAYER_ID);
    expect(await apiFootballIdOf(PLAYER_ID)).toBe(REAL_API_FOOTBALL_ID);
  });

  it('still matches an abbreviated null-id name to the right player rather than duplicating them', async () => {
    // Regression guard on the restructure this fix required. Both name
    // tiers used to sit inside the "we have an id" block, so simply
    // gating that block on a non-null id -- the obvious one-line fix --
    // would have sent every id-less abbreviated sighting straight to the
    // insert path and quietly created a second row for a player we
    // already had. That is the same duplicate-identity failure the
    // abbreviated tier was written to prevent in the first place.
    const id = await upsertPlayerGoldenRecord(pool, {
      externalApiFootballId: null,
      fullName: 'B. Guimaraes',
      teamId: TEAM_ID,
    });

    expect(id).toBe(ABBREV_PLAYER_ID);
  });

  it('still links a real id when the source provides one', async () => {
    // The guards must not have turned the happy path off.
    const id = await upsertPlayerGoldenRecord(pool, {
      externalApiFootballId: REAL_API_FOOTBALL_ID,
      fullName: 'Alexander Isak Ramirez',
      teamId: TEAM_ID,
    });

    expect(id).toBe(PLAYER_ID);
    expect(await apiFootballIdOf(PLAYER_ID)).toBe(REAL_API_FOOTBALL_ID);
  });

  it('handles a null id from the squads endpoint too', async () => {
    // Same raw field, different endpoint and a different id space
    // ('api_football_squads'). It linked unconditionally, so it had the
    // identical crash.
    const id = await upsertPlayerForTeamRoster(pool, OTHER_TEAM_ID, {
      externalApiFootballId: null,
      fullName: 'Squad Player Without An Id',
    });

    expect(id).toBeGreaterThan(0);
    const { rows } = await pool.query(`SELECT 1 FROM player_external_ids WHERE player_id = $1 AND source = 'api_football_squads'`, [id]);
    expect(rows).toHaveLength(0);
  });
});
