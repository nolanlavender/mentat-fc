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

// football-data.co.uk is a free, hobby-run site with no SLA (same
// reasoning already applied to the FPL API in docs/CLAUDE.md) -- and the
// current, in-progress season's CSV is the one most likely to not exist
// yet at all early in a season, rather than just being sparse. A fetch
// failure here used to crash the entire npm run db:seed run, sacrificing
// everything downstream (FA Cup, current-season fixture lists, the
// lineup/player-stats backfill) over one missing historical file that
// doesn't block any of that. Catches and logs per season/competition
// instead of per the whole function, so one bad file doesn't take out five
// good ones next to it.
async function seedHistoricalResultsAndOdds(): Promise<void> {
  for (const seasonCode of SEASON_CODES) {
    for (const { div, competitionName } of [
      { div: 'E0', competitionName: 'Premier League' },
      { div: 'E1', competitionName: 'Championship' },
    ] as const) {
      console.log(`Seeding ${competitionName} ${seasonCode} from football-data.co.uk...`);
      try {
        await seedFootballDataSeason(pool, { div, competitionName, competitionType: 'league', seasonCode });
      } catch (err) {
        console.log(
          `  Skipped ${competitionName} ${seasonCode}: ${err instanceof Error ? err.message : err} -- ` +
            `likely means this season's CSV doesn't exist on football-data.co.uk yet (common for the current, ` +
            `in-progress season early on). Continuing with the rest of the pipeline.`,
        );
      }
    }
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
export async function seedCurrentSeasonFixtureLists(): Promise<void> {
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

// Guarded so importing individual functions from this module (e.g.
// seed/current-season.ts importing seedCurrentSeasonFixtureLists) doesn't
// also trigger the full pipeline as a side effect of the import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
