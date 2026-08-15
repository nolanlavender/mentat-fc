import { Pool } from 'pg';
import { env } from '../config/env.js';

// keepAlive sends periodic TCP-level pings on idle connections. Without it,
// a connection that sits unused for a while (e.g. the seed pipeline
// sleeping through an API-Football rate-limit backoff between DB writes)
// can get silently closed by Neon's pooler or an intermediate network hop
// -- the socket just goes away with no error until the next query tries to
// use it, surfacing as "Connection terminated unexpectedly". keepAlive
// doesn't prevent every possible disconnect (a real backfillLineupsForCompetitionSeason
// retry in sources/api-football.ts still handles that), but it removes the
// most common cause of one.
export const pool = new Pool({ connectionString: env.databaseUrl, keepAlive: true });
