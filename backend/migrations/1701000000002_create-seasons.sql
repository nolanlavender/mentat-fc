-- Up Migration

CREATE TABLE seasons (
  id serial PRIMARY KEY,
  label text NOT NULL UNIQUE, -- e.g. '2023/24'
  start_date date NOT NULL,
  end_date date NOT NULL
);

-- Down Migration

DROP TABLE seasons;
