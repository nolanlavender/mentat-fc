import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Fetch-if-absent: the 100-request/day API-Football free tier and repeated
// football-data.co.uk downloads are a scarce resource, not just a dev-loop
// annoyance. Every source module reads through this instead of calling
// fetch() directly, so resetting Postgres and rerunning the seed never
// re-spends that budget on data we already have on disk.
export async function fetchCached(cachePath: string, fetcher: () => Promise<string>): Promise<string> {
  if (existsSync(cachePath)) {
    return readFileSync(cachePath, 'utf-8');
  }
  const data = await fetcher();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, data, 'utf-8');
  return data;
}
