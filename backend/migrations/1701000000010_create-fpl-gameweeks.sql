-- Up Migration

CREATE TABLE fpl_gameweeks (
  id serial PRIMARY KEY,
  gw_number integer NOT NULL UNIQUE,
  deadline_time timestamptz NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  is_finished boolean NOT NULL DEFAULT false,
  average_score integer,
  highest_score integer
);

-- Down Migration

DROP TABLE fpl_gameweeks;
