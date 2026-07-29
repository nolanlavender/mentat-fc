-- Up Migration

-- Per-player, per-fixture performance (as opposed to fixture_lineups, which
-- only says who played, starting or sub, in what position). Sourced from a
-- *separate* API-Football endpoint from lineups -- one more call per
-- fixture, which is why this was deferred during initial schema design and
-- is only being added now that a paid API-Football tier is planned to
-- absorb the extra backfill cost. minutes_played lives here, not on
-- fixture_lineups, since it comes from this same endpoint rather than the
-- lineup one.
CREATE TABLE fixture_player_stats (
  id serial PRIMARY KEY,
  fixture_id integer NOT NULL REFERENCES fixtures (id) ON DELETE CASCADE,
  team_id integer NOT NULL REFERENCES teams (id),
  player_id integer NOT NULL REFERENCES players (id),
  minutes_played integer,
  rating numeric,
  goals integer,
  assists integer,
  shots integer,
  shots_on_target integer,
  passes integer,
  passes_accuracy numeric,
  tackles integer,
  interceptions integer,
  dribbles_attempted integer,
  dribbles_completed integer,
  fouls_drawn integer,
  fouls_committed integer,
  yellow_cards integer,
  red_cards integer,
  penalties_scored integer,
  penalties_missed integer,
  saves integer, -- goalkeepers
  UNIQUE (fixture_id, player_id)
);

CREATE INDEX fixture_player_stats_player_id_idx ON fixture_player_stats (player_id);

-- Down Migration

DROP TABLE fixture_player_stats;
