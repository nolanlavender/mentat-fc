-- Up Migration

-- One row per fixture per model run (never overwritten), keyed on
-- model_version, so Phase 5's backtesting/evaluation has history to compare
-- against instead of only ever seeing the latest prediction.
CREATE TABLE model_predictions (
  id serial PRIMARY KEY,
  fixture_id integer NOT NULL REFERENCES fixtures (id),
  model_version text NOT NULL,
  predicted_at timestamptz NOT NULL DEFAULT now(),
  prob_home_win numeric NOT NULL,
  prob_draw numeric NOT NULL,
  prob_away_win numeric NOT NULL,
  predicted_home_goals numeric,
  predicted_away_goals numeric,
  UNIQUE (fixture_id, model_version)
);

-- Down Migration

DROP TABLE model_predictions;
