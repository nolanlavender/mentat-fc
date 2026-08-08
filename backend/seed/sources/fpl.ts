import type { Pool } from 'pg';
import { fetchCached } from '../lib/cache.js';
import {
  getOrCreateTeam,
  setTeamExternalFplId,
  setPlayerCurrentTeam,
  upsertPlayerGoldenRecord,
  upsertFplGameweek,
  upsertFplPlayerGameweekStats,
} from '../lib/db.js';

// The official FPL API only ever reflects the *current* season -- it isn't a
// historical archive. That's a fundamental property of what FPL is (a live
// fantasy game), not a gap in this script: there's no "3 years of FPL data"
// to backfill the way there is for match results. seedFplBootstrap seeds
// teams/players/gameweeks from bootstrap-static; seedFplPlayerGameweekHistory
// (below) fills in per-gameweek performance, which needs a separate call per
// player on top of that.
//
// UNVERIFIED, like sources/api-football.ts: written against FPL's publicly
// known element-summary response shape, never run against a live response in
// this environment (this container's network policy blocks
// fantasy.premierleague.com the same way it blocks football-data.co.uk and
// API-Football -- confirmed by testing).

interface BootstrapStatic {
  teams: Array<{ id: number; name: string }>;
  element_types: Array<{ id: number; singular_name_short: string }>;
  elements: Array<{
    id: number;
    first_name: string;
    second_name: string;
    web_name: string;
    element_type: number;
    team: number;
    birth_date?: string | null;
  }>;
  events: Array<{
    id: number;
    deadline_time: string;
    is_current: boolean;
    finished: boolean;
    average_entry_score: number;
    highest_score: number | null;
  }>;
}

async function downloadBootstrapStatic(): Promise<BootstrapStatic> {
  const cachePath = new URL('../raw/fpl/bootstrap-static.json', import.meta.url).pathname;
  const text = await fetchCached(cachePath, async () => {
    const res = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
    if (!res.ok) throw new Error(`FPL bootstrap-static fetch failed: ${res.status}`);
    return res.text();
  });
  return JSON.parse(text) as BootstrapStatic;
}

export async function seedFplBootstrap(pool: Pool): Promise<void> {
  const data = await downloadBootstrapStatic();

  const positionByTypeId = new Map(data.element_types.map((t) => [t.id, t.singular_name_short]));

  // FPL team names match football-data.co.uk's canonical names closely enough
  // in practice (both use full names like "Arsenal", "Nottingham Forest") --
  // getOrCreateTeam matches on name, so this links to teams already seeded
  // from historical results rather than creating duplicates.
  const teamIdByFplId = new Map<number, number>();
  for (const team of data.teams) {
    const teamId = await getOrCreateTeam(pool, team.name);
    await setTeamExternalFplId(pool, teamId, team.id);
    teamIdByFplId.set(team.id, teamId);
  }

  for (const element of data.elements) {
    const playerId = await upsertPlayerGoldenRecord(pool, {
      externalFplId: element.id,
      fullName: `${element.first_name} ${element.second_name}`.trim(),
      dateOfBirth: element.birth_date ?? undefined,
      position: positionByTypeId.get(element.element_type),
    });
    const teamId = teamIdByFplId.get(element.team);
    if (teamId) await setPlayerCurrentTeam(pool, playerId, teamId);
  }

  for (const event of data.events) {
    await upsertFplGameweek(pool, {
      gwNumber: event.id,
      deadlineTime: new Date(event.deadline_time),
      isCurrent: event.is_current,
      isFinished: event.finished,
      averageScore: event.average_entry_score,
      highestScore: event.highest_score ?? undefined,
    });
  }
}

interface ElementSummary {
  history: Array<{
    element: number;
    round: number; // gameweek number
    total_points: number;
    minutes: number;
    goals_scored: number;
    assists: number;
    clean_sheets: number;
    goals_conceded: number;
    own_goals: number;
    penalties_saved: number;
    penalties_missed: number;
    yellow_cards: number;
    red_cards: number;
    saves: number;
    bonus: number;
    bps: number;
    influence: string; // FPL returns these as decimal strings, not numbers
    creativity: string;
    threat: string;
    ict_index: string;
    value: number; // price at that point, tenths of GBP million -- same convention as now_cost
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadElementSummary(fplPlayerId: number): Promise<ElementSummary> {
  const cachePath = new URL(`../raw/fpl/element-summary/${fplPlayerId}.json`, import.meta.url).pathname;
  const text = await fetchCached(cachePath, async () => {
    // No documented rate limit on this endpoint (unlike API-Football's
    // 100/day), but ~700+ calls in a row against someone else's free public
    // API is still worth throttling rather than firing as fast as possible.
    await sleep(150);
    const res = await fetch(`https://fantasy.premierleague.com/api/element-summary/${fplPlayerId}/`);
    if (!res.ok) throw new Error(`FPL element-summary fetch failed: ${res.status} (player ${fplPlayerId})`);
    return res.text();
  });
  return JSON.parse(text) as ElementSummary;
}

/**
 * Fills in fpl_player_gameweek_stats for every player already seeded by
 * seedFplBootstrap. Resumable the same way the API-Football backfill is:
 * fetchCached means a rerun after an interruption only re-fetches players
 * that don't have a cached response yet. A single player's fetch failing
 * (network hiccup, since there's no budget to exhaust here) is logged and
 * skipped rather than aborting the whole run.
 */
export async function seedFplPlayerGameweekHistory(pool: Pool): Promise<{ done: number; skipped: number }> {
  const { rows: players } = await pool.query<{ id: number; external_fpl_id: number }>(
    `SELECT id, external_fpl_id FROM players WHERE external_fpl_id IS NOT NULL`,
  );
  const { rows: gameweeks } = await pool.query<{ id: number; gw_number: number }>(`SELECT id, gw_number FROM fpl_gameweeks`);
  const gameweekIdByNumber = new Map(gameweeks.map((g) => [g.gw_number, g.id]));

  let done = 0;
  let skipped = 0;
  for (const player of players) {
    let summary: ElementSummary;
    try {
      summary = await downloadElementSummary(player.external_fpl_id);
    } catch (err) {
      console.error(`Skipping player (FPL id ${player.external_fpl_id}): ${(err as Error).message}`);
      skipped += 1;
      continue;
    }

    for (const gw of summary.history) {
      const gameweekId = gameweekIdByNumber.get(gw.round);
      if (!gameweekId) continue; // shouldn't happen if seedFplBootstrap ran first, but don't crash the whole run over one row

      await upsertFplPlayerGameweekStats(pool, {
        playerId: player.id,
        gameweekId,
        nowCost: gw.value,
        totalPoints: gw.total_points,
        minutes: gw.minutes,
        goalsScored: gw.goals_scored,
        assists: gw.assists,
        cleanSheets: gw.clean_sheets,
        goalsConceded: gw.goals_conceded,
        ownGoals: gw.own_goals,
        penaltiesSaved: gw.penalties_saved,
        penaltiesMissed: gw.penalties_missed,
        yellowCards: gw.yellow_cards,
        redCards: gw.red_cards,
        saves: gw.saves,
        bonus: gw.bonus,
        bps: gw.bps,
        influence: Number(gw.influence),
        creativity: Number(gw.creativity),
        threat: Number(gw.threat),
        ictIndex: Number(gw.ict_index),
      });
    }
    done += 1;
  }
  return { done, skipped };
}
