import type { Pool } from 'pg';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchCached } from '../lib/cache.js';
import { canonicalTeamName } from '../lib/team-aliases.js';
import { utcInstantToLondonDate } from '../lib/london-time.js';
import {
  getOrCreateCompetition,
  getOrCreateSeason,
  getOrCreateCompetitionSeason,
  getOrCreateTeam,
  upsertFixture,
  upsertFixtureLineup,
  upsertFixtureLineupsBatch,
  upsertFixturePlayerStats,
  upsertFixturePlayerStatsBatch,
  upsertPlayerGoldenRecord,
  markFixturesLineupsChecked,
  type FixturePlayerStatsInput,
} from '../lib/db.js';

// CONFIRMED 2026-08-15 via `npm run check:lineup-depth` against a real
// API_FOOTBALL_KEY: the free tier serves full lineup and player-stats data
// for a 2023/24 (2+ season old) fixture -- 40 lineup rows, 40 player-stats
// rows for one match. The original 3-season backfill plan holds; no paid
// tier needed for depth. (This module's response-shape assumptions were
// also exercised for real at that point, not just written against
// API-Football v3's docs.)

const API_BASE = 'https://v3.football.api-sports.io';
const DAILY_BUDGET = 7500; // Pro tier -- confirmed on the account's api-sports.io dashboard, not the free tier's 100/day

function apiFootballKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY is not set -- required for API-Football seeding');
  return key;
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super(`API-Football's ${DAILY_BUDGET}/day plan budget is used up for today -- rerun tomorrow to continue.`);
  }
}

const MAX_CALL_RETRIES = 5; // covers both 429s and the timeout/network-error case below
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every live (non-cached) call this process makes is counted here so a
// multi-day lineup backfill can stop cleanly at the daily cap instead of
// getting rate-limited mid-run, and pick back up automatically tomorrow.
const budgetDir = new URL('../raw/api-football/', import.meta.url).pathname;
const budgetStatePath = `${budgetDir}.call-budget.json`;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function readBudgetState(): { date: string; callsUsed: number } {
  if (!existsSync(budgetStatePath)) return { date: todayKey(), callsUsed: 0 };
  const state = JSON.parse(readFileSync(budgetStatePath, 'utf-8'));
  return state.date === todayKey() ? state : { date: todayKey(), callsUsed: 0 };
}

function writeBudgetState(state: { date: string; callsUsed: number }): void {
  mkdirSync(budgetDir, { recursive: true });
  writeFileSync(budgetStatePath, JSON.stringify(state), 'utf-8');
}

async function callApiFootball<T>(path: string, cacheFile: string): Promise<T> {
  const cachePath = new URL(`../raw/api-football/${cacheFile}`, import.meta.url).pathname;
  const text = await fetchCached(cachePath, async () => {
    const state = readBudgetState();
    if (state.callsUsed >= DAILY_BUDGET) throw new BudgetExhaustedError();

    // A per-minute rate limit (separate from the daily cap above) is real
    // on every tier, and this backfill fires thousands of sequential
    // requests -- a single transient 429 used to crash the entire
    // npm run db:seed run instead of just pausing. Retries don't touch the
    // daily budget counter below: they're not a new logical call, just the
    // same one arriving late.
    for (let attempt = 0; ; attempt++) {
      // fetch() has no timeout by default -- if API-Football's connection
      // stalls (drops the response without ever closing the socket) this
      // used to hang forever with zero log output, indistinguishable from
      // "still working." A real run hit exactly this: no rate-limit
      // message, no error, just silence. AbortController turns that
      // indefinite wait into a bounded, retried failure instead.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${API_BASE}${path}`, { headers: { 'x-apisports-key': apiFootballKey() }, signal: controller.signal });
      } catch (err) {
        // Bundles the timeout (AbortError) together with genuine network
        // errors (DNS hiccup, TLS reset) -- both are transient from this
        // call's perspective, and neither is distinguishable from the
        // other in a way that would change what to do about it: back off
        // and retry, same as a 429.
        if (attempt >= MAX_CALL_RETRIES) {
          throw new Error(
            `API-Football request to ${path} failed ${MAX_CALL_RETRIES} times in a row (${err instanceof Error ? err.message : err}) -- giving up.`,
          );
        }
        const waitMs = 2 ** attempt * 1000;
        console.log(
          `${path} failed or timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${err instanceof Error ? err.message : err}), retrying ${attempt + 1}/${MAX_CALL_RETRIES} in ${Math.round(waitMs / 1000)}s...`,
        );
        await sleep(waitMs);
        continue;
      } finally {
        clearTimeout(timeoutId);
      }

      if (res.status === 429) {
        if (attempt >= MAX_CALL_RETRIES) {
          throw new Error(`API-Football rate-limited ${MAX_CALL_RETRIES} times in a row on ${path} -- giving up.`);
        }
        const retryAfterHeader = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 2 ** attempt * 1000;
        console.log(`Rate-limited on ${path}, waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_CALL_RETRIES}...`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`API-Football request failed: ${res.status} ${path}`);
      writeBudgetState({ date: state.date, callsUsed: state.callsUsed + 1 });
      return res.text();
    }
  });
  return JSON.parse(text) as T;
}

interface ApiFootballFixturesResponse {
  response: Array<{
    fixture: { id: number; date: string; referee: string | null; venue: { name: string | null }; status: { short: string } };
    league: { round: string };
    teams: { home: { id: number; name: string; logo: string | null }; away: { id: number; name: string; logo: string | null } };
    goals: { home: number | null; away: number | null };
    score: { halftime: { home: number | null; away: number | null } };
  }>;
}

export interface CompetitionSeasonSpec {
  competitionName: string;
  competitionType: 'league' | 'cup';
  externalLeagueId: number;
  seasonLabel: string;
  externalSeasonYear: number;
  seasonStart: string;
  seasonEnd: string;
}

/** Fixture lists are cheap -- one call returns a whole competition-season. */
export async function seedApiFootballFixtures(pool: Pool, spec: CompetitionSeasonSpec): Promise<void> {
  const competitionId = await getOrCreateCompetition(pool, spec.competitionName, spec.competitionType, spec.externalLeagueId);
  const seasonId = await getOrCreateSeason(pool, spec.seasonLabel, spec.seasonStart, spec.seasonEnd);
  const competitionSeasonId = await getOrCreateCompetitionSeason(pool, competitionId, seasonId, spec.externalSeasonYear);

  const data = await callApiFootball<ApiFootballFixturesResponse>(
    `/fixtures?league=${spec.externalLeagueId}&season=${spec.externalSeasonYear}`,
    `fixtures/${spec.externalLeagueId}_${spec.externalSeasonYear}.json`,
  );

  for (const item of data.response) {
    const homeTeamId = await getOrCreateTeam(pool, canonicalTeamName(item.teams.home.name), item.teams.home.logo ?? undefined);
    const awayTeamId = await getOrCreateTeam(pool, canonicalTeamName(item.teams.away.name), item.teams.away.logo ?? undefined);
    const kickoffAt = new Date(item.fixture.date);

    await upsertFixture(pool, {
      competitionSeasonId,
      homeTeamId,
      awayTeamId,
      kickoffAt,
      kickoffDate: utcInstantToLondonDate(kickoffAt),
      status: item.fixture.status.short === 'FT' ? 'finished' : 'scheduled',
      round: item.league.round,
      homeScore: item.goals.home ?? undefined,
      awayScore: item.goals.away ?? undefined,
      homeScoreHt: item.score.halftime.home ?? undefined,
      awayScoreHt: item.score.halftime.away ?? undefined,
      referee: item.fixture.referee ?? undefined,
      venue: item.fixture.venue.name ?? undefined,
      externalApiFootballId: item.fixture.id,
    });
  }
}

// startXI/substitutes/players typed as possibly null, not just possibly
// empty -- confirmed real: a real FA Cup fixture came back with a team
// lineup entry whose startXI was null rather than [], crashing the `for
// (... of teamLineup.startXI)` loop with "is not iterable". Same messy-
// data pattern already seen twice on lower-profile competitions (empty
// lineups entirely, a repeated player) -- API-Football's coverage just
// isn't uniformly complete once you're off Premier League/Championship,
// so every array read from this response needs to tolerate null, not
// assume the docs' happy-path shape.
interface ApiFootballLineupEntry {
  team: { id: number; name: string; logo?: string | null };
  startXI: Array<{ player: { id: number; name: string; number: number | null; pos: string | null } }> | null;
  substitutes: Array<{ player: { id: number; name: string; number: number | null; pos: string | null } }> | null;
}

interface ApiFootballPlayerStatsEntry {
  team: { id: number; name: string; logo?: string | null };
  players:
    | Array<{
        player: { id: number; name: string; photo?: string | null };
        statistics: Array<{
          games: { minutes: number | null; rating: string | null; position: string | null };
          shots: { total: number | null; on: number | null };
          goals: { total: number | null; assists: number | null; saves: number | null };
          passes: { total: number | null; accuracy: string | null };
          tackles: { total: number | null; interceptions: number | null };
          dribbles: { attempts: number | null; success: number | null };
          fouls: { drawn: number | null; committed: number | null };
          cards: { yellow: number | null; red: number | null };
          penalty: { scored: number | null; missed: number | null };
        }>;
      }>
    | null;
}

interface ApiFootballLineupsResponse {
  response: ApiFootballLineupEntry[];
}

/**
 * One call per fixture -- the actual rate-limit bottleneck. Call this in a
 * loop over fixtures still missing external_api_football_id-linked lineups;
 * it throws BudgetExhaustedError once the daily cap is hit so the caller can
 * stop cleanly and report progress instead of crashing mid-backfill.
 */
export async function seedApiFootballLineup(pool: Pool, fixtureExternalId: number, fixtureId: number): Promise<void> {
  const data = await callApiFootball<ApiFootballLineupsResponse>(
    `/fixtures/lineups?fixture=${fixtureExternalId}`,
    `lineups/${fixtureExternalId}.json`,
  );

  for (const teamLineup of data.response) {
    const teamId = await getOrCreateTeam(pool, canonicalTeamName(teamLineup.team.name), teamLineup.team.logo ?? undefined);

    for (const { player } of teamLineup.startXI ?? []) {
      const playerId = await upsertPlayerGoldenRecord(pool, {
        externalApiFootballId: player.id,
        fullName: player.name,
        position: player.pos ?? undefined,
      });
      await upsertFixtureLineup(pool, {
        fixtureId,
        teamId,
        playerId,
        isStarting: true,
        shirtNumber: player.number ?? undefined,
        position: player.pos ?? undefined,
      });
    }

    for (const { player } of teamLineup.substitutes ?? []) {
      const playerId = await upsertPlayerGoldenRecord(pool, {
        externalApiFootballId: player.id,
        fullName: player.name,
        position: player.pos ?? undefined,
      });
      await upsertFixtureLineup(pool, {
        fixtureId,
        teamId,
        playerId,
        isStarting: false,
        shirtNumber: player.number ?? undefined,
        position: player.pos ?? undefined,
      });
    }
  }
}

interface ApiFootballPlayerStatsResponse {
  response: ApiFootballPlayerStatsEntry[];
}

/**
 * A *separate* per-fixture call from lineups (API-Football splits "who
 * played" from "how did they perform" across two endpoints) -- this is the
 * one that doubles the backfill's daily-budget cost, which is why it's
 * gated behind having a paid tier rather than bundled into the original
 * free-tier lineup plan.
 */
export async function seedApiFootballPlayerStats(pool: Pool, fixtureExternalId: number, fixtureId: number): Promise<void> {
  const data = await callApiFootball<ApiFootballPlayerStatsResponse>(
    `/fixtures/players?fixture=${fixtureExternalId}`,
    `player-stats/${fixtureExternalId}.json`,
  );

  for (const teamEntry of data.response) {
    const teamId = await getOrCreateTeam(pool, canonicalTeamName(teamEntry.team.name), teamEntry.team.logo ?? undefined);

    for (const { player, statistics } of teamEntry.players ?? []) {
      const stats = statistics[0]; // one fixture -> one stat block per player
      if (!stats) continue;

      const playerId = await upsertPlayerGoldenRecord(pool, {
        externalApiFootballId: player.id,
        fullName: player.name,
        position: stats.games.position ?? undefined,
        photoUrl: player.photo ?? undefined,
      });

      await upsertFixturePlayerStats(pool, {
        fixtureId,
        teamId,
        playerId,
        minutesPlayed: stats.games.minutes ?? undefined,
        rating: stats.games.rating ? Number(stats.games.rating) : undefined,
        goals: stats.goals.total ?? undefined,
        assists: stats.goals.assists ?? undefined,
        shots: stats.shots.total ?? undefined,
        shotsOnTarget: stats.shots.on ?? undefined,
        passes: stats.passes.total ?? undefined,
        passesAccuracy: stats.passes.accuracy ? Number(stats.passes.accuracy) : undefined,
        tackles: stats.tackles.total ?? undefined,
        interceptions: stats.tackles.interceptions ?? undefined,
        dribblesAttempted: stats.dribbles.attempts ?? undefined,
        dribblesCompleted: stats.dribbles.success ?? undefined,
        foulsDrawn: stats.fouls.drawn ?? undefined,
        foulsCommitted: stats.fouls.committed ?? undefined,
        yellowCards: stats.cards.yellow ?? undefined,
        redCards: stats.cards.red ?? undefined,
        penaltiesScored: stats.penalty.scored ?? undefined,
        penaltiesMissed: stats.penalty.missed ?? undefined,
        saves: stats.goals.saves ?? undefined,
      });
    }
  }
}

interface ApiFootballBulkFixturesResponse {
  response: Array<{
    fixture: { id: number };
    lineups: ApiFootballLineupEntry[] | null;
    players: ApiFootballPlayerStatsEntry[] | null;
  }>;
}

const BULK_FIXTURES_CHUNK_SIZE = 20; // API-Football's `ids=` filter hard cap, per the docs

/**
 * CONFIRMED 2026-08-15 via `npm run check:bulk-fixtures` against a real
 * API_FOOTBALL_KEY: GET /fixtures?ids=id1-id2-...-id20 embeds each
 * fixture's lineups + player stats directly in the response (see
 * backend/seed/raw/api-football/bulk-fixtures-check.json) -- not just the
 * docs' prose claim. This replaces the old seedApiFootballLineup +
 * seedApiFootballPlayerStats pair (2 calls/fixture) with 1 call per chunk
 * of up to 20 fixtures: a real ~40x reduction in API-Football call volume
 * for the backfill, which is what actually gates how fast 3 seasons x 3
 * competitions of lineup depth can be pulled under the daily budget.
 *
 * DB writes are batched per chunk too (one INSERT for every lineup row in
 * the chunk, one for every player-stats row), same reasoning as the
 * football-data.co.uk odds/team-stats batching in lib/db.ts -- no reason to
 * pay per-row round-trips here just because the API call itself got
 * cheaper.
 */
export interface BulkChunkResult {
  lineupRows: number;
  playerStatsRows: number;
  emptyFixtures: number;
}

export async function seedApiFootballLineupsAndStatsBulk(
  pool: Pool,
  fixtures: Array<{ externalId: number; fixtureId: number }>,
): Promise<BulkChunkResult> {
  if (fixtures.length === 0) return { lineupRows: 0, playerStatsRows: 0, emptyFixtures: 0 };
  if (fixtures.length > BULK_FIXTURES_CHUNK_SIZE) {
    throw new Error(
      `seedApiFootballLineupsAndStatsBulk got ${fixtures.length} fixtures -- API-Football's ids= filter caps at ${BULK_FIXTURES_CHUNK_SIZE} per call.`,
    );
  }

  const fixtureIdByExternalId = new Map(fixtures.map((f) => [f.externalId, f.fixtureId]));
  const idsParam = fixtures.map((f) => f.externalId).join('-');

  const data = await callApiFootball<ApiFootballBulkFixturesResponse>(
    `/fixtures?ids=${idsParam}`,
    `bulk-fixtures/${idsParam}.json`,
  );

  const lineupRows: Array<{
    fixtureId: number;
    teamId: number;
    playerId: number;
    isStarting: boolean;
    shirtNumber?: number;
    position?: string;
  }> = [];
  const playerStatsRows: FixturePlayerStatsInput[] = [];

  for (const item of data.response) {
    const fixtureId = fixtureIdByExternalId.get(item.fixture.id);
    if (fixtureId === undefined) continue; // the API only ever echoes back ids we asked for, but guard anyway

    for (const teamLineup of item.lineups ?? []) {
      const teamId = await getOrCreateTeam(pool, canonicalTeamName(teamLineup.team.name), teamLineup.team.logo ?? undefined);

      for (const { player } of teamLineup.startXI ?? []) {
        const playerId = await upsertPlayerGoldenRecord(pool, {
          externalApiFootballId: player.id,
          fullName: player.name,
          position: player.pos ?? undefined,
        });
        lineupRows.push({ fixtureId, teamId, playerId, isStarting: true, shirtNumber: player.number ?? undefined, position: player.pos ?? undefined });
      }
      for (const { player } of teamLineup.substitutes ?? []) {
        const playerId = await upsertPlayerGoldenRecord(pool, {
          externalApiFootballId: player.id,
          fullName: player.name,
          position: player.pos ?? undefined,
        });
        lineupRows.push({ fixtureId, teamId, playerId, isStarting: false, shirtNumber: player.number ?? undefined, position: player.pos ?? undefined });
      }
    }

    for (const teamEntry of item.players ?? []) {
      const teamId = await getOrCreateTeam(pool, canonicalTeamName(teamEntry.team.name), teamEntry.team.logo ?? undefined);

      for (const { player, statistics } of teamEntry.players ?? []) {
        const stats = statistics[0]; // one fixture -> one stat block per player
        if (!stats) continue;

        const playerId = await upsertPlayerGoldenRecord(pool, {
          externalApiFootballId: player.id,
          fullName: player.name,
          position: stats.games.position ?? undefined,
          photoUrl: player.photo ?? undefined,
        });

        playerStatsRows.push({
          fixtureId,
          teamId,
          playerId,
          minutesPlayed: stats.games.minutes ?? undefined,
          rating: stats.games.rating ? Number(stats.games.rating) : undefined,
          goals: stats.goals.total ?? undefined,
          assists: stats.goals.assists ?? undefined,
          shots: stats.shots.total ?? undefined,
          shotsOnTarget: stats.shots.on ?? undefined,
          passes: stats.passes.total ?? undefined,
          passesAccuracy: stats.passes.accuracy ? Number(stats.passes.accuracy) : undefined,
          tackles: stats.tackles.total ?? undefined,
          interceptions: stats.tackles.interceptions ?? undefined,
          dribblesAttempted: stats.dribbles.attempts ?? undefined,
          dribblesCompleted: stats.dribbles.success ?? undefined,
          foulsDrawn: stats.fouls.drawn ?? undefined,
          foulsCommitted: stats.fouls.committed ?? undefined,
          yellowCards: stats.cards.yellow ?? undefined,
          redCards: stats.cards.red ?? undefined,
          penaltiesScored: stats.penalty.scored ?? undefined,
          penaltiesMissed: stats.penalty.missed ?? undefined,
          saves: stats.goals.saves ?? undefined,
        });
      }
    }
  }

  // Real production data proved this wrong: a chunk crashed with Postgres's
  // "ON CONFLICT DO UPDATE command cannot affect row a second time" --
  // meaning the same (fixture_id, player_id) pair really did appear twice
  // within one batch. The DB's unique constraints (fixtures.external_api_
  // football_id, players.external_api_football_id) rule out this being two
  // different fixtures or two different real players colliding; the
  // remaining explanation is API-Football itself occasionally repeating a
  // player within lineups[]/players[] for one fixture (seen so far only on
  // lower-profile competitions, e.g. a messy FA Cup round). Deduping here
  // -- last entry wins -- turns that from a hard crash into a harmless,
  // logged no-op instead of assuming it can't happen.
  const dedupedLineupRows = dedupeByFixturePlayer(lineupRows, 'fixture_lineups');
  const dedupedPlayerStatsRows = dedupeByFixturePlayer(playerStatsRows, 'fixture_player_stats');

  await upsertFixtureLineupsBatch(pool, dedupedLineupRows);
  await upsertFixturePlayerStatsBatch(pool, dedupedPlayerStatsRows);

  // Mark every fixture in this chunk as checked, win or lose -- a fixture
  // that contributed zero rows (real, common for lower-tier FA Cup matches
  // API-Football has no lineup data for at all) needs this exactly as much
  // as one that succeeded, otherwise backfillLineupsForCompetitionSeason
  // keeps re-attempting it forever. The caller only ever passes finished
  // fixtures in here (see its status = 'finished' filter), so this can't
  // wrongly mark a not-yet-played match as permanently unavailable.
  const emptyFixtureCount = fixtures.length - new Set([...dedupedLineupRows.map((r) => r.fixtureId), ...dedupedPlayerStatsRows.map((r) => r.fixtureId)]).size;
  if (emptyFixtureCount > 0) {
    console.log(`${emptyFixtureCount}/${fixtures.length} fixture(s) in this chunk had no lineup/player-stats data available (marked checked, won't retry).`);
  }
  await markFixturesLineupsChecked(
    pool,
    fixtures.map((f) => f.fixtureId),
  );

  return { lineupRows: dedupedLineupRows.length, playerStatsRows: dedupedPlayerStatsRows.length, emptyFixtures: emptyFixtureCount };
}

function dedupeByFixturePlayer<T extends { fixtureId: number; playerId: number }>(rows: T[], label: string): T[] {
  const byKey = new Map<string, T>();
  let duplicates = 0;
  for (const row of rows) {
    const key = `${row.fixtureId}:${row.playerId}`;
    if (byKey.has(key)) duplicates++;
    byKey.set(key, row); // last entry wins -- API-Football's own response order, not something we control
  }
  if (duplicates > 0) {
    console.log(
      `${label}: API-Football's response repeated ${duplicates} (fixture, player) pair(s) within one chunk -- deduped before upserting.`,
    );
  }
  return [...byKey.values()];
}

/**
 * Resumable backfill: finds fixtures in the given competition-season still
 * missing lineups and/or player stats, and pulls them BULK_FIXTURES_CHUNK_SIZE
 * at a time via the /fixtures?ids=... endpoint. Unlike the old per-fixture
 * version, lineups and player stats always arrive together now (one call
 * gets both), so a fixture missing just one of the two gets both refetched
 * -- a harmless no-op re-upsert for whichever half it already had, not a
 * correctness issue. Stops cleanly when the daily budget runs out; safe to
 * rerun (daily, on a paid tier or free) until it reports everything done.
 *
 * Ordered by kickoff_date so chunk boundaries are stable across reruns --
 * fetchCached's cache key is the joined id list, so a run that dies partway
 * through and gets rerun hits the same cache files instead of building
 * different 20-fixture groupings each time.
 *
 * status = 'finished' matters for more than "don't bother, nothing's
 * happened yet": fetchCached's cache key is just the chunk's id list, with
 * no expiry. A not-yet-played fixture bundled into a chunk today would get
 * its (necessarily empty) lineup response cached under that id list
 * forever -- so a rerun after the match is actually played could still
 * read the stale pre-match cache file and never see the real data. Only
 * ever considering finished fixtures means that situation can't arise: a
 * fixture only enters a chunk once the match has actually happened, so
 * whatever comes back is the real result, not a too-early snapshot.
 * lineups_checked_at IS NULL is the other half -- see markFixturesLineupsChecked.
 */
export async function backfillLineupsForCompetitionSeason(
  pool: Pool,
  competitionSeasonId: number,
): Promise<{ done: number; remaining: number; stoppedOnBudget: boolean }> {
  const { rows } = await pool.query<{ id: number; external_api_football_id: number }>(
    `SELECT f.id, f.external_api_football_id
     FROM fixtures f
     WHERE f.competition_season_id = $1
       AND f.external_api_football_id IS NOT NULL
       AND f.status = 'finished'
       AND f.lineups_checked_at IS NULL
       AND (
         NOT EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id)
         OR NOT EXISTS (SELECT 1 FROM fixture_player_stats fps WHERE fps.fixture_id = f.id)
       )
     ORDER BY f.kickoff_date ASC`,
    [competitionSeasonId],
  );

  const totalChunks = Math.ceil(rows.length / BULK_FIXTURES_CHUNK_SIZE);
  let done = 0;
  for (let i = 0; i < rows.length; i += BULK_FIXTURES_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_FIXTURES_CHUNK_SIZE).map((r) => ({ externalId: r.external_api_football_id, fixtureId: r.id }));
    const chunkNumber = i / BULK_FIXTURES_CHUNK_SIZE + 1;

    // Real crash hit here: "Connection terminated unexpectedly" from pg,
    // mid-multi-hour run -- a pooled connection that sat idle through an
    // API-Football retry/backoff sleep got closed server-side (Neon's
    // pooler or an intermediate network hop) before the next query used
    // it. pool.ts's keepAlive addresses the common cause, but a dropped
    // connection is still possible, so this chunk gets its own bounded
    // retry rather than taking the whole backfill down over one query.
    // Safe to retry wholesale: callApiFootball's disk cache means the
    // retry doesn't re-spend an API call, and every DB write inside is an
    // idempotent upsert.
    for (let attempt = 0; ; attempt++) {
      try {
        // Per-chunk, not just per-competition-season: a long Championship
        // backfill (~28 chunks) used to print exactly one line at the very
        // end, so a real, slow-but-working run looked identical to a hang
        // for the whole time in between. This is the fix asked for after
        // that exact confusion.
        const result = await seedApiFootballLineupsAndStatsBulk(pool, chunk);
        console.log(
          `  chunk ${chunkNumber}/${totalChunks} (${chunk.length} fixtures): +${result.lineupRows} lineup rows, +${result.playerStatsRows} player-stat rows` +
            (result.emptyFixtures > 0 ? `, ${result.emptyFixtures} fixture(s) had no data` : ''),
        );
        done += chunk.length;
        break;
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          return { done, remaining: rows.length - done, stoppedOnBudget: true };
        }
        if (isTransientDbConnectionError(err) && attempt < MAX_CALL_RETRIES) {
          const waitMs = 2 ** attempt * 1000;
          console.log(
            `DB connection dropped mid-chunk (${err instanceof Error ? err.message : err}), retrying ${attempt + 1}/${MAX_CALL_RETRIES} in ${Math.round(waitMs / 1000)}s...`,
          );
          await sleep(waitMs);
          continue;
        }
        throw err;
      }
    }
  }
  return { done, remaining: 0, stoppedOnBudget: false };
}

function isTransientDbConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /connection terminated|connection reset|ECONNRESET|ETIMEDOUT/i.test(message);
}
