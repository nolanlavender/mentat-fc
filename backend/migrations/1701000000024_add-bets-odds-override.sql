-- Up Migration

-- Combined odds are still *derived* from bet_legs.odds_decimal by default
-- (see backend/src/services/bets.service.ts's rowsToBet) -- unchanged from
-- migration 018's original reasoning. This column is an *optional*
-- override for parlays only: a real sportsbook's quoted total price for an
-- accumulator is a real number the book chose, and it can differ slightly
-- from the pure product of each leg's own odds (rounding, house margin
-- applied at the parlay level rather than per leg). Nullable and unused for
-- straight (single-leg) bets, where the one leg's own odds already *is*
-- the bet's price. Still stored per-leg too, not instead of -- that's what
-- keeps void-leg repricing working (a void leg's own odds drops out of the
-- product automatically); this override is ignored the moment any leg in
-- the bet is void, since there's no way to know how the book's own quoted
-- total would have adjusted for that specific leg voiding.
ALTER TABLE bets ADD COLUMN odds_override_decimal numeric(8, 2) CHECK (odds_override_decimal IS NULL OR odds_override_decimal > 1);

-- Down Migration

ALTER TABLE bets DROP COLUMN odds_override_decimal;
