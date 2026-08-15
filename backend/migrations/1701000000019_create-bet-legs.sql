-- Up Migration

-- One row per pick within a bet -- a straight bet has exactly one leg, a
-- parlay has several, and the whole bet only wins if every leg does.
-- market/selection stay free text (same shape as fixture_odds's
-- market/outcome, and the original single-table bets design) so a new bet
-- type never needs a migration.
CREATE TABLE bet_legs (
  id serial PRIMARY KEY,
  bet_id integer NOT NULL REFERENCES bets (id) ON DELETE CASCADE,
  fixture_id integer NOT NULL REFERENCES fixtures (id),
  market text NOT NULL,
  selection text NOT NULL,
  odds_decimal numeric(6, 2) NOT NULL CHECK (odds_decimal > 1),
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'won', 'lost', 'void')),
  settled_at timestamptz
);

CREATE INDEX bet_legs_bet_id_idx ON bet_legs (bet_id);
CREATE INDEX bet_legs_fixture_id_idx ON bet_legs (fixture_id);

-- Down Migration

DROP TABLE bet_legs;
