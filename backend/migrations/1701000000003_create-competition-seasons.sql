-- Up Migration

-- Join table so a competition's participation in a season is data, not schema --
-- adding a new competition or season later is new rows here, nothing else.
CREATE TABLE competition_seasons (
  id serial PRIMARY KEY,
  competition_id integer NOT NULL REFERENCES competitions (id),
  season_id integer NOT NULL REFERENCES seasons (id),
  external_season_year integer, -- API-Football's "season" query param, e.g. 2023 for '2023/24'
  is_current boolean NOT NULL DEFAULT false,
  UNIQUE (competition_id, season_id)
);

-- Down Migration

DROP TABLE competition_seasons;
