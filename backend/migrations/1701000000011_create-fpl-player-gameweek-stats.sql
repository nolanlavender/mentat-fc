-- Up Migration

-- One row per player per gameweek -- the FPL API's own shape (player prices,
-- ownership, and scoring are all reported per gameweek, not as running totals
-- we'd have to diff ourselves).
CREATE TABLE fpl_player_gameweek_stats (
  id serial PRIMARY KEY,
  player_id integer NOT NULL REFERENCES players (id),
  gameweek_id integer NOT NULL REFERENCES fpl_gameweeks (id),
  now_cost integer, -- tenths of GBP million, per FPL's own convention
  selected_by_percent numeric,
  total_points integer,
  minutes integer,
  goals_scored integer,
  assists integer,
  clean_sheets integer,
  goals_conceded integer,
  own_goals integer,
  penalties_saved integer,
  penalties_missed integer,
  yellow_cards integer,
  red_cards integer,
  saves integer,
  bonus integer,
  bps integer,
  influence numeric,
  creativity numeric,
  threat numeric,
  ict_index numeric,
  UNIQUE (player_id, gameweek_id)
);

CREATE INDEX fpl_player_gameweek_stats_gameweek_id_idx ON fpl_player_gameweek_stats (gameweek_id);

-- Down Migration

DROP TABLE fpl_player_gameweek_stats;
