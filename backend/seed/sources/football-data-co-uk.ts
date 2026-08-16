import { parse } from 'csv-parse/sync';
import type { Pool } from 'pg';
import { fetchCached } from '../lib/cache.js';
import { canonicalTeamName } from '../lib/team-aliases.js';
import { londonWallTimeToUtc } from '../lib/london-time.js';
import {
  getOrCreateCompetition,
  getOrCreateSeason,
  getOrCreateCompetitionSeason,
  getOrCreateTeam,
  upsertFixture,
  upsertFixtureTeamStatsBatch,
  upsertFixtureOddsBatch,
  type FixtureOddsInput,
} from '../lib/db.js';

// football-data.co.uk match-winner odds: one {open, close} column pair per
// bookmaker. "Max"/"Avg" aren't real bookmakers -- they're the best/average
// price across all bookmakers they track -- but we record them as pseudo-
// bookmakers since that's a useful signal on its own (closing line value).
const MATCH_WINNER_BOOKMAKERS = [
  { bookmaker: 'bet365', open: 'B365', close: 'B365C' },
  { bookmaker: 'bet_and_win', open: 'BW', close: 'BWC' },
  { bookmaker: 'interwetten', open: 'IW', close: 'IWC' },
  { bookmaker: 'pinnacle', open: 'PS', close: 'PSC' },
  { bookmaker: 'william_hill', open: 'WH', close: 'WHC' },
  { bookmaker: 'vc_bet', open: 'VC', close: 'VCC' },
  { bookmaker: 'market_max', open: 'Max', close: 'MaxC' },
  { bookmaker: 'market_avg', open: 'Avg', close: 'AvgC' },
] as const;

// Over/under 2.5 goals. Pinnacle's prefix is just "P" here (not "PS" like
// match-winner) -- that inconsistency is football-data.co.uk's own naming,
// not a typo.
const OVER_UNDER_BOOKMAKERS = [
  { bookmaker: 'bet365', open: 'B365', close: 'B365C' },
  { bookmaker: 'pinnacle', open: 'P', close: 'PC' },
  { bookmaker: 'market_max', open: 'Max', close: 'MaxC' },
  { bookmaker: 'market_avg', open: 'Avg', close: 'AvgC' },
] as const;

// Asian handicap. The line itself (AHh / AHCh) is shared across bookmakers
// in this dataset -- football-data.co.uk only records one handicap line per
// snapshot, not a per-bookmaker line.
const ASIAN_HANDICAP_BOOKMAKERS = [
  { bookmaker: 'bet365', open: 'B365AH', close: 'B365CAH' },
  { bookmaker: 'pinnacle', open: 'PAH', close: 'PCAH' },
  { bookmaker: 'market_max', open: 'MaxAH', close: 'MaxCAH' },
  { bookmaker: 'market_avg', open: 'AvgAH', close: 'AvgCAH' },
] as const;

interface CsvRow {
  [column: string]: string;
}

function num(row: CsvRow, col: string): number | undefined {
  const raw = row[col];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isNaN(value) ? undefined : value;
}

function parseKickoff(row: CsvRow): { at: Date; date: string } {
  const [d, m, y] = row.Date.split('/').map(Number);
  const year = y < 100 ? 2000 + y : y; // this dataset only has 4-digit years, but keep the guard cheap
  const [hh, mm] = (row.Time || '15:00').split(':').map(Number);
  const at = londonWallTimeToUtc(year, m, d, hh, mm);
  const date = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { at, date };
}

export interface FootballDataSeasonConfig {
  /** football-data.co.uk division code, e.g. 'E0' (Premier League), 'E1' (Championship) */
  div: string;
  competitionName: string;
  competitionType: 'league' | 'cup';
  /** e.g. '2324' for the 2023/24 season */
  seasonCode: string;
}

function seasonLabel(seasonCode: string): string {
  const startYear = Number(seasonCode.slice(0, 2));
  const endYear = Number(seasonCode.slice(2, 4));
  return `20${startYear}/${String(endYear).padStart(2, '0')}`;
}

function seasonDates(seasonCode: string): { start: string; end: string } {
  const startYear = 2000 + Number(seasonCode.slice(0, 2));
  const endYear = 2000 + Number(seasonCode.slice(2, 4));
  return { start: `${startYear}-08-01`, end: `${endYear}-06-30` };
}

async function downloadCsv(config: FootballDataSeasonConfig): Promise<string> {
  const url = `https://www.football-data.co.uk/mmz4281/${config.seasonCode}/${config.div}.csv`;
  const cachePath = new URL(`../raw/football-data-co-uk/${config.div}_${config.seasonCode}.csv`, import.meta.url).pathname;
  return fetchCached(cachePath, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`football-data.co.uk fetch failed: ${res.status} ${url}`);
    return res.text();
  });
}

export async function seedFootballDataSeason(pool: Pool, config: FootballDataSeasonConfig): Promise<void> {
  const csv = await downloadCsv(config);
  const rows: CsvRow[] = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });

  const competitionId = await getOrCreateCompetition(pool, config.competitionName, config.competitionType);
  const { start, end } = seasonDates(config.seasonCode);
  const seasonId = await getOrCreateSeason(pool, seasonLabel(config.seasonCode), start, end);
  const competitionSeasonId = await getOrCreateCompetitionSeason(pool, competitionId, seasonId);

  let wrongDivisionSkipped = 0;
  for (const row of rows) {
    if (!row.HomeTeam || !row.AwayTeam) continue; // trailing blank lines some seasons' CSVs have

    // Confirmed for real 2026-08-16: the current season's E0 (Premier
    // League) file contained a real row whose own Div column said "EC"
    // (Conference/National League) -- "Boston Utd vs Aldershot", two real
    // non-league clubs, ended up seeded as a Premier League fixture and
    // showed up in the actual PL table on the live site. Every row was
    // trusted to belong to whatever division this function was called for,
    // with no check against the row's own data. Rather than assume this
    // was a one-off and move on, guard against it structurally: skip (and
    // count) any row whose own Div doesn't match what we asked for.
    if (row.Div && row.Div !== config.div) {
      wrongDivisionSkipped++;
      continue;
    }

    const homeTeamId = await getOrCreateTeam(pool, canonicalTeamName(row.HomeTeam));
    const awayTeamId = await getOrCreateTeam(pool, canonicalTeamName(row.AwayTeam));
    const kickoff = parseKickoff(row);

    const fixtureId = await upsertFixture(pool, {
      competitionSeasonId,
      homeTeamId,
      awayTeamId,
      kickoffAt: kickoff.at,
      kickoffDate: kickoff.date,
      status: 'finished',
      homeScore: num(row, 'FTHG'),
      awayScore: num(row, 'FTAG'),
      homeScoreHt: num(row, 'HTHG'),
      awayScoreHt: num(row, 'HTAG'),
      referee: row.Referee || undefined,
    });

    await upsertFixtureTeamStatsBatch(pool, [
      {
        fixtureId,
        teamId: homeTeamId,
        isHome: true,
        shots: num(row, 'HS'),
        shotsOnTarget: num(row, 'HST'),
        corners: num(row, 'HC'),
        fouls: num(row, 'HF'),
        yellowCards: num(row, 'HY'),
        redCards: num(row, 'HR'),
      },
      {
        fixtureId,
        teamId: awayTeamId,
        isHome: false,
        shots: num(row, 'AS'),
        shotsOnTarget: num(row, 'AST'),
        corners: num(row, 'AC'),
        fouls: num(row, 'AF'),
        yellowCards: num(row, 'AY'),
        redCards: num(row, 'AR'),
      },
    ]);

    await upsertFixtureOddsBatch(pool, buildOddsRows(fixtureId, row));
  }

  if (wrongDivisionSkipped > 0) {
    console.log(`  ${config.div} ${config.seasonCode}: skipped ${wrongDivisionSkipped} row(s) whose own Div column didn't match ${config.div}.`);
  }
}

// Builds every odds row for one fixture in memory first (no DB calls) so
// the caller can write them all in a single batched INSERT -- see
// upsertFixtureOddsBatch's docstring for why that's safe (no two rows this
// builds can ever target the same conflict key).
function buildOddsRows(fixtureId: number, row: CsvRow): FixtureOddsInput[] {
  const rows: FixtureOddsInput[] = [];

  for (const { bookmaker, open, close } of MATCH_WINNER_BOOKMAKERS) {
    for (const [snapshotType, prefix] of [
      ['opening', open],
      ['closing', close],
    ] as const) {
      const home = num(row, `${prefix}H`);
      const draw = num(row, `${prefix}D`);
      const away = num(row, `${prefix}A`);
      if (home) rows.push({ fixtureId, bookmaker, market: 'match_winner', outcome: 'home', line: 0, price: home, snapshotType, source: 'football_data_co_uk' });
      if (draw) rows.push({ fixtureId, bookmaker, market: 'match_winner', outcome: 'draw', line: 0, price: draw, snapshotType, source: 'football_data_co_uk' });
      if (away) rows.push({ fixtureId, bookmaker, market: 'match_winner', outcome: 'away', line: 0, price: away, snapshotType, source: 'football_data_co_uk' });
    }
  }

  for (const { bookmaker, open, close } of OVER_UNDER_BOOKMAKERS) {
    for (const [snapshotType, prefix] of [
      ['opening', open],
      ['closing', close],
    ] as const) {
      const over = num(row, `${prefix}>2.5`);
      const under = num(row, `${prefix}<2.5`);
      if (over) rows.push({ fixtureId, bookmaker, market: 'over_under', outcome: 'over', line: 2.5, price: over, snapshotType, source: 'football_data_co_uk' });
      if (under) rows.push({ fixtureId, bookmaker, market: 'over_under', outcome: 'under', line: 2.5, price: under, snapshotType, source: 'football_data_co_uk' });
    }
  }

  const openLine = num(row, 'AHh');
  const closeLine = num(row, 'AHCh');
  for (const { bookmaker, open, close } of ASIAN_HANDICAP_BOOKMAKERS) {
    if (openLine !== undefined) {
      const home = num(row, `${open}H`);
      const away = num(row, `${open}A`);
      if (home) rows.push({ fixtureId, bookmaker, market: 'asian_handicap', outcome: 'home', line: openLine, price: home, snapshotType: 'opening', source: 'football_data_co_uk' });
      if (away) rows.push({ fixtureId, bookmaker, market: 'asian_handicap', outcome: 'away', line: openLine, price: away, snapshotType: 'opening', source: 'football_data_co_uk' });
    }
    if (closeLine !== undefined) {
      const home = num(row, `${close}H`);
      const away = num(row, `${close}A`);
      if (home) rows.push({ fixtureId, bookmaker, market: 'asian_handicap', outcome: 'home', line: closeLine, price: home, snapshotType: 'closing', source: 'football_data_co_uk' });
      if (away) rows.push({ fixtureId, bookmaker, market: 'asian_handicap', outcome: 'away', line: closeLine, price: away, snapshotType: 'closing', source: 'football_data_co_uk' });
    }
  }

  return rows;
}
