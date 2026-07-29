-- Up Migration

-- Expected goals (xG) per team per fixture -- a genuinely missing feature
-- for the model, not just a display nicety. football-data.co.uk doesn't
-- provide it; API-Football's fixture-statistics endpoint may (UNVERIFIED --
-- confirm against a real response, and note it's a second per-fixture call
-- on top of lineups, the same rate-limit cost tradeoff as minutes_played).
-- Nullable and unpopulated until that's confirmed; harmless to add now.
ALTER TABLE fixture_team_stats ADD COLUMN xg numeric;

-- One row per team per fixture (not per fixture), so "what's this team's
-- form/season record" doesn't need hand-written CASE logic for home vs.
-- away in every query that wants it. Still fully derived from fixtures +
-- fixture_team_stats -- this is a view, not a stored/materialized table, so
-- it can't drift from the source data the way a cached aggregate could.
CREATE VIEW team_fixture_results AS
SELECT
  f.id AS fixture_id,
  f.competition_season_id,
  f.kickoff_date,
  f.home_team_id AS team_id,
  f.away_team_id AS opponent_team_id,
  true AS is_home,
  f.home_score AS goals_for,
  f.away_score AS goals_against,
  CASE
    WHEN f.home_score IS NULL OR f.away_score IS NULL THEN NULL
    WHEN f.home_score > f.away_score THEN 'W'
    WHEN f.home_score < f.away_score THEN 'L'
    ELSE 'D'
  END AS result,
  CASE
    WHEN f.home_score IS NULL OR f.away_score IS NULL THEN NULL
    WHEN f.home_score > f.away_score THEN 3
    WHEN f.home_score < f.away_score THEN 0
    ELSE 1
  END AS points,
  fts.shots, fts.shots_on_target, fts.corners, fts.fouls, fts.yellow_cards, fts.red_cards, fts.xg
FROM fixtures f
LEFT JOIN fixture_team_stats fts ON fts.fixture_id = f.id AND fts.team_id = f.home_team_id
UNION ALL
SELECT
  f.id,
  f.competition_season_id,
  f.kickoff_date,
  f.away_team_id,
  f.home_team_id,
  false,
  f.away_score,
  f.home_score,
  CASE
    WHEN f.home_score IS NULL OR f.away_score IS NULL THEN NULL
    WHEN f.away_score > f.home_score THEN 'W'
    WHEN f.away_score < f.home_score THEN 'L'
    ELSE 'D'
  END,
  CASE
    WHEN f.home_score IS NULL OR f.away_score IS NULL THEN NULL
    WHEN f.away_score > f.home_score THEN 3
    WHEN f.away_score < f.home_score THEN 0
    ELSE 1
  END,
  fts.shots, fts.shots_on_target, fts.corners, fts.fouls, fts.yellow_cards, fts.red_cards, fts.xg
FROM fixtures f
LEFT JOIN fixture_team_stats fts ON fts.fixture_id = f.id AND fts.team_id = f.away_team_id;

-- Down Migration

DROP VIEW team_fixture_results;
ALTER TABLE fixture_team_stats DROP COLUMN xg;
