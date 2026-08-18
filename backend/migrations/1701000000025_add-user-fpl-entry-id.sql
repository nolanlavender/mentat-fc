-- Up Migration

-- "My Team" was built single-user, before real login existed (Phase 4,
-- before Phase 6's auth) -- it read one FPL_ENTRY_ID from the server's own
-- .env, the same team for every visitor, and stayed that way even after
-- multi-user auth shipped (requireAuth got added later, but nothing ever
-- made the endpoint actually look at which user was asking). Real bug,
-- found in production: a second person logs in and sees the first
-- person's fantasy team, or nothing at all if FPL_ENTRY_ID isn't set.
-- fpl_entry_id is nullable and has no default -- most users won't have
-- linked a team yet, and that's a normal state (see fpl.service.ts's
-- getMyTeamForUser), not an error one.
ALTER TABLE users ADD COLUMN fpl_entry_id integer;

-- Down Migration

ALTER TABLE users DROP COLUMN fpl_entry_id;
