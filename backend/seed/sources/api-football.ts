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
  upsertFixturePlayerStats,
  upsertPlayerGoldenRecord,
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

const MAX_RATE_LIMIT_RETRIES = 5;

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
      const res = await fetch(`${API_BASE}${path}`, { headers: { 'x-apisports-key': apiFootballKey() } });
      if (res.status === 429) {
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw new Error(`API-Football rate-limited ${MAX_RATE_LIMIT_RETRIES} times in a row on ${path} -- giving up.`);
        }
        const retryAfterHeader = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 2 ** attempt * 1000;
        console.log(`Rate-limited on ${path}, waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}...`);
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
    teams: { home: { id: number; name: string }; away: { id: number; name: string } };
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
    const homeTeamId = await getOrCreateTeam(pool, canonicalTeamName(item.teams.home.name));
    const awayTeamId = await getOrCreateTeam(pool, canonicalTeamName(item.teams.away.name));
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

interface ApiFootballLineupsResponse {
  response: Array<{
    team: { id: number; name: string };
    startXI: Array<{ player: { id: number; name: string; number: number | null; pos: string | null } }>;
    substitutes: Array<{ player: { id: number; name: string; number: number | null; pos: string | null } }>;
  }>;
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
    const teamId = await getOrCreateTeam(pool, canonicalTeamName(teamLineup.team.name));

    for (const { player } of teamLineup.startXI) {
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

    for (const { player } of teamLineup.substitutes) {
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
  response: Array<{
    team: { id: number; name: string };
    players: Array<{
      player: { id: number; name: string };
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
    }>;
  }>;
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
    const teamId = await getOrCreateTeam(pool, canonicalTeamName(teamEntry.team.name));

    for (const { player, statistics } of teamEntry.players) {
      const stats = statistics[0]; // one fixture -> one stat block per player
      if (!stats) continue;

      const playerId = await upsertPlayerGoldenRecord(pool, {
        externalApiFootballId: player.id,
        fullName: player.name,
        position: stats.games.position ?? undefined,
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

/**
 * Resumable backfill: finds fixtures in the given competition-season still
 * missing lineups and/or player stats, and fetches only whatever's actually
 * missing for each one -- so a fixture that already has lineups from an
 * earlier run doesn't burn budget re-fetching them just because player
 * stats came later. Stops cleanly when the daily budget runs out; safe to
 * rerun (daily, on a paid tier or free) until it reports everything done.
 */
export async function backfillLineupsForCompetitionSeason(
  pool: Pool,
  competitionSeasonId: number,
): Promise<{ done: number; remaining: number; stoppedOnBudget: boolean }> {
  const { rows } = await pool.query<{
    id: number;
    external_api_football_id: number | null;
    has_lineup: boolean;
    has_player_stats: boolean;
  }>(
    `SELECT f.id, f.external_api_football_id,
       EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id) AS has_lineup,
       EXISTS (SELECT 1 FROM fixture_player_stats fps WHERE fps.fixture_id = f.id) AS has_player_stats
     FROM fixtures f
     WHERE f.competition_season_id = $1
       AND f.external_api_football_id IS NOT NULL
       AND (
         NOT EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id)
         OR NOT EXISTS (SELECT 1 FROM fixture_player_stats fps WHERE fps.fixture_id = f.id)
       )`,
    [competitionSeasonId],
  );

  let done = 0;
  for (const row of rows) {
    try {
      if (!row.has_lineup) await seedApiFootballLineup(pool, row.external_api_football_id!, row.id);
      if (!row.has_player_stats) await seedApiFootballPlayerStats(pool, row.external_api_football_id!, row.id);
      done += 1;
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        return { done, remaining: rows.length - done, stoppedOnBudget: true };
      }
      throw err;
    }
  }
  return { done, remaining: 0, stoppedOnBudget: false };
}
