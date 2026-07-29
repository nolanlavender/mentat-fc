# Seeding the database

How to go from an empty Postgres to a fully populated one, and how to avoid
ever doing the expensive part twice. Written as a runbook (steps you
actually execute), not a narrative — see `docs/learning-log.md` for the
reasoning and concepts behind these choices.

## Scope

Historical match data (results, odds, team stats, lineups, per-fixture
player performance) covers **Premier League + Championship + FA Cup, 3
seasons**. This is wider than the app's user-facing surface, but not
uniformly PL-only: team dashboards/fantasy/betting stay Premier League
only, but **match predictions cover Premier League and Championship, plus
FA Cup fixtures where both teams are in one of those two tiers** — an FA
Cup fixture against a lower-tier side gets a default logo and no
prediction. See `docs/CLAUDE.md`'s "Data scope vs. app scope" for the full
breakdown. Nothing about the schema changes based on this; it only affects
which competitions Phase 2's endpoints filter to.

## The three layers, and what each one is for

1. **`backend/seed/raw/`** (gitignored, machine-local) — every payload
   actually fetched from football-data.co.uk / API-Football / FPL, cached
   to disk. Fetch-if-absent: reruns of the seed script never re-fetch
   something already here. This is what protects API-Football's 100/day
   budget *during* the backfill itself — it has to exist before a snapshot
   does, and it stays gitignored because it's large-ish and fully
   reproducible from step 3 below.
2. **`backend/seed/snapshot/mentat_fc_seed.dump`** (committed to git) — a
   `pg_dump` of the fully seeded database. Restoring it (`npm run
   db:restore`) rehydrates a working dev database in seconds, no network,
   no re-parsing thousands of rows. This is the direct answer to "don't
   want to hit the API to seed local environments" — a fresh clone of this
   repo already has a working dataset. It's currently just the 2023/24
   Premier League season + FPL bootstrap (the only data this cloud session
   could actually test against); update it once the real backfill below
   completes.
3. **Postgres migrations** (`backend/migrations/`) — the schema itself.
   Independent of the two layers above; `db:restore` still requires
   migrations to have been run first so the extensions/table shapes match
   what the dump expects to load into.

## Step-by-step plan

Run this on a machine with normal internet access (this cloud session's
network policy blocks both football-data.co.uk and API-Football — steps 1-3
below were already verified there against a small sample, but the full
multi-season/multi-competition pull needs your own machine).

1. **Fast path first, always try this before anything else:**
   ```
   docker compose up -d          # Postgres, from repo root
   cd backend && npm install
   npm run migrate:up
   npm run db:restore            # instant, from the committed snapshot
   ```
   If this is enough for what you're doing (frontend/backend work against
   real PL data), stop here — no API calls needed.

2. **Get a full historical PL + Championship dataset** (free, no key,
   network only):
   ```
   npm run db:seed
   ```
   This fetches the 2024/25 and 2025/26 football-data.co.uk CSVs for both
   divisions (2023/24 is already cached from this session) plus FPL's
   current bootstrap, and upserts everything. Idempotent — safe to rerun.

3. **Sign up for an API-Football key** and add it to `backend/.env` as
   `API_FOOTBALL_KEY` — never commit it or paste it anywhere outside your
   own `.env`. The plan is to pay for a higher tier once the code below is
   verified working, specifically because per-fixture player performance
   stats (`fixture_player_stats` — goals/assists/cards/minutes, not just who
   played) need a *second* API-Football call per fixture on top of lineups,
   roughly doubling the free tier's already-long backfill timeline.

4. **Before trusting a multi-week (or paid-tier) backfill, run the depth
   check:**
   ```
   npm run check:lineup-depth
   ```
   This fetches one 2023/24 Premier League fixture's lineup *and* player
   stats and reports on both separately. It's possible one comes back and
   the other doesn't (they're different endpoints) — the script tells you
   which case you're in. If neither works, stop and check whether your tier
   covers historical seasons for these endpoints at all before paying for
   more speed. See `docs/learning-log.md`'s Phase 1 entry for why this is a
   real risk, not a formality.

5. **Run the full backfill** (`npm run db:seed` again — it now also pulls
   FA Cup fixture lists and kicks off the lineup + player-stats backfill for
   any fixture missing either). This is throttled to the daily API-Football
   budget (whatever your tier's limit is) and resumable: it logs how many
   fixtures it backfilled and how many remain, then stops cleanly. **Rerun
   this regularly** (a cron job, or just remembering) until it reports zero
   remaining across Premier League, Championship, and FA Cup, all 3 seasons.

6. **Once the backfill is complete, update the committed snapshot:**
   ```
   npm run db:dump
   git add backend/seed/snapshot/mentat_fc_seed.dump
   git commit -m "Update seed snapshot: full 3-competition, 3-season backfill"
   ```
   From this point on, every environment (this cloud session next time, a
   new laptop, CI) skips straight to step 1's fast path.

## When the snapshot needs updating again

Any time the schema changes (new migration) or you re-run a meaningfully
larger seed (new season added, a data source's coverage changes), re-dump
and commit. If the dump file ever grows large enough that committing it
stops being reasonable, move it to a GitHub Release asset instead and point
`db:restore` at a download step — don't build that now, the file is ~400KB
for one season and unlikely to reach a size where this matters.
