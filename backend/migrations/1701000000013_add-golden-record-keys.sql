-- Up Migration

-- Deterministic "golden record" keys: any source can compute the same key
-- from the same normalized identity attributes and land on the same row,
-- instead of a name-lookup-and-hope-it-matches step. GENERATED ... STORED
-- means Postgres maintains it automatically from the row's own columns --
-- it can never drift out of sync with a hash computed separately in
-- application code.
--
-- md5(), not pgcrypto's sha256 digest(): Postgres requires a generated
-- column's expression to be IMMUTABLE, and pgcrypto's digest() isn't marked
-- as such (confirmed by testing this migration -- it fails with "generation
-- expression is not immutable"). Built-in md5() is immutable and sufficient
-- here: this is a determinism/matching key, not a security control, so
-- collision-resistance strength beyond md5() buys nothing (the same
-- reasoning tools like dbt's surrogate-key macro use).

-- Teams: name alone disambiguates cleanly at Premier League/Championship/FA
-- Cup scale, and unlike a stadium or ground name it never changes for
-- sponsorship reasons. (For a single-attribute key like this, a plain
-- unique index on the normalized name would do the identical job --
-- it's hashed here mainly for a consistent "natural_key" pattern with
-- players' composite key below, not because a team name specifically
-- needs hashing.)
ALTER TABLE teams ADD COLUMN natural_key text GENERATED ALWAYS AS (
  md5(lower(trim(name)))
) STORED;
ALTER TABLE teams ADD CONSTRAINT teams_natural_key_key UNIQUE (natural_key);

-- Players: full name + date of birth is a genuinely stable composite
-- identity -- unlike position (not a fixed attribute, and doesn't
-- disambiguate two same-name players anyway). date_of_birth is coalesced to
-- '' when unknown, which is the common case for a player only seen so far
-- via API-Football's lineup endpoint (name + shirt number, no birth date --
-- that requires a separate per-player profile call this project doesn't
-- budget for). See seed/lib/db.ts's upsertPlayerGoldenRecord for how a
-- DOB-less sighting is still reconciled against an existing name match
-- before falling back to inserting under this key.
--
-- date_of_birth is folded in as an integer day-offset from a fixed epoch,
-- not date_of_birth::text -- casting a date to text depends on the
-- session's DateStyle setting, which disqualifies it from a STORED
-- generated column (confirmed by testing: Postgres rejects it as "not
-- immutable"). Date arithmetic against a literal date is immutable.
ALTER TABLE players ADD COLUMN natural_key text GENERATED ALWAYS AS (
  md5(lower(trim(full_name)) || '|' || coalesce((date_of_birth - date '1970-01-01')::text, ''))
) STORED;
ALTER TABLE players ADD CONSTRAINT players_natural_key_key UNIQUE (natural_key);

-- Down Migration

ALTER TABLE players DROP CONSTRAINT players_natural_key_key;
ALTER TABLE players DROP COLUMN natural_key;
ALTER TABLE teams DROP CONSTRAINT teams_natural_key_key;
ALTER TABLE teams DROP COLUMN natural_key;
