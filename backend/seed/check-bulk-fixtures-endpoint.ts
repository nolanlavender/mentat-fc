import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pool } from '../src/db/pool.js';

// Two real questions to answer with real API calls before trusting either
// answer, same principle as check-lineup-depth.ts:
//
// 1. Does GET /fixtures?ids=id-id-id... actually return embedded lineups/
//    players/statistics/events, the way the docs' prose claims but doesn't
//    show the expanded JSON for? If true, this replaces ~2 calls/fixture
//    (separate /fixtures/lineups + /fixtures/players calls) with roughly
//    1 call per 20 fixtures -- a ~40x reduction in the backfill's API
//    volume. Worth confirming before rewriting the backfill around it.
// 2. Does the Championship (league id 40) actually have lineups/
//    statistics_players coverage on this account's plan, per the
//    `coverage` field on GET /leagues -- not just "the league exists,"
//    which tells you nothing about whether the detailed endpoints have
//    real data for it.
//
// Usage: npx tsx seed/check-bulk-fixtures-endpoint.ts

const API_BASE = 'https://v3.football.api-sports.io';

function apiFootballKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY is not set -- required for this check');
  return key;
}

async function callApi(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'x-apisports-key': apiFootballKey() } });
  if (!res.ok) throw new Error(`API-Football request failed: ${res.status} ${path}`);
  return res.json();
}

async function checkLeagueCoverage(leagueId: number, leagueName: string, season: number): Promise<void> {
  const data = await callApi(`/leagues?id=${leagueId}&season=${season}`);
  const coverage = data.response?.[0]?.seasons?.find((s: any) => s.year === season)?.coverage;
  console.log(`\n${leagueName} (id=${leagueId}) ${season} coverage:`);
  console.log(JSON.stringify(coverage, null, 2));
}

async function checkBulkFixturesEndpoint(): Promise<void> {
  // Premier League specifically, not "earliest fixture in the whole DB" --
  // that first attempt picked FA Cup Extra Preliminary Round fixtures
  // between non-league clubs (the earliest matches by date across every
  // competition), which API-Football almost certainly never tracks
  // detailed lineups for regardless of endpoint. A fair test needs
  // fixtures from a competition/tier already confirmed to have real depth
  // (see check-lineup-depth.ts's result).
  const { rows } = await pool.query<{ external_api_football_id: number }>(
    `SELECT f.external_api_football_id
     FROM fixtures f
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     WHERE c.name = 'Premier League' AND f.external_api_football_id IS NOT NULL
     ORDER BY f.kickoff_date ASC
     LIMIT 5`,
  );
  if (rows.length === 0) {
    console.log(
      '\nNo Premier League fixtures with an external_api_football_id in this database yet -- ' +
        'run check:lineup-depth or a fixture-list seed first.',
    );
    return;
  }

  const ids = rows.map((r) => r.external_api_football_id).join('-');
  console.log(`\nCalling /fixtures?ids=${ids} ...`);
  const data = await callApi(`/fixtures?ids=${ids}`);

  const outDir = new URL('raw/api-football/', import.meta.url).pathname;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}bulk-fixtures-check.json`;
  writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`Full raw response saved to ${outPath} -- open it and look at the first entry.`);

  const first = data.response?.[0];
  if (!first) {
    console.log('EMPTY response -- something is wrong with the ids or the call itself.');
    return;
  }

  const topLevelKeys = Object.keys(first);
  console.log(`\nTop-level keys on the first fixture object: ${topLevelKeys.join(', ')}`);

  const hasLineups = 'lineups' in first && Array.isArray(first.lineups) && first.lineups.length > 0;
  const hasPlayers = 'players' in first && Array.isArray(first.players) && first.players.length > 0;
  const hasStatistics = 'statistics' in first && Array.isArray(first.statistics) && first.statistics.length > 0;
  const hasEvents = 'events' in first && Array.isArray(first.events) && first.events.length > 0;

  console.log(`Embedded lineups present:   ${hasLineups}`);
  console.log(`Embedded players present:   ${hasPlayers}`);
  console.log(`Embedded statistics present: ${hasStatistics}`);
  console.log(`Embedded events present:    ${hasEvents}`);

  if (hasLineups && hasPlayers) {
    console.log(
      '\nGOOD: the bulk ids= endpoint really does embed lineups + player stats. ' +
        'This means the backfill can be rewritten to use this instead of two separate ' +
        'per-fixture calls -- real ~40x reduction in API volume. Send the saved JSON file ' +
        'back so the exact field shapes can be matched precisely before rewriting anything.',
    );
  } else {
    console.log(
      '\nNOT CONFIRMED: the bulk endpoint did not return embedded lineups/players the way the ' +
        'docs prose implied. Stick with the current two-calls-per-fixture approach -- send the ' +
        'saved JSON file back so we can see what actually came back instead.',
    );
  }
}

async function main(): Promise<void> {
  await checkLeagueCoverage(39, 'Premier League', 2023);
  await checkLeagueCoverage(40, 'Championship', 2023);
  await checkBulkFixturesEndpoint();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
