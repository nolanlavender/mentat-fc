-- Up Migration

-- WHEN a team's roster was last confirmed against API-Football's
-- /players/squads, which is the difference between "this player has left"
-- and "we have never checked".
--
-- Real bug this fixes (2026-08-22): Mohamed Salah was predicted to score
-- for Liverpool after leaving them. The pipeline had already worked out he
-- was gone -- clearStaleTeamRoster sets players.current_team_id to NULL
-- for anyone missing from a team's latest squad -- but
-- load_player_squad_appearances then read
-- COALESCE(current_team_id, most_recent_appearance_team) and put him
-- straight back, because his most recent appearance was for Liverpool.
-- The authoritative "he left" signal was silently undone by the fallback
-- one layer down.
--
-- That fallback is not wrong in general; it exists because a NULL
-- current_team_id used to mean "FPL doesn't cover this player" (see the
-- 2026-08-16 Harry Wilson chain). The problem is that NULL now has two
-- meanings and nothing distinguishes them:
--
--   never checked  -> fall back to appearances, the old behaviour
--   checked, absent -> the player is gone; do not attach him to anything
--
-- A per-team sync timestamp separates them: if the club a player last
-- appeared for HAS been synced and he still has no current team, he was
-- looked for and not found.
--
-- Deliberately on teams rather than players: the fact being recorded is
-- "this roster was verified", which is a property of the team and one row
-- per sync instead of one per player.
ALTER TABLE teams ADD COLUMN roster_synced_at timestamptz;

COMMENT ON COLUMN teams.roster_synced_at IS
  'Last successful, non-empty API-Football /players/squads sync. NULL = never verified, so a player with no current_team_id may simply be uncovered rather than departed.';

-- Down Migration

ALTER TABLE teams DROP COLUMN roster_synced_at;
