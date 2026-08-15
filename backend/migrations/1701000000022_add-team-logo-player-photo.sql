-- Up Migration

-- Sourced from API-Football's own responses (teams.home/away.logo on the
-- fixtures endpoint, player.photo on the fixtures/players endpoint) --
-- both are already being fetched for other reasons, so capturing these
-- columns costs zero extra API calls against the daily budget. Deliberately
-- not scraping crest/headshot images from anywhere else: API-Football is
-- the licensed, already-paid-for source for this data.
ALTER TABLE teams ADD COLUMN logo_url text;
ALTER TABLE players ADD COLUMN photo_url text;

-- Down Migration

ALTER TABLE players DROP COLUMN photo_url;
ALTER TABLE teams DROP COLUMN logo_url;
