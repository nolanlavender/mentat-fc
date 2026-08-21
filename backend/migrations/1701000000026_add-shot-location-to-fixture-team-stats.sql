-- Up Migration

-- Shot LOCATION, split inside vs outside the penalty area. The closest
-- thing to real expected goals this project can actually get: a shot from
-- inside the box converts at a far higher rate than one from outside, so
-- the same "total shots" number means very different things depending on
-- where they came from. app.data.blend_shots_on_target_into_scores already
-- proved a shot-volume proxy beats raw goals for fitting (a real ~2.4%
-- Brier gain in the Premier League, see docs/learning-log.md's 2026-08-19
-- entry) -- location should sharpen that same signal.
--
-- Deliberately NOT following the xg column added by migration
-- 1701000000014, which was created on the assumption the data would show
-- up and stayed null in production forever, silently making a whole blend
-- feature a no-op. The difference: these two columns are confirmed present
-- on API-Football's /fixtures/statistics endpoint ("Shots insidebox" /
-- "Shots outsidebox") before being added, and the backfill that populates
-- them reports its own null rate per season as it runs, so "documented but
-- empty for older seasons" gets caught in the first handful of API calls
-- rather than after thousands.
--
-- Nullable because coverage is genuinely expected to be partial:
-- fixture_team_stats is otherwise populated entirely from
-- football-data.co.uk's CSV (which has no shot-location columns at all),
-- so every existing row starts null here and only fills in as the
-- API-Football backfill reaches it.
ALTER TABLE fixture_team_stats
  ADD COLUMN shots_inside_box integer,
  ADD COLUMN shots_outside_box integer;

-- Down Migration
ALTER TABLE fixture_team_stats
  DROP COLUMN shots_inside_box,
  DROP COLUMN shots_outside_box;
