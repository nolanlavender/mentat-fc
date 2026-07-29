-- Up Migration

-- Normalized (one row per team per fixture) instead of home_x/away_x columns
-- on fixtures, so adding a new stat type later is a column here, not an
-- alter + a doubled column set on the fixtures table.
CREATE TABLE fixture_team_stats (
  id serial PRIMARY KEY,
  fixture_id integer NOT NULL REFERENCES fixtures (id) ON DELETE CASCADE,
  team_id integer NOT NULL REFERENCES teams (id),
  is_home boolean NOT NULL,
  shots integer,
  shots_on_target integer,
  corners integer,
  fouls integer,
  yellow_cards integer,
  red_cards integer,
  UNIQUE (fixture_id, team_id)
);

-- Down Migration

DROP TABLE fixture_team_stats;
