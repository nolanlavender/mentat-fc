-- Up Migration

-- Real bug found in production 2026-08-16: players.external_api_football_id
-- is a single column, but API-Football itself isn't one consistent id
-- space -- confirmed twice with real data, Bruno Fernandes (1485 via one
-- endpoint family, 459407 via another) and Reece James (19890 via
-- /fixtures/lineups and /fixtures/players, 19545 via /players/squads).
-- A flat column can only ever hold one of those, so any endpoint whose id
-- disagrees with whatever's already stored either needed a bespoke
-- name-scoped matcher (what upsertPlayerPhotoForTeam did for squads) or,
-- worse, silently created a duplicate row -- which is exactly the bug
-- fixed earlier the same day for FPL vs. API-Football's abbreviated names.
--
-- This table is the general fix: every (source, external_id) sighting
-- that ever gets resolved to a real player is recorded here, so future
-- sightings under that exact id resolve in one indexed lookup instead of
-- re-solving the same name-matching ambiguity every time. players.
-- external_fpl_id and players.external_api_football_id stay as-is (the
-- "primary"/first-linked id for each, used everywhere they already are --
-- no reason to touch working code that doesn't have this problem), and
-- this table is purely additive on top of them.
CREATE TABLE player_external_ids (
  id serial PRIMARY KEY,
  player_id integer NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  source text NOT NULL,
  external_id integer NOT NULL,
  UNIQUE (source, external_id)
);

CREATE INDEX player_external_ids_player_id_idx ON player_external_ids (player_id);

-- Backfill from the existing flat columns so every player already linked
-- keeps that exact same identity, just also recorded here. 'api_football'
-- matches the id space players.external_api_football_id has always used
-- (fixtures/lineups/player-stats/the bulk endpoint) -- 'api_football_squads'
-- (the separate id space /players/squads uses) gets populated going
-- forward as that endpoint is actually called, not backfilled here, since
-- the old flat column never distinguished which API-Football id space a
-- given value came from.
INSERT INTO player_external_ids (player_id, source, external_id)
SELECT id, 'fpl', external_fpl_id FROM players WHERE external_fpl_id IS NOT NULL;

INSERT INTO player_external_ids (player_id, source, external_id)
SELECT id, 'api_football', external_api_football_id FROM players WHERE external_api_football_id IS NOT NULL;

-- Down Migration

DROP TABLE player_external_ids;
