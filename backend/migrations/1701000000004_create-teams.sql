-- Up Migration

-- Global, not scoped to a competition/season: the same team plays across
-- competitions and moves between Premier League and Championship via
-- promotion/relegation.
CREATE TABLE teams (
  id serial PRIMARY KEY,
  name text NOT NULL,
  short_name text,
  external_api_football_id integer UNIQUE,
  external_fpl_id integer UNIQUE
);

-- Down Migration

DROP TABLE teams;
