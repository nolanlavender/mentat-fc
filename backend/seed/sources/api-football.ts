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
  upsertPlayerByApiFootballId,
} from '../lib/db.js';

// UNVERIFIED: this module is written against API-Football v3's publicly
// documented response shape, but has not been run against a live response in
// this environment (no key configured, and this container's network policy
// blocks the API-Football host anyway). Before trusting a large backfill,
// run seedApiFootballFixtures for one competition-season and eyeball the
// cached JSON in seed/raw/api-football/ against what actually came back --
// per the plan, also specifically check whether a 2+-season-old fixture's
// lineup data is served at all on the free tier, since that's unconfirmed
// and would change this whole approach if it isn't.

const API_BASE = 'https://v3.football.api-sports.io';
const DAILY_BUDGET = 100;

function apiFootballKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY is not set -- required for API-Football seeding');
  return key;
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super(`API-Football's ${DAILY_BUDGET}/day free-tier budget is used up for today -- rerun tomorrow to continue.`);
  }
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
    const res = await fetch(`${API_BASE}${path}`, { headers: { 'x-apisports-key': apiFootballKey() } });
    if (!res.ok) throw new Error(`API-Football request failed: ${res.status} ${path}`);
    writeBudgetState({ date: state.date, callsUsed: state.callsUsed + 1 });
    return res.text();
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
      const playerId = await upsertPlayerByApiFootballId(pool, {
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
      const playerId = await upsertPlayerByApiFootballId(pool, {
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

/**
 * Resumable backfill: finds fixtures in the given competition-season that
 * don't have lineups yet and fetches them one at a time, stopping cleanly
 * when the daily budget runs out. Safe to rerun daily until it reports
 * everything is done.
 */
export async function backfillLineupsForCompetitionSeason(
  pool: Pool,
  competitionSeasonId: number,
): Promise<{ done: number; remaining: number; stoppedOnBudget: boolean }> {
  const { rows } = await pool.query<{ id: number; external_api_football_id: number | null }>(
    `SELECT f.id, f.external_api_football_id
     FROM fixtures f
     WHERE f.competition_season_id = $1
       AND f.external_api_football_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id)`,
    [competitionSeasonId],
  );

  let done = 0;
  for (const row of rows) {
    try {
      await seedApiFootballLineup(pool, row.external_api_football_id!, row.id);
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
