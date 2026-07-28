-- Up Migration

-- kickoff_date is set explicitly by the seed scripts (the Europe/London
-- calendar day of kickoff), not derived by Postgres from kickoff_at, so both
-- importers agree on it even when their kickoff_at precision differs.
--
-- The unique constraint on (competition_season_id, home_team_id, away_team_id,
-- kickoff_date) -- not external_api_football_id -- is the dedup target both
-- the football-data.co.uk importer and the API-Football importer upsert
-- against. The two sources have no shared ID space for the same real match,
-- so keying on an external id alone would insert a second row per match
-- instead of the second importer enriching the first.
CREATE TABLE fixtures (
  id serial PRIMARY KEY,
  competition_season_id integer NOT NULL REFERENCES competition_seasons (id),
  home_team_id integer NOT NULL REFERENCES teams (id),
  away_team_id integer NOT NULL REFERENCES teams (id),
  kickoff_at timestamptz NOT NULL,
  kickoff_date date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  round text,
  leg integer,
  home_score integer,
  away_score integer,
  home_score_ht integer,
  away_score_ht integer,
  venue text,
  referee text,
  external_api_football_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_season_id, home_team_id, away_team_id, kickoff_date)
);

CREATE UNIQUE INDEX fixtures_external_api_football_id_idx
  ON fixtures (external_api_football_id)
  WHERE external_api_football_id IS NOT NULL;

CREATE INDEX fixtures_competition_season_id_idx ON fixtures (competition_season_id);

-- Down Migration

DROP TABLE fixtures;
