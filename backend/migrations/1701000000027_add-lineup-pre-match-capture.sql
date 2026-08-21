-- Up Migration

-- WHEN a lineup was captured, not just that it exists.
--
-- fixture_lineups is written by two different jobs that both call
-- API-Football's /fixtures/lineups and both land in this table with no
-- record of which one did it:
--
--   seedTodaysLineups                   status != 'finished', +/-3h of
--                                       kickoff  -> genuinely PRE-match
--   backfillLineupsForCompetitionSeason status = 'finished'  -> post-match
--
-- The endpoint returns the same announced XI + bench either way, so the
-- CONTENT is identical and nothing looked wrong. What was missing is
-- whether we had it in time to act on it, and that is a different
-- question with real consequences:
--
--   1. The availability adjustment and the starter-vs-bench scorer odds
--      only mean anything if the lineup arrived before kickoff. Post-match
--      rows are useful for fitting and useless for betting.
--   2. app.evaluate_scorers' "confirmed lineup" mode runs on FINISHED
--      fixtures, whose rows came from the post-match backfill. Without
--      this column it silently assumes we would have had every one of
--      those lineups in time -- an optimism bias that flatters the
--      backtest for exactly the fixtures where pre-match capture fails.
--
-- NULL means "not known to have been captured pre-match", which covers
-- both the post-match backfill and every row seeded before this migration.
-- Deliberately not a boolean: the timestamp also answers "how far ahead of
-- kickoff do we actually get these?", which is the number that decides
-- whether the +/-3h check window is wide enough.
ALTER TABLE fixture_lineups ADD COLUMN pre_match_captured_at timestamptz;

COMMENT ON COLUMN fixture_lineups.pre_match_captured_at IS
  'Set only by the pre-kickoff matchday check. NULL = post-match backfill, or seeded before this column existed.';

-- Down Migration

ALTER TABLE fixture_lineups DROP COLUMN pre_match_captured_at;
