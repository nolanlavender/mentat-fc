import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pool } from '../src/db/pool.js';

// Real question to answer before building anything around it, same
// principle as check-lineup-depth.ts and check-bulk-fixtures-endpoint.ts:
// does GET /players/squads?team={id} actually return a team's current
// roster with a photo per player, in one call, no season/pagination
// needed? If so, it's a far better fit for "get current-roster photos"
// than the current seedApiFootballPlayerPhotosForSeason, which has to
// page through an entire league's player-STATS list (~25-35 pages) to
// find the same players -- real production coverage after that approach
// was only 57/573 rostered players, consistent with the pull dying
// partway through those pages rather than actually being unable to find
// the data.
//
// Usage: npm run check:squads-endpoint

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

async function main(): Promise<void> {
  const { rows } = await pool.query<{ id: number; name: string; external_api_football_id: number }>(
    `SELECT id, name, external_api_football_id FROM teams WHERE name = 'Chelsea'`,
  );
  const chelsea = rows[0];
  if (!chelsea || !chelsea.external_api_football_id) {
    console.error(
      "Chelsea's row is missing an external_api_football_id -- run the fixture-list seed first so teams get linked, then rerun this check.",
    );
    process.exit(1);
  }

  console.log(`Calling /players/squads?team=${chelsea.external_api_football_id} (Chelsea) ...`);
  const data = await callApi(`/players/squads?team=${chelsea.external_api_football_id}`);

  const outDir = new URL('raw/api-football/', import.meta.url).pathname;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}squads-check.json`;
  writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`Full raw response saved to ${outPath}.`);

  const first = data.response?.[0];
  if (!first || !Array.isArray(first.players)) {
    console.log('EMPTY or unexpected shape -- open the saved JSON and check what actually came back.');
    await pool.end();
    return;
  }

  const players: Array<{ id: number; name: string; photo?: string | null }> = first.players;
  const withPhoto = players.filter((p) => !!p.photo).length;

  console.log(`\nSquad size returned: ${players.length}`);
  console.log(`Players with a photo field populated: ${withPhoto}/${players.length}`);
  console.log(`\nFirst 3 entries:`);
  console.log(JSON.stringify(players.slice(0, 3), null, 2));

  if (players.length >= 20 && withPhoto === players.length) {
    console.log(
      '\nGOOD: one call returned the full current squad with a photo on every player. ' +
        'This is a strong candidate to replace/supplement seedApiFootballPlayerPhotosForSeason -- ' +
        'send this output back before wiring it in so field names can be matched exactly.',
    );
  } else if (players.length >= 20 && withPhoto > 0) {
    console.log(
      `\nPARTIAL: got the full squad but only ${withPhoto}/${players.length} have a photo -- ` +
        'still likely useful, but not a complete fix on its own. Send this output back.',
    );
  } else {
    console.log(
      '\nNOT WHAT WAS EXPECTED -- squad size or photo coverage looks off. Send this output back before building anything around it.',
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
