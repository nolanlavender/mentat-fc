-- Up Migration

-- Personal bet log -- deliberately no user_id column. CLAUDE.md describes
-- the betting tracker as a single-user personal tracker throughout, not
-- "waiting on Phase 9 auth" -- see docs/erd.md's note on this table for the
-- full reasoning. Add user_id later only if that assumption changes.
--
-- market/selection follow the same free-text shape as fixture_odds
-- (bookmaker/market/outcome) rather than an enum, so a new bet type (Asian
-- handicap, over/under, a player prop) never needs a schema migration --
-- just a new string value the frontend knows how to render.
CREATE TABLE bets (
  id serial PRIMARY KEY,
  fixture_id integer NOT NULL REFERENCES fixtures (id),
  market text NOT NULL,
  selection text NOT NULL,
  odds_decimal numeric(6, 2) NOT NULL CHECK (odds_decimal > 1),
  stake numeric(10, 2) NOT NULL CHECK (stake > 0),
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'won', 'lost', 'void')),
  placed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX bets_fixture_id_idx ON bets (fixture_id);

-- Down Migration

DROP TABLE bets;
