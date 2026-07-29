-- Up Migration

-- Surfaced while building Phase 2's team dashboard endpoint: there was no
-- way to answer "who's on this team's squad" at all. fixture_lineups would
-- be the source of truth for that eventually, but it's empty until the
-- paid-tier API-Football backfill runs. FPL's bootstrap-static already
-- gives us a player's current team directly (it's a live fantasy game, so
-- this is always up to date) -- current_team_id is populated from that,
-- Premier League players only. Championship squads stay empty until lineups
-- are backfilled; that's a known, documented gap, not a bug.
ALTER TABLE players ADD COLUMN current_team_id integer REFERENCES teams (id);
CREATE INDEX players_current_team_id_idx ON players (current_team_id);

-- Down Migration

ALTER TABLE players DROP COLUMN current_team_id;
