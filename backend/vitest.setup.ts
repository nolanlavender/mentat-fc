// bets.service.ts (and anything else importing src/db/pool.ts) reads
// DATABASE_URL/JWT_SECRET at import time via src/config/env.ts's
// requireEnv, even though the pure business-logic functions under test
// here never actually touch the DB. Dummy values are enough -- pg's Pool
// doesn't open a real connection until a query runs, and these tests never
// run one.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret';
