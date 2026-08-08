import { pool } from '../src/db/pool.js';
import { seedFootballDataSeason } from './sources/football-data-co-uk.js';
import { seedFplBootstrap, seedFplPlayerGameweekHistory } from './sources/fpl.js';
import {
  seedApiFootballFixtures,
  backfillLineupsForCompetitionSeason,
  BudgetExhaustedError,
} from './sources/api-football.js';
import { getOrCreateCompetition, getOrCreateSeason, getOrCreateCompetitionSeason } from './lib/db.js';

// Last 3 completed seasons plus the current one: 2023/24, 2024/25, 2025/26
// (now complete), 2026/27 (current, partial). football-data.co.uk's CSV for
// a season in progress only ever contains matches already played -- it has
// no concept of a future fixture -- so this alone can't give app.train
// anything to predict. See seedCurrentSeasonFixtureLists for the piece that
// actually pulls the full schedule, including matches that haven't happened
// yet.
const SEASON_CODES = ['2324', '2425', '2526', '2627'];

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

/**
 * Pulls the *full* current-season fixture list for Premier League and
 * Championship from API-Football -- including fixtures that haven't been
 * played yet. This is the piece football-data.co.uk structurally can't
 * provide (its CSVs only ever contain results for matches already played),
 * and it's what gives app.train (model-service) actual upcoming fixtures to
 * predict. Upserts against the same natural key as the football-data.co.uk
 * importer, so this enriches already-seeded played matches (adding
 * venue/referee/external id) and adds new rows for anything still to come.
 *
 * Safe to rerun any time (e.g. weekly) to pick up newly-scheduled fixtures
 * and mark newly-finished ones -- there's no scheduled job wired up for that
 * yet (see docs/PHASES.md's Phase 2 "recurring refresh job" item), so for
 * now this just runs as part of a manual `npm run db:seed`.
 */
async function seedCurrentSeasonFixtureLists(): Promise<void> {
  if (!process.env.API_FOOTBALL_KEY) {
    console.log(
      'Skipping current-season fixture lists (API_FOOTBALL_KEY not set) -- ' +
        'football-data.co.uk has no upcoming (unplayed) fixtures, so app.train will have nothing to predict without this.',
    );
    return;
  }

  const currentSeasonCode = SEASON_CODES[SEASON_CODES.length - 1];
  const seasonLabel = `20${currentSeasonCode.slice(0, 2)}/${currentSeasonCode.slice(2, 4)}`;
  const externalSeasonYear = Number(`20${currentSeasonCode.slice(0, 2)}`);

  const leagues: Array<{ name: string; externalLeagueId: number }> = [
    { name: 'Premier League', externalLeagueId: API_FOOTBALL_LEAGUE_IDS.premierLeague },
    { name: 'Championship', externalLeagueId: API_FOOTBALL_LEAGUE_IDS.championship },
  ];

  for (const league of leagues) {
    console.log(`Seeding ${league.name} ${seasonLabel} fixture list (incl. upcoming) from API-Football...`);
    await seedApiFootballFixtures(pool, {
      competitionName: league.name,
      competitionType: 'league',
      externalLeagueId: league.externalLeagueId,
      seasonLabel,
      externalSeasonYear,
      seasonStart: `${externalSeasonYear}-08-01`,
      seasonEnd: `${externalSeasonYear + 1}-06-30`,
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
    console.log('Skipping lineup + player-stats backfill (API_FOOTBALL_KEY not set).');
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
        console.log(`${competition.name} ${label}: backfilled ${result.done} fixtures (lineups + player stats), ${result.remaining} remaining.`);
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
  await seedCurrentSeasonFixtureLists();
  await seedFplBootstrap(pool);

  console.log('Seeding FPL per-gameweek player stats (one call per player, throttled)...');
  const gwHistoryResult = await seedFplPlayerGameweekHistory(pool);
  console.log(`FPL per-gameweek stats: ${gwHistoryResult.done} players done, ${gwHistoryResult.skipped} skipped (fetch errors).`);

  await seedFaCupFixtures();
  await backfillLineups();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
