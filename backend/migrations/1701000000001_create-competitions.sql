-- Up Migration

CREATE TABLE competitions (
  id serial PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('league', 'cup')),
  external_api_football_league_id integer UNIQUE
);

-- Down Migration

DROP TABLE competitions;
