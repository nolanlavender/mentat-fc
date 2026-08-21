import type { Pool } from 'pg';
import { teamShortCode } from './team-short-codes.js';

// Builds "($1, $2, ...), ($3, $4, ...), ..." for a multi-row INSERT --
// shared by the batch upserts below, which exist because seeding
// football-data.co.uk originally issued one INSERT per odds row (~30-60
// per fixture) and one per team-stats row (2 per fixture), each its own
// network round-trip to a remote Postgres. For ~2,800 fixtures across
// Premier League + Championship that's 100,000+ sequential round-trips --
// real, measured seed latency, not a hypothetical. Collapsing a whole
// fixture's odds/stats into one multi-row statement each cuts that to 2
// round-trips per fixture instead of ~35-65.
function buildValuesPlaceholders(rowCount: number, colCount: number): string {
  const rows: string[] = [];
  let paramIndex = 1;
  for (let r = 0; r < rowCount; r++) {
    const cols: string[] = [];
    for (let c = 0; c < colCount; c++) cols.push(`$${paramIndex++}`);
    rows.push(`(${cols.join(', ')})`);
  }
  return rows.join(', ');
}

// API-Football's "R. James" shorthand form, as opposed to a genuinely
// one-word or already-full name -- deliberately narrow (a single letter,
// a literal period, then the rest) so this never misfires on a real
// mononym or a name that just happens to start with an initial-looking
// token.
export function parseAbbreviatedName(fullName: string): { initial: string; surname: string } | null {
  const match = fullName.trim().match(/^([A-Za-z])\.\s*(.+)$/);
  if (!match) return null;
  return { initial: match[1].toLowerCase(), surname: match[2].trim().toLowerCase() };
}

function normalizeNameWords(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // drops NFD-decomposed accent marks so accented and unaccented spellings of the same name compare equal
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function isWordSubsequence(shorter: string[], longer: string[]): boolean {
  let i = 0;
  for (const word of longer) {
    if (i < shorter.length && word === shorter[i]) i++;
  }
  return i === shorter.length;
}

/**
 * True if one name's words appear, in order, inside the other's -- e.g.
 * "Pedro Neto" inside "Pedro Lomba Neto", or "João Pedro" inside "João
 * Pedro Junqueira de Jesus". Deliberately bidirectional: real production
 * data confirmed 2026-08-16 that either source can be the longer one --
 * FPL had the fuller legal name for João Pedro, but API-Football's squads
 * endpoint had the fuller name ("Geovany Tcherno Quenda") for a player FPL
 * stores under the shorter "Geovany Quenda". A lone single-word name has
 * to match the other name's FIRST word specifically (not just appear
 * anywhere in it) -- a bare first name like "Pedro" turning up anywhere
 * isn't a strong enough signal by itself, but matching the start of the
 * full name is.
 */
export function namesLikelyMatch(a: string, b: string): boolean {
  const wa = normalizeNameWords(a);
  const wb = normalizeNameWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (shorter.length === 1) return longer[0] === shorter[0];
  return isWordSubsequence(shorter, longer);
}

function nameWordCount(name: string): number {
  return normalizeNameWords(name).length;
}

export async function getOrCreateCompetition(
  pool: Pool,
  name: string,
  type: 'league' | 'cup',
  externalApiFootballLeagueId?: number,
): Promise<number> {
  // Matched by name, not an ON CONFLICT on external_api_football_league_id:
  // that column is nullable, and Postgres never treats NULL = NULL as a
  // conflict, so a naive upsert on it would silently insert a fresh row
  // every single run whenever the id isn't supplied (exactly what happened
  // here in testing -- competitions, then everything downstream of them,
  // doubled on a second seed run).
  const existing = await pool.query<{ id: number }>(`SELECT id FROM competitions WHERE name = $1`, [name]);
  if (existing.rows[0]) {
    if (externalApiFootballLeagueId !== undefined) {
      await pool.query(
        `UPDATE competitions SET external_api_football_league_id = $2 WHERE id = $1 AND external_api_football_league_id IS NULL`,
        [existing.rows[0].id, externalApiFootballLeagueId],
      );
    }
    return existing.rows[0].id;
  }
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO competitions (name, type, external_api_football_league_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, type, externalApiFootballLeagueId ?? null],
  );
  return inserted.rows[0].id;
}

export async function getOrCreateSeason(pool: Pool, label: string, startDate: string, endDate: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seasons (label, start_date, end_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (label) DO UPDATE SET start_date = EXCLUDED.start_date
     RETURNING id`,
    [label, startDate, endDate],
  );
  return rows[0].id;
}

export async function getOrCreateCompetitionSeason(
  pool: Pool,
  competitionId: number,
  seasonId: number,
  externalSeasonYear?: number,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO competition_seasons (competition_id, season_id, external_season_year)
     VALUES ($1, $2, $3)
     ON CONFLICT (competition_id, season_id) DO UPDATE SET external_season_year = COALESCE(EXCLUDED.external_season_year, competition_seasons.external_season_year)
     RETURNING id`,
    [competitionId, seasonId, externalSeasonYear ?? null],
  );
  return rows[0].id;
}

// Teams' golden-record key (natural_key, a generated column hashing the
// normalized name -- see migration 1701000000013) makes this a single
// upsert instead of a select-then-insert: any source computes the same key
// for "Manchester United" and lands on the same row, as long as
// canonicalTeamName() has already resolved source-specific short names to
// the canonical one before this is called.
// Module-level, not per-call -- lives for the process's lifetime, which is
// exactly one `npm run db:seed` run. Real seeding cost measured: getOrCreateTeam
// was called ~2x per fixture (home + away), so ~5,600 round-trips for PL +
// Championship alone, resolving the same ~50 distinct team names over and
// over. Team names don't change mid-run and nothing else writes to `teams`
// concurrently during a seed run, so caching here is safe, not just fast.
const teamIdCache = new Map<string, number>();

// logoUrl is optional and only ever fills a gap (COALESCE), never
// overwrites -- the fixtures-list call sees every team many times per
// season, but teamIdCache means only the first sighting per process run
// actually reaches this query, so there's no point re-sending it on every
// cache hit.
// externalApiFootballId is optional and only ever fills a gap (COALESCE),
// same reasoning as logoUrl. Real gap found in production 2026-08-16: every
// API-Football team payload (fixtures, lineups, player-stats) carries the
// source's own numeric team id, but nothing ever passed it through here --
// teams.external_api_football_id has existed since the Phase 1 schema and
// was never once written to, which silently blocked anything needing a
// team-scoped API-Football call (e.g. GET /players/squads?team=).
//
// short_name is the same shape of gap, found the same way: the column has
// existed since the Phase 1 schema, nothing ever wrote to it. Unlike the
// other two fields, there's no source payload to read it from -- API-
// Football's fixtures/lineups responses don't carry a short code -- so
// it's derived from `name` itself via teamShortCode() rather than passed
// in by the caller. `name` is always canonicalTeamName()'s output by the
// time it reaches here, so this stays consistent regardless of which raw
// source name a given call started from.
export async function getOrCreateTeam(pool: Pool, name: string, logoUrl?: string, externalApiFootballId?: number): Promise<number> {
  const cached = teamIdCache.get(name);
  if (cached !== undefined) return cached;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO teams (name, logo_url, external_api_football_id, short_name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (natural_key) DO UPDATE SET
       name = teams.name,
       logo_url = COALESCE(teams.logo_url, EXCLUDED.logo_url),
       external_api_football_id = COALESCE(teams.external_api_football_id, EXCLUDED.external_api_football_id),
       short_name = COALESCE(teams.short_name, EXCLUDED.short_name)
     RETURNING id`,
    [name, logoUrl ?? null, externalApiFootballId ?? null, teamShortCode(name)],
  );
  teamIdCache.set(name, rows[0].id);
  return rows[0].id;
}

export async function setTeamExternalFplId(pool: Pool, teamId: number, externalFplId: number): Promise<void> {
  await pool.query(`UPDATE teams SET external_fpl_id = $2 WHERE id = $1`, [teamId, externalFplId]);
}

// A direct overwrite, not a COALESCE-preserve-old upsert: both callers'
// sources always reflect current reality on a rerun, so either should win
// over whatever was there before (a transfer moved the player, and that
// stops being true, not something to preserve). Two callers, deliberately
// not three: FPL's bootstrap-static (Premier League) and, since
// 2026-08-18, upsertPlayerForTeamRoster's GET /players/squads?team={id}
// sightings (Championship and PL both, though PL's FPL signal usually
// lands first) -- both are genuine "this is the player's CURRENT team"
// signals. API-Football's lineups/player-stats sightings still don't call
// this and never should: they only know "this player played for this team
// in THIS match," which stops being true the moment a transfer happens,
// exactly the staleness getSquad's 2026-08-18 fix had to work around.
export async function setPlayerCurrentTeam(pool: Pool, playerId: number, teamId: number): Promise<void> {
  await pool.query(`UPDATE players SET current_team_id = $2 WHERE id = $1`, [playerId, teamId]);
}

export interface PlayerInput {
  externalFplId?: number;
  externalApiFootballId?: number;
  fullName: string;
  dateOfBirth?: string;
  nationality?: string;
  position?: string;
  photoUrl?: string;
  // Our internal team id this sighting was FOR (e.g. the team a lineup
  // entry lists the player under), when the caller has it. Purely an
  // optional safety net -- see the fuzzy-match tier below -- callers that
  // don't have team context (or don't need one, e.g. FPL, which already
  // matches reliably by exact name/DOB) simply omit it.
  teamId?: number;
}

// Records that (source, externalId) genuinely is this player, going
// forward -- see migration 1701000000023's comment for why this exists
// separately from players.external_api_football_id/external_fpl_id (those
// stay as the "primary"/first-linked id for each, used everywhere they
// already are; this is the general fix for a source having more than one
// internal id for the same real person). ON CONFLICT DO NOTHING, not DO
// UPDATE: if (source, externalId) is already recorded, the caller already
// resolved to the same player_id through the exact-id lookup below, so
// there's nothing to change -- and silently repointing an existing
// mapping to a different player would be exactly the kind of misattribution
// this table exists to prevent.
export async function linkPlayerExternalId(pool: Pool, playerId: number, source: string, externalId: number): Promise<void> {
  await pool.query(
    `INSERT INTO player_external_ids (player_id, source, external_id) VALUES ($1, $2, $3)
     ON CONFLICT (source, external_id) DO NOTHING`,
    [playerId, source, externalId],
  );
}

async function findPlayerByExternalId(pool: Pool, source: string, externalId: number): Promise<{ id: number; full_name: string } | null> {
  const { rows } = await pool.query<{ id: number; full_name: string }>(
    `SELECT p.id, p.full_name FROM player_external_ids pei JOIN players p ON p.id = pei.player_id
     WHERE pei.source = $1 AND pei.external_id = $2`,
    [source, externalId],
  );
  return rows[0] ?? null;
}

/**
 * Safely claims external_fpl_id or external_api_football_id for a player
 * row -- both are UNIQUE (migration 1701000000005). Real crashes found in
 * production 2026-08-18, three separate times, all the same shape: an
 * UPDATE (or an INSERT ... ON CONFLICT DO UPDATE) wrote one of these
 * columns directly, assumed it would succeed, and let Postgres discover a
 * collision with a DIFFERENT row's already-claimed value -- crashing the
 * whole batch instead of anyone deciding what the collision actually
 * means. Every write to either column in this file now goes through here
 * instead of writing it inline.
 *
 * Skips (logs, doesn't throw) when a different row already has the value
 * -- same "check first, don't guess a merge mid-batch" choice already made
 * for the players.natural_key collision below. A real collision here is
 * evidence of a duplicate worth reconciling with repair-duplicate-players.ts,
 * not something to resolve automatically inside a live seed run a whole
 * daily pipeline depends on completing.
 */
async function claimPlayerExternalId(
  pool: Pool,
  playerId: number,
  column: 'external_fpl_id' | 'external_api_football_id',
  value: number,
): Promise<void> {
  const { rows } = await pool.query<{ id: number }>(`SELECT id FROM players WHERE ${column} = $1 AND id != $2`, [value, playerId]);
  if (rows[0]) {
    console.warn(
      `claimPlayerExternalId: skipping ${column}=${value} for player ${playerId} -- already claimed by player ${rows[0].id}. ` +
        `Likely a real duplicate; reconcile with repair-duplicate-players.ts.`,
    );
    return;
  }
  await pool.query(`UPDATE players SET ${column} = $2 WHERE id = $1`, [playerId, value]);
}

/**
 * One golden-record entry point for both sources, instead of a separate
 * upsert per external ID (which is what let the same real player get two
 * disconnected rows -- one from FPL, one from API-Football -- with no link
 * between them). Match priority, most reliable identifier first:
 *
 * 1. player_external_ids, source='api_football' -- a stable numeric id
 *    from the source itself, so it's checked before any name-based logic.
 *    Two different API-Football endpoints (lineups vs. player stats)
 *    don't always spell the same player's name identically, which is
 *    exactly what made this the right first check, not an optimization:
 *    without it, the same real player calling in with two name spellings
 *    across two endpoint calls for one fixture produced two INSERTs
 *    racing for the same external id and a unique-constraint violation.
 *    (This is the same "api_football" id space players.external_api_football_id
 *    has always tracked -- callers seeing a DIFFERENT API-Football id
 *    space, like /players/squads, use their own source name and their own
 *    matching, see upsertPlayerForTeamRoster.)
 * 2. players.natural_key (full name + date of birth, generated column),
 *    the merge target when we know a DOB -- normally an FPL-sourced call.
 * 3. An exact case-insensitive name match against an existing row, for the
 *    common case of a player only seen via API-Football's lineup endpoint
 *    (a name and shirt number, no birth date) who's already in the table
 *    from FPL with a real DOB. Falls back to inserting under a DOB-less
 *    natural_key if nothing matches. Not perfect: two genuinely different
 *    real players sharing an exact name and both missing a DOB (and
 *    neither having an external_api_football_id yet) would incorrectly
 *    merge. Acceptable at Premier League/Championship scale; revisit if
 *    FA Cup's lower-tier entrants make that collision observably real.
 *
 * Every exit path links whatever external ids this call carried into
 * player_external_ids (idempotent -- a no-op if already recorded), so a
 * future sighting under the exact same id resolves in one indexed lookup
 * via step 1, without needing to re-solve the same name-matching ambiguity
 * every time.
 */
export async function upsertPlayerGoldenRecord(pool: Pool, p: PlayerInput): Promise<number> {
  // Check the reliable external id first, before any name-based matching.
  if (p.externalApiFootballId !== undefined) {
    const existing = await findPlayerByExternalId(pool, 'api_football', p.externalApiFootballId);
    if (existing) {
      const { id, full_name: existingFullName } = existing;
      // Real bug found in production 2026-08-16: leaving full_name
      // permanently untouched here meant whichever API-Football endpoint
      // happened to see a player FIRST decided their name forever --
      // lineups calls in particular sometimes spell a player abbreviated
      // ("I. Thiago", "E. Riis"), and a later call to a different endpoint
      // for the same external_api_football_id that carries their real full
      // name never got to fix it. Matched by the source's own stable
      // numeric id (not a name guess), so upgrading is safe: only replaces
      // an abbreviated stored name with a non-abbreviated incoming one,
      // never the other direction, so a good name can't get clobbered by a
      // later abbreviated sighting.
      const shouldUpgradeName = parseAbbreviatedName(existingFullName) !== null && parseAbbreviatedName(p.fullName) === null;

      // Real crash found in production 2026-08-18: full_name and
      // date_of_birth both feed players.natural_key (a STORED generated
      // column -- migration 1701000000013), so writing either one here
      // recomputes it immediately. If the resulting name+DOB combination
      // already belongs to a DIFFERENT row (this row was originally
      // created DOB-less from one API-Football sighting; a separate row
      // already exists for the exact same real name+DOB, most likely an
      // FPL-seeded duplicate of the same real person), the UPDATE itself
      // hits players_natural_key_key's unique constraint and crashes.
      // This row's own identity was never in question (matched by its own
      // stable external_api_football_id) -- only what to do once the
      // requested change would collide with someone else's already-claimed
      // identity. Same shape as today's other two production crashes: an
      // UPDATE assumed success on a uniqueness-constrained column instead
      // of checking first.
      //
      // Rather than guess at a merge mid-batch, this checks first and, if
      // writing name/DOB would collide, simply leaves both untouched for
      // now (every other field still updates normally) and logs the
      // collision -- no data lost, no batch-wide crash. This file already
      // has dedicated, deliberately-run merge tooling for exactly this
      // (see repair-duplicate-players.ts), built to reconcile a real
      // duplicate on purpose, with its own safety checks -- not something
      // to attempt blind, mid-batch, inside a live seed run.
      const finalFullName = shouldUpgradeName ? p.fullName : existingFullName;
      const { rows: collisionRows } = await pool.query<{ id: number }>(
        `SELECT p2.id
         FROM players p1
         JOIN players p2 ON p2.id != p1.id
         WHERE p1.id = $1
           AND p2.natural_key = md5(lower(trim($2)) || '|' || coalesce((COALESCE(p1.date_of_birth, $3) - date '1970-01-01')::text, ''))`,
        [id, finalFullName, p.dateOfBirth ?? null],
      );
      const wouldCollide = collisionRows.length > 0;
      if (wouldCollide) {
        console.warn(
          `upsertPlayerGoldenRecord: skipping name/DOB update for player ${id} ("${existingFullName}") -- ` +
            `would collide with player ${collisionRows[0].id}'s natural_key. Likely a real duplicate; ` +
            `reconcile with repair-duplicate-players.ts.`,
        );
      }
      await pool.query(
        `UPDATE players SET
           full_name = CASE WHEN $6 AND NOT $8 THEN $7 ELSE full_name END,
           date_of_birth = CASE WHEN $8 THEN date_of_birth ELSE COALESCE(date_of_birth, $2) END,
           nationality = COALESCE($3, nationality),
           position = COALESCE($4, position),
           photo_url = COALESCE(photo_url, $5)
         WHERE id = $1`,
        [id, p.dateOfBirth ?? null, p.nationality ?? null, p.position ?? null, p.photoUrl ?? null, shouldUpgradeName, p.fullName, wouldCollide],
      );
      if (p.externalFplId !== undefined) {
        await claimPlayerExternalId(pool, id, 'external_fpl_id', p.externalFplId);
        await linkPlayerExternalId(pool, id, 'fpl', p.externalFplId);
      }
      return id;
    }

    // Real bug found in production 2026-08-16: API-Football frequently
    // serves a player under an abbreviated "R. James" form -- confirmed for
    // Reece James himself, a current Chelsea/Premier League player, not
    // just an obscure lower-league one -- which never satisfies the exact
    // full_name match below. That silently created a duplicate row per
    // abbreviated sighting (5,845 of them in production against only 12
    // players correctly linked) holding the real lineup/stats data,
    // disconnected from the FPL-seeded row with the real name and
    // current_team_id. Resolving this by initial+surname, but ONLY against
    // this season's rostered players (external_fpl_id IS NOT NULL) and
    // ONLY when exactly one such player matches -- an ambiguous or
    // zero-match case falls through to the exact-name/insert path
    // unchanged below, so this can never misattribute one player's stats
    // to another.
    //
    // Matches the surname against ANY word after the first, not just the
    // last -- real bug found in production 2026-08-16: Moisés Caicedo
    // Corozo (Hispanic two-surname convention, paternal then maternal)
    // never matched API-Football's "M. Caicedo", because "Caicedo" is the
    // *first* surname, not the last word ("Corozo") -- 119 real appearances
    // sat on an orphan row while the real player showed zero.
    const abbreviated = parseAbbreviatedName(p.fullName);
    if (abbreviated) {
      const { rows: candidates } = await pool.query<{ id: number }>(
        `SELECT id FROM players
         WHERE external_fpl_id IS NOT NULL
           AND external_api_football_id IS NULL
           AND lower(left(full_name, 1)) = $1
           AND $2 = ANY((string_to_array(lower(full_name), ' '))[2:])`,
        [abbreviated.initial, abbreviated.surname],
      );
      if (candidates.length === 1) {
        const id = candidates[0].id;
        await pool.query(
          `UPDATE players SET
             position = COALESCE(position, $2),
             photo_url = COALESCE(photo_url, $3)
           WHERE id = $1`,
          [id, p.position ?? null, p.photoUrl ?? null],
        );
        await claimPlayerExternalId(pool, id, 'external_api_football_id', p.externalApiFootballId);
        await linkPlayerExternalId(pool, id, 'api_football', p.externalApiFootballId);
        return id;
      }
    }

    // Real bug found in production 2026-08-16: goal-scorer prediction data
    // for several current Chelsea attackers (Estêvão, Pedro Neto, João
    // Pedro) was landing on orphan rows instead of their real FPL-linked
    // player -- same root cause as the squads-endpoint case fixed earlier
    // the same day (FPL's full_name is sometimes a player's full legal
    // name, API-Football's lineups/player-stats sometimes use their common
    // football name), but this time on the path that actually feeds
    // model-service's goal-scorer training data, not just photos. Reusing
    // upsertPlayerForTeamRoster's same word-subsequence match and the same
    // safety rule: only attempted when the caller knows which team this
    // sighting is FOR (most lineup/player-stats calls do), scoped to that
    // team's roster, and only acted on with exactly one candidate -- the
    // false-positive risk that keeps this out of the fully global path
    // doesn't apply once it's scoped this tightly.
    if (p.teamId !== undefined) {
      const { rows: roster } = await pool.query<{ id: number; full_name: string }>(
        `SELECT id, full_name FROM players WHERE current_team_id = $1`,
        [p.teamId],
      );
      const fuzzyMatches = roster.filter((r) => namesLikelyMatch(r.full_name, p.fullName));
      if (fuzzyMatches.length === 1) {
        const match = fuzzyMatches[0];
        const preferIncomingName = nameWordCount(p.fullName) < nameWordCount(match.full_name);

        // Same players.natural_key collision risk as the found-by-id
        // branch above (full_name feeds it) -- check before writing,
        // same reasoning, see that branch's comment for the full story.
        const finalFullName = preferIncomingName ? p.fullName : match.full_name;
        const { rows: collisionRows } = await pool.query<{ id: number }>(
          `SELECT p2.id
           FROM players p1
           JOIN players p2 ON p2.id != p1.id
           WHERE p1.id = $1
             AND p2.natural_key = md5(lower(trim($2)) || '|' || coalesce((p1.date_of_birth - date '1970-01-01')::text, ''))`,
          [match.id, finalFullName],
        );
        const wouldCollide = collisionRows.length > 0;
        if (wouldCollide) {
          console.warn(
            `upsertPlayerGoldenRecord: skipping full_name update for player ${match.id} ("${match.full_name}") -- ` +
              `would collide with player ${collisionRows[0].id}'s natural_key. Likely a real duplicate; ` +
              `reconcile with repair-duplicate-players.ts.`,
          );
        }
        await pool.query(
          `UPDATE players SET
             full_name = CASE WHEN $2 AND NOT $4 THEN $3 ELSE full_name END,
             position = COALESCE(position, $5),
             photo_url = COALESCE(photo_url, $6)
           WHERE id = $1`,
          [match.id, preferIncomingName, p.fullName, wouldCollide, p.position ?? null, p.photoUrl ?? null],
        );
        await claimPlayerExternalId(pool, match.id, 'external_api_football_id', p.externalApiFootballId);
        await linkPlayerExternalId(pool, match.id, 'api_football', p.externalApiFootballId);
        return match.id;
      }
    }
  }

  // The three write paths below all used to pass external_fpl_id/
  // external_api_football_id straight into the INSERT/UPDATE column list.
  // Real crash found in production 2026-08-18 (players_external_fpl_id_key):
  // an ON CONFLICT (natural_key) DO UPDATE only resolves a natural_key
  // collision -- it does nothing to protect the SEPARATE unique
  // constraints on these two columns, whether hit via a fresh INSERT (no
  // natural_key collision, but the id is already claimed elsewhere) or via
  // the DO UPDATE's own COALESCE(EXCLUDED.x, players.x) (which overwrites
  // whenever the incoming value is non-null, and can just as easily
  // collide). Both id columns are now left out of these three statements
  // entirely and claimed afterward via claimPlayerExternalId, same as
  // every other write path in this function.

  if (p.dateOfBirth) {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO players (full_name, date_of_birth, nationality, position, photo_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (natural_key) DO UPDATE SET
         nationality = COALESCE(EXCLUDED.nationality, players.nationality),
         position = COALESCE(EXCLUDED.position, players.position),
         photo_url = COALESCE(players.photo_url, EXCLUDED.photo_url)
       RETURNING id`,
      [p.fullName, p.dateOfBirth, p.nationality ?? null, p.position ?? null, p.photoUrl ?? null],
    );
    const id = rows[0].id;
    if (p.externalApiFootballId !== undefined) {
      await claimPlayerExternalId(pool, id, 'external_api_football_id', p.externalApiFootballId);
      await linkPlayerExternalId(pool, id, 'api_football', p.externalApiFootballId);
    }
    if (p.externalFplId !== undefined) {
      await claimPlayerExternalId(pool, id, 'external_fpl_id', p.externalFplId);
      await linkPlayerExternalId(pool, id, 'fpl', p.externalFplId);
    }
    return id;
  }

  const existingByName = await pool.query<{ id: number }>(`SELECT id FROM players WHERE lower(full_name) = lower($1) LIMIT 1`, [
    p.fullName,
  ]);
  if (existingByName.rows[0]) {
    const id = existingByName.rows[0].id;
    await pool.query(
      `UPDATE players SET
         position = COALESCE($2, position),
         photo_url = COALESCE(photo_url, $3)
       WHERE id = $1`,
      [id, p.position ?? null, p.photoUrl ?? null],
    );
    if (p.externalApiFootballId !== undefined) {
      await claimPlayerExternalId(pool, id, 'external_api_football_id', p.externalApiFootballId);
      await linkPlayerExternalId(pool, id, 'api_football', p.externalApiFootballId);
    }
    if (p.externalFplId !== undefined) {
      await claimPlayerExternalId(pool, id, 'external_fpl_id', p.externalFplId);
      await linkPlayerExternalId(pool, id, 'fpl', p.externalFplId);
    }
    return id;
  }

  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO players (full_name, nationality, position, photo_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (natural_key) DO UPDATE SET
       position = COALESCE(EXCLUDED.position, players.position),
       photo_url = COALESCE(players.photo_url, EXCLUDED.photo_url)
     RETURNING id`,
    [p.fullName, p.nationality ?? null, p.position ?? null, p.photoUrl ?? null],
  );
  const id = inserted.rows[0].id;
  if (p.externalApiFootballId !== undefined) {
    await claimPlayerExternalId(pool, id, 'external_api_football_id', p.externalApiFootballId);
    await linkPlayerExternalId(pool, id, 'api_football', p.externalApiFootballId);
  }
  if (p.externalFplId !== undefined) {
    await claimPlayerExternalId(pool, id, 'external_fpl_id', p.externalFplId);
    await linkPlayerExternalId(pool, id, 'fpl', p.externalFplId);
  }
  return id;
}

// Shared by upsertPlayerForTeamRoster's two candidate queries below. Same
// "current_team_id if set, else this season's most recent finished
// appearance" resolution teams.service.ts's getSquad uses -- deliberately
// reused, not reinvented (see that function's own comment, and
// docs/learning-log.md's 2026-08-18 entry). Needed here specifically
// because a Championship player's current_team_id is never set before
// their FIRST squads-endpoint sighting -- matching on current_team_id
// alone (this function's original behavior) could therefore never succeed
// for a team FPL doesn't cover, and every sighting fell through to
// inserting a fresh orphan row instead of finding the real one already
// populated by /fixtures/lineups.
const ROSTER_CANDIDATES_CTE = `
  WITH latest_season AS (
    SELECT id FROM seasons ORDER BY start_date DESC LIMIT 1
  ),
  recent_appearance AS (
    SELECT DISTINCT ON (fl.player_id) fl.player_id, fl.team_id
    FROM fixture_lineups fl
    JOIN fixtures f ON f.id = fl.fixture_id
    JOIN competition_seasons cs ON cs.id = f.competition_season_id
    WHERE f.status = 'finished' AND cs.season_id = (SELECT id FROM latest_season)
    ORDER BY fl.player_id, f.kickoff_date DESC
  ),
  roster_candidates AS (
    SELECT p.id, p.full_name
    FROM players p
    LEFT JOIN recent_appearance ra ON ra.player_id = p.id
    WHERE COALESCE(p.current_team_id, ra.team_id) = $1
  )
`;

/**
 * Resolves a GET /players/squads?team={id} sighting to a real player row
 * AND records that this team is that player's current one via
 * setPlayerCurrentTeam -- previously photo-only (see git history), fixed
 * 2026-08-18 alongside getSquad's season-bound fallback. This endpoint is
 * API-Football's own "who's actually on this roster right now" signal
 * (confirmed for real 2026-08-16), the same authority FPL already provides
 * for Premier League, so it's the right source to extend
 * players.current_team_id to Championship with, replacing reliance on
 * appearance-recency alone: a transferred player's old club kept a "most
 * recent" appearance for them until their new club accumulated one of its
 * own, so they kept showing up on the old squad page in that gap. See
 * docs/learning-log.md's 2026-08-18 entry for the real report that caught
 * this and the full reasoning.
 *
 * Deliberately NOT routed through upsertPlayerGoldenRecord's usual
 * external-id-first matching, because that checks the 'api_football'
 * source specifically. Real, confirmed quirk in production data
 * 2026-08-16: this endpoint can carry a DIFFERENT internal player id than
 * /fixtures/lineups or /fixtures/players use for the exact same real
 * person (Reece James is external_api_football_id 19890 via lineups, but
 * 19545 via this endpoint -- same shape of issue already seen with Bruno
 * Fernandes across two other endpoints). This id space gets its own
 * source, 'api_football_squads', in player_external_ids -- checked first,
 * so a repeat sighting of the same squads-endpoint id resolves in one
 * lookup without re-solving the name ambiguity below every time.
 *
 * Never overwrites players.external_api_football_id with this endpoint's
 * possibly-different id, since the one already linked there is presumably
 * the one every other row (lineups, player-stats) already points at.
 */
export async function upsertPlayerForTeamRoster(
  pool: Pool,
  teamId: number,
  p: { externalApiFootballId: number; fullName: string; photoUrl?: string },
): Promise<number> {
  const existing = await findPlayerByExternalId(pool, 'api_football_squads', p.externalApiFootballId);
  if (existing) {
    await pool.query(`UPDATE players SET photo_url = COALESCE(photo_url, $2) WHERE id = $1`, [existing.id, p.photoUrl ?? null]);
    await setPlayerCurrentTeam(pool, existing.id, teamId);
    return existing.id;
  }

  // Matches the surname against ANY word after the first, not just the
  // last -- see the identical fix in upsertPlayerGoldenRecord's abbreviated
  // branch for why (Hispanic two-surname names like "Moisés Caicedo
  // Corozo").
  const abbreviated = parseAbbreviatedName(p.fullName);
  const { rows: candidates } = await pool.query<{ id: number }>(
    `${ROSTER_CANDIDATES_CTE}
     SELECT id FROM roster_candidates
     WHERE lower(full_name) = lower($2)
        OR ($3::text IS NOT NULL AND lower(left(full_name, 1)) = $3 AND $4 = ANY((string_to_array(lower(full_name), ' '))[2:]))`,
    [teamId, p.fullName, abbreviated?.initial ?? null, abbreviated?.surname ?? null],
  );
  if (candidates.length === 1) {
    const id = candidates[0].id;
    await pool.query(`UPDATE players SET photo_url = COALESCE(photo_url, $2) WHERE id = $1`, [id, p.photoUrl ?? null]);
    await linkPlayerExternalId(pool, id, 'api_football_squads', p.externalApiFootballId);
    await setPlayerCurrentTeam(pool, id, teamId);
    return id;
  }

  if (candidates.length === 0) {
    // Real bug found in production 2026-08-16: several Brazilian/South
    // American players (João Pedro, Estêvão, Moisés Caicedo...) never
    // matched here at all -- FPL's full_name is sometimes their full
    // LEGAL name ("João Pedro Junqueira de Jesus") while API-Football's
    // squads endpoint uses their common football name ("João Pedro"),
    // and neither exact nor abbreviated-initial+surname matching bridges
    // that gap. namesLikelyMatch's word-subsequence check catches it in
    // both directions without needing to know in advance which source has
    // the longer form. Still scoped to this team's roster candidates and
    // still requires a unique match, so the false-positive risk that made
    // this too risky to do as a *global* fallback (see
    // upsertPlayerGoldenRecord) doesn't apply here. When it matches, the
    // stored name is upgraded to whichever of the two is shorter -- the
    // common football name is consistently the shorter one in every real
    // case seen so far, regardless of which source it came from.
    const { rows: roster } = await pool.query<{ id: number; full_name: string }>(
      `${ROSTER_CANDIDATES_CTE} SELECT id, full_name FROM roster_candidates`,
      [teamId],
    );
    const fuzzyMatches = roster.filter((r) => namesLikelyMatch(r.full_name, p.fullName));
    if (fuzzyMatches.length === 1) {
      const match = fuzzyMatches[0];
      const preferIncomingName = nameWordCount(p.fullName) < nameWordCount(match.full_name);
      await pool.query(
        `UPDATE players SET
           full_name = CASE WHEN $3 THEN $4 ELSE full_name END,
           photo_url = COALESCE(photo_url, $2)
         WHERE id = $1`,
        [match.id, p.photoUrl ?? null, preferIncomingName, p.fullName],
      );
      await linkPlayerExternalId(pool, match.id, 'api_football_squads', p.externalApiFootballId);
      await setPlayerCurrentTeam(pool, match.id, teamId);
      return match.id;
    }
  }

  // No confident match against this team's roster candidates (new signing
  // not yet linked elsewhere, or a genuinely ambiguous name) -- fall
  // through to the normal golden-record path, same as any other
  // API-Football sighting, but matched by name only, NOT this endpoint's
  // own numeric id.
  //
  // Real crash found in production 2026-08-18: passing p.externalApiFootballId
  // straight through here violates this file's own documented rule (see
  // this function's own comment above) that this endpoint's id space
  // doesn't always agree with /fixtures/lineups' -- upsertPlayerGoldenRecord
  // treats ANY externalApiFootballId it's given as the 'api_football'
  // source specifically, the same space lineups/player-stats use. When
  // this endpoint's numeric id for one real person collides with a
  // DIFFERENT real person's already-linked lineups-sourced id (the exact
  // shape of gap the Reece James example above documents), the unhandled
  // INSERT hit players_external_api_football_id_key's unique constraint
  // and crashed the whole batch, well before the run ever reached teams
  // later in the list. Every exit path in this function already links the
  // id under its own 'api_football_squads' source instead (see below) --
  // that's the correct, collision-safe place for it; it was never meant to
  // reach 'api_football' at all.
  const id = await upsertPlayerGoldenRecord(pool, {
    fullName: p.fullName,
    photoUrl: p.photoUrl,
  });
  await linkPlayerExternalId(pool, id, 'api_football_squads', p.externalApiFootballId);
  await setPlayerCurrentTeam(pool, id, teamId);
  return id;
}

/**
 * The complement to upsertPlayerForTeamRoster's writes: clears
 * current_team_id for anyone previously recorded as being on teamId but
 * absent from a fresh, real GET /players/squads?team={id} response --
 * without this, current_team_id could only ever gain members for a team,
 * never lose one who'd transferred out, released, or dropped out of
 * first-team football entirely. Call once per team, after processing that
 * team's full squad response.
 *
 * Refuses to act on an empty roster list -- a transient/malformed API
 * response returning zero players is far more likely than a real team
 * genuinely having none, and clearing every current player over one bad
 * call would be a lot of damage from a single flaky response.
 */
export async function clearStaleTeamRoster(pool: Pool, teamId: number, currentRosterPlayerIds: number[]): Promise<void> {
  if (currentRosterPlayerIds.length === 0) return;
  await pool.query(`UPDATE players SET current_team_id = NULL WHERE current_team_id = $1 AND NOT (id = ANY($2::int[]))`, [
    teamId,
    currentRosterPlayerIds,
  ]);
}

export async function upsertFplGameweek(
  pool: Pool,
  gw: {
    gwNumber: number;
    deadlineTime: Date;
    isCurrent: boolean;
    isFinished: boolean;
    averageScore?: number;
    highestScore?: number;
  },
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO fpl_gameweeks (gw_number, deadline_time, is_current, is_finished, average_score, highest_score)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (gw_number) DO UPDATE SET
       is_current = EXCLUDED.is_current,
       is_finished = EXCLUDED.is_finished,
       average_score = EXCLUDED.average_score,
       highest_score = EXCLUDED.highest_score
     RETURNING id`,
    [gw.gwNumber, gw.deadlineTime, gw.isCurrent, gw.isFinished, gw.averageScore ?? null, gw.highestScore ?? null],
  );
  return rows[0].id;
}

export interface FixtureInput {
  competitionSeasonId: number;
  homeTeamId: number;
  awayTeamId: number;
  kickoffAt: Date;
  kickoffDate: string; // YYYY-MM-DD, the natural-key component
  status: string;
  round?: string;
  homeScore?: number;
  awayScore?: number;
  homeScoreHt?: number;
  awayScoreHt?: number;
  referee?: string;
  venue?: string;
  externalApiFootballId?: number;
}

export async function upsertFixture(pool: Pool, f: FixtureInput): Promise<number> {
  // Real crash found in production 2026-08-18: the natural key
  // (competition_season_id, home_team_id, away_team_id, kickoff_date) is
  // the right PRIMARY dedup target (see migration 1701000000006's comment
  // -- it's what lets a CSV-seeded row and a later API-Football pass agree
  // on the same real fixture with no shared id space between sources), but
  // it silently assumed kickoff_date never changes for a given real match.
  // A rescheduled fixture (postponement, a TV-driven date change) is the
  // same real match with the same external_api_football_id, but a natural
  // key that no longer matches whatever it was first seeded under. The
  // INSERT ... ON CONFLICT below only ever targets the natural key, so a
  // reschedule made it attempt a fresh INSERT instead of finding the
  // existing row -- and that INSERT collided with the separate partial
  // unique index on external_api_football_id
  // (fixtures_external_api_football_id_idx), crashing the whole seed run
  // instead of just updating the date.
  //
  // Fixed by checking external_api_football_id FIRST when the caller has
  // one -- API-Football's own numeric id is durable across a reschedule in
  // a way the natural key isn't, the same "most reliable identifier first"
  // principle upsertPlayerGoldenRecord already uses for players. Falls
  // back to the natural-key upsert, unchanged, when there's no external id
  // yet (a CSV-seeded row not yet enriched by an API-Football pass).
  if (f.externalApiFootballId !== undefined) {
    const { rows: existing } = await pool.query<{ id: number }>(`SELECT id FROM fixtures WHERE external_api_football_id = $1`, [
      f.externalApiFootballId,
    ]);
    if (existing[0]) {
      const id = existing[0].id;
      await pool.query(
        `UPDATE fixtures SET
           competition_season_id = $2,
           home_team_id = $3,
           away_team_id = $4,
           kickoff_at = $5,
           kickoff_date = $6,
           status = $7,
           round = COALESCE($8, round),
           home_score = COALESCE($9, home_score),
           away_score = COALESCE($10, away_score),
           home_score_ht = COALESCE($11, home_score_ht),
           away_score_ht = COALESCE($12, away_score_ht),
           referee = COALESCE($13, referee),
           venue = COALESCE($14, venue),
           updated_at = now()
         WHERE id = $1`,
        [
          id,
          f.competitionSeasonId,
          f.homeTeamId,
          f.awayTeamId,
          f.kickoffAt,
          f.kickoffDate,
          f.status,
          f.round ?? null,
          f.homeScore ?? null,
          f.awayScore ?? null,
          f.homeScoreHt ?? null,
          f.awayScoreHt ?? null,
          f.referee ?? null,
          f.venue ?? null,
        ],
      );
      return id;
    }
  }

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO fixtures (
       competition_season_id, home_team_id, away_team_id, kickoff_at, kickoff_date,
       status, round, home_score, away_score, home_score_ht, away_score_ht, referee,
       venue, external_api_football_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (competition_season_id, home_team_id, away_team_id, kickoff_date)
     DO UPDATE SET
       status = EXCLUDED.status,
       home_score = COALESCE(EXCLUDED.home_score, fixtures.home_score),
       away_score = COALESCE(EXCLUDED.away_score, fixtures.away_score),
       home_score_ht = COALESCE(EXCLUDED.home_score_ht, fixtures.home_score_ht),
       away_score_ht = COALESCE(EXCLUDED.away_score_ht, fixtures.away_score_ht),
       referee = COALESCE(EXCLUDED.referee, fixtures.referee),
       venue = COALESCE(EXCLUDED.venue, fixtures.venue),
       external_api_football_id = COALESCE(EXCLUDED.external_api_football_id, fixtures.external_api_football_id),
       updated_at = now()
     RETURNING id`,
    [
      f.competitionSeasonId,
      f.homeTeamId,
      f.awayTeamId,
      f.kickoffAt,
      f.kickoffDate,
      f.status,
      f.round ?? null,
      f.homeScore ?? null,
      f.awayScore ?? null,
      f.homeScoreHt ?? null,
      f.awayScoreHt ?? null,
      f.referee ?? null,
      f.venue ?? null,
      f.externalApiFootballId ?? null,
    ],
  );
  return rows[0].id;
}

/**
 * Writes ONLY the shot-location columns, deliberately leaving every other
 * column on the row untouched.
 *
 * That restraint is the whole point: fixture_team_stats is owned by the
 * football-data.co.uk CSV importer (shots/shots_on_target/corners/fouls/
 * cards), which is the more complete and trustworthy source for the two
 * leagues it covers. A blanket upsert from API-Football would overwrite
 * that CSV data with a second source's numbers, which disagree slightly
 * on definitions -- so this one touches its own two columns and nothing
 * else. The INSERT branch only fires for a fixture the CSV never covered
 * (an FA Cup tie), where the other columns legitimately stay null.
 *
 * is_home is required by the table's NOT NULL constraint on the INSERT
 * path, but is never updated -- an existing row already has it right.
 */
export async function upsertFixtureShotLocation(
  pool: Pool,
  fixtureId: number,
  teamId: number,
  isHome: boolean,
  shotsInsideBox: number | null,
  shotsOutsideBox: number | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO fixture_team_stats (fixture_id, team_id, is_home, shots_inside_box, shots_outside_box)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (fixture_id, team_id) DO UPDATE SET
       shots_inside_box = EXCLUDED.shots_inside_box,
       shots_outside_box = EXCLUDED.shots_outside_box`,
    [fixtureId, teamId, isHome, shotsInsideBox, shotsOutsideBox],
  );
}

export async function upsertFixtureTeamStats(
  pool: Pool,
  fixtureId: number,
  teamId: number,
  isHome: boolean,
  stats: {
    shots?: number;
    shotsOnTarget?: number;
    corners?: number;
    fouls?: number;
    yellowCards?: number;
    redCards?: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO fixture_team_stats (fixture_id, team_id, is_home, shots, shots_on_target, corners, fouls, yellow_cards, red_cards)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (fixture_id, team_id) DO UPDATE SET
       shots = EXCLUDED.shots,
       shots_on_target = EXCLUDED.shots_on_target,
       corners = EXCLUDED.corners,
       fouls = EXCLUDED.fouls,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards`,
    [
      fixtureId,
      teamId,
      isHome,
      stats.shots ?? null,
      stats.shotsOnTarget ?? null,
      stats.corners ?? null,
      stats.fouls ?? null,
      stats.yellowCards ?? null,
      stats.redCards ?? null,
    ],
  );
}

/** One multi-row INSERT for both a fixture's team-stats rows (home + away) instead of two separate round-trips. */
export async function upsertFixtureTeamStatsBatch(
  pool: Pool,
  entries: Array<{
    fixtureId: number;
    teamId: number;
    isHome: boolean;
    shots?: number;
    shotsOnTarget?: number;
    corners?: number;
    fouls?: number;
    yellowCards?: number;
    redCards?: number;
  }>,
): Promise<void> {
  if (entries.length === 0) return;
  const params = entries.flatMap((s) => [
    s.fixtureId,
    s.teamId,
    s.isHome,
    s.shots ?? null,
    s.shotsOnTarget ?? null,
    s.corners ?? null,
    s.fouls ?? null,
    s.yellowCards ?? null,
    s.redCards ?? null,
  ]);
  await pool.query(
    `INSERT INTO fixture_team_stats (fixture_id, team_id, is_home, shots, shots_on_target, corners, fouls, yellow_cards, red_cards)
     VALUES ${buildValuesPlaceholders(entries.length, 9)}
     ON CONFLICT (fixture_id, team_id) DO UPDATE SET
       shots = EXCLUDED.shots,
       shots_on_target = EXCLUDED.shots_on_target,
       corners = EXCLUDED.corners,
       fouls = EXCLUDED.fouls,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards`,
    params,
  );
}

export interface FixtureOddsInput {
  fixtureId: number;
  bookmaker: string;
  market: string;
  outcome: string;
  line: number;
  price: number;
  snapshotType: 'opening' | 'closing' | 'live';
  source: string;
}

export async function upsertFixtureOdds(pool: Pool, o: FixtureOddsInput): Promise<void> {
  await pool.query(
    `INSERT INTO fixture_odds (fixture_id, bookmaker, market, outcome, line, price, snapshot_type, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (fixture_id, bookmaker, market, outcome, line, snapshot_type) DO UPDATE SET
       price = EXCLUDED.price,
       recorded_at = now()`,
    [o.fixtureId, o.bookmaker, o.market, o.outcome, o.line, o.price, o.snapshotType, o.source],
  );
}

/**
 * One multi-row INSERT for an entire fixture's odds (~30-60 rows across 8
 * bookmakers x several markets x opening/closing) instead of one
 * round-trip per row. Safe against Postgres's "ON CONFLICT DO UPDATE
 * command cannot affect row a second time" error -- that fires only if two
 * rows in the same batch target the same conflict key
 * (fixture_id, bookmaker, market, outcome, line, snapshot_type). Every
 * bookmaker name is unique within its own market group in
 * football-data-co-uk.ts's bookmaker constants, and match_winner/
 * over_under/asian_handicap never share a market value with each other,
 * so no two rows built from one fixture's CSV row can ever collide.
 */
export async function upsertFixtureOddsBatch(pool: Pool, rows: FixtureOddsInput[]): Promise<void> {
  if (rows.length === 0) return;
  const params = rows.flatMap((o) => [o.fixtureId, o.bookmaker, o.market, o.outcome, o.line, o.price, o.snapshotType, o.source]);
  await pool.query(
    `INSERT INTO fixture_odds (fixture_id, bookmaker, market, outcome, line, price, snapshot_type, source)
     VALUES ${buildValuesPlaceholders(rows.length, 8)}
     ON CONFLICT (fixture_id, bookmaker, market, outcome, line, snapshot_type) DO UPDATE SET
       price = EXCLUDED.price,
       recorded_at = now()`,
    params,
  );
}

export async function upsertFixtureLineup(
  pool: Pool,
  entry: {
    fixtureId: number;
    teamId: number;
    playerId: number;
    isStarting: boolean;
    shirtNumber?: number;
    position?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO fixture_lineups (fixture_id, team_id, player_id, is_starting, shirt_number, position)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (fixture_id, player_id) DO UPDATE SET
       is_starting = EXCLUDED.is_starting,
       shirt_number = COALESCE(EXCLUDED.shirt_number, fixture_lineups.shirt_number),
       position = COALESCE(EXCLUDED.position, fixture_lineups.position)`,
    [entry.fixtureId, entry.teamId, entry.playerId, entry.isStarting, entry.shirtNumber ?? null, entry.position ?? null],
  );
}

/**
 * One multi-row INSERT for every lineup row (startXI + substitutes, both
 * teams) coming out of a single bulk /fixtures?ids=... call -- up to 20
 * fixtures' worth (~800 rows) in one round-trip instead of one per row.
 *
 * Callers MUST dedupe by (fixture_id, player_id) before calling this --
 * Postgres rejects a multi-row ON CONFLICT DO UPDATE outright if the same
 * conflict target appears twice in one statement. The original assumption
 * here ("a player is either starting or a sub, never both, so this can't
 * happen") was real-world-wrong: API-Football has been observed repeating
 * a player within one fixture's lineups[] on at least one messy
 * lower-profile competition. See sources/api-football.ts's
 * dedupeByFixturePlayer, the caller responsible for this.
 */
export async function upsertFixtureLineupsBatch(
  pool: Pool,
  entries: Array<{
    fixtureId: number;
    teamId: number;
    playerId: number;
    isStarting: boolean;
    shirtNumber?: number;
    position?: string;
  }>,
): Promise<void> {
  if (entries.length === 0) return;
  const params = entries.flatMap((e) => [e.fixtureId, e.teamId, e.playerId, e.isStarting, e.shirtNumber ?? null, e.position ?? null]);
  await pool.query(
    `INSERT INTO fixture_lineups (fixture_id, team_id, player_id, is_starting, shirt_number, position)
     VALUES ${buildValuesPlaceholders(entries.length, 6)}
     ON CONFLICT (fixture_id, player_id) DO UPDATE SET
       is_starting = EXCLUDED.is_starting,
       shirt_number = COALESCE(EXCLUDED.shirt_number, fixture_lineups.shirt_number),
       position = COALESCE(EXCLUDED.position, fixture_lineups.position)`,
    params,
  );
}

export interface FixturePlayerStatsInput {
  fixtureId: number;
  teamId: number;
  playerId: number;
  minutesPlayed?: number;
  rating?: number;
  goals?: number;
  assists?: number;
  shots?: number;
  shotsOnTarget?: number;
  passes?: number;
  passesAccuracy?: number;
  tackles?: number;
  interceptions?: number;
  dribblesAttempted?: number;
  dribblesCompleted?: number;
  foulsDrawn?: number;
  foulsCommitted?: number;
  yellowCards?: number;
  redCards?: number;
  penaltiesScored?: number;
  penaltiesMissed?: number;
  saves?: number;
}

export async function upsertFixturePlayerStats(pool: Pool, s: FixturePlayerStatsInput): Promise<void> {
  await pool.query(
    `INSERT INTO fixture_player_stats (
       fixture_id, team_id, player_id, minutes_played, rating, goals, assists,
       shots, shots_on_target, passes, passes_accuracy, tackles, interceptions,
       dribbles_attempted, dribbles_completed, fouls_drawn, fouls_committed,
       yellow_cards, red_cards, penalties_scored, penalties_missed, saves
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     ON CONFLICT (fixture_id, player_id) DO UPDATE SET
       minutes_played = EXCLUDED.minutes_played,
       rating = EXCLUDED.rating,
       goals = EXCLUDED.goals,
       assists = EXCLUDED.assists,
       shots = EXCLUDED.shots,
       shots_on_target = EXCLUDED.shots_on_target,
       passes = EXCLUDED.passes,
       passes_accuracy = EXCLUDED.passes_accuracy,
       tackles = EXCLUDED.tackles,
       interceptions = EXCLUDED.interceptions,
       dribbles_attempted = EXCLUDED.dribbles_attempted,
       dribbles_completed = EXCLUDED.dribbles_completed,
       fouls_drawn = EXCLUDED.fouls_drawn,
       fouls_committed = EXCLUDED.fouls_committed,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards,
       penalties_scored = EXCLUDED.penalties_scored,
       penalties_missed = EXCLUDED.penalties_missed,
       saves = EXCLUDED.saves`,
    [
      s.fixtureId,
      s.teamId,
      s.playerId,
      s.minutesPlayed ?? null,
      s.rating ?? null,
      s.goals ?? null,
      s.assists ?? null,
      s.shots ?? null,
      s.shotsOnTarget ?? null,
      s.passes ?? null,
      s.passesAccuracy ?? null,
      s.tackles ?? null,
      s.interceptions ?? null,
      s.dribblesAttempted ?? null,
      s.dribblesCompleted ?? null,
      s.foulsDrawn ?? null,
      s.foulsCommitted ?? null,
      s.yellowCards ?? null,
      s.redCards ?? null,
      s.penaltiesScored ?? null,
      s.penaltiesMissed ?? null,
      s.saves ?? null,
    ],
  );
}

/**
 * Same batching as upsertFixtureLineupsBatch, for the fixture_player_stats
 * side of one bulk /fixtures?ids=... call -- one INSERT for up to ~800
 * rows (20 fixtures x ~40 players) instead of one round-trip per player.
 * Same caller-must-dedupe-first requirement applies (see
 * upsertFixtureLineupsBatch's comment).
 */
export async function upsertFixturePlayerStatsBatch(pool: Pool, entries: FixturePlayerStatsInput[]): Promise<void> {
  if (entries.length === 0) return;
  const params = entries.flatMap((s) => [
    s.fixtureId,
    s.teamId,
    s.playerId,
    s.minutesPlayed ?? null,
    s.rating ?? null,
    s.goals ?? null,
    s.assists ?? null,
    s.shots ?? null,
    s.shotsOnTarget ?? null,
    s.passes ?? null,
    s.passesAccuracy ?? null,
    s.tackles ?? null,
    s.interceptions ?? null,
    s.dribblesAttempted ?? null,
    s.dribblesCompleted ?? null,
    s.foulsDrawn ?? null,
    s.foulsCommitted ?? null,
    s.yellowCards ?? null,
    s.redCards ?? null,
    s.penaltiesScored ?? null,
    s.penaltiesMissed ?? null,
    s.saves ?? null,
  ]);
  await pool.query(
    `INSERT INTO fixture_player_stats (
       fixture_id, team_id, player_id, minutes_played, rating, goals, assists,
       shots, shots_on_target, passes, passes_accuracy, tackles, interceptions,
       dribbles_attempted, dribbles_completed, fouls_drawn, fouls_committed,
       yellow_cards, red_cards, penalties_scored, penalties_missed, saves
     ) VALUES ${buildValuesPlaceholders(entries.length, 22)}
     ON CONFLICT (fixture_id, player_id) DO UPDATE SET
       minutes_played = EXCLUDED.minutes_played,
       rating = EXCLUDED.rating,
       goals = EXCLUDED.goals,
       assists = EXCLUDED.assists,
       shots = EXCLUDED.shots,
       shots_on_target = EXCLUDED.shots_on_target,
       passes = EXCLUDED.passes,
       passes_accuracy = EXCLUDED.passes_accuracy,
       tackles = EXCLUDED.tackles,
       interceptions = EXCLUDED.interceptions,
       dribbles_attempted = EXCLUDED.dribbles_attempted,
       dribbles_completed = EXCLUDED.dribbles_completed,
       fouls_drawn = EXCLUDED.fouls_drawn,
       fouls_committed = EXCLUDED.fouls_committed,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards,
       penalties_scored = EXCLUDED.penalties_scored,
       penalties_missed = EXCLUDED.penalties_missed,
       saves = EXCLUDED.saves`,
    params,
  );
}

/**
 * Records "we asked API-Football about these fixtures' lineups/stats" --
 * regardless of whether the response actually had any rows to write.
 * Without this, backfillLineupsForCompetitionSeason's "still missing"
 * query has no way to tell "genuinely no data available" (a real, common
 * outcome for lower-tier FA Cup matches) apart from "haven't tried yet",
 * so every rerun re-attempts the same permanently-empty fixtures forever.
 * Only ever called for fixtures already confirmed status = 'finished' by
 * the caller -- marking a not-yet-played fixture here would wrongly make
 * it look permanently unavailable instead of "ask again once it's played".
 */
export async function markFixturesLineupsChecked(pool: Pool, fixtureIds: number[]): Promise<void> {
  if (fixtureIds.length === 0) return;
  await pool.query(`UPDATE fixtures SET lineups_checked_at = now() WHERE id = ANY($1::int[])`, [fixtureIds]);
}

export interface FplPlayerGameweekStatsInput {
  playerId: number;
  gameweekId: number;
  nowCost?: number;
  totalPoints?: number;
  minutes?: number;
  goalsScored?: number;
  assists?: number;
  cleanSheets?: number;
  goalsConceded?: number;
  ownGoals?: number;
  penaltiesSaved?: number;
  penaltiesMissed?: number;
  yellowCards?: number;
  redCards?: number;
  saves?: number;
  bonus?: number;
  bps?: number;
  influence?: number;
  creativity?: number;
  threat?: number;
  ictIndex?: number;
}

// selected_by_percent is deliberately never set here -- FPL's per-gameweek
// element-summary endpoint only gives a raw ownership *count* at that point
// in time, not the percent bootstrap-static reports for the current
// snapshot. Left null for historical rows rather than faked from a count
// without knowing that gameweek's total manager count.
export async function upsertFplPlayerGameweekStats(pool: Pool, s: FplPlayerGameweekStatsInput): Promise<void> {
  await pool.query(
    `INSERT INTO fpl_player_gameweek_stats (
       player_id, gameweek_id, now_cost, total_points, minutes, goals_scored, assists,
       clean_sheets, goals_conceded, own_goals, penalties_saved, penalties_missed,
       yellow_cards, red_cards, saves, bonus, bps, influence, creativity, threat, ict_index
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (player_id, gameweek_id) DO UPDATE SET
       now_cost = EXCLUDED.now_cost,
       total_points = EXCLUDED.total_points,
       minutes = EXCLUDED.minutes,
       goals_scored = EXCLUDED.goals_scored,
       assists = EXCLUDED.assists,
       clean_sheets = EXCLUDED.clean_sheets,
       goals_conceded = EXCLUDED.goals_conceded,
       own_goals = EXCLUDED.own_goals,
       penalties_saved = EXCLUDED.penalties_saved,
       penalties_missed = EXCLUDED.penalties_missed,
       yellow_cards = EXCLUDED.yellow_cards,
       red_cards = EXCLUDED.red_cards,
       saves = EXCLUDED.saves,
       bonus = EXCLUDED.bonus,
       bps = EXCLUDED.bps,
       influence = EXCLUDED.influence,
       creativity = EXCLUDED.creativity,
       threat = EXCLUDED.threat,
       ict_index = EXCLUDED.ict_index`,
    [
      s.playerId,
      s.gameweekId,
      s.nowCost ?? null,
      s.totalPoints ?? null,
      s.minutes ?? null,
      s.goalsScored ?? null,
      s.assists ?? null,
      s.cleanSheets ?? null,
      s.goalsConceded ?? null,
      s.ownGoals ?? null,
      s.penaltiesSaved ?? null,
      s.penaltiesMissed ?? null,
      s.yellowCards ?? null,
      s.redCards ?? null,
      s.saves ?? null,
      s.bonus ?? null,
      s.bps ?? null,
      s.influence ?? null,
      s.creativity ?? null,
      s.threat ?? null,
      s.ictIndex ?? null,
    ],
  );
}

export async function findFixtureId(
  pool: Pool,
  competitionSeasonId: number,
  homeTeamId: number,
  awayTeamId: number,
  kickoffDate: string,
): Promise<number | undefined> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM fixtures
     WHERE competition_season_id = $1 AND home_team_id = $2 AND away_team_id = $3 AND kickoff_date = $4`,
    [competitionSeasonId, homeTeamId, awayTeamId, kickoffDate],
  );
  return rows[0]?.id;
}
