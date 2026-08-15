import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { AppError, UpstreamError } from '../lib/errors.js';

const FPL_BASE = 'https://fantasy.premierleague.com/api';

// Live, per-request calls to FPL's public entry endpoints -- deliberately
// NOT run through the seed pipeline's fetch-if-absent cache. That cache
// exists to protect a scarce resource (API-Football's 100/day cap); squad
// picks are single-user, low-volume, and change weekly (transfers), so
// there's no budget to protect here. Caching this would only reintroduce
// staleness for something cheap enough to just fetch fresh every time.
//
// The /entry/{id}/ shape is now confirmed against a real response (tested
// live during pre-season 2026-07-30: current_event correctly came back
// null). The /entry/{id}/event/{event}/picks/ shape is still unverified
// against a real response -- confirm it once a squad is actually saved for
// gameweek 1 or the season starts.
async function fetchFplLive<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${FPL_BASE}${path}`);
  } catch (err) {
    throw new UpstreamError(`Couldn't reach the FPL API: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new UpstreamError(`FPL API returned ${res.status} for ${path}`, res.status);
  }
  return res.json() as Promise<T>;
}

interface FplEntry {
  id: number;
  name: string;
  player_first_name: string;
  player_last_name: string;
  current_event: number | null;
}

interface FplPicksResponse {
  active_chip: string | null;
  entry_history: {
    event: number;
    points: number;
    total_points: number;
    event_transfers: number;
    event_transfers_cost: number;
    points_on_bench: number;
    bank: number;
    value: number;
  };
  picks: Array<{
    element: number; // FPL player id
    position: number; // 1-11 starting XI, 12-15 bench
    multiplier: number; // 0 = benched (not auto-subbed in), 1 = normal, 2 = captain, 3 = triple captain
    is_captain: boolean;
    is_vice_captain: boolean;
  }>;
}

export interface MyTeamPlayer {
  playerId: number;
  fplPlayerId: number;
  fullName: string;
  position: string | null;
  photoUrl: string | null;
  team: { id: number; name: string; logoUrl: string | null } | null;
  squadPosition: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isStarting: boolean;
}

export interface MyTeam {
  entryName: string;
  managerName: string;
  gameweek: number;
  gameweekPoints: number;
  totalPoints: number;
  bank: number;
  squadValue: number;
  activeChip: string | null;
  players: MyTeamPlayer[];
  // True when there's no "current" gameweek yet (pre-season) and this is
  // your saved gameweek-1 squad instead -- no live scoring to report, just
  // who's picked. The frontend should label this clearly rather than
  // presenting it as real gameweek data.
  isPreview: boolean;
}

// entry.current_event is null before the season's first deadline, but a
// squad may already be saved for gameweek 1 -- try that as a preview
// instead of only ever saying "nothing to show." A 404 here specifically
// means "no picks saved for this event," which is expected pre-season, not
// a real upstream failure -- anything else (5xx, network error) still
// propagates as a genuine UpstreamError.
async function fetchPicksOrNull(entryId: number, eventId: number): Promise<FplPicksResponse | null> {
  try {
    return await fetchFplLive<FplPicksResponse>(`/entry/${entryId}/event/${eventId}/picks/`);
  } catch (err) {
    if (err instanceof UpstreamError && err.upstreamStatus === 404) return null;
    throw err;
  }
}

export async function getMyTeam(): Promise<MyTeam> {
  if (!env.fplEntryId) {
    throw new AppError('FPL_ENTRY_ID is not configured -- set it in backend/.env to use this endpoint.', 400);
  }

  const entry = await fetchFplLive<FplEntry>(`/entry/${env.fplEntryId}/`);
  const isPreview = !entry.current_event;
  const eventId = entry.current_event ?? 1;

  const picksData = isPreview
    ? await fetchPicksOrNull(env.fplEntryId, eventId)
    : await fetchFplLive<FplPicksResponse>(`/entry/${env.fplEntryId}/event/${eventId}/picks/`);

  if (!picksData) {
    throw new AppError('No squad saved for gameweek 1 yet -- pick your team on fantasy.premierleague.com first.', 400);
  }

  // Join FPL's player ids (picksData.picks[].element) against our own
  // players table -- we already have names/positions/teams cached locally
  // from seedFplBootstrap, no reason to ask FPL for that again here.
  const fplPlayerIds = picksData.picks.map((p) => p.element);
  const { rows: ourPlayers } = await pool.query(
    `SELECT p.id, p.external_fpl_id, p.full_name, p.position, p.photo_url, t.id AS team_id, t.name AS team_name, t.logo_url AS team_logo_url
     FROM players p
     LEFT JOIN teams t ON t.id = p.current_team_id
     WHERE p.external_fpl_id = ANY($1)`,
    [fplPlayerIds],
  );
  const byFplId = new Map(ourPlayers.map((r) => [r.external_fpl_id, r]));

  const players: MyTeamPlayer[] = picksData.picks
    .map((pick) => {
      const row = byFplId.get(pick.element);
      return {
        playerId: row?.id ?? -1,
        fplPlayerId: pick.element,
        fullName: row?.full_name ?? `Unknown player (FPL id ${pick.element})`,
        position: row?.position ?? null,
        photoUrl: row?.photo_url ?? null,
        team: row?.team_id ? { id: row.team_id, name: row.team_name, logoUrl: row.team_logo_url ?? null } : null,
        squadPosition: pick.position,
        multiplier: pick.multiplier,
        isCaptain: pick.is_captain,
        isViceCaptain: pick.is_vice_captain,
        isStarting: pick.position <= 11,
      };
    })
    .sort((a, b) => a.squadPosition - b.squadPosition);

  return {
    entryName: entry.name,
    managerName: `${entry.player_first_name} ${entry.player_last_name}`,
    gameweek: eventId,
    gameweekPoints: picksData.entry_history.points,
    totalPoints: picksData.entry_history.total_points,
    bank: picksData.entry_history.bank / 10, // FPL reports in tenths of GBP million
    squadValue: picksData.entry_history.value / 10,
    activeChip: picksData.active_chip,
    players,
    isPreview,
  };
}
