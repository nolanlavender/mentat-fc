-- Up Migration

-- Two separate nullable external-id columns because FPL and API-Football use
-- unrelated ID systems for the same real person -- matching them is a real
-- entity-resolution problem the seed scripts handle, not something the schema
-- can guarantee automatically.
CREATE TABLE players (
  id serial PRIMARY KEY,
  full_name text NOT NULL,
  date_of_birth date,
  nationality text,
  position text,
  external_api_football_id integer UNIQUE,
  external_fpl_id integer UNIQUE
);

-- Down Migration

DROP TABLE players;
