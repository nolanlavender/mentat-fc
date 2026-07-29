import type { Pool } from 'pg';
import { fetchCached } from '../lib/cache.js';
import { getOrCreateTeam, setTeamExternalFplId, setPlayerCurrentTeam, upsertPlayerGoldenRecord, upsertFplGameweek } from '../lib/db.js';

// The official FPL API only ever reflects the *current* season -- it isn't a
// historical archive. That's a fundamental property of what FPL is (a live
// fantasy game), not a gap in this script: there's no "3 years of FPL data"
// to backfill the way there is for match results. Per-gameweek player stats
// (fpl_player_gameweek_stats) additionally need one element-summary call per
// player on top of bootstrap-static, which is a Phase 4 (FPL integration)
// concern, not Phase 1 -- this module seeds teams/players/gameweeks now,
// since that's what bootstrap-static actually gives us today.

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
