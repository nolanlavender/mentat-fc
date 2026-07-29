-- Up Migration

-- EAV-shaped on purpose: ~8 bookmakers x several markets x opening/closing
-- snapshots per fixture doesn't fit fixed columns without constant schema
-- changes as new bookmakers/markets show up. The model-service will need a
-- pivot query/view to get a wide training dataframe back out of this.
--
-- `line` holds the spread/total value (e.g. 2.5 for an over/under, -1.5 for
-- an Asian handicap) and defaults to 0 for markets that don't have one (e.g.
-- match_winner). It can't be nullable: Postgres treats NULL <> NULL in
-- unique constraints, so an all-nullable `line` would silently let duplicate
-- rows through and break the idempotent upsert this table depends on.
CREATE TABLE fixture_odds (
  id serial PRIMARY KEY,
  fixture_id integer NOT NULL REFERENCES fixtures (id) ON DELETE CASCADE,
  bookmaker text NOT NULL,
  market text NOT NULL, -- 'match_winner' | 'over_under' | 'asian_handicap'
  outcome text NOT NULL, -- 'home' | 'draw' | 'away' | 'over' | 'under'
  line numeric NOT NULL DEFAULT 0,
  price numeric NOT NULL,
  snapshot_type text NOT NULL CHECK (snapshot_type IN ('opening', 'closing', 'live')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  UNIQUE (fixture_id, bookmaker, market, outcome, line, snapshot_type)
);

CREATE INDEX fixture_odds_fixture_id_idx ON fixture_odds (fixture_id);

-- Down Migration

DROP TABLE fixture_odds;
