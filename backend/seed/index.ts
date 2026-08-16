import { pool } from '../src/db/pool.js';
import { seedFootballDataSeason } from './sources/football-data-co-uk.js';
import { seedFplBootstrap, seedFplPlayerGameweekHistory } from './sources/fpl.js';
import {
  seedApiFootballFixtures,
  seedApiFootballTeamSquadPhotos,
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

// API-Football's season param, e.g. 2023 = '2023/24'. Shared with
// backfillTeamLogos below so both loop over the exact same FA Cup seasons.
const FA_CUP_SEASON_YEARS = [2023, 2024, 2025];

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
  for (const year of FA_CUP_SEASON_YEARS) {
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

/**
 * Standalone, fast path to (re-)capture team crest URLs -- for
 * `npm run db:seed:logos`, exported so seed/backfill-logos.ts can run just
 * this on its own. Deliberately NOT the full `npm run db:seed` (which can
 * run over an hour, almost all of it the per-fixture lineup/player-stats
 * backfill in backfillLineups below): team logos only ever come from the
 * fixtures-list response, the cheap call every full seed already makes
 * once per competition-season, so this just replays that call.
 *
 * Current season only, not every historical season -- a team's crest is
 * effectively static, so the only real reason to look at older seasons at
 * all is to catch a team that's since dropped out of PL/Championship
 * entirely (relegated below the Championship, or a one-off FA Cup
 * minnow), and that's a small enough gap to accept in exchange for this
 * running in a handful of calls instead of the 11 a full historical sweep
 * needs. Rerun `npm run db:seed` (or manually call seedApiFootballFixtures
 * for older seasons) if a specific historical team's logo is ever needed.
 *
 * On a machine that's already run a full seed before, this costs zero new
 * API-Football requests: the current season's fixture-list response is
 * already sitting in the on-disk cache (backend/seed/raw/api-football/
 * fixtures/*.json -- see lib/cache.ts's fetch-if-absent behavior), so this
 * is just re-reading cached JSON and upserting teams.logo_url for whichever
 * teams don't have one yet (getOrCreateTeam's COALESCE means teams that
 * already have a logo are untouched).
 */
export async function backfillTeamLogos(): Promise<void> {
  if (!process.env.API_FOOTBALL_KEY) {
    throw new Error('API_FOOTBALL_KEY is not set -- required to pull team logos from API-Football.');
  }

  const currentSeasonCode = SEASON_CODES[SEASON_CODES.length - 1];
  const seasonLabel = `20${currentSeasonCode.slice(0, 2)}/${currentSeasonCode.slice(2, 4)}`;
  const externalSeasonYear = Number(`20${currentSeasonCode.slice(0, 2)}`);

  const leagues: Array<{ name: string; externalLeagueId: number }> = [
    { name: 'Premier League', externalLeagueId: API_FOOTBALL_LEAGUE_IDS.premierLeague },
    { name: 'Championship', externalLeagueId: API_FOOTBALL_LEAGUE_IDS.championship },
  ];

  for (const league of leagues) {
    console.log(`Pulling ${league.name} ${seasonLabel} fixtures (for team logos)...`);
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

  const currentFaCupYear = FA_CUP_SEASON_YEARS[FA_CUP_SEASON_YEARS.length - 1];
  console.log(`Pulling FA Cup ${currentFaCupYear}/${String(currentFaCupYear + 1).slice(2)} fixtures (for team logos)...`);
  await seedApiFootballFixtures(pool, {
    competitionName: 'FA Cup',
    competitionType: 'cup',
    externalLeagueId: API_FOOTBALL_LEAGUE_IDS.faCup,
    seasonLabel: `${currentFaCupYear}/${String(currentFaCupYear + 1).slice(2)}`,
    externalSeasonYear: currentFaCupYear,
    seasonStart: `${currentFaCupYear}-08-01`,
    seasonEnd: `${currentFaCupYear + 1}-06-30`,
  });

  const { rows } = await pool.query<{ total: string; with_logo: string }>(
    `SELECT count(*) AS total, count(logo_url) AS with_logo FROM teams`,
  );
  console.log(`Done: ${rows[0].with_logo}/${rows[0].total} teams now have a logo_url.`);
}

/**
 * Standalone, bounded-cost path to capture player headshots -- for
 * `npm run db:seed:photos`, exported so seed/backfill-photos.ts can run
 * just this on its own. Uses GET /players/squads?team={id} (confirmed for
 * real 2026-08-16, see seedApiFootballTeamSquadPhotos's own comment): one
 * call per team, full current roster, photo on every player. Replaces the
 * old /players?league=&season= pagination approach, which had to page
 * through an entire league's player-STATS list (~25-35 pages) to find the
 * same players -- real production coverage after that approach was only
 * 57/573 rostered players, consistent with the pull dying partway through
 * those pages rather than the data not existing.
 *
 * Teams without a linked external_api_football_id yet (see
 * getOrCreateTeam's comment on that column) simply can't be queried by
 * this endpoint and are skipped with a warning -- run `npm run
 * db:seed:current-season` first if that count is ever non-zero.
 *
 * Current season only, same reasoning as backfillTeamLogos above: this is
 * about getting headshots for the squads actually playing right now, not
 * an exhaustive historical sweep. Nothing here touches which team a player
 * is "on" (players.current_team_id stays FPL's alone to set, see
 * lib/db.ts's setPlayerCurrentTeam) -- this only ever enriches photo_url.
 */
export async function backfillPlayerPhotos(): Promise<void> {
  if (!process.env.API_FOOTBALL_KEY) {
    throw new Error('API_FOOTBALL_KEY is not set -- required to pull player photos from API-Football.');
  }

  const currentSeasonCode = SEASON_CODES[SEASON_CODES.length - 1];
  const seasonLabel = `20${currentSeasonCode.slice(0, 2)}/${currentSeasonCode.slice(2, 4)}`;

  const leagues: Array<{ name: string }> = [{ name: 'Premier League' }, { name: 'Championship' }];

  let totalPlayersSeen = 0;
  for (const league of leagues) {
    const { rows: teams } = await pool.query<{ id: number; name: string; external_api_football_id: number | null }>(
      `SELECT DISTINCT t.id, t.name, t.external_api_football_id
       FROM teams t
       JOIN fixtures f ON f.home_team_id = t.id OR f.away_team_id = t.id
       JOIN competition_seasons cs ON cs.id = f.competition_season_id
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons s ON s.id = cs.season_id
       WHERE c.name = $1 AND s.label = $2
       ORDER BY t.name`,
      [league.name, seasonLabel],
    );

    const linked = teams.filter((t) => t.external_api_football_id !== null);
    const unlinked = teams.length - linked.length;
    console.log(`Pulling ${league.name} ${seasonLabel} squad photos from API-Football (${linked.length}/${teams.length} team(s) linked)...`);
    if (unlinked > 0) {
      console.log(`  ${unlinked} team(s) have no external_api_football_id yet -- run npm run db:seed:current-season first to link them.`);
    }

    for (const team of linked) {
      const result = await seedApiFootballTeamSquadPhotos(pool, team.id, team.external_api_football_id!);
      console.log(`  ${team.name}: ${result.playersSeen} player(s) seen.`);
      totalPlayersSeen += result.playersSeen;
    }
  }

  const { rows } = await pool.query<{ total: string; with_photo: string }>(
    `SELECT count(*) AS total, count(photo_url) AS with_photo FROM players WHERE current_team_id IS NOT NULL`,
  );
  console.log(
    `Done: ${rows[0].with_photo}/${rows[0].total} rostered players now have a photo_url (${totalPlayersSeen} squad entries processed).`,
  );
}

/**
 * One-time catch-up, discovered for real 2026-08-15 by a verification
 * query showing 5 of 7 historical competition-seasons with zero backfill
 * candidates -- not "0 remaining because done", but "external_api_football_id
 * was never set on a single one of these fixtures". seedApiFootballFixtures
 * (the only thing that sets it) was only ever called for the *current*
 * season (seedCurrentSeasonFixtureLists) and FA Cup (seedFaCupFixtures) --
 * Premier League 2024/25, 2025/26 and all 3 Championship historical seasons
 * were seeded purely from football-data.co.uk CSVs, which have no concept
 * of an API-Football id at all. Without this, backfillLineupsForCompetitionSeason
 * can never see those fixtures as candidates, no matter how many times it
 * runs -- this isn't a data-availability gap like FA Cup's lower rounds,
 * it's a real pipeline gap.
 *
 * Idempotent and cache-backed exactly like every other seedApiFootballFixtures
 * call (upserts against the same natural key football-data.co.uk already
 * used, enriching those rows rather than duplicating them), so it's SAFE to
 * leave in the regular pipeline permanently -- but not free. Discovered
 * while sizing up the daily-refresh job: each of these 6 calls re-upserts
 * an entire season's fixture list (380-552 rows) every single time it
 * runs, even once a season is fully linked and will never change again --
 * ~2,700 pointless DB round-trips on every daily run, forever, for
 * seasons that are done. A cheap EXISTS check per season skips the whole
 * fetch+upsert once nothing is left to link, so daily reruns cost 6 fast
 * SELECTs instead of 6 full-season upserts.
 */
async function linkHistoricalSeasonsToApiFootball(): Promise<void> {
  if (!process.env.API_FOOTBALL_KEY) return; // already logged by the caller

  const historicalSeasonCodes = SEASON_CODES.slice(0, -1); // exclude current -- seedCurrentSeasonFixtureLists's job, refreshed every run
  const leagues: Array<{ name: string; externalLeagueId: number }> = [
    { name: 'Premier League', externalLeagueId: API_FOOTBALL_LEAGUE_IDS.premierLeague },
    { name: 'Championship', externalLeagueId: API_FOOTBALL_LEAGUE_IDS.championship },
  ];

  for (const seasonCode of historicalSeasonCodes) {
    const seasonLabel = `20${seasonCode.slice(0, 2)}/${seasonCode.slice(2, 4)}`;
    const externalSeasonYear = Number(`20${seasonCode.slice(0, 2)}`);
    for (const league of leagues) {
      const competitionId = await getOrCreateCompetition(pool, league.name, 'league', league.externalLeagueId);
      const seasonId = await getOrCreateSeason(pool, seasonLabel, `${externalSeasonYear}-08-01`, `${externalSeasonYear + 1}-06-30`);
      const competitionSeasonId = await getOrCreateCompetitionSeason(pool, competitionId, seasonId, externalSeasonYear);

      const { rows } = await pool.query<{ still_missing: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM fixtures WHERE competition_season_id = $1 AND external_api_football_id IS NULL) AS still_missing`,
        [competitionSeasonId],
      );
      if (!rows[0].still_missing) continue; // already fully linked -- nothing to do, don't re-upsert a whole season for no reason

      console.log(`Linking ${league.name} ${seasonLabel} fixtures to API-Football (attaching external ids for the lineup backfill)...`);
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
}

/**
 * Exported so seed/backfill-lineups.ts can run just this stage on its own.
 * "Resume where it stopped" doesn't need a saved position or a --from flag:
 * backfillLineupsForCompetitionSeason (sources/api-football.ts) always
 * re-queries the DB for fixtures still missing lineups/player stats, so
 * calling this again after any crash -- API-Football flakiness, a dropped
 * DB connection, anything -- naturally skips everything already written
 * and continues from there. The DB itself is the checkpoint.
 */
export async function backfillLineups(): Promise<void> {
  if (!process.env.API_FOOTBALL_KEY) {
    console.log('Skipping lineup + player-stats backfill (API_FOOTBALL_KEY not set).');
    return;
  }

  await linkHistoricalSeasonsToApiFootball();

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
