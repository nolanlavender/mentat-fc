import { pool } from '../src/db/pool.js';

// Real question to answer before building anything around it, same
// principle as check-squads-endpoint.ts and check-bulk-fixtures-endpoint.ts
// -- and specifically the same discipline that saved us from shipping an
// xG blend built on a column nothing ever populated (see
// docs/learning-log.md's 2026-08-19 entry):
//
//   Does GET /fixtures/statistics actually return shot-LOCATION counts
//   ("Shots insidebox" / "Shots outsidebox"), and does it return them for
//   OLD fixtures, not just recent ones?
//
// Why it matters: fixture_team_stats today is populated exclusively by
// football-data.co.uk's CSV (see football-data-co-uk.ts -- HS/HST/HF/HC),
// which has no shot-location columns at all. Inside-box shots convert at a
// far higher rate than outside-box ones, so splitting them is the closest
// thing to real xG available to this project -- but only if the data
// exists across the 3 seasons the model actually fits on. A stat that only
// exists for the current season is close to useless for training.
//
// So this samples THREE fixtures deliberately spread across the oldest,
// middle and newest finished matches on record, and prints every stat type
// each one returns. If shot-location is present in all three, the backfill
// is worth building. If it's only in the newest, that's a scope decision to
// make deliberately, not discover 2,000 API calls in.
//
// Costs 3 API calls. Read-only -- writes nothing to the database.
//
// Usage: npm run check:statistics-endpoint

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

interface SampleFixture {
  id: number;
  external_api_football_id: number;
  kickoff_date: string;
  home_team: string;
  away_team: string;
  season_label: string;
}

async function main(): Promise<void> {
  // Oldest / middle / newest finished fixture that actually has an
  // API-Football id -- a fixture seeded only from the CSV has no id to call
  // the statistics endpoint with, so those can't be sampled at all.
  const { rows } = await pool.query<SampleFixture>(
    `WITH linked AS (
       SELECT f.id, f.external_api_football_id, f.kickoff_date::text,
              ht.name AS home_team, at.name AS away_team, s.label AS season_label,
              row_number() OVER (ORDER BY f.kickoff_date) AS oldest_first,
              count(*) OVER () AS total
       FROM fixtures f
       JOIN teams ht ON ht.id = f.home_team_id
       JOIN teams at ON at.id = f.away_team_id
       JOIN competition_seasons cs ON cs.id = f.competition_season_id
       JOIN seasons s ON s.id = cs.season_id
       WHERE f.status = 'finished' AND f.external_api_football_id IS NOT NULL
     )
     SELECT id, external_api_football_id, kickoff_date, home_team, away_team, season_label
     FROM linked
     WHERE oldest_first IN (1, (total / 2)::bigint, total)
     ORDER BY kickoff_date`,
  );

  if (rows.length === 0) {
    console.error('No finished fixtures with an external_api_football_id -- run the fixture seed first, then rerun this check.');
    process.exit(1);
  }

  console.log(`Sampling ${rows.length} fixture(s) spread across the data's full date range.\n`);

  const typesSeen = new Map<string, number>();

  for (const fixture of rows) {
    console.log(`--- ${fixture.kickoff_date} (${fixture.season_label}): ${fixture.home_team} vs ${fixture.away_team} ---`);
    const data = await callApi(`/fixtures/statistics?fixture=${fixture.external_api_football_id}`);

    const teamBlocks: any[] = data.response ?? [];
    if (teamBlocks.length === 0) {
      console.log('  NO STATISTICS RETURNED for this fixture (empty response array).');
      if (data.errors && Object.keys(data.errors).length > 0) console.log('  errors:', JSON.stringify(data.errors));
      console.log('');
      continue;
    }

    for (const block of teamBlocks) {
      const stats: Array<{ type: string; value: unknown }> = block.statistics ?? [];
      console.log(`  ${block.team?.name}: ${stats.length} stat types`);
      for (const { type, value } of stats) {
        typesSeen.set(type, (typesSeen.get(type) ?? 0) + 1);
        console.log(`    ${type} = ${value === null ? 'null' : value}`);
      }
    }
    console.log('');
  }

  // The actual verdict, called out explicitly rather than left for the
  // reader to spot in the dump above.
  console.log('=== Verdict ===');
  const wanted = ['Shots insidebox', 'Shots outsidebox'];
  for (const type of wanted) {
    const count = typesSeen.get(type) ?? 0;
    console.log(count > 0 ? `  FOUND "${type}" in ${count} team block(s)` : `  MISSING "${type}" -- not returned by this endpoint`);
  }
  console.log('\nAll stat types seen across every sampled fixture:');
  for (const [type, count] of [...typesSeen.entries()].sort()) console.log(`  ${type} (${count})`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
