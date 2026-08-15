-- Up Migration

-- A bet is the container: who placed it, how much, and its overall result.
-- What was actually picked lives in bet_legs (migration 019) -- a single
-- "straight" bet is just a bet with exactly one leg, a parlay is a bet with
-- several. Keeping the pick-level detail out of this table is what makes
-- parlays possible without a second, parallel bets-like table: overall
-- result and combined odds are *derived* from the legs (see
-- backend/src/services/bets.service.ts), not stored redundantly here,
-- the same reasoning already used for team_fixture_results as a view
-- instead of a stored table back in Phase 1.
-- No settled_at here either, for the same reason -- each leg settles
-- independently as its own fixture finishes, so "when did this bet finish
-- resolving" is max(leg.settled_at) once every leg is no longer pending,
-- computed where it's read rather than kept in sync by hand in two places.
CREATE TABLE bets (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users (id),
  stake numeric(10, 2) NOT NULL CHECK (stake > 0),
  placed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bets_user_id_idx ON bets (user_id);

-- Down Migration

DROP TABLE bets;
