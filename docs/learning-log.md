# Learning log

Study reference — one entry per phase, written for future-me. Not a changelog.

---

## Phase 0 — Environment & planning (2026-07-22)

### What we built

- **Repo scaffold**: `/frontend`, `/backend`, `/model-service`, `/docs` (docs already existed).
  Initialized git (`git init`) — the repo had no version control until today.
- **Version managers, not system runtimes**: installed `nvm` and `pyenv` into the home
  directory (`~/.nvm`, `~/.pyenv`) rather than using whatever Node/Python macOS ships with.
  - Node: v24.18.0 (current LTS), pinned via `.nvmrc` in `/frontend` and `/backend`.
  - Python: 3.12.13, pinned via `.python-version` in `/model-service` (the machine's
    system Python was 3.9.6 — old enough that some current libraries have already
    dropped support for it).
- **Backend**: Express 5 + TypeScript, ESM (`"type": "module"` + `moduleResolution:
  "NodeNext"`), `tsx` for dev-mode hot reload, `tsc` for production builds. Structure so
  far is deliberately thin — `src/index.ts` (app + `/health` route), `src/config/env.ts`
  (fails fast if required env vars are missing instead of limping along with
  `undefined`), `src/db/pool.ts` (a `pg` connection pool). No `routes/controllers/services`
  split yet — that's a Phase 2 decision, once there's more than one endpoint to justify it.
- **Frontend**: Vite + React + TypeScript (`react-ts` template). Vite was the obvious
  pick over Create React App (officially deprecated) or a full framework like Next.js
  (overkill — we don't need server-side rendering, just a SPA talking to our own API).
- **Model service**: FastAPI on the pinned Python, in its own virtualenv
  (`model-service/.venv`), dependencies frozen to exact versions in `requirements.txt`
  (`pip freeze`, the Python equivalent of a lockfile — without it, `pip install
  fastapi` could resolve to a different version next month and behave differently).
  Confirmed working with a `/health` endpoint.
- **Docker Compose**: single `postgres:16-alpine` service, root `docker-compose.yml`,
  named volume so data survives container restarts, a healthcheck so other tools can
  wait for Postgres to actually be ready rather than just "started."
- **`.env.example`** for root (Postgres credentials for Compose), `backend`, `frontend`,
  and `model-service`, plus a root `.gitignore` covering `node_modules/`, `.venv/`,
  `.env`, build output, and OS/editor cruft.

### Concepts this taught

- **Version managers (nvm/pyenv) vs. system runtimes.** The OS's Node/Python is shared
  by the OS itself and other tools — upgrading it for one project can break something
  else, and it drifts silently between machines. A version manager installs multiple
  versions side by side in your home directory (no `sudo`) and a `.nvmrc`/
  `.python-version` file pins the exact version a project needs. This is the core of
  "repeatable environment": anyone (including CI, including future-you on a new laptop)
  runs one command and gets the identical runtime the code was written against.
- **Docker Compose.** `docker-compose.yml` is a declarative description of one or more
  containers (here, just Postgres) — image, env vars, ports, volumes. `docker compose up`
  reads it and creates/starts exactly that, every time, on any machine with Docker
  installed. The alternative — installing Postgres directly on your Mac — works but
  means "works on my machine" config drift, and doesn't match how we'll actually run
  Postgres in the cloud later (a managed instance, but still "a Postgres" the app
  connects to over a connection string — Compose gets you used to that mental model
  now). We did **not** install Docker Desktop for this — see "decisions" below.
- **Why the model service is a separate process from Express**, not a Python script
  Express shells out to: it trains a model and writes predictions to Postgres on a
  schedule (batch inference). Express just reads that table later, like any other
  data source. This means the two services can be deployed, scaled, and iterated on
  independently, and a slow/crashing training run can never take the API down.
- **Lockfiles as a concept, not just an npm thing.** `package-lock.json` (npm) and
  `requirements.txt` generated via `pip freeze` (Python) do the same job: pin the
  *exact* resolved version of every dependency, including transitive ones, so
  `npm install`/`pip install -r requirements.txt` gives you the same thing today,
  next month, and on a teammate's machine.
- **Fail-fast config loading.** `src/config/env.ts` throws immediately at startup if
  `DATABASE_URL` is missing, instead of the app starting and failing confusingly the
  first time something touches the database. Validating configuration at the
  boundary (startup) rather than deep inside business logic is a pattern worth
  reusing everywhere.

### Decisions worth remembering

- **Docker runtime: Colima, not Docker Desktop.** You chose Colima — a lightweight,
  open-source, CLI-only Docker runtime — over Docker Desktop's GUI app. It's installed
  via Homebrew, which needed a one-time `sudo` step only you could grant (I can't enter
  your admin password), so you ran the Homebrew installer yourself.
- **Frontend `.env.example` does NOT include the API-Football/Odds/Groq keys**, even
  though the original plan called for the same four placeholders in every service's
  `.env.example`. Vite bundles any `VITE_`-prefixed variable straight into the
  JavaScript the browser downloads — anything client-side is public. Those secrets
  live only in `backend/.env` (and `model-service/.env` where relevant); the frontend
  only needs `VITE_API_BASE_URL` to know where our own backend lives. Flagging this
  since it's a deviation from the literal instruction, made to avoid shipping API
  keys to every visitor's browser.
- **model-service's `.env.example` is minimal** — just `DATABASE_URL` and
  `API_FOOTBALL_KEY` (for future live-fixture pulls), not Odds API or Groq keys, since
  neither is called from the model service per `docs/architecture.md`.
- **`postgres:16-alpine`, not a fully-pinned patch version.** Floating on the minor/patch
  within major version 16 means `docker compose pull` picks up security patches
  automatically; Postgres patch releases are always backward-compatible, so this
  isn't the same repeatability risk as floating on an app dependency's major version.
- **Known gap: Python's `lzma` module didn't compile** when building 3.12.13 via
  pyenv (missing the `xz` library, which normally comes from Homebrew). Doesn't block
  anything in Phase 0 — flagging so it doesn't cause a confusing failure later if a
  library needs it (e.g., reading `.xz`-compressed data). Fix once Homebrew/Colima is
  set up: `brew install xz && pyenv install --force 3.12.13`.

### Data source findings (confirm before Phase 1 schema design)

**Fixtures/lineups/standings — API-Football vs. football-data.org:**

| | API-Football | football-data.org |
|---|---|---|
| Free tier limit | 100 requests/day | 10 requests/minute |
| Leagues (free) | All, including Premier League | 12 competitions, PL included |
| Lineups (free) | Included | Not confirmed — appears to be a paid-tier feature |
| Live/delayed scores | Live | Delayed |
| Historical season range | Limited on free tier | Not fully confirmed |

**Recommendation: API-Football.** Its daily cap sounds restrictive, but the app's own
architecture is batch/cache-first (`docs/architecture.md`'s cache layer, plus a
single-user personal project, not a real-time feed) — refreshing fixtures/standings
once or a few times a day comfortably fits under 100 requests, and it's the only one
of the two confirmed to include lineups on the free tier, which the Phase 1 schema
explicitly needs.

**The Odds API — important gotcha found today.** The free "Starter" tier is **NBA +
MLB only, moneyline (h2h) markets only — no soccer at all.** There's no free-tier path
to Premier League odds. To get PL coverage (h2h/spreads/totals across major European
leagues), the **Professional plan at $29/month** is the entry point. That's within the
$10–30/mo budget CLAUDE.md sets aside for paid data APIs, but it uses the whole range —
worth deciding deliberately before Phase 6 (betting tracker), not defaulting into it.
In the meantime, football-data.co.uk's historical CSVs already include closing odds
from multiple bookmakers, which is enough for model backtesting; it's only *live/
current* odds for new bets that need the paid API.

**Groq (Llama 3.3 70B, free tier):** 30 requests/min, 12,000 tokens/min, 1,000
requests/day, 100,000 tokens/day. Comfortable for a cached, single-user explainer
feature — the explicit caching-in-front-of-Groq design in `docs/architecture.md`
matters here: without it, a busy session could plausibly bump the per-minute limits.

**Official FPL API (`fantasy.premierleague.com/api/bootstrap-static/`)** — no key
needed, confirmed live. Top-level keys: `elements` (players — prices via `now_cost` in
tenths of £m, `selected_by_percent`, `total_points`, per-stat totals like
`goals_scored`/`assists`/`clean_sheets`/`bonus`/`bps`, injury/availability via `status`
and `news`), `teams` (with home/away attack/defence "strength" ratings FPL itself
uses), `events` (gameweeks — deadlines, chip usage, highest/average scores),
`element_types` (positions), `game_settings`/`game_config` (scoring rules). Pulling
this today also revealed we're mid off-season: the 2025/26 season's gameweeks are all
marked `finished: true` and none is `is_current`, since 2026/27 hasn't kicked off yet
— worth remembering when testing against "live" gameweek data before August.

**football-data.co.uk historical CSV** (`E0.csv`, 2023/24 Premier League season) — 380
matches (20 teams × 38 games) confirmed. Columns: match result fields (`FTHG`/`FTAG`/
`FTR` full-time goals/result, `HTHG`/`HTAG`/`HTR` half-time), match stats (shots,
shots-on-target, fouls, corners, cards, referee), and a large block of **bookmaker
odds** — multiple bookmakers (Bet365, Pinnacle, William Hill, etc.) for match odds,
over/under 2.5 goals, and Asian handicap, each with both opening and closing ("C")
prices, plus `Max`/`Avg` columns across bookmakers. This is exactly the labeled,
odds-rich dataset CLAUDE.md pointed at for Phase 5 model training — no gaps found.

### Still open before Phase 1

- Whether football-data.org's free tier includes lineups at all (would only matter if
  we ever needed a second source alongside API-Football).
- Deciding when to pay for The Odds API's Professional tier — needed by Phase 6, not
  before.

---

## Phase 1 — Data layer & schema (2026-07-28)

### What we built

Scope grew before this phase started: instead of Premier League only, we're now
covering **Premier League + Championship + FA Cup, 3 seasons back, full depth**
(lineups and player-level data for all three, not just match results for model
training) — decided via a couple of scoping questions up front, since that choice
changes the schema and the data-sourcing plan materially.

- **12 tables**, migrated via plain SQL files in `backend/migrations/` (`node-pg-migrate`,
  `.sql` mode): `competitions`, `seasons`, `competition_seasons` (join table),
  `teams`, `players`, `fixtures`, `fixture_team_stats`, `fixture_odds`,
  `fixture_lineups`, `fpl_gameweeks`, `fpl_player_gameweek_stats`, `model_predictions`.
  Full breakdown and the ERD diagram are in `docs/erd.md` — that file is the source
  of truth for the schema, this entry is about *why*.
- **Seed pipeline** in `backend/seed/`: one module per data source
  (`sources/football-data-co-uk.ts`, `sources/fpl.ts`, `sources/api-football.ts`),
  a shared `lib/db.ts` of upsert helpers, and `lib/cache.ts` implementing
  fetch-if-absent caching to `backend/seed/raw/` (gitignored). Orchestrated by
  `seed/index.ts`, run via `npm run db:seed`.
- **Tested end-to-end in this session**, since this container has no Docker and no
  network access to football-data.co.uk/API-Football (its network policy blocks
  both): installed Postgres 16 natively (no Docker needed for this — `initdb`/`pg_ctl`
  directly) as a scratch database, ran all 12 migrations up and back down cleanly,
  then ran the football-data.co.uk + FPL seed against the real cached samples already
  in the repo. Confirmed: 380 real 2023/24 Premier League fixtures with correct
  scores/referees/dates, real odds parsed correctly across 8 bookmakers and three
  market types, 841 real FPL players, 38 real gameweeks — and reran the whole seed
  three times in a row with **zero duplicate rows and zero network calls** after the
  first run, proving both the idempotent-upsert design and the cache actually work.

### Concepts this taught

- **Why migrations are SQL you write, not SQL you generate.** We used
  `node-pg-migrate` in its `.sql` file mode (not its JS DSL, and not an ORM like
  Prisma) specifically so every `CREATE TABLE` is something we wrote and can read
  back, not something a schema DSL generated on our behalf. The tool still earns its
  keep: it tracks which migrations have run (a `pgmigrations` bookkeeping table) and
  runs them in order, so you're not manually remembering "did I run that one on this
  machine yet." Each migration file has both an `up` and a `down` — we actually ran
  `down` on all 12 tables and confirmed the database returned to empty, which is the
  concrete answer to "why not just hand-edit the DB": a hand edit isn't recorded
  anywhere, isn't reversible, and doesn't replay on a teammate's machine or in CI.
- **Entity resolution across data sources — the same bug, twice.** FPL and
  API-Football assign their own, unrelated IDs to the same real player, and
  football-data.co.uk and API-Football have no shared ID at all for the same real
  match. Both `players` and `fixtures` solve this the same way: a **natural key**
  (something derived from the real-world data itself — team names + date for
  fixtures) is the actual dedup target, with each source's numeric ID stored
  alongside as a nullable enrichment column, not the primary way of finding the row.
  Reach for a natural key whenever two systems describe the same real thing but
  don't agree on an ID for it — this comes up constantly in data engineering, not
  just here.
- **A live bug in exactly that pattern, found by actually rerunning the seed.**
  The first version of `getOrCreateCompetition` used `ON CONFLICT (external_api_football_league_id)`
  — a nullable column — to decide whether "Premier League" already existed.
  Postgres never treats `NULL = NULL` as a conflict, so with no id supplied yet
  (which is the normal case until API-Football actually runs), every rerun silently
  inserted a second "Premier League" row, which cascaded into doubled seasons,
  fixtures, and odds on the second seed run. Fixed by matching on `name` (the actual
  natural key — there are only 3 competitions, ever) and only using the external id
  as an enrichment column once we have one. The lesson: an `ON CONFLICT` target has
  to be a column that's actually always populated at conflict time, or it silently
  doesn't do its job — and this class of bug only shows up if you rerun the thing
  and check row counts, which is exactly why we tested that instead of assuming it
  worked after one clean run.
- **EAV (entity-attribute-value) tables, and when the tradeoff is worth it.**
  `fixture_odds` stores `(bookmaker, market, outcome, line, price)` as rows instead
  of giving every bookmaker/market combination its own column. That's the EAV
  pattern, normally a smell — but here it's the right call because the set of
  bookmakers and market types isn't fixed and shouldn't require a schema change
  every time football-data.co.uk adds one. The real cost, which we're deferring:
  reading this back out as a wide table for model training needs a pivot
  query/view, which doesn't exist yet — a Phase 5 problem, noted now so it isn't a
  surprise later.
- **UTC vs. local wall-clock time, concretely.** football-data.co.uk gives kickoff
  times as UK local time with no timezone attached, and that offset changes between
  GMT and BST across a single season. `seed/lib/london-time.ts` converts correctly
  in both directions using `Intl.DateTimeFormat` against the `Europe/London` zone
  (asking the real IANA tz database what the offset was at that specific moment,
  rather than assuming a fixed one) — both the football-data.co.uk importer and the
  (not-yet-run) API-Football importer compute `kickoff_date` this same way, so they
  agree on which calendar day a match happened on even though their raw timestamps
  come from different sources with different precision.
- **Why Postgres was available without Docker in this session, and why that
  doesn't change anything about the real setup.** This cloud dev container has no
  Docker daemon, but does have Postgres 16 installed as a system package, so
  `initdb`/`pg_ctl` stood up a scratch instance directly for testing. Your actual
  local dev environment still uses `docker-compose.yml` as documented in the
  README — this was purely a way to verify the migrations and seed script actually
  work before you run them for real.

### Decisions worth remembering

- **No stored standings table, no `fixture_events` table, no `minutes_played` on
  lineups, no `bets` table yet.** All four were deliberately left out and explained
  in `docs/erd.md`'s notes rather than silently designed away — standings are
  derivable from `fixtures` on demand; goal/card event data and `minutes_played`
  are Phase 7 (goal scorer prediction) needs, and `minutes_played` specifically
  would have doubled the API-Football lineup backfill for no Phase 1 payoff;
  `bets` is Phase 6, and won't need a `user_id` at all given this is a single-user
  personal tracker throughout CLAUDE.md, not "waiting on Phase 9 auth."
- **The full 3-year, 3-competition, full-depth backfill could not be completed in
  this session** — two real constraints, not a shortcut: (1) this container's
  network policy blocks both football-data.co.uk and API-Football, so only the
  already-cached 2023/24 Premier League CSV and FPL sample could be tested; (2) no
  real `API_FOOTBALL_KEY` exists yet. Concretely still to do, on a machine with
  normal internet access and a real key in `backend/.env`:
  1. Run `npm run migrate:up` and `npm run db:seed` in `backend/` — this will
     actually fetch the 2024/25 and 2025/26 Premier League + Championship CSVs
     over the network (the 2023/24 one is already cached from this session) and
     seed FPL fresh.
  2. Add `API_FOOTBALL_KEY` to `backend/.env`, then **before trusting the lineup
     backfill**: run `seedApiFootballLineup` against a single fixture from 2+
     seasons ago and check what comes back. API-Football's free tier is
     confirmed at 100 requests/day, but whether it serves detailed
     lineups/statistics that far back at all is genuinely unconfirmed — if it
     doesn't, that's a "pay for depth" decision, not a "wait longer" one, and
     worth deciding together rather than discovering mid-backfill.
  3. If that check passes, `npm run db:seed` again to pull FA Cup fixture lists
     and kick off the lineup backfill — it's throttled to the daily budget and
     resumable by design (`backend/seed/sources/api-football.ts`), so it's meant
     to be rerun daily (not left running) until it reports nothing left to do.
  4. Recommending against paying for a faster API-Football tier for now: The Odds
     API's Professional tier ($29/mo, needed by Phase 6) already uses nearly all
     of the $10-30/mo paid-API budget CLAUDE.md sets aside, so stacking a second
     paid tier here would be defaulting into a cost rather than deciding on it.
- **`api-football.ts` is unverified against a real response.** It's written
  against API-Football v3's publicly documented response shape, but this session
  never received an actual response to check it against (no key, no network path
  to the host). Treat the field names in there as "best effort, confirm before a
  large backfill," not "known correct."

### Follow-up, same day: data scope vs. app scope, and a snapshot layer

Clarified after the initial pass: the full-depth Championship/FA Cup data is for
**the model only** — the frontend and API only ever surface Premier League. This
didn't change the schema at all (it was already competition-agnostic — teams,
fixtures, and lineups were never scoped to one competition), which is a decent
sign the schema design held up under a real scope clarification instead of
needing rework. It does mean Phase 2's endpoints need to filter to Premier
League deliberately rather than exposing everything the schema can hold — noted
in `docs/architecture.md` and `docs/CLAUDE.md` so it isn't lost before Phase 2.

Also added a **second storage layer on top of the raw cache**: `backend/seed/dump.ts`
/ `restore.ts` (`npm run db:dump` / `db:restore`) wrap `pg_dump`/`pg_restore` to
snapshot the fully seeded database itself, committed to git at
`backend/seed/snapshot/mentat_fc_seed.dump`. These solve two different problems,
not the same one twice:

- `seed/raw/` (gitignored) protects the **API budget** during the weeks-long
  backfill — fetch-if-absent, so reruns never re-spend the 100/day cap.
- The snapshot protects **setup time on a new environment** — restoring it skips
  the entire parse-and-upsert pipeline (thousands of rows) in favor of one
  `pg_restore` call, no network involved at all. This is the concrete answer to
  "store it somewhere so we don't have to hit the API to seed local environments."

Tested the same way as the seed pipeline itself: dumped the scratch database
(410KB for one season + FPL data — small enough that committing it to git
outright, rather than a GitHub Release or external blob storage, is the right
call for now), wiped all 12 tables with `migrate down`, restored from the dump,
and confirmed identical row counts. The committed snapshot right now only has
the 2023/24 Premier League season + FPL bootstrap (the only data this session
could actually test against) — `docs/seeding-runbook.md` has the full step-by-step
plan for running the real 3-competition, 3-season, full-lineup backfill on a
machine with real internet access, and re-dumping once it's done.

Added `npm run check:lineup-depth` — the empirical test flagged earlier (does
API-Football's free tier serve lineup data for old fixtures at all?) as an
actual runnable script rather than a manual instruction, so it's not something
that quietly gets skipped before the real backfill starts.

### Second follow-up, same day: golden records, expected-goals features, and player performance depth

**Secrets, and a reminder of a real constraint.** Asked to paste a real
`API_FOOTBALL_KEY` into chat so it could be committed to the branch — that's
two things to never do: secrets never enter git history (that's the entire
reason `.env` is gitignored and `.env.example` only has placeholders), and
this cloud session's network policy blocks `v3.football.api-sports.io`
outright (confirmed with a direct test — 403 at the proxy, same as
football-data.co.uk), so it couldn't have been used here regardless. The key
belongs in `backend/.env` on a machine with real internet access.

**Golden records via deterministic hashing.** Proposed hashing team
name+location and player name+position into a primary key. Landed somewhere
close but adjusted both: teams hash name alone (a stadium/sponsor rename
would otherwise silently change a team's key, which defeats the point of a
*stable* identity), and players hash full name + date of birth instead of
position (position isn't a fixed identity attribute and doesn't disambiguate
same-name players anyway; DOB is on both FPL's and API-Football's profiles).
Implemented as `natural_key`, a `GENERATED ALWAYS ... STORED` column on both
`teams` and `players` (migration `1701000000013`) rather than a hash computed
in TypeScript — the point being it's *impossible* for the key to drift out of
sync with the row, since Postgres derives it from the row's own columns every
time.

This surfaced a real, useful error: Postgres requires a generated column's
expression to be **immutable**, and two attempts failed that check before
one worked --- pgcrypto's `digest()` (SHA-256) isn't marked immutable, and
neither is casting `date` to `text` (depends on session `DateStyle`). Fixed
with built-in `md5()` (immutable, and cryptographic strength isn't a
requirement for a matching key, not a security one) and epoch-day integer
arithmetic (`date_of_birth - date '1970-01-01'`, immutable) instead of a text
cast. Concept worth keeping: **IMMUTABLE vs. STABLE vs. VOLATILE** is
Postgres's classification of whether a function's output depends on
anything beyond its literal arguments (session settings, the database,
wall-clock time) --- generated columns, and function-based indexes, both
require immutable expressions for the same reason: their stored/indexed
value has to be reconstructible byte-for-byte from the row alone, forever.

Also replaced the two source-specific player upsert functions
(`upsertPlayerByFplId`, `upsertPlayerByApiFootballId`) with a single
`upsertPlayerGoldenRecord` in `backend/seed/lib/db.ts`. This is the actual
fix for the gap flagged in the previous message (FPL and API-Football
creating two disconnected rows for the same real player): when a DOB is
known, upsert against `natural_key` directly; when it isn't (the normal
case for a player only seen via API-Football's lineup endpoint, which
doesn't include birth date), fall back to a case-insensitive name match
against an existing row first. Tested for real: seeded a player from FPL
(with a real DOB), then simulated an API-Football sighting of the *same
name* with no DOB and a fake external id --- it correctly reused the
existing row (still one row for "Kepa Arrizabalaga Revuelta," not two),
merging in the new `external_api_football_id` while keeping the original
`external_fpl_id` and `date_of_birth`. Named honestly in the code: two
genuinely different real players sharing an exact name and both missing a
DOB would still incorrectly merge --- acceptable at Premier
League/Championship scale, revisit only if FA Cup's lower-tier entrants
make that collision observably real.

**Scope update: predictions aren't Premier-League-only.** Clarified that
match predictions should cover Premier League *and* Championship, plus FA
Cup fixtures where both teams are in one of those two tiers (most FA Cup
matchups from the Third Round on qualify); an FA Cup fixture against a
lower-tier side gets a default logo and no prediction rather than a guess.
Team dashboards/fantasy/betting stay Premier League only. Updated
`docs/CLAUDE.md` and `docs/architecture.md` --- no schema change, this is
purely a Phase 2 endpoint-filtering decision.

**Expected-goals-style score predictions ("3.2 - 0.4") already just work.**
`model_predictions.predicted_home_goals`/`predicted_away_goals` were already
`numeric`, not `integer`, from the original Phase 1 design --- Postgres
`numeric` stores exact decimals natively. Nothing to change; worth noting
that the schema quietly already supported this because "numeric, not
integer" was the right default the first time, not because it was designed
for this specific ask.

**`team_fixture_results`, a view, not a stored table.** Added to make
season-level team stats (record, goal difference, form) easy to query
without hand-written home-vs-away `CASE` logic every time --- it unpivots
`fixtures` + `fixture_team_stats` into one row per team per fixture, always
from that team's own perspective (`goals_for`/`goals_against`/`result`/
`points`). Still a view, not a materialized/stored table, for the same
reason there's no stored standings table: it's fully derivable from source
data, so storing it separately would just be another place for staleness to
creep in. Verified against real data, not just eyeballed: querying it for
the 2023/24 season reproduces the actual final Premier League table exactly
(Man City 91 points and champions, Arsenal 89, Liverpool 82, Aston Villa 68,
Tottenham 66). Also added `fixture_team_stats.xg` (expected goals) as a
nullable column --- a real gap (football-data.co.uk doesn't have it), source
unconfirmed (API-Football's fixture-statistics endpoint, maybe), left
unpopulated until that's confirmed.

**`fixture_player_stats`: a deliberate scope reopening, not scope creep.**
Until now, player data beyond identity was: who started/subbed
(`fixture_lineups`, no performance detail) plus FPL's current-PL-season
gameweek stats. For the historical Championship/FA Cup depth this project
actually wants for the model, there was no goals/assists/cards/minutes at
all. Flagged the real cost of closing that gap before building it: API-Football
splits "who played" (lineups) from "how did they perform" (a *separate*
per-fixture endpoint), so adding this doubles the backfill's daily-budget
cost. Decision: accept the doubled cost, pay for a higher tier once this
code is verified working, rather than wait out the free tier or skip it.
Added `fixture_player_stats` (migration `1701000000015`) --- minutes played,
rating, goals, assists, shots, passes, tackles, cards, penalties, saves,
one row per player per fixture --- and `seedApiFootballPlayerStats` in
`backend/seed/sources/api-football.ts`. `minutes_played` lives here now, not
on `fixture_lineups`, since it comes from this endpoint specifically. The
resumable backfill (`backfillLineupsForCompetitionSeason`) now checks each
fixture for lineups and player stats *independently* and only fetches
whichever is actually missing, so a fixture that already has lineups from an
earlier run doesn't burn budget re-fetching them just because player stats
arrived as a feature later. `npm run check:lineup-depth` now tests both
endpoints against the same fixture and reports on each separately, since
they could plausibly behave differently (one confirmed working, one not).

**Recurring refresh jobs: designed now, deliberately not built yet.** Asked
about keeping Postgres current after the initial historical backfill (new
fixtures, results going final, FPL prices shifting daily). Agreed to design
now, build once Phase 2's API actually exists to consume fresher data ---
building a refresh job with nothing reading its output would be premature.
The design (in `docs/architecture.md`) turned out to need zero new fetching
logic: every seed source already does idempotent upserts, so "refresh" is
just rerunning the existing functions scoped to the *current*
competition-season instead of 3 years of history. Scheduling itself (cron
locally, Azure Container Apps Jobs once deployed) is the same pattern
already planned for the model service's batch job, not a new concept.

Re-dumped `backend/seed/snapshot/mentat_fc_seed.dump` after each schema
change in this session (golden-record keys, the view, `fixture_player_stats`)
so the committed snapshot stays in sync with what the migrations actually
produce.

---

## Phase 2 — Backend API core (2026-07-29)

### What we built

Express endpoints in `backend/src/`, split into three layers for the first
time (Phase 0's learning-log explicitly deferred this until there was more
than one endpoint to justify it):

- **`routes/`** — just URL + HTTP method → controller function mapping.
- **`controllers/`** — parse/validate the request (query params, route
  params), call a service, shape the response. No SQL here.
- **`services/`** — the actual `pool.query(...)` calls and business logic.
  No knowledge of `req`/`res` here — a service could be called from a CLI
  script or a test with zero changes.

Endpoints: `GET /api/teams`, `GET /api/teams/:id`,
`GET /api/teams/:id/dashboard` (next match + prediction if one exists,
league table position, squad), `GET /api/fixtures` (filterable by
competition/team/date range), `GET /api/fixtures/:id` (team stats, all odds
rows, latest prediction), `GET /api/players` and `GET /api/players/:id`.

**Deliberately read-only — no POST/PUT/DELETE**, even though PHASES.md's
checklist said "CRUD endpoints." Nothing about teams/fixtures/players is
ever authored through this API: the seed pipeline and the (future) refresh
job own writing this data. Building create/update/delete for a resource
nothing ever calls would be unused surface area — the same "don't build for
a need that doesn't exist" reasoning applied throughout Phase 1.

Error handling: a small typed hierarchy (`AppError`, `NotFoundError` in
`src/lib/errors.ts`) and one centralized `errorHandler` middleware
(`src/middleware/errorHandler.ts`) that turns a thrown error into the right
status code + JSON body. Controllers just `throw new NotFoundError(...)` —
they don't know or care how that becomes an HTTP response.

### Concepts this taught

- **Why routes/controllers/services, not one file.** `src/index.ts` used to
  hold the entire app (one route, inline). That's fine at one endpoint; past
  that, mixing "what URL matches this," "how do I validate this request,"
  and "what SQL answers this" in one function makes each one harder to
  change without touching the others. Splitting them means a service can be
  tested or reused without spinning up Express at all, and a controller's
  validation logic doesn't depend on knowing SQL.
- **Express 5 changed a real Express 4 pain point.** In Express 4, an async
  route handler that throws or rejects does *not* automatically reach your
  error middleware — every tutorial either wraps handlers in try/catch or
  pulls in the `express-async-errors` package as a workaround. Express 5
  (already the version installed here from Phase 0) forwards rejected
  promises from async handlers to error middleware automatically. Every
  controller here is a plain `async function` that just `throw`s on
  failure — no wrapper needed. Worth knowing this is version-specific: code
  copied from an older Express 4 tutorial would need the workaround this
  project doesn't.
- **Error middleware position is the routing mechanism, not a path.** Express
  recognizes error-handling middleware by its arity (4 parameters:
  `(err, req, res, next)`), and only middleware registered *after* a route
  can catch that route's errors. `app.use(errorHandler)` has to be the last
  thing registered in `src/index.ts` — moving it earlier would silently stop
  it from seeing errors from routes below it.
- **A real gap found by building the feature, not planning it.** The team
  dashboard's "squad" needed *some* way to answer "who's on this team," and
  there wasn't one: `fixture_lineups` (the eventual real source) is empty
  until the paid-tier backfill runs, and nothing had ever captured a
  player's team from FPL's `bootstrap-static` (`element.team` was parsed for
  position but the team link was dropped). Added `players.current_team_id`
  (migration `1701000000016`), populated from FPL — Premier League only,
  since FPL has no Championship players, which means Championship dashboards
  get an empty squad until lineups exist. Documented as a known gap, not
  silently left broken.
- **A stale snapshot, and why that's expected, not a bug.** Restoring the
  previously-committed `seed/snapshot/mentat_fc_seed.dump` against the new
  schema failed (`cannot drop table teams because other objects depend on
  it` — the new `players.current_team_id` foreign key). Postgres restores
  objects in dependency order captured *at dump time*; a dump taken before a
  new foreign key existed doesn't know to drop it first. This is exactly why
  `docs/seeding-runbook.md` says to re-dump after every schema change —
  re-seeded from the cached raw CSV/JSON (no network needed) and re-dumped.

### Decisions worth remembering

- **"Next match" isn't filtered to Premier League/Championship.** It shows
  the team's next fixture across any competition (including FA Cup against
  a lower-tier side); the *prediction* attached to it is what's
  conditionally missing, via a plain `LEFT JOIN`-style lookup that returns
  `null` when there's nothing in `model_predictions` yet. This naturally
  handles both "Phase 5 hasn't run yet" and "this opponent is out of scope
  for a prediction" the same way, without the API needing to know which
  case it's in.
- **Table position falls back to "most recent season with fixtures for this
  team"** rather than a genuine "current season" flag, because
  `competition_seasons.is_current` was designed in Phase 1's schema but
  nothing has ever set it to `true` — there's only ever been one season's
  worth of data in any environment so far. Revisit once multiple seasons are
  actually seeded and "current" needs to mean something more precise than
  "most recent by start date."
- **Verified against real data, not just "it returned 200."** Arsenal's
  dashboard reports 2nd place, 89 points, 91 goals for, 29 against for
  2023/24 — the actual final table. `GET /api/fixtures/1` returns Burnley
  0-3 Manchester City, referee C Pawson — the same row spot-checked against
  the raw CSV back in Phase 1. 404s and 400s (bad ID, non-numeric query
  param) checked directly against a running server, not assumed from
  reading the code.

---

## Phase 3 — Frontend shell (2026-07-29)

### What we built

Two pages in `frontend/src/`: a team list (`pages/TeamListPage.tsx`, the
team switcher's home) and a team dashboard (`pages/TeamDashboardPage.tsx`),
wired up with `react-router-dom` (`/` and `/teams/:id`). A shared
`components/TeamSwitcher.tsx` (a team-picker dropdown that navigates on
selection) appears on the dashboard page. `hooks/useFetch.ts` is a small
custom hook wrapping `fetch` with loading/error state and a
cancelled-request guard; `api/client.ts` + `api/types.ts` centralize the
backend base URL and response shapes.

### Concepts this taught

- **Client state vs. server state, concretely, not just as a definition.**
  `TeamSwitcher`'s `<select>` has both in the same ten lines: which option
  is *currently rendered as selected* is server state (it's derived from
  the `currentTeamId` prop, which came from the URL, which reflects
  whatever team the dashboard is currently showing — backend-owned data by
  way of the route). The act of choosing a new option and firing
  `navigate(...)` is a momentary client-side interaction with no state of
  its own worth keeping — React doesn't need a `useState` for "what the user
  just clicked," the URL change *is* the new source of truth. The
  distinction that actually matters in practice: server state needs
  loading/error handling and can go stale; client state doesn't have either
  of those problems because nothing external can invalidate it.
- **Why a custom hook now, a library later.** `useFetch` duplicates what
  TanStack Query would give for free (caching, dedup, refetch-on-focus) —
  deliberately not pulled in for two pages. The tell for when to actually
  reach for a library: the moment navigating *back* to a team you already
  viewed should feel instant instead of showing a loading spinner again,
  plain `useState`+`useEffect` can't do that without hand-rolling a cache,
  and that's not worth building from scratch.
- **The cancelled-request guard in `useFetch` is a real race condition, not
  defensive-programming theater.** Click through teams quickly enough and
  two fetches are in flight; without the `cancelled` flag, whichever
  response arrives *second* wins, even if it was requested *first* — a user
  looking at Team B's dashboard could briefly see Team A's data land on top
  of it. The cleanup function returned from `useEffect` runs before the next
  effect (i.e., before the next fetch starts), which is exactly when a
  stale in-flight request needs to be told "ignore your result."

### Decisions worth remembering

- **Verified in an actual browser, not just `tsc --noEmit`.** Ran both dev
  servers, drove Chromium via Playwright: the team list renders all 20 real
  Premier League teams, clicking through to Arsenal's dashboard renders the
  real 2023/24 final table (2nd, 89 pts, 91-29) and the real current squad
  (Saka, Ødegaard, Rice, Saliba, ...), zero console errors. A fixed
  screenshot mid-navigation initially caught a "Loading…" frame — not a bug,
  just proof the loading state renders — recaptured after waiting for
  content to confirm the fully-loaded page.
- **A dependency vulnerability, read rather than reflexively patched.**
  `react-router-dom` pulled in a "high severity" advisory (RSC-mode CSRF
  bypass). Read what it actually requires: React Router's server-actions/RSC
  framework mode, which this app doesn't use at all (plain client-side
  `BrowserRouter`). Noted rather than force-downgrading to the suggested
  fixed version, which would have meant an older release with unclear React
  19 compatibility for a vector that doesn't apply to how this app is built.
- **Cleaned up the default Vite template fully** (counter button, template
  CSS, unused logo/hero assets) rather than leaving dead code alongside the
  real app — same standard as removing anything else no longer used.

---

## Phase 4 — FPL fantasy integration (2026-07-30)

### What we built

- **`seedFplPlayerGameweekHistory`** (`backend/seed/sources/fpl.ts`): one
  call per player to FPL's `element-summary` endpoint, filling in
  `fpl_player_gameweek_stats` (goals/assists/bonus/bps/minutes per player
  per gameweek) — the table existed since Phase 1's schema design but was
  never populated until now. Cached and resumable the same way as
  API-Football's backfill; throttled with a small delay between requests
  even though FPL documents no rate limit, since ~700+ rapid requests
  against someone else's free API is worth being polite about regardless.
- **`GET /api/fpl/my-team`**: the first backend service that calls an
  external API live, per request, instead of only reading Postgres — see
  the "one deliberate exception" note in `docs/architecture.md`. Calls
  FPL's public `entry` and `entry/.../picks` endpoints (no login needed,
  just the entry ID), joins the results against players we already have
  cached locally for names/positions/teams.
- A **`UpstreamError`** type (`src/lib/errors.ts`, extends `AppError`,
  status 502) distinct from our own 500s — see below.
- A "My Team" frontend page plus a small persistent nav bar (the first
  thing on every page, not just the dashboard) so it's reachable from
  anywhere.

### Concepts this taught

- **Why `getMyTeam()` doesn't recompute FPL's scoring rules.** The
  temptation with "gameweek scoring against real FPL rules" is to
  reimplement the points formula from raw stats (goals by position,
  assists, bonus, etc.). We don't: FPL's own `picks` response already
  includes `entry_history.points` — their own computed total for that
  gameweek, plus each pick's `multiplier` (0/1/2/3 for bench/normal/
  captain/triple-captain). Consuming the source's own computed result is
  both less code and structurally can't be wrong the way a from-scratch
  reimplementation of a fairly detailed scoring system could be. The real
  logic we do own is *interpretation*: `squadPosition <= 11` means
  starting XI, `multiplier` distinguishes captain from a benched player.
- **502 vs. 500, and why the distinction is worth a dedicated error type.**
  `UpstreamError` (502) means "a service we depend on failed us"; the
  existing generic 500 path means "we have a bug." They're different
  failure modes with different fixes — one you can't do anything about
  except wait or retry, the other means opening the code. Making this a
  distinct type (not just picking status 502 inline) means the distinction
  is enforced everywhere the type is used, not just wherever someone
  remembered to.
- **Confirmed, not assumed: this container can't reach `fantasy.premierleague.com`
  either** (403 at the proxy, same as football-data.co.uk and
  API-Football, tested directly). Every FPL-touching piece built this phase
  is therefore "written correctly, unverified against a live response" —
  same honesty standard as `sources/api-football.ts` from Phase 1. What
  *was* verified for real, live in a browser: the "not configured" error
  path (`FPL_ENTRY_ID` unset → 400, clear message) and the "configured but
  unreachable" path (set to a placeholder ID → live fetch attempted → 403
  from the proxy → correctly surfaced as a 502, not a crash) both trace
  cleanly through service → error middleware → frontend `useFetch` → a
  readable message on the page. The one thing that still needs a real
  `FPL_ENTRY_ID` and a machine with real network access: the actual
  success path with real squad data.
- **`selected_by_percent` is honestly left null for historical per-gameweek
  rows.** `element-summary`'s `history` gives a raw ownership *count* at
  that point in time, not the percent `bootstrap-static` reports for the
  live snapshot. Rather than fake a percentage from a count without
  knowing that gameweek's total manager count, the column just stays null
  for rows from this source — an honest gap, not a wrong number.

### Decisions worth remembering

- **Not every service reads Postgres, and that's fine when it's
  deliberate.** `getMyTeam()` breaks the "services only read Postgres"
  pattern established in Phase 2 on purpose — single-user, low-volume,
  changes weekly, no rate-limit budget to protect. Worth restating: the
  pattern was never "services must never call external APIs," it was
  "don't call external APIs live from a request handler when the data is
  bulk/historical and would benefit from batch pre-loading." Squad picks
  fail that test in the other direction.
- **Still waiting on a real `FPL_ENTRY_ID`** to actually run the backfill
  and test `/api/fpl/my-team` against real data. Everything is built and
  its error paths are verified; the happy path is the one piece that needs
  your machine, your ID, and real network access to confirm.

### Follow-up, same day: real-machine testing, a real bug found, and a local-dev pivot

Got a real `FPL_ENTRY_ID` (2159850) and tried testing against it on a
borrowed Mac. Several real things came out of this, worth recording
separately from the code itself:

**`entry.current_event` being `null` pre-season was confirmed for real, not
just theorized.** The live call to `/entry/{id}/` succeeded and correctly
reported no current gameweek — proof the entry/picks integration is
fundamentally sound, just untested past that first call. Decided to add a
gameweek-1 preview fallback (`isPreview` on `MyTeam`) rather than only
saying "nothing to show": `fetchPicksOrNull` tries `/event/1/picks/` when
there's no current event, distinguishing a 404 ("no picks saved yet,"
expected pre-season, return a clean message) from any other failure (a
genuine `UpstreamError`, still surfaced as one). Needed adding an
`upstreamStatus` field to `UpstreamError` to make that distinction — a
generic "something failed" 502 isn't enough information for a caller to
decide whether a specific failure mode is expected.

**A real Docker/Colima setup problem, diagnosed with actual signal.**
`GET /api/teams` came back "Internal server error" — not a per-team bug the
error location (the team *list* endpoint, not a specific dashboard)
narrowed it down. The useful fact: **`/health` only ever proves the
database is *reachable* (`SELECT 1`), never that migrations actually ran**
— an empty, unmigrated database passes `/health` and then fails on every
real query with something like `relation "teams" does not exist`. Traced
back to Colima's VM not actually running (`docker compose exec` failed
with the exact same "dial unix /var/run/docker.sock" error as the very
first setup attempt) — Colima needs restarting after a reboot/sleep, it's
not a one-time start.

**Then hit a real hardware wall, not a config mistake:** this particular
machine is on macOS 12, old enough that Homebrew's build toolchain
(`meson`) refuses to build some of Colima's dependencies at all. Not
something to debug further — some things are genuinely version walls, and
recognizing "this isn't fixable by trying harder" is as important a skill
as debugging itself.

**Decision: hybrid local dev, not a premature full cloud deployment.**
Considered standing up the real Render/Vercel/Neon stack right now instead
of fighting Docker locally, and deliberately didn't: `backend`/`frontend`
still run locally via `npm run dev` (that part was never broken — Node,
npm, `tsc`, Vite all worked fine all along), only Postgres moves to a free
Neon project. Full deployment means CI/CD, secrets across three platforms,
and Render's free-tier cold starts on every test — real overhead that
Phase 10 was deliberately sequenced last specifically to avoid taking on
before the app's features are done. Documented the setup in
`docs/seeding-runbook.md`'s new "No Docker available?" section: use
`npm run db:seed` instead of `npm run db:restore` on a Docker-less
machine, since `db:restore` shells out to `pg_dump`/`pg_restore` CLI
binaries that may hit the exact same Homebrew wall, while `db:seed` is
pure Node/`fetch` and needs nothing installed beyond what `npm install`
already provides. Confirmed separately (browser test) that this machine
*can* reach football-data.co.uk, so this path should actually work once
set up.

**Not done tonight — picking this up next session:** actually create the
Neon project, set `DATABASE_URL`, and run `migrate:up` + `db:seed` for
real. This would also be the first full historical seed run by anyone,
cloud sandbox included — worth treating as a real milestone once it
happens, not just "finally got local dev working."

---

## Phase 5 — Prediction model service, match outcome (2026-07-30/08-08)

### What we built

`model-service/app/`: `dixon_coles.py` (the actual model — fit + predict),
`data.py` (loads results/odds from Postgres into pandas), `train.py` (batch
job: fit, predict every upcoming fixture, upsert into `model_predictions`),
`evaluate.py` (backtest against a held-out season slice and a closing-odds
baseline). Added `numpy`, `scipy`, `pandas`, `psycopg[binary]` to
`requirements.txt` (frozen via `pip freeze`, same lockfile discipline as
Phase 0). Tested end-to-end against a scratch Postgres seeded with the real
2023/24 Premier League season — the only real data available to test
against in this session.

### Why odds are a baseline, never a training input

Worked through this as a design discussion before writing any code: feeding
betting odds into the model as a feature would be *leakage* — odds are
themselves an extremely strong, market-tested prediction, so a model trained
on them would mostly just learn to echo the market instead of learning
anything from the underlying football data. Worse, it would make the
model's opinion structurally incapable of *disagreeing* with the market,
which defeats the entire point of the betting-comparison feature this
project wants. Odds belong exactly one place: `evaluate.py` converts closing
`fixture_odds` prices to implied probabilities (`1/price`, renormalized to
remove the bookmaker's built-in margin) purely as a benchmark to score the
model against, never as something the model sees during fitting.

### Why Dixon-Coles specifically, and what it actually does

Goals fit a Poisson distribution (discrete counts of relatively rare,
roughly independent events over a fixed window) — the whole modeling
problem reduces to estimating one number, λ (expected goals), per team per
match. The base version (sometimes called the Maher model): each team gets
an attack strength and a defense weakness, `λ_home = attack_home ×
defense_away × home_advantage`, fit by maximum likelihood across all
historical matches at once. Dixon & Coles (1997) added two real
refinements: a correlation correction (`rho`) for the four low-scoring
cells (0-0, 1-0, 0-1, 1-1), since a plain independent-Poisson model
systematically underestimates how often real football produces those
scorelines; and time-weighting, so a result from a year ago counts for less
than one from last month (implemented as exponential decay off a
configurable half-life, `_time_weight` in `dixon_coles.py`).

Chosen over XGBoost for three concrete reasons, not just "it's the classic
approach": it produces the "3.2 - 0.4" expected-goals output the project
explicitly wanted *natively* (λ is the number, not something derived
after the fact); it's parameter-efficient for a modest dataset (one
attack + one defense number per team, versus XGBoost's much larger
hypothesis space, which risks overfitting on a few thousand matches); and
it's interpretable — "Arsenal's attack strength is 1.50" is something you
can sanity-check by eye against the real table, which mattered for trusting
the result during testing (see below).

### A real bug caught by verifying against known facts, not just "it ran"

The first version of `predict()` had `prob_home_win` and `prob_away_win`
swapped — an easy mistake, since `numpy.triu`/`numpy.tril` name their
triangles by matrix position (upper/lower), not by football meaning, and
it's not obvious at a glance which one corresponds to "home goals greater
than away goals" in a grid indexed `[home_goals, away_goals]`. Caught it
with a three-line numpy sanity check *before* trusting a full model run —
built a tiny grid with a known single result and confirmed which numpy
function actually summed it correctly, rather than reasoning about matrix
triangles from memory and hoping. Once fixed, the model's real output
matched real history exactly: Manchester City had the highest fitted attack
strength (1.61) and were 2023/24's actual champions and top scorers;
Arsenal had the best fitted defense (0.63) and had the league's actual best
defensive record that season; Sheffield United (relegated, bottom of the
table) had the *worst* fitted attack strength. This is the same lesson as
Phase 1's `getOrCreateCompetition` bug and Phase 2's team-dashboard
verification: a script completing without an exception proves nothing by
itself — checking the actual numbers against known reality is what catches
a bug like a swapped triangle, which would otherwise have silently flipped
every single prediction the model ever made.

### Two smaller real bugs, also only found by running real data through it

- **Identifiability**: the raw fit has a one-parameter ridge of equivalent
  solutions — you can add a constant to every team's log-attack and
  subtract it from every team's log-defense and every prediction stays
  identical (the algebra: `(a_i+c) + (d_j-c) = a_i+d_j`). This isn't a bug
  in the sense of wrong predictions, but it means the raw fitted numbers
  landing wherever the optimizer's starting point happens to put them
  isn't meaningful for interpretation. Fixed with a post-fit
  renormalization (recenter so `mean(log_attack) == 0`, i.e. "1.0" means
  exactly league-average) — doesn't touch a single prediction, just makes
  the numbers a human can actually read.
- **`decimal.Decimal` vs. `float`**: `1.0 / price` on odds pulled from
  Postgres threw `TypeError: unsupported operand type(s) for /: 'float'
  and 'decimal.Decimal'` — psycopg returns Postgres `numeric` columns as
  Python `Decimal`, not `float`, and the two don't mix in arithmetic
  without an explicit cast. `fixture_odds.price` is `numeric` (Phase 1's
  schema), so this was always going to happen the first time real odds
  data actually flowed through this code path — fixed with an explicit
  `.astype(float)` right after loading. Also swapped `pandas.read_sql`
  (which only officially supports SQLAlchemy connections and prints a
  `UserWarning` against a raw psycopg connection on every call) for a small
  cursor-based helper, avoiding both problems in one pass rather than
  suppressing a warning that was actually pointing at something real.

### The honest backtest result, and why it's the correct one to get

`evaluate.py` holds out the most recent 20% of a season's matches by date,
fits on the rest, and scores both the model and the closing-odds baseline
with Brier score and log-loss on the same held-out matches. Real result,
2023/24 Premier League, 76 held-out matches: model Brier 0.5416 vs. market
0.4904 (lower is better) — the model lost. Exactly what was predicted in
the design discussion before any code was written: a model trained purely
on historical goals, with no injury news, no lineup news, no market money
flow, isn't expected to beat an efficient closing line. Getting this result
honestly, and having the mechanism to *know* it rather than assume, is the
actual point of building the evaluation step — a model that silently looked
great with no baseline to check against would have been far more worrying
than one that loses to the market and shows its work.

### A scope gap found by writing the training loop, not by planning ahead

Building `train.py` surfaced a real limitation the original phase plan
didn't anticipate: Dixon-Coles is fit **per competition** (one full
optimization for Premier League, a separate one for Championship), because
attack/defense numbers are only meaningful relative to the other teams in
the same fit. That means FA Cup — the plan's own stated goal was "predict
fixtures where both teams are Premier League/Championship sides" — can't
actually be predicted yet: a Premier League team's fitted strength and a
Championship team's fitted strength live on two different, incomparable
scales. Making them comparable (a joint fit, or a bridging adjustment
between the two competitions' scales) is real additional modeling work,
not a small fix. Documented as an explicit, deliberate deferral in
`docs/PHASES.md` and `docs/CLAUDE.md` rather than silently shipping FA Cup
predictions that would have been comparing apples to oranges, or silently
dropping the FA Cup goal without saying so.

### The real, full-scale backtest (run by the user, on real Neon data)

Ran `python -m app.evaluate` against the fully seeded Neon database — 3
seasons, both competitions. Match counts confirm the seed landed exactly
right: Premier League 912 train / 228 test (1140 = 3 × 380, correct);
Championship 1324 train / 332 test (1656 = 3 × 552, correct).

Real result: Premier League model Brier 0.6517 vs. market 0.6300;
Championship model 0.6359 vs. market 0.6204. Model still loses on both —
still the expected, correct outcome — but the **gap narrowed** versus the
single-season test (was ~0.05, now ~0.02/0.015), consistent with more
training data producing more stable per-team estimates.

Worth understanding *why* both scores got worse in absolute terms compared
to the single-season backtest, since the instinct "more data should help"
doesn't immediately explain it: the single-season test trained and tested
*within the same season* (predict late-2023/24 from early-2023/24), where
team strength barely shifts. The 3-season test's held-out slice spans a
season boundary, so the model (and the market) now have to generalize
across real squad turnover — transfers, promotions/relegations, manager
changes — a genuinely harder problem, which is exactly why the *market's*
score got worse too, not just the model's. The single-season number was
also a noisier, smaller sample (76 matches vs. 228/332) — the larger result
is the one worth trusting.

**Championship's gap to the market (0.0155) is smaller than Premier
League's (0.0217)** — a real, if modest, data point in favor of the
"less-watched markets are less efficient" theory discussed earlier in this
project, not proof of it. One backtest, worth watching rather than acting
on.

One tuning knob surfaced by thinking through this, not yet explored: the
default time-decay half-life (180 days) means a 3-season-old match already
carries ~2% of a recent match's weight, so "3 seasons of data" isn't really
"3x the effective signal" — most of the model's influence still comes from
roughly the last season regardless of how much history is loaded.

### Half-life, made concrete and tuned

Worked through actual weight numbers rather than reasoning about "half-life"
abstractly: at 180 days, a match from last month already carries ~89%
weight (recency already mattered quite a bit by default) -- what a shorter
half-life really buys isn't "recent games count," it's "everything *beyond*
recent counts dramatically less." At 60 days, a 90-day-old match is down to
35%, a year-old one to ~1.5%.

The real tradeoff going shorter: a team plays ~4-5 matches a month, so a
very short half-life fits two parameters (attack, defense) per team off an
increasingly small, noisy effective sample -- the classic "form vs. true
quality" tension in sports modeling, where chasing recent results too hard
means chasing luck (a deflected goal, a red card) rather than tracking real
changes (transfers, injuries, a new manager).

Landed on 60 days as a starting point -- meaningfully shorter than the
180-day default without collapsing to just the last handful of games.
Pulled it out as a named `HALF_LIFE_DAYS` constant at the top of both
`app/train.py` and `app/evaluate.py` (duplicated between the two on
purpose, not shared from one module -- `evaluate.py` doubles as the
experimentation sandbox for trying a candidate value, `train.py` is the
deployed choice; keeping them separate means testing a new value doesn't
silently change what's actually written to `model_predictions` until
deliberately copied over).

Tested the plumbing works locally (only Premier League 2023/24 available
here) -- and honestly, it did *slightly worse* on that single-season test
(Brier 0.5485 vs. 0.5416 at 180 days). Not a contradiction: with only one
season to test against, a shorter half-life just shrinks the effective
sample with nothing to gain -- the actual benefit (discounting stale,
multi-season-old squad compositions) can't show up until there's more than
one season's worth of history to discount. Real comparison needs rerunning
`python -m app.evaluate` against the full 3-season Neon data and comparing
to the 180-day baseline already recorded above.

**The real result, against the full 3-season Neon data:**

| Half-life | Premier League Brier | Championship Brier |
|---|---|---|
| 180 days (original default) | 0.6517 | 0.6359 |
| 120 days | 0.6561 | 0.6409 |
| 60 days | 0.6682 | 0.6575 |

Monotonic in both leagues, no exceptions -- every step shorter made
predictions worse. The instinct going in ("recent form should count for
more") wasn't wrong exactly, it just doesn't apply the way it would to a
form-tracking model. Dixon-Coles isn't scoring "how hot is this team right
now" -- it's estimating each team's underlying attack/defense strength,
a property that changes slowly (transfers, injuries, a new manager), not
week to week. Shortening the half-life doesn't sharpen that estimate, it
starves it: at 60 days the effective sample per team drops to roughly the
last 8-10 matches, small enough that one freak scoreline or a lucky
deflection swings the fitted parameters noticeably. The 180-day setting was
already doing something like "smooth over a mini-season," and that
smoothing turned out to matter more than the staleness it costs.

Reverted `HALF_LIFE_DAYS` back to `180` in both `app/train.py` (the
deployed value) and `app/evaluate.py` (the sandbox, now recording what's
already been tried in its own comment) rather than shipping a config the
real data said was worse. This is the actual point of having a real
backtest instead of reasoning from intuition alone -- a plausible-sounding
idea (weight recent form more) can be measured and found to not hold up,
and that's a more useful outcome than either blindly shipping the instinct
or never testing it at all. A natural follow-up worth trying later:
whether an *even longer* half-life (e.g. 365 days) does better still, now
that the direction of the trend is established -- not pursued now since
the goal here was validating the specific "shorter is better" hypothesis,
which the data answered.

### Reading a Brier score, and why it's meaningless without a baseline

After the real backtest, worked through what the actual numbers (0.62-0.68)
mean rather than just comparing them to each other. Brier score is the mean
squared error between the predicted probability vector and the one-hot
actual outcome -- 0 is perfect, and there's no other fixed "good" value,
because it depends entirely on how hard the underlying prediction problem
is. What makes a number meaningful is a baseline on the *same* matches:

- Guessing uniformly (33/33/33 every time, no model at all) scores a fixed
  **0.667** -- constant regardless of outcome, since the squared-error math
  works out the same either way.
- The model, across every half-life tried, scored **0.65-0.68** -- only
  modestly ahead of blind guessing.
- The market (bookmaker closing odds) scored **0.62-0.63** -- meaningfully
  ahead of the model, expected since odds price in information (injuries,
  suspensions, lineup news, market money flow) a goals-only Dixon-Coles fit
  never sees.

So "beats uniform guessing, loses to the market" is the honest, specific
read of where a first-pass goals-only model actually stands -- not "0.65 is
bad" or "0.65 is fine," which are both meaningless without the comparison.

### Seeding the current season so there's something to predict

First real run of `app.train` against the full 3-season data produced a
correctly-fit model (`fitted on 1140 matches` for PL -- exactly 380 x 3, no
drops) but wrote **zero predictions**. Not a bug: the three seeded seasons
(2023/24, 2024/25, 2025/26) were all already fully played out by the time
this ran, and `load_upcoming_fixtures` correctly found no fixture with a
null score to predict.

The fix needed a new seed step, not a code change to the model: football-
data.co.uk's CSVs are structurally incapable of listing a fixture that
hasn't been played yet (there's no "played" concept in a source that's
purely a results feed), so getting an actual schedule of upcoming matches
requires API-Football's fixture-list endpoint instead, which returns every
fixture in a season -- played or not, with a status field, no score for the
ones still to come. Added `seedCurrentSeasonFixtureLists` in
`backend/seed/index.ts`, which pulls the full 2026/27 Premier League and
Championship fixture list via the same `seedApiFootballFixtures` function
already used for FA Cup, upserting against the same natural key the
football-data.co.uk importer uses -- so it enriches already-played matches
(adding venue/referee/external id) and inserts fresh rows for everything
still ahead, idempotently, safe to rerun as the season progresses. This is
a manual stand-in for the recurring refresh job `docs/PHASES.md`'s Phase 2
already flagged and deliberately deferred -- not a replacement for it, see
the updated note there.

Also split it out as its own entry point (`npm run db:seed:current-season`,
`backend/seed/current-season.ts`) rather than only being reachable through
the full `npm run db:seed` -- the full pipeline re-walks 3 seasons of
football-data.co.uk CSVs and the throttled FPL/lineup backfills every time,
all of which are either already done or their own slow job, so forcing a
full rerun just to pick up this week's fixture changes would be needless
waiting (and, for the API-Football-backed steps, needless budget spend).
Real gotcha caught before pushing: `index.ts`'s `main()` was called
unconditionally at module scope, so importing `seedCurrentSeasonFixtureLists`
from it for the new entry point would have silently run the *entire*
pipeline as a side effect of the `import` statement, before the new file's
own `main()` even started. Fixed by gating it behind
`import.meta.url === file://${process.argv[1]}` -- the ESM equivalent of
Python's `if __name__ == "__main__":` -- so the file is safe to import for
just its individual exported functions.

## Phase 6 — Betting tracker (2026-08-14)

### What "value" actually means

Every decimal odds number implies a probability: `1/odds`. Add up all three
match-winner outcomes' implied probabilities and they sum to *more* than
100% -- the bookmaker's margin, the "overround" (the exact same
renormalization already used in `model-service/app/data.py`'s market
baseline for backtesting). A bet has **value** when your own probability
estimate for an outcome is meaningfully higher than what the odds imply --
e.g. the model says 45%, the odds you got imply 35%. That gap is the actual
edge a personal model gives you over betting on instinct: any single bet's
outcome is luck either way, but making value bets consistently is what
should show up as positive ROI over a large enough sample. This is also
*why* the phase's checklist wants the model's prediction sitting right next
to a logged bet -- that comparison, not just recording wins and losses, is
the actual point of the feature.

### Schema: free text over enums, again

`bets.market`/`bets.selection` follow the same shape as `fixture_odds`'s
`market`/`outcome` columns from Phase 1 -- plain text, not a Postgres enum
or a foreign-keyed lookup table. A new bet type (an Asian handicap, an
over/under line, a player prop) is then just a new string value the
frontend knows how to render, never a migration. `result`, by contrast, got
a `CHECK` constraint (`pending`/`won`/`lost`/`void`) -- those four values
are closed and never grow, the opposite situation from `market`/`selection`,
so the tradeoff runs the other way: a `CHECK` catches a typo'd result at
insert time for free, which an open text column wouldn't.

Deliberately **no `user_id`** column -- `docs/CLAUDE.md` describes the
betting tracker as a single-user personal tracker throughout, not a
"waiting on Phase 9 auth" placeholder. `docs/erd.md` already had this
sketched out since Phase 1; Phase 6 just built it.

### Deferred: live market odds (The Odds API)

`docs/CLAUDE.md` names The Odds API as the intended live-odds source, but
integrating it got deliberately deferred this phase after weighing it out:
when you log a bet, you already know the odds you got -- you just placed
it. So the comparison that actually matters day-to-day is *your bet's own
odds vs. the model's probability*, which needs nothing beyond what's
already in the `bets` row. A live odds feed would matter for a different
feature -- shopping for the best line *before* placing a bet -- which
wasn't asked for and would add a new $29/mo-tier API, its own caching
design, and rate-limit handling for a comparison the app doesn't need yet.
Each `bets` API response still computes `edge` (model probability minus
your own implied probability) so the value-betting comparison works today,
just against your own logged odds rather than a live line.

### Testing this for real, not just "no exception thrown"

Backend: spun up a scratch local Postgres (`initdb`/`pg_ctl`, since this
sandbox has no Docker -- same approach used throughout this project),
restored the seed snapshot, ran the new migration on top of it, then
exercised every endpoint with real `curl` calls against real fixtures from
the snapshot -- not just checking success responses, but checking the
actual numbers: a bet at odds 1.35 settled `won` returned exactly
`20 * 1.35 = 27`, ROI summed correctly across a mixed won/lost pair
(`-22.857%`, hand-verified), and a manually-inserted `model_predictions`
row correctly flowed through to a bet's `modelProbability`/`edge` fields
for the right outcome (`away`, matching `prob_away_win`). Validation paths
(bad odds, bad stake, unknown fixture, unknown result, double-delete) all
returned the expected 400/404s.

Frontend: ran the actual Vite dev server against the actual Express
backend in a real browser (Playwright, headless Chromium, this sandbox's
pre-installed browser), not just a typecheck -- logged a real bet through
the UI form, watched the record/ROI summary update after settling it, and
confirmed zero console/page errors. One thing worth remembering for next
time: a Playwright full-page screenshot taken immediately after a state
update can catch the page mid-reflow and clip content that's actually
fine in the DOM (a table cell's text looked truncated in one screenshot;
`textContent()` on the actual element proved the data was correct all
along) -- a lesson in trusting the DOM over a screenshot's exact pixels
when the two disagree.

### Revisiting the design: real auth and parlays (2026-08-15)

The single-user, no-`user_id` design above was a deliberate call at the
time, made explicit back in Phase 1 -- but "deliberate" isn't the same as
"permanent." Once real multi-user login was actually wanted, and parlays
came up as a real feature (not hypothetical), both got built into Phase 6
directly rather than staying deferred. Two design threads worth recording:

**Pulling Phase 9's auth forward, not duplicating it.** JWT auth was
already on the roadmap for Phase 9; building it now instead of a
Phase-6-specific shortcut means Phase 9 doesn't rebuild it later. What a
JWT actually is: a signed, self-contained token (`header.payload.signature`,
base64url) proving "this is user X" without a server-side session lookup on
every request -- the payload (e.g. `{userId: 5, exp: ...}`) is plainly
readable (it's encoding, not encryption), but unforgeable, because the
signature is an HMAC of the payload using a secret only the server holds;
changing one byte of the payload produces a completely different signature.
Login exchanges a bcrypt-verified password for a signed token; every
request after that carries it as `Authorization: Bearer <token>`, and a
small `requireAuth` middleware verifies the signature and attaches
`req.userId` before the route handler runs. The alternative, server-side
sessions (a cookie + a sessions table looked up per request), is more
instantly revocable but needs shared session storage -- JWT was picked
because it needs nothing beyond Postgres, which the app already has.
Deliberately scoped `requireAuth` to just the `/api/bets` router, not the
whole API: bets are the only genuinely per-user data in this app so far
(teams, fixtures, `/my-team` are shared/public reads) -- gating everything
behind login would have been scope creep past what multi-user actually
requires today.

**Parlays forced a real schema rethink, not just new columns.** The
original `bets` table had `market`/`selection`/`odds_decimal`/`fixture_id`
directly on it -- one pick per bet, by construction. A parlay is a
different shape: one bet, several picks, a combined price, and a result
that only resolves once every pick does. Rather than bolt on a
`bet_type`/`parent_bet_id` special case, `bets` got split into a thin
container (`id`, `user_id`, `stake`, `placed_at`) and a new `bet_legs`
table holding the actual picks -- a straight bet is simply a bet with one
leg, not a separate code path from a parlay. This is the same "unify the
single case into the general case" move as treating a scalar as a
one-element array elsewhere in programming: it means `createBet` and the
settle/list logic only have one shape to handle, not two. Since the
original single-table `bets` migration hadn't been run anywhere but a
disposable scratch database (nothing shipped to the real Neon DB yet), it
was safe to directly edit/renumber the unmerged migration files rather
than layer an `ALTER TABLE` on top -- a real, deliberate exception to
"migrations are append-only," justified specifically by nothing external
depending on the old shape yet.

Overall result and combined odds are **derived from the legs, not
stored** -- the same reasoning already used for `team_fixture_results` as
a view instead of a stored table back in Phase 1. Rules, matching how a
real sportsbook settles an accumulator: any leg that loses fails the whole
bet; any leg still pending keeps the whole bet pending; a *void* leg (the
match was postponed, a market got scrapped, etc.) is dropped entirely --
removed from both the combined odds calculation and the required-to-win
set -- so a 3-leg parlay with one void leg becomes, in effect, a 2-leg
parlay. If every leg is void, the whole bet is void (stake returned, no
profit). The model-vs-market "edge" comparison generalizes to parlays by
taking the *product* of each non-void leg's own model probability --
which assumes the legs' outcomes are statistically independent. That's a
real, named simplification, not strictly true (two matches on the same
day can be weakly correlated by things like weather or refereeing
tendencies league-wide), but it's the standard approach and worth stating
plainly rather than quietly baking in.

**Verified for real again, not just typechecked:** the full flow --
register, duplicate-email rejection, wrong-password rejection, JWT
issuance, `requireAuth` blocking unauthenticated requests, parlay combined
odds (`1.90 x 2.50 = 4.75`), void-leg exclusion recalculating combined
odds down to `1.90` and the model-probability product down to a single
leg's value, cross-user isolation (a second user probing the first user's
bet/leg ids gets a 404, not a 403 -- doesn't even confirm the id exists),
and the season/team breakdown filters -- all against a real scratch
Postgres via `curl`, plus a real registered-user session through the
actual UI in headless Chromium (register -> build a 2-leg parlay -> settle
both legs -> watch the record/ROI summary update to 1-0, +375% ROI, exact
match for `stake x combinedOdds`). One real UX bug caught by that browser
run and fixed before merging: the fixture picker didn't exclude fixtures
already added as a leg, so building a multi-leg parlay could silently
re-offer the same fixture and trip the duplicate-leg guard -- filtering
already-added fixtures out of the dropdown fixed it.

## Bug found running Phase 1's lineup-depth check for real (2026-08-15)

First real run of `npm run check:lineup-depth` (a real `API_FOOTBALL_KEY`,
the exact scenario the Phase 1 plan flagged as untestable in this cloud
session and deferred to a real machine) hit a real bug immediately:
`error: duplicate key value violates unique constraint
"players_external_api_football_id_key"`, thrown from
`upsertPlayerGoldenRecord` while seeding player stats for the very first
test fixture.

Root cause: `upsertPlayerGoldenRecord` (`backend/seed/lib/db.ts`) only
ever matched an existing player two ways -- `natural_key` (name + date of
birth) when a DOB is known, or an exact case-insensitive name match
otherwise. It never checked `external_api_football_id` itself, even
though that's the most reliable identifier available whenever it's
present -- a real bug hiding in code that had never run against real
API-Football responses before. What actually happened: `seedApiFootballLineup`
ran first and inserted the player under one name spelling from the
lineups endpoint; `seedApiFootballPlayerStats` ran second for the same
fixture and got a *differently formatted* spelling of the same real
player's name from the stats endpoint (API-Football doesn't guarantee
identical name strings for the same player across its own endpoints --
accents, abbreviations). The name-based lookup missed, fell through to
INSERT, and collided on `external_api_football_id` since it was genuinely
the same person.

Fixed by checking `external_api_football_id` first, before any name-based
logic, whenever the caller supplies one -- see the updated docstring on
`upsertPlayerGoldenRecord` for the full match-priority ordering. The
general lesson, worth remembering past this one function: **when you have
two identifiers for the same real-world entity from the same source,
prefer the stable numeric id over any string match, even a same-source
string match** -- "same API, so the names must agree" is not a safe
assumption. Verified the fix directly (not just re-running the depth
check) by reproducing the exact collision in a script -- two calls with
the same `external_api_football_id` and different name spellings, no
DOB on either -- confirming both calls now resolve to one row, the row's
`full_name` stays whatever the first call set (a later, differently-
spelled call enriches other fields but never overwrites the name), and
regression-checked the DOB-based and name-fallback paths still merge
correctly on their own. This is exactly why Phase 1 built the depth-check
script to run against *one* fixture before trusting a multi-day backfill
-- this bug would otherwise have surfaced 1 fixture in either way, but
finding it on fixture 1 instead of fixture 500 of a live backfill is the
whole point of that ordering.

## Upgraded to API-Football's Pro tier, added rate-limit retry (2026-08-15)

Raised `DAILY_BUDGET` from 100 to 7,500/day to match a real Pro-tier
account (confirmed on the api-sports.io dashboard, not assumed from
memory of pricing pages -- pricing/limits are exactly the kind of thing
that goes stale, so asking for the real number beat guessing).

More important than the bigger number: the *daily* cap was never the only
limit. Every tier also has a *per-minute* rate limit, and the backfill
fires thousands of sequential requests -- at 7,500/day instead of 100,
hitting that per-minute ceiling during a real run went from "basically
never happens" to "will definitely happen eventually." Before this, a 429
response wasn't handled specially at all -- it just threw the same generic
`API-Football request failed: 429 ...` error as any other failure, which
would crash the entire `npm run db:seed` process. Not catastrophic (the
fetch-if-absent cache and the "still missing lineups/stats" backfill query
mean a rerun just resumes where it left off), but a multi-week unattended
backfill shouldn't need a human to notice a crash and manually restart it
every time it gets rate-limited.

Added a retry loop inside `callApiFootball`: on a 429, honor the
`Retry-After` header if the response includes one, otherwise fall back to
exponential backoff (1s, 2s, 4s, ...), up to 5 attempts before giving up
for real. Deliberately placed *inside* the per-call cache/budget wrapper
rather than around the whole backfill loop -- a retry is the same logical
call arriving late, not a new one, so it shouldn't double-count against
the daily budget tracker.

Verified against the actual exported function, not a reimplementation of
the retry logic in isolation: monkeypatched `globalThis.fetch` to return a
429 with `retry-after: 1` on the first call and a real fixture payload on
the second, called `seedApiFootballFixtures` for real against a scratch
Postgres, and confirmed all of it -- exactly 2 fetch calls, elapsed time
respected the 1-second `Retry-After` header, the budget counter only
incremented once (the failed attempt didn't count), and the fixture data
from the eventually-successful call landed correctly in Postgres.
