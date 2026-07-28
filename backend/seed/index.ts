import { pool } from '../src/db/pool.js';
import { seedFootballDataSeason } from './sources/football-data-co-uk.js';
import { seedFplBootstrap } from './sources/fpl.js';
import {
  seedApiFootballFixtures,
  backfillLineupsForCompetitionSeason,
  BudgetExhaustedError,
} from './sources/api-football.js';
import { getOrCreateCompetition, getOrCreateSeason, getOrCreateCompetitionSeason } from './lib/db.js';

// Last 3 seasons as of today: 2023/24, 2024/25, 2025/26 (current, partial).
const SEASON_CODES = ['2324', '2425', '2526'];

// API-Football league IDs -- see the UNVERIFIED note in sources/api-football.ts.
// Confirm these against a real API response before relying on them.
const API_FOOTBALL_LEAGUE_IDS = {
  premierLeague: 39,
  championship: 40,
  faCup: 45,
};

async function seedHistoricalResultsAndOdds(): Promise<void> {
  for (const seasonCode of SEASON_CODES) {
    console.log(`Seeding Premier League ${seasonCode} from football-data.co.uk...`);
    await seedFootballDataSeason(pool, {
      div: 'E0',
      competitionName: 'Premier League',
      competitionType: 'league',
      seasonCode,
    });

    console.log(`Seeding Championship ${seasonCode} from football-data.co.uk...`);
    await seedFootballDataSeason(pool, {
      div: 'E1',
      competitionName: 'Championship',
      competitionType: 'league',
      seasonCode,
    });
  }
}

async function seedFaCupFixtures(): Promise<void> {
  if (!process.env.API_FOOTBALL_KEY) {
    console.log('Skipping FA Cup (API_FOOTBALL_KEY not set) -- football-data.co.uk has no cup coverage.');
    return;
  }
  const seasonYears = [2023, 2024, 2025]; // API-Football's season param, e.g. 2023 = '2023/24'
  for (const year of seasonYears) {
    console.log(`Seeding FA Cup ${year}/${String(year + 1).slice(2)} fixtures from API-Football...`);
    await seedApiFootballFixtures(pool, {
      competitionName: 'FA Cup',
      competitionType: 'cup',
      externalLeagueId: API_FOOTBALL_LEAGUE_IDS.faCup,
      seasonLabel: `${year}/${String(year + 1).slice(2)}`,
      externalSeasonYear: year,
      seasonStart: `${year}-08-01`,
      seasonEnd: `${year + 1}-06-30`,
    });
  }
}

async function backfillLineups(): Promise<void> {
  if (!process.env.API_FOOTBALL_KEY) {
    console.log('Skipping lineup backfill (API_FOOTBALL_KEY not set).');
    return;
  }

  const competitions: Array<{ name: string; type: 'league' | 'cup' }> = [
    { name: 'Premier League', type: 'league' },
    { name: 'Championship', type: 'league' },
    { name: 'FA Cup', type: 'cup' },
  ];

  for (const competition of competitions) {
    const competitionId = await getOrCreateCompetition(pool, competition.name, competition.type);
    for (const seasonCode of SEASON_CODES) {
      const label = `20${seasonCode.slice(0, 2)}/${seasonCode.slice(2, 4)}`;
      const seasonId = await getOrCreateSeason(pool, label, `20${seasonCode.slice(0, 2)}-08-01`, `20${seasonCode.slice(2, 4)}-06-30`);
      const competitionSeasonId = await getOrCreateCompetitionSeason(pool, competitionId, seasonId);

      try {
        const result = await backfillLineupsForCompetitionSeason(pool, competitionSeasonId);
        console.log(`${competition.name} ${label}: backfilled ${result.done} lineups, ${result.remaining} remaining.`);
        if (result.stoppedOnBudget) {
          console.log('Daily API-Football budget exhausted -- rerun tomorrow to continue.');
          return;
        }
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          console.log(err.message);
          return;
        }
        throw err;
      }
    }
  }
}

async function main(): Promise<void> {
  await seedHistoricalResultsAndOdds();
  await seedFplBootstrap(pool);
  await seedFaCupFixtures();
  await backfillLineups();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
