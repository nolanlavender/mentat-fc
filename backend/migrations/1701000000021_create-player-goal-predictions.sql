-- Up Migration

-- Phase 7: goal scorer prediction. Not a separate model from model_predictions
-- -- the model-service allocates the already-fitted Dixon-Coles team's
-- expected goals across its players (lambda_player = team_xg * goal_share *
-- minutes_share, see model-service/app/goal_scorer.py), so this table stores
-- the per-player result of that allocation, one row per player per fixture
-- per model run. Same never-overwritten-across-versions pattern as
-- model_predictions, for the same reason: backtesting needs history to
-- compare against, not just the latest run.
CREATE TABLE player_goal_predictions (
  id serial PRIMARY KEY,
  fixture_id integer NOT NULL REFERENCES fixtures (id),
  player_id integer NOT NULL REFERENCES players (id),
  team_id integer NOT NULL REFERENCES teams (id),
  model_version text NOT NULL,
  predicted_at timestamptz NOT NULL DEFAULT now(),
  expected_goals numeric NOT NULL,
  prob_scores numeric NOT NULL,
  UNIQUE (fixture_id, player_id, model_version)
);

CREATE INDEX player_goal_predictions_fixture_id_idx ON player_goal_predictions (fixture_id);

-- Down Migration

DROP TABLE player_goal_predictions;
