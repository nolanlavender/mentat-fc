import { pool } from '../src/db/pool.js';
import { seedApiFootballFixtures, seedApiFootballLineup } from './sources/api-football.js';

// Run this BEFORE trusting the full lineup backfill (npm run db:seed with
// API_FOOTBALL_KEY set). API-Football's 100/day free tier is confirmed, but
// whether it serves detailed lineups/statistics for seasons this old is not
// -- and if it doesn't, no amount of patient throttling fixes that; it's a
// "pay for depth" decision, not a "wait longer" one. Better to find out
// against one fixture than 1,500 fixtures into a backfill.
//
// Usage: npm run check:lineup-depth
async function main() {
  if (!process.env.API_FOOTBALL_KEY) {
    console.error('Set API_FOOTBALL_KEY in backend/.env first.');
    process.exit(1);
  }

  console.log('Fetching 2023/24 Premier League fixture list (1 API call, enriches already-seeded fixtures with external ids)...');
  await seedApiFootballFixtures(pool, {
    competitionName: 'Premier League',
    competitionType: 'league',
    externalLeagueId: 39, // unverified -- see the note in sources/api-football.ts
    seasonLabel: '2023/24',
    externalSeasonYear: 2023,
    seasonStart: '2023-08-01',
    seasonEnd: '2024-06-30',
  });

  const { rows } = await pool.query<{ id: number; external_api_football_id: number; kickoff_date: string }>(
    `SELECT f.id, f.external_api_football_id, f.kickoff_date
     FROM fixtures f
     JOIN competition_seasons cs ON cs.id = f.competition_season_id
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     WHERE c.name = 'Premier League' AND s.label = '2023/24' AND f.external_api_football_id IS NOT NULL
     ORDER BY f.kickoff_date ASC
     LIMIT 1`,
  );

  if (!rows[0]) {
    console.error('No 2023/24 fixture got an external_api_football_id -- the fixture-list call itself may have failed or the league/season ids are wrong.');
    process.exit(1);
  }

  console.log(`Testing lineup depth for fixture ${rows[0].id} (external id ${rows[0].external_api_football_id}, ${rows[0].kickoff_date})...`);
  await seedApiFootballLineup(pool, rows[0].external_api_football_id, rows[0].id);

  const lineupCount = await pool.query<{ count: string }>(`SELECT count(*) FROM fixture_lineups WHERE fixture_id = $1`, [rows[0].id]);
  const count = Number(lineupCount.rows[0].count);

  if (count > 0) {
    console.log(`GOOD: got ${count} lineup rows for a 2023/24 fixture. The free tier does serve historical lineups -- the throttled backfill plan holds.`);
  } else {
    console.log('EMPTY RESULT: the free tier returned no lineup data for this 2023/24 fixture.');
    console.log('This means the "wait longer" backfill plan does not work as designed -- stop and decide: pay for a higher tier, or scope lineups to the current season only.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
