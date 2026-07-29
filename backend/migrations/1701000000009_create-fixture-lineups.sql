-- Up Migration

-- No minutes_played in Phase 1: API-Football serves that from a separate
-- per-fixture statistics endpoint, which would double the free-tier lineup
-- backfill (100 requests/day) for no Phase 1 payoff. Add it in Phase 7
-- alongside goal/card event data, when the goal-scorer model actually needs it.
CREATE TABLE fixture_lineups (
  id serial PRIMARY KEY,
  fixture_id integer NOT NULL REFERENCES fixtures (id) ON DELETE CASCADE,
  team_id integer NOT NULL REFERENCES teams (id),
  player_id integer NOT NULL REFERENCES players (id),
  is_starting boolean NOT NULL,
  shirt_number integer,
  position text,
  UNIQUE (fixture_id, player_id)
);

CREATE INDEX fixture_lineups_fixture_id_idx ON fixture_lineups (fixture_id);
CREATE INDEX fixture_lineups_player_id_idx ON fixture_lineups (player_id);

-- Down Migration

DROP TABLE fixture_lineups;
