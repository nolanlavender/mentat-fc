-- Up Migration

-- Surfaced 2026-08-15 by a real verification query: "FA Cup 2024/25:
-- backfilled 814 fixtures, 0 remaining" didn't mean what it sounded like.
-- backfillLineupsForCompetitionSeason counted a fixture as done just for
-- being attempted, not for actually landing rows in fixture_lineups/
-- fixture_player_stats -- and FA Cup's early rounds are mostly non-league
-- clubs API-Football has no lineup data for at all (confirmed earlier via
-- check-bulk-fixtures-endpoint.ts). Every rerun re-attempted those same
-- fixtures forever with nothing to show for it, and "remaining" never
-- reflected reality.
--
-- lineups_checked_at records "we asked API-Football about this fixture's
-- lineups/stats at least once" independent of whether it returned any
-- rows -- the missing piece needed to tell "genuinely unavailable" apart
-- from "not yet tried". Only ever set for finished fixtures (see the
-- application-side status = 'finished' filter added alongside this), so a
-- match that simply hasn't been played yet is never wrongly marked
-- permanent -- it stays a real candidate until it's actually finished and
-- checked.
ALTER TABLE fixtures ADD COLUMN lineups_checked_at timestamptz;

-- Down Migration

ALTER TABLE fixtures DROP COLUMN lineups_checked_at;
