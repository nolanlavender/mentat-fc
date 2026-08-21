-- Up Migration

-- The handicap or total a leg is priced against -- "Arsenal -2.5" is not
-- expressible without it.
--
-- bet_legs.market/selection are deliberately free text so a new bet type
-- never needs a migration, and that holds for anything whose selection is
-- a single label ('home', a player id). A spread is different in kind: the
-- SAME market and the SAME selection settle differently depending on a
-- number, so 'home' at -2.5 and 'home' at -0.5 are genuinely different
-- bets. Encoding it into the selection text ('home -2.5') would push
-- parsing into the settlement SQL, where a formatting slip becomes a
-- mis-graded bet rather than a validation error.
--
-- fixture_odds already reached the same conclusion and has this exact
-- column for the same reason (see migration 1701000000012's note about
-- distinguishing -1.5 from -0.5), so this keeps the two sides of the app
-- describing a line the same way.
--
-- NOT NULL DEFAULT 0 rather than nullable, matching fixture_odds: 0 is a
-- truthful "no line" for markets that don't have one, and a nullable
-- column would make every settlement comparison NULL-aware for no gain.
ALTER TABLE bet_legs ADD COLUMN line numeric(5, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN bet_legs.line IS
  'Goal handicap applied to the selected side (spread markets). 0 for markets with no line.';

-- Down Migration

ALTER TABLE bet_legs DROP COLUMN line;
