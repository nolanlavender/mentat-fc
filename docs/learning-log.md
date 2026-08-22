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

## Phase 7 — Goal scorer prediction, planned but paused (2026-08-15)

Real depth in `fixture_player_stats` (minutes + goals per player per
fixture, 3 seasons, both leagues) is what this needs, and the Pro-tier
backfill that provides it had literally just started -- decided the
concept and the approach now, deliberately, rather than either blocking
on data that doesn't exist yet or building against too little of it to
mean anything.

**Why this is a genuinely harder prediction problem than match outcome,**
not just "the same thing at finer grain":

- **Attribution noise.** Dixon-Coles is estimating something slow-moving
  and well-sampled -- a team's attack/defense strength, built from ~35-45
  goals a season across the whole squad. A single player's own scoring
  rate is a much smaller, noisier sample (a 15-goal season is still only
  15 data points), so *which* of a team's likely ~2 goals a given player
  gets is a meaningfully less certain question than *how many* goals the
  team gets.
- **Appearance noise.** Predictions are generated ahead of time (batch
  inference, same architectural choice as Phase 5), before lineups are
  announced. A player's normal 90 minutes can vanish to rotation, a knock,
  or a suspension with zero warning available at prediction time -- a
  whole extra source of uncertainty match-outcome prediction never has to
  model, since a team fields *some* XI regardless.

**Planned approach, decided now so it doesn't need re-litigating later:**
Poisson allocation on top of the existing Dixon-Coles output, not a
separate classifier. Dixon-Coles already produces
`predicted_home_goals`/`predicted_away_goals` per fixture; a player's
expected goals for that match become
`team's expected goals × player's historical share of the team's goals ×
player's expected share of available minutes`, and `1 - e^(-λ_player)`
(the same Poisson survival-function math already used for match outcomes
in `dixon_coles.py`) converts that into a scoring probability. Chosen over
a logistic-regression/XGBoost classifier specifically to stay consistent
with Phase 5's deliberate pick of an interpretable statistical model over
a black-box one -- introducing a second, different modeling paradigm for
one feature would cost more in "now I have to understand two different
kinds of model" than it would likely gain in accuracy at this stage.

Picked up Phase 5's original FA Cup deferral and a new predictions-page UI
task instead, in parallel with the backfill running in the background --
see their own entries below.

## Dedicated predictions page (2026-08-15)

Small, but a real gap: match predictions existed in the database since
Phase 5 and were genuinely working, but the only place the app *showed*
one was buried in a single team's own dashboard, one fixture at a time.
There was no way to see "what does the model think is happening across
the league this week" at a glance.

Fix was smaller than it sounds because almost everything needed already
existed: `GET /api/fixtures` (list endpoint) just didn't embed a
prediction the way `GET /api/fixtures/:id` (detail endpoint) already did.
Added the same `LEFT JOIN LATERAL` pattern already used in
`getFixtureById` to `listFixtures`, so every fixture in a list response
now carries its latest prediction (or `null`, same graceful-degradation
pattern as everywhere else in the app -- a fixture with no prediction
yet isn't an error state). `FixtureDetail` used to duplicate the
prediction shape inline; now it just inherits `prediction` from
`FixtureSummary` instead of redeclaring an identical type, since both
endpoints return the exact same shape.

New `/predictions` frontend page: two competition-filtered fetches
(Premier League, Championship) merged and sorted by kickoff time
client-side, rather than teaching the backend a multi-competition list
filter for a feature this small. Verified against real seeded data and a
real headless-Chromium session: a fixture with a real prediction renders
percentages and an expected scoreline, a fixture without one renders "No
prediction yet," and switching the competition filter to one with no
matching fixtures renders "No upcoming fixtures found" rather than
erroring -- all three states exercised for real, not assumed from reading
the code.

## FA Cup reconciliation: one joint fit instead of three separate ones (2026-08-15)

The real Phase 5 deferral, picked back up: Premier League and Championship
were each fit independently, so "Arsenal's attack strength is 1.3" and
"a Championship team's attack strength is 1.3" meant two different things
-- each fit's `mean(log_attack) == 0` recentering (see `dixon_coles.py`'s
identifiability note) makes "1.0" mean "average team *in that fit*," and
the two fits have no way to know which league's average is actually
stronger. FA Cup fixtures were sitting right there in the database the
whole time as the answer: they're the only real matches where a Premier
League team and a Championship team play each other, which makes them the
literal connecting data a joint fit needs to place both leagues on one
comparable scale. Two disconnected groups of teams that never play each
other can't be reconciled by fitting them together in one call *without*
the FA Cup matches -- there'd be nothing tying the groups' scales
together at all, just two independent problems sharing one home-advantage
term. It's specifically the crossover matches that do the actual work.

**Validated the claim before trusting it, with a synthetic dataset with a
known ground truth** (not just eyeballing real predictions and hoping
they looked plausible): built two fake leagues, one deliberately 1.8x
stronger than the other by construction, plus a set of "FA Cup" matches
between them. Two independent fits (mirroring the old per-competition
approach) both recentered to essentially the same ~1.0 mean attack
(1.026 vs. 1.051) -- statistically indistinguishable, concretely
demonstrating the two-independent-fits problem rather than just asserting
it. The joint fit, same data, recovered a real, correctly-directioned gap
(2.60x -- overshooting the 1.8x ground truth some, expected MLE noise on
a small synthetic sample, but unambiguously in the right direction and
magnitude), and a predicted crossover fixture correctly favored the
stronger side. This is the actual value of testing the mechanism in
isolation with a known answer, rather than only testing against real data
where you don't have a ground truth to check against.

**Implementation:** `data.load_finished_matches` now takes a list of
competition names instead of one, returning a `competition_name` column
so a joint dataset can still be filtered back apart for reporting.
`app.train` fits one `DixonColesModel` across Premier League +
Championship + FA Cup, then predicts upcoming fixtures in all three
(previously FA Cup was skipped entirely). `app.evaluate`'s backtest split
changed from three independent per-competition date cutoffs to **one
global cutoff** across the combined dataset -- necessary so the
train/test boundary means the same point in time for every competition,
matching how the single deployed joint fit actually works, rather than
three different real-world dates that happened to each be "the last 20%"
of that competition's own results.

**Verified against real Postgres, not just the synthetic math:** seeded a
small but real cross-league dataset (Championship-only matches, plus FA
Cup matches connecting real Premier League teams already in the seed
snapshot to the new Championship ones), ran the actual `app.train` and
`app.evaluate` end to end. `app.train` wrote a real FA Cup prediction for
the first time in the project's history -- Arsenal an 84.5% favorite
against a synthetic weaker side, matching the real quality gap built into
the synthetic data. `app.evaluate` correctly handled all three
competitions differently: a normal Premier League backtest with a market
comparison, a Championship competition with genuinely zero held-out
matches in the test window (a property of the synthetic date ranges, not
a bug -- handled without crashing), and FA Cup correctly reporting "no
closing odds available" since football-data.co.uk has no cup coverage and
The Odds API integration is still deliberately deferred.

The app's frontend still only *displays* Premier League and Championship
predictions (see `docs/CLAUDE.md`'s data scope note) -- FA Cup
predictions now genuinely exist and are meaningful, but surfacing them as
an actual feature is separate, not-yet-decided scope, not bundled into
this fix.

## Why `npm run db:seed` was so slow, and batching the writes (2026-08-15)

Flagged as "seems really slow going into the db" while a real backfill was
running against real Neon. Root cause, confirmed by reading the code
rather than guessing: `seedFootballDataSeason` (the football-data.co.uk
importer) issued one `pool.query` call *per row it wrote*, sequentially
awaited, no batching at all. A single fixture writes 2 team lookups, 1
fixture row, 2 team-stats rows, and ~30-77 odds rows (8 bookmakers x
several markets x opening/closing snapshots -- 77 turned out to be the
real number for a real 2023/24 Premier League fixture, higher than the
~30-60 estimate in earlier docs). Every one of those is a separate network
round-trip to a remote Postgres instance. Across all 380 Premier League
fixtures in one season, that's **31,134 individual sequential round-trips
for one file** -- and the full pipeline re-walks 6 season/competition
combinations (Premier League x3, Championship x3) on every `npm run
db:seed` run, whether or not anything actually changed, since the
upserts are unconditional even when idempotent.

Two independent fixes, both safe because they don't change *what* gets
written, only *how many round-trips* it costs to write it:

1. **In-memory team-id cache.** `getOrCreateTeam` hit the database on
   every single call, but there are only ~20 distinct Premier League team
   names -- it was resolving the same names over and over across 380
   fixtures (2 lookups/fixture = 760 calls for 20 real answers). A
   module-level `Map` cache, valid for the lifetime of one seed run (team
   names don't change mid-run, and nothing else writes to `teams`
   concurrently during a seed run), turns that into ~20 real lookups.
2. **Batched multi-row INSERTs.** `upsertFixtureOddsBatch` and
   `upsertFixtureTeamStatsBatch` collect all of one fixture's odds/stats
   rows in memory first (pure JS, no DB calls), then write them in a
   single `INSERT ... VALUES (...), (...), ... ON CONFLICT ...`
   statement instead of one statement per row. Safe specifically because
   no two rows built from one fixture's CSV row can ever target the same
   `ON CONFLICT` key (verified against the actual bookmaker constant
   lists: every bookmaker name is unique within its own market group, and
   the three markets -- match_winner/over_under/asian_handicap -- never
   share a market value) -- Postgres rejects a multi-row `ON CONFLICT DO
   UPDATE` if two rows in the same statement would affect the same
   existing row twice, so this needed checking, not assuming.

**Measured, not estimated:** instrumented `pool.query` to count real
calls against the actual cached 2023/24 Premier League CSV (a real file,
not synthetic). Before: ~31,134 round-trips for that one file (740 of
them redundant team lookups, the rest odds/stats). After: **1,164** --
roughly a **27x reduction**. Reran the same file a second time to confirm
idempotency held after the rewrite: identical row counts (380 fixtures,
760 team-stats rows, 29,234 odds rows), no duplicates introduced.

This sandbox's scratch Postgres runs on localhost, so wall-clock time
here (about 2 seconds either way) doesn't reflect the real slowdown --
the actual cost lives in per-round-trip network latency to a remote Neon
instance, which this environment can't reproduce. But round-trip *count*
is the number that actually predicts real-world wall-clock time on a
remote database, and that dropped by the same ~27x regardless of what
the per-round-trip latency happens to be. Deliberately didn't go further
(e.g. batching across an entire season file into one statement instead
of per-fixture, which would cut round-trips further but requires a
riskier two-pass restructure -- inserting all fixtures first, then
mapping their generated ids back to build dependent rows) -- per-fixture
batching already gets the overwhelming majority of the win for a much
smaller, more reviewable change to code that writes to a real production
database.

## One missing CSV shouldn't crash the whole backfill (2026-08-15)

Real error hit mid-run against real Neon: `football-data.co.uk fetch
failed: 300 .../2627/E1.csv` -- an HTTP 300 (Multiple Choices), an unusual
status for a plain file download. Most likely explanation: the 2026/27
Championship season's CSV doesn't exist on football-data.co.uk yet (early
in the season), and whatever server-side handling they have for a missing
file emits a non-standard status instead of a normal 404 in this case.

The real problem wasn't the 300 itself -- it's that `seedFootballDataSeason`
had no error handling around it, and neither did its caller. One
not-yet-existing file crashed the entire `npm run db:seed` run, which also
killed everything *downstream* of it in the same process: FA Cup fixtures,
the current-season fixture list, and the actual lineup/player-stats
backfill this whole run was for. football-data.co.uk is a free, hobby-run
site with no SLA -- the same reasoning already applied to the FPL API in
`docs/CLAUDE.md` -- so a fetch failure there should degrade gracefully,
not take the whole pipeline down with it.

Fixed by wrapping each individual season/competition fetch in its own
try/catch inside `seedHistoricalResultsAndOdds`, logging clearly and
moving on rather than crashing `main()`. Verified against the real
failure, not a hypothetical: monkeypatched `fetch` to reproduce the exact
300 response for the exact URL from the error, mixed with real successful
fetches on either side of it, and confirmed the real `seedFootballDataSeason`
function still throws exactly as before (unchanged), but the pipeline now
catches it, logs it, and keeps seeding everything else -- 760 real fixture
rows landed from the two calls on either side of the deliberately-failing
one.

## Rewriting the lineup/player-stats backfill around a bulk endpoint (2026-08-15)

The lineup/player-stats backfill was the API-Football pipeline's real
bottleneck: `backfillLineupsForCompetitionSeason` called
`seedApiFootballLineup` (`GET /fixtures/lineups?fixture=X`) and
`seedApiFootballPlayerStats` (`GET /fixtures/players?fixture=X`)
separately for every fixture -- 2 calls each, ~3,000+ fixtures across 3
seasons x 3 competitions. That's the resource actually gated by the daily
budget, unlike the DB round-trips fixed above.

API-Football's docs describe a `GET /fixtures?ids=id1-id2-...-id20`
filter (max 20 ids, hyphen-separated) but don't show an expanded JSON
example proving it returns anything beyond the same core fixture fields
the plain `?league=&season=` list call already gives. Rather than trust
the prose, this got tested for real: a small script
(`seed/check-bulk-fixtures-endpoint.ts`) called it against 5 real fixture
ids and inspected the actual response. First attempt picked the earliest
fixtures in the whole database with no competition filter, which turned
out to be FA Cup Extra Preliminary Round matches between non-league clubs
-- API-Football has no detailed data for that tier at all, so the
all-empty result was a false negative about the *tier*, not real evidence
about the *endpoint*. Refiltered to 5 real Premier League fixtures and
reran: **confirmed** -- each fixture object in the bulk response embeds
`lineups[]`, `players[]`, `statistics[]`, and `events[]` directly, same
shape as the separate per-fixture endpoints. Saved the raw response
(`seed/raw/api-football/bulk-fixtures-check.json`, gitignored) and used
its exact field shapes (including real quirks like `passes.accuracy` and
`games.rating` arriving as numeric *strings*, not numbers) to build the
rewrite against real data instead of the docs' prose.

Rewrote `seedApiFootballLineup` + `seedApiFootballPlayerStats` (2
calls/fixture) into `seedApiFootballLineupsAndStatsBulk`, one call per
chunk of up to 20 fixtures via the `ids=` filter -- a real **~40x**
reduction in API-Football call volume for the backfill (2,800 fixtures x
2 calls = 5,600 calls before; ~140 chunk calls after). Since a chunk's
response covers many fixtures' worth of lineup/player-stats rows at once,
the DB writes got batched too: two new helpers,
`upsertFixtureLineupsBatch` and `upsertFixturePlayerStatsBatch` in
`seed/lib/db.ts`, each building one multi-row `INSERT ... ON CONFLICT` for
an entire chunk (~800 rows) instead of one round-trip per row -- same
reasoning as the earlier odds/team-stats batching, applied here because a
cheaper API call shouldn't still pay per-row DB round-trips.

The old per-fixture `seedApiFootballLineup`/`seedApiFootballPlayerStats`
functions were kept (not deleted) -- `check-lineup-depth.ts`, the
diagnostic script that originally confirmed this tier serves historical
lineup data at all, still calls them directly, and rewriting a script
that already did its job and is referenced by an earlier learning-log
entry wasn't part of this change.

**Design decisions made and deliberately left out of scope:**
- **Cache keys:** the old per-fixture cache (`lineups/{id}.json`,
  `player-stats/{id}.json`) doesn't fit a batch-of-20 response. New scheme:
  `bulk-fixtures/{id1-id2-...-id20}.json`, matching the same ids used in
  the URL's `ids=` param. The backfill query also gained an
  `ORDER BY kickoff_date` it didn't strictly need before (each fixture was
  its own cache key, so order was irrelevant) -- now chunk *boundaries*
  need to be stable across reruns, or a partial run resumed later would
  build different 20-fixture groupings and mostly miss the cache.
- **`expected_goals` (xg):** the bulk response's `statistics[]` includes
  it (as a string, like the other numeric fields), and
  `fixture_team_stats.xg` already exists as a column from an earlier
  migration -- but capturing it wasn't part of what this change was
  asked to do, so it's left unfilled for now rather than added silently.
- **`events[]` (goal/card timeline):** also present in the bulk response,
  also not captured -- `docs/erd.md` already documents `fixture_events` as
  a deliberate future extension (Phase 7), not something to backfill into
  early.

**Verified against real Postgres, not just typechecked:** the real
sandbox has no network access to API-Football, so `fetch` was
monkeypatched to return a response shaped exactly like the real, saved
`bulk-fixtures-check.json` (including the string-typed `rating`/
`passes.accuracy` fields) for 25 fixtures, forcing the chunker to produce
a real 20-then-5 split. Ran `backfillLineupsForCompetitionSeason` against
a real scratch Postgres instance with real migrations applied: chunking
produced exactly 2 fetch calls (not 25 or 50), row counts matched
expectations exactly (100 lineup rows = 25 fixtures x 4 players, 50
player-stats rows), the string-typed fields parsed correctly to numeric
columns, and a second run made **zero** fetch calls and produced
identical row counts -- confirming the cache and the idempotent
`ON CONFLICT` upserts both still hold under the new batched-chunk shape.
Real API-Football verification (does the live endpoint actually behave
this way in production, not just in a mocked test) is still pending a
real run against a real key -- the mocked test proves the code is
correct against the confirmed shape, not that the shape itself is
eternal.

## `fetch` has no timeout by default -- a real hang, not throttling (2026-08-15)

Mid-run, `npm run db:seed` sat silent after "Seeding FA Cup 2025/26
fixtures from API-Football..." -- no output, no error, nothing running.
First guess was rate-limiting, but the code already logs a clear
`Rate-limited on ...` line whenever that actually happens (from the
earlier 429-retry fix), and no such line ever printed. Ruled out a
concurrent process hitting the same key too. That combination -- total
silence, no retry log, nothing else touching the API -- pointed
somewhere else: `callApiFootball`'s `fetch()` call had no timeout at all.

The concept: `fetch` doesn't time out on its own. If the server accepts
the connection but then never sends a response (a stalled proxy hop, a
half-open TCP connection, anything short of the OS actually closing the
socket), `await fetch(...)` waits *forever* -- not "slow," genuinely
unbounded. The existing 429-retry logic never got a chance to run,
because it only fires once a response actually arrives; a stalled
connection never produces one.

The fix is `AbortController`: create one, pass its `signal` into
`fetch`'s options, and call `controller.abort()` from a `setTimeout` after
a deadline (30s here -- generous for a JSON API response, but not
infinite). That turns the hang into a normal, catchable error. Bundled
that error handling together with genuine network failures (DNS hiccups,
TLS resets) under one retry path, same backoff shape as the 429 handling
-- both are transient from the caller's point of view, and there's no
way to tell them apart from a caught error alone that would change what
to do about it. Renamed `MAX_RATE_LIMIT_RETRIES` to `MAX_CALL_RETRIES`
since it now bounds both cases, not just 429s.

**Verified for real, not assumed:** a stalled connection is hard to
reproduce against a live API on demand, so this got tested against a fake
`fetch` built to behave exactly like the real failure -- a promise that
never resolves or rejects on its own, only settling when the abort signal
fires (the same shape a truly stalled server produces, not a fast
network error that would've passed even before this fix). Two real runs
against a real scratch Postgres:
- One stalled call followed by a working retry: the process actually
  waited the full ~30s timeout (not simulated/mocked away), logged the
  new retry message, and succeeded on the second attempt -- 31.1s elapsed,
  matching the real deadline plus backoff almost exactly.
- Every call stalling: confirmed the retry loop is actually bounded --
  6 real fetch attempts (1 + 5 retries), each waiting its own real 30s
  timeout plus the increasing backoff between them (~211s total), then a
  clear thrown error instead of hanging a 6th time. Before this fix,
  that scenario never would have thrown anything -- it just wouldn't
  have finished, ever.

## API-Football repeats a player within one fixture's data (2026-08-15)

Real crash, further into the same real backfill run: right after
Championship 2026/27 finished cleanly (552 fixtures), the next chunk threw
`ON CONFLICT DO UPDATE command cannot affect row a second time` from
`upsertFixtureLineupsBatch`. This is exactly the Postgres restriction the
batch-upsert design already had to reason about for `fixture_odds` --
Postgres refuses a multi-row `ON CONFLICT DO UPDATE` outright if the same
conflict target `(fixture_id, player_id)` shows up twice in one `INSERT`.
The comment on `upsertFixtureLineupsBatch` had reasoned this couldn't
happen ("a player is either starting or a sub, never both"), and real
production data proved that reasoning wrong.

Worked through what *could* actually produce two identical
`(fixture_id, player_id)` rows in one chunk, ruling hypotheses out with
what's actually enforced in the schema rather than guessing:
- Two different fixtures landing on the same `fixture_id` in the chunk?
  Impossible -- `fixtures.id` is the primary key, and the chunk-building
  query selects distinct rows by it.
- Two different *DB rows* secretly sharing the same
  `external_api_football_id`, so the same fixture got requested twice in
  one `ids=` call? Ruled out by `fixtures_external_api_football_id_idx`,
  a real partial unique index (`migrations/1701000000006_create-fixtures.sql`)
  that's been enforced on every insert since Phase 1, not just checked
  once.
- Two different real players colliding on the same golden-record id?
  Ruled out the same way -- `players.external_api_football_id` is
  `UNIQUE`, and `upsertPlayerGoldenRecord` already resolves by that id
  first before any name-based matching.

That leaves one real explanation: API-Football itself returned the same
player twice within one fixture's `lineups[]` (or, same risk, `players[]`)
-- observed here on a lower-profile competition (FA Cup), consistent with
the messier data already seen there (the empty-lineups false-negative from
the bulk-endpoint check). Free-tier and even paid sports-data feeds aren't
guaranteed internally consistent; code that assumes a source is clean
because it's *usually* clean is exactly what broke here.

Fixed with a `dedupeByFixturePlayer` helper in `seed/sources/api-football.ts`,
run on both the lineup rows and the player-stats rows right before their
batch upserts -- last entry wins, and a duplicate is logged
(`... repeated N (fixture, player) pair(s) ... deduped before upserting`)
rather than silently dropped, so a future occurrence is visible instead of
invisible. `upsertFixtureLineupsBatch`/`upsertFixturePlayerStatsBatch`'s
comments in `lib/db.ts` were corrected to state the real contract: callers
must dedupe first, this isn't guaranteed by the data.

No cleanup needed on the already-run pipeline: the batch `INSERT` that
crashed is one atomic statement, so the failing chunk's fixtures never got
any lineup or player-stats rows written at all (not a partial write) --
they're still correctly flagged as "missing" and will be retried
automatically (and now successfully) on the next `npm run db:seed`.

**Verified against the real failure, not a hypothetical:** reproduced the
exact crash first -- a fake fixture with the same player id listed twice
in one team's `startXI` -- against a real scratch Postgres on the
pre-fix code, and got the identical error message
(`ON CONFLICT DO UPDATE command cannot affect row a second time`),
confirming the test actually exercises the real bug rather than a
different one. Reran the same test against the fix: no crash, the
duplicate got logged and deduped, and both the real player and the
duplicated one landed as exactly one row each.

## API-Football's arrays aren't always arrays -- `startXI: null` (2026-08-15)

Third real crash in the same real backfill run, further along still:
right after FA Cup 2024/25 finished cleanly (873 fixtures), the next
chunk threw `TypeError: teamLineup.startXI is not iterable`. The
`ApiFootballLineupEntry` type declared `startXI`/`substitutes` as always
being an array, matching every example seen so far (the confirmed bulk
response, the check-lineup-depth spot check) -- but a real FA Cup fixture
came back with a team lineup entry whose `startXI` was `null` instead of
`[]`. Same underlying story as the two fixes before this one: API-Football's
coverage gets less clean the further you get from Premier League/
Championship, and this project has now hit three distinct shapes of that
messiness (empty lineups entirely, a repeated player, and now a null
array) in the same run.

Rather than patch just the one field that happened to crash first, applied
the same `?? []` guard everywhere an array is read off this response --
`item.lineups`, `teamLineup.startXI`, `teamLineup.substitutes`,
`item.players`, `teamEntry.players` -- in both the new bulk-endpoint parser
and the older per-fixture `seedApiFootballLineup`/`seedApiFootballPlayerStats`
functions (still used by `check-lineup-depth.ts`), since they read the
same shape of data and carry the identical risk. Updated the TypeScript
interfaces to say `Array<...> | null` instead of `Array<...>` -- the type
should describe what the API actually, confirmedly sends, not the
happy-path shape assumed from the docs.

**Verified against the real failure:** reproduced the identical error
message (`teamLineup.startXI is not iterable`) against a real scratch
Postgres on the pre-fix code with a fake fixture shaped exactly like the
real one (one team's `startXI`/`substitutes` both `null`, the whole
`players` array also `null`), then confirmed the fix processes the
fixture cleanly -- the team with null data contributes nothing (correctly
skipped, not crashed), and the other team's real player still lands as
expected.

## Resuming the backfill without a saved position, and a dropped DB connection (2026-08-15)

Two related things from the same real run. First, a new crash: `Error:
Connection terminated unexpectedly` from `pg`, mid-backfill. Different
class of failure from the last three (those were all API-Football data/
network issues) -- this is the Postgres *client* connection itself dying.
The likely mechanism: `backend/src/db/pool.ts`'s `Pool` had no TCP
keepalive configured, and the backfill's own retry/backoff sleeps (API-
Football's 429 handling, the fetch timeout fix) leave a checked-out pooled
connection sitting idle for anywhere from seconds to minutes at a time --
long enough for Neon's pooler or an intermediate network hop to silently
close the socket. The next query on that connection then fails with
exactly this error, with no warning beforehand.

Two-part fix, matching the "prevent it, but also survive it" approach
already used for the timeout fix:
- `pool.ts` now sets `keepAlive: true` -- periodic TCP-level pings that
  stop most idle connections from being silently dropped in the first
  place. This is the actual fix for the root cause.
- `backfillLineupsForCompetitionSeason` also wraps each chunk in a bounded
  retry (reusing `MAX_CALL_RETRIES`) for connection-loss-shaped errors
  (`Connection terminated`, `ECONNRESET`, `ETIMEDOUT`), same backoff shape
  as the API-Football retry. Safe to retry the whole chunk wholesale:
  `callApiFootball`'s disk cache means a retry doesn't re-spend an API
  call, and every DB write inside is an idempotent upsert -- there's
  nothing to double-write.

Second, a real request: after a run interrupted three separate times in
one session (data quirks, now a dropped connection), rerunning the *whole*
`npm run db:seed` pipeline every time to get back to the backfill was
wasteful -- football-data.co.uk and FPL bootstrap are cheap/cached
rerunning, but not free, and every rerun risks hitting a *new* transient
failure in an earlier stage that has nothing to do with what actually
needs finishing.

The interesting part: the actual resume mechanism already existed and
didn't need building. `backfillLineupsForCompetitionSeason` always
re-queries the database for fixtures still missing lineups/player stats
before doing any work -- the database *is* the checkpoint, not something
held in memory or a progress file. Calling it again after any interruption
already only does the fixtures that are still missing, at zero extra cost,
because of how it was written for the original resumable-backfill design
in Phase 1. What was actually missing was a way to invoke *just* that
stage -- `npm run db:seed` always runs the historical-CSV, FPL, and FA-Cup-
fixture-list stages first. Fixed by exporting `backfillLineups` from
`seed/index.ts` and adding `seed/backfill-lineups.ts`, a standalone entry
point exactly mirroring the existing `seed/current-season.ts` pattern
(same idea: pull one stage out so it can run alone), wired up as
`npm run db:seed:backfill-lineups`.

No new flag, parameter, or saved position needed -- the fix is "let the
DB-driven resume logic that already existed run on its own," not "build
resumability from scratch."

**Verified against real scenarios, not just typechecked:**
- Reproduced the connection-drop crash for real: monkeypatched `pool.query`
  to throw the exact `Connection terminated unexpectedly` message on one
  specific call in the middle of a chunk's processing (not the outer
  "what's missing" query), confirmed it retries and the chunk still
  completes successfully against a real scratch Postgres.
- Proved the resume behavior end to end: backfilled Premier League and
  Championship for real (via `backfillLineupsForCompetitionSeason`
  directly, simulating "the process stopped here"), left FA Cup
  completely untouched, then called the same `backfillLineups()` a second
  time -- exactly what the new entry point invokes. The second run made
  **zero** real fetch calls for Premier League/Championship (correctly
  recognized as already done) and exactly **one** for FA Cup (the only
  competition still missing data), landing all 15 fixtures' lineups
  total.

## "We're loaded" wasn't true -- a real verification query said so (2026-08-15)

Asked "where do we go now, and how does this stay fresh daily" after the
backfill looked finished. Ran the honest check instead of taking "the last
run said 0 remaining" at face value -- a query grouping `fixtures` by
competition/season and counting ones still missing lineups or player
stats. The real result exposed two separate problems, not one:

**Bug 1 -- most historical seasons were never linkable at all.** Premier
League 2024/25, 2025/26 and all 3 Championship historical seasons didn't
show up in the query's results *at all* -- not "0 missing", genuinely
absent, because zero fixtures in those seasons had an
`external_api_football_id`. Traced it in the actual code:
`seedApiFootballFixtures` (the only thing that ever sets that column) was
only ever called for the *current* season (`seedCurrentSeasonFixtureLists`)
and FA Cup (`seedFaCupFixtures`) -- the 3 historical PL/Championship
seasons were seeded purely from football-data.co.uk CSVs, which have no
concept of an API-Football id. `backfillLineupsForCompetitionSeason`
requires that column to be non-null before it'll even look at a fixture,
so those seasons were structurally invisible to the whole backfill, not
"done." Fixed with a new `linkHistoricalSeasonsToApiFootball` (`seed/index.ts`),
run automatically at the start of `backfillLineups()` -- one cheap
`seedApiFootballFixtures` call per historical PL/Championship season
(6 total), idempotent and cache-backed like every other call of that
function, so safe to leave in the pipeline permanently even though it only
ever does real work once. Verified for real: seeded a fixture the exact
way football-data.co.uk would (no external id at all), confirmed
`backfillLineups()` both attached a real external id to it *and* backfilled
its lineup data in the same run.

**Bug 2 -- FA Cup's "0 remaining" didn't mean what it sounded like.**
`backfillLineupsForCompetitionSeason` counted a fixture as done just for
being *attempted* (`done += chunk.length`), not for actually landing rows
in `fixture_lineups`/`fixture_player_stats` -- and a large share of FA
Cup's early-round fixtures are non-league clubs API-Football has no
lineup data for at all (confirmed earlier via `check-bulk-fixtures-endpoint.ts`).
Every rerun re-attempted the same permanently-empty fixtures, and
`remaining: 0` just meant "finished iterating the list captured at the
start of this call," never re-checking whether those fixtures actually
got data. Fixed with a new `fixtures.lineups_checked_at` column
(migration `1701000000020`) and `markFixturesLineupsChecked`, set for
every fixture in a processed chunk regardless of outcome -- the missing
piece needed to tell "genuinely unavailable" apart from "not yet tried."

**The subtle part: this column is only safe because of a second, related
fix.** A fixture that hasn't been played yet legitimately has no lineup
data too -- for a completely different reason (the match hasn't happened),
one that should absolutely be retried once it has. Marking those the same
way as a permanently-empty FA Cup match would be wrong. Worse, there was
a real caching bug lurking here too: `callApiFootball`'s disk cache never
expires, keyed only on the chunk's id list -- a not-yet-played fixture
bundled into a chunk today would cache its (necessarily empty) response
*forever*, so a rerun after the match is actually played could still read
the stale pre-match cache file and never see the real result. Both
problems share one fix: `backfillLineupsForCompetitionSeason`'s candidate
query now requires `status = 'finished'`, so a fixture only ever enters a
chunk (and only ever gets checked) once the match has actually happened --
a not-yet-played fixture can never be marked and never gets a premature
cache entry. Verified for real against a scratch Postgres: a finished
fixture with genuinely no lineup data got marked checked and correctly
skipped on a second run (zero fetch calls); a scheduled fixture in the
same test never got touched or marked at all, confirmed it stays a real
candidate.

**Then, the actual daily-refresh question.** The design already existed
(`docs/architecture.md`'s "Keeping data current," written in Phase 1) but
was never built -- "premature before something reads the data" was true
then, isn't now. Built `backend/scripts/daily-refresh.sh`: refreshes
current-season fixtures, backfills newly-finished ones' lineups (order
matters -- the backfill only sees `status = 'finished'` fixtures, so the
fixture refresh has to run first), then refits the Dixon-Coles model on
the fresh data. Meant for local `cron`/`launchd` rather than GitHub
Actions, since the app isn't deployed yet (that's still Phase 10, same
commands, different scheduler). football-data.co.uk and FPL bootstrap are
deliberately left out of the daily job -- the former never has anything
new to say about a match that's already been played, and the latter
changes slowly enough that a manual `npm run db:seed` rerun covers it.

**Caught and corrected right after merging:** the PR description, this
entry, `architecture.md`, and `PHASES.md` all initially said the script
was "wired into" `cron`/`launchd`, as if the scheduling itself were
already active -- it wasn't. Actually adding the crontab entry (or a
launchd plist) is a manual, machine-local step that can't be done or
verified from a remote coding session at all, and it hadn't been done.
Caught this by reviewing the docs against reality when asked "is all
documentation done?" rather than assuming they were right because I'd
just written them -- exactly the "don't trust no-exception-thrown" habit
this project is supposed to apply to code, applied to documentation
instead. Fixed the wording everywhere to say what's actually true: the
script is built and merged; scheduling it is still an open, manual step.

Every fix here got the same treatment as the earlier crash fixes: verified
against a real scratch Postgres with fetches shaped like the real,
confirmed data (not just typechecked), not assumed correct because the
code "looked right."

## A model worse than guessing led to three real duplicate clubs (2026-08-15)

Ran `python -m app.evaluate` for real once the historical-link fix had
enough data to matter, and Premier League's result was genuinely bad:
Brier 0.7205. Checked the actual formula in `evaluate.py` rather than
trust a gut feeling that this "seemed low" -- it's mean squared error
against a one-hot outcome, and for that formula, guessing uniformly
(33/33/33 every match) scores 0.667. The model was *worse than guessing*.
Championship was roughly a wash with guessing; FA Cup was actually fine.
Same model code ran all three, so this wasn't a Dixon-Coles bug -- it had
to be something specific to the data feeding PL and Championship.

Traced it with real queries, not assumptions, at each step:
1. A season-fixture-count check showed Championship's historical seasons
   inflated by 51-138 fixtures over the real 552 -- but a follow-up query
   grouping by exact `(home_team_id, away_team_id)` pairs found the
   *legitimate* explanation for part of it first: EFL Championship
   play-offs. Two teams that already met twice in the regular season can
   meet again in the play-offs (semi-final, 2 legs + a final), reusing one
   of the two existing home/away directions -- confirmed by every single
   "duplicate" pair's second date landing in the real, narrow May play-off
   window, and matching exactly 552 + 5 = 557 (the number the very first
   backfill run had already reported).
2. That only explained 5-6 of the ~51-138 excess per season, though --
   nowhere near enough. A distinct-team-count query was the actual
   smoking gun: Championship seasons that should have exactly 24 real
   clubs showed 25-27. Listing every team name that's appeared in a
   Championship fixture, sorted alphabetically, made the culprits obvious
   by eye: **Oxford** / **Oxford United**, **Sheffield Wednesday** /
   **Sheffield Weds**, and **Sheffield United** / **Sheffield Utd** -- three
   real clubs, each split across two `teams` rows because
   `team-aliases.ts` had no entry mapping API-Football's spelling to
   football-data.co.uk's. Every match those three clubs played got
   inserted twice, once under each team_id -- which meant Dixon-Coles was
   training on two separate, artificially weaker versions of each real
   club instead of one team's true record, for three clubs playing in
   the same division as everyone else in the backtest.

Fixed with 3 new entries in `TEAM_NAME_ALIASES`, deliberately breaking
this file's usual "map to the fuller/more official name" convention:
these map to whichever spelling already carries the real odds/team-stats
data (football-data.co.uk's, the only source for historical odds -- not
re-fetchable from anywhere else), not the more official-sounding one.
The other side's data (lineups) is cheap to re-fetch once the alias
makes both sources agree, so keeping the odds-bearing row was the lower-
risk choice.

**Verified for real, both directions:** reproduced the exact bug first --
the same real match seeded once as football-data.co.uk would name it
("Oxford") and once as API-Football would ("Oxford United") -- against a
real scratch Postgres on the pre-fix code, and got exactly the
duplication seen in production (2 teams, 2 fixtures for the same game).
Reran against the fix: 1 team, 1 fixture, correctly enriched with the
external id from the second call instead of creating a duplicate.

Fixing the already-duplicated production rows themselves is a separate,
deliberately un-automated step -- it means deleting real rows (fixtures,
their cascaded dependents, and the duplicate team rows) from a live
database, so a reviewed, transactional cleanup script was handed off
rather than run directly, gated behind an explicit check that no real
logged bet (`bet_legs`) touches any of the affected fixtures first. Once
applied and the backfill rerun, the plan is to rerun `python -m
app.evaluate` again for a real, clean number -- not assumed better,
checked.

## Per-chunk progress logging, and a hidden daily cost (2026-08-15)

Two small, related fixes asked for together after the multi-hour backfill
runs made both gaps obvious.

**Progress logging**: `backfillLineupsForCompetitionSeason` used to print
exactly one line per whole competition-season -- for Championship (~28
chunks needed), that meant long stretches with zero output during a real,
working run, indistinguishable from a hang (this is what prompted the
earlier "is this taking longer than you'd think?" question). Changed
`seedApiFootballLineupsAndStatsBulk` to return real counts (lineup rows
written, player-stat rows written, fixtures with no data available)
instead of `void`, and log one line per chunk from the caller, which
already tracks chunk position. Verified against a real scratch Postgres
with a 25-fixture backfill (forces a 20+5 split): confirmed two separate
log lines print, one per chunk, with real counts, not one line at the end.

**The daily-refresh cost question** turned up something worth fixing
before it became a permanent daily tax: `linkHistoricalSeasonsToApiFootball`
(the historical-season-linking fix from two entries back) unconditionally
re-fetches and re-upserts all 3 historical PL/Championship seasons --
~2,700 individual fixture upserts -- on *every single call*, including
from the daily-refresh script. The API calls themselves are cache-hits
(cheap), but nothing skipped the DB upsert loop even once a season was
fully linked and could never change again. Unlike `seedCurrentSeasonFixtureLists`
(which *needs* to re-check the current season daily to catch newly-
finished matches -- that cost is real and necessary), this one was pure
waste in steady state.

Fixed with a cheap `EXISTS` check per season before the fetch+upsert:
if no fixture in that competition-season still has a null
`external_api_football_id`, skip it entirely. Verified against a real
scratch Postgres: seeded one already-fully-linked season and one
not-yet-linked one, ran `backfillLineups()`, and confirmed zero fetch
calls for the linked season while the unlinked one still got linked
correctly -- the short-circuit doesn't just look right, it measurably
changes what gets called.

## Splitting the joint fit back into three models (2026-08-15)

After the team-alias cleanup, a fresh `python -m app.train` printed
`821 teams` for the joint fit -- Premier League and Championship combined
are only ~44-45 real clubs, so the other ~776 were one-off FA Cup entrants
(Extra Preliminary Round upward, mostly non-league clubs API-Football has
almost no data for, confirmed back in the bulk-endpoint check). Premier
League's backtest Brier was still worse than guessing (0.7085) even after
the real duplicate-data bug was fixed, and that team count was the lead
worth chasing.

The original Phase 5/7 reasoning for a joint fit was sound and is still
correct for what it was actually solving: FA Cup fixtures are the only
matches where a Premier League side and a Championship side play each
other, so they're genuinely necessary to make the two leagues'
attack/defense scales comparable *for FA Cup predictions*. What didn't
follow from that premise, but had been built that way anyway: every
prediction, including pure Premier-League-vs-Premier-League and
Championship-vs-Championship ones, was coming from that same contaminated
fit. Those ~776 low-sample non-league parameters don't just sit inertly
off to the side -- they pull on the fit's shared `home_advantage`/`rho`
and the recentering constant every team's attack/defense gets shifted by
(see `dixon_coles.py`'s identifiability note), degrading Premier League
and Championship's own predictions for a connection those predictions
never needed in the first place.

Split `app.train`/`app.evaluate` into three fits: Premier League alone,
Championship alone, and the joint (all three competitions) fit kept
exactly as before but now used *only* for FA Cup. `evaluate.py`'s
backtest was restructured to match -- same global date cutoff as before
(one fair real-world time boundary across all three), but each
competition's test set now gets predicted by its own matching model
instead of one shared one, so the backtest actually measures what
`app.train` deploys rather than a different, friendlier setup.

**Verified against real dependencies, not just read for correctness:**
this session's sandbox has no network access to Postgres or the real
API sources, but `model-service/.venv` has real `psycopg`/`pandas`/`scipy`
installed, so this got tested against a real (scratch) Postgres instance
rather than just eyeballed. Seeded synthetic data specifically shaped to
catch the bug this was fixing: 20 Premier League teams, 24 Championship
teams, and 80 FA-Cup-only "minnow" teams that never play a PL/Championship
side (mirroring the real contamination). `python -m app.train` confirmed
the fix directly: the Premier League fit reported exactly 20 teams, the
Championship fit exactly 24 -- zero minnow contamination -- while the
joint fit reported 124 (20+24+80), correctly pulling in everyone since
it's the one used for FA Cup. `python -m app.evaluate` ran cleanly
end-to-end too, including a real edge case worth noting: because of this
synthetic dataset's date layout, the joint model's *training* window
happened to contain zero FA Cup matches, so it had no minnow parameters
fitted at all -- the backtest correctly skipped predicting any FA Cup
test match involving a minnow (`ValueError`, team not in training data)
rather than crashing, and still scored the 10 held-out matches between
already-known Premier League/Championship teams.

Considered whether to add more raw inputs to the model at the same time
(shots, corners, cards) -- deliberately didn't. Dixon-Coles has no
mechanism to consume arbitrary covariates; it's a generative model of
goal-scoring rates from historical goals alone, not a feature-based
regression. Folding in shot/corner data for real would mean a different
modeling approach entirely (an expected-goals-based target, or the
XGBoost path Phase 5 already considered and deliberately passed on for
interpretability) -- worth revisiting *after* this fix and the data
cleanup get a clean real backtest number, not stacked on top of two
still-unverified changes at once.

## Closing the "worse than guessing" investigation -- real numbers (2026-08-15)

Everything above (the duplicate Oxford/Sheffield United/Sheffield
Wednesday cleanup, the three-model split) was verified against synthetic
or scratch-Postgres data only, since this sandbox has no network access
to the real Neon database. Ran `python -m app.evaluate` for real, on the
real (now-cleaned) production data, to find out whether the fixes
actually worked rather than assuming they would:

| | Before any fix | After team-dedup only | After 3-model split |
|---|---|---|---|
| Premier League Brier | 0.7205 | 0.7085 | **0.6399** |
| Championship Brier | 0.6687-0.6761 | -- | **0.6526** |
| FA Cup Brier | 0.6425 | -- | **0.6513** |

Naive uniform guessing on this Brier formula (computed directly from
`evaluate.py`'s own `brier_score`, not assumed) is 0.667 -- Premier
League started 0.054 *worse* than a coin flip across three outcomes,
which is what actually started this whole investigation ("i think it is
worse than guessing"). It now sits at 0.6399, clearly better than
guessing on both Brier and log-loss, trailing the market by ~0.03 --
the expected, honest gap for a first real model against an efficient
betting market, not a red flag (see the original Phase 5 entry for why
"beat the market" was never the actual bar). Championship and FA Cup
both land in the same "clearly better than guessing" territory.

Both real bugs -- the duplicate Championship clubs and the 811/821-team
joint-fit contamination -- are now confirmed to have actually been
responsible for the bad numbers, not just plausible theories that
happened to also be true. Both fixes were verified against synthetic/
scratch data before this, and now against the real thing too.

## Phase 7: goal scorer prediction (2026-08-15)

Unblocked once the backfill was genuinely caught up. Built the approach
already decided when this phase was originally paused: **allocation, not
a second model**. A team's Dixon-Coles-predicted expected goals for an
upcoming fixture already exist (`predicted_home_goals`/`predicted_away_goals`,
computed for the match-outcome prediction) -- goal-scorer prediction
splits that number across the team's players rather than training a
separate model on a much smaller, noisier per-player dataset:
`λ_player = team_xg × goal_share × minutes_share`, converted to a scoring
probability via the same Poisson math already in `dixon_coles.py`:
`P(scores ≥ 1) = 1 - e^(-λ_player)`.

**Why harder than match outcome, and how that's actually accounted for,
not just acknowledged:** a team always "appears" for roughly a full
match; an individual player might be rested, injured, or subbed early,
and there's no real-time squad-news feed here. `minutes_share` is a
historical-average proxy for playing-time involvement -- computed across
*every* match the team played where the player was named in the squad
(`fixture_lineups`, starting or bench), including matches where they got
0 minutes. That last part matters concretely: averaging only over
matches a player actually got on the pitch would make a rotated squad
player look like a nailed-on starter. Per-player samples are also far
smaller and noisier than team-level ones -- a player with a handful of
appearances has almost no real signal -- so `MIN_PLAYER_MATCHES` (5)
excludes them from prediction entirely rather than producing a
confident-looking number built on nothing.

**A subtlety worth recording, since it's easy to get wrong**: `goal_share`
and `minutes_share` have to answer genuinely different questions, or
multiplying them double-counts playing time. `goal_share` is computed on
a **per-90 rate basis** (goals per 90 minutes actually played, normalized
against teammates' rates) -- "if everyone played equal minutes, what
fraction of the scoring would this player account for," which does *not*
already reflect how much they actually play. `minutes_share` answers the
separate question of how much of a match they're likely to get. Using
raw historical goal totals for `goal_share` instead of a per-90 rate
would have silently baked the same playing-time effect into both factors.

**Scope decision**: player shares are computed from a player's *full*
cross-competition appearance history (Premier League + Championship + FA
Cup combined), not scoped to whichever competition the fixture being
predicted belongs to -- unlike the match-outcome models, which were just
split apart specifically to stop different *teams'* strength estimates
from contaminating each other across competitions. That contamination
risk doesn't apply here: a player's rotation pattern and scoring rate for
their own team is the same real thing whether it happened in a league
game or an FA Cup tie, and excluding a team's own cup appearances would
just throw away real, relevant data about the same players.

Reused `dixon_coles.py`'s exact time-decay formula (`time_weight`, made
public rather than duplicated) and its 180-day half-life, rather than
inventing a second weighting scheme -- consistency with an already-tuned
value beats guessing at a new one.

**Verified against a real scratch Postgres, with a known ground truth,
not just read for correctness:** seeded one team with three players --
"Starman" (started all 19 matches, full 90 minutes, 17 goals), "Fringe"
(named as a substitute in all 19 matches but rarely got on, 50 total
minutes, 1 goal), and "TooFewApps" (only 2 appearances, deliberately
below the reliability threshold). Ran the real `python -m app.train`:
Starman's real predicted scoring probability came out **31.7%**, Fringe's
**2.3%** -- correctly and dramatically directioned, not just "both
nonzero." TooFewApps got no prediction at all, confirming the reliability
threshold actually excludes low-sample players rather than just
existing in the code. Reran the same command a second time and confirmed
the row count stayed at exactly 2 -- the `ON CONFLICT` upsert is
idempotent, not silently duplicating.

Not surfaced in the frontend in this pass -- see the follow-up entry
below for that.

## Surfacing predictions in the frontend (2026-08-15)

Both goal-scorer predictions (just built) and FA Cup match predictions
(built in Phase 5) existed only in the database until now -- nothing in
the frontend showed them. Extended the existing `/predictions` page
rather than building a new one: no fixture-detail page exists yet at all
(`getFixtureById`'s rich response -- team stats, odds -- isn't consumed
anywhere in the frontend either, a separate, pre-existing gap not touched
here), so a new page for this specifically would have been bigger than
what was asked for.

`GET /api/fixtures` and `GET /api/fixtures/:id` now embed each fixture's
top 5 predicted scorers via a `LATERAL` subquery aggregating
`player_goal_predictions` into a JSON array, ordered by `prob_scores`,
mirroring exactly how `model_predictions` was already embedded (same
one-query, no-N+1 shape). `PredictionsPage.tsx` renders the top 3 as a
compact line under the existing home/draw/away probabilities: "Likely
scorers: Name (X%), ...".

**Deliberately did not expand scope to FA Cup while doing this.**
`docs/CLAUDE.md` calls out FA Cup predictions existing in the database
without being an app feature as "a deliberate scope boundary, not a data
gap" -- extending goal-scorer predictions to the exact same competitions
the predictions page already shows (Premier League, Championship) keeps
that boundary intact rather than quietly widening it as a side effect of
an unrelated change.

**Verified in an actual browser, not just typechecked** -- this project's
own rule for UI changes. Seeded a real upcoming fixture with a known
predicted top scorer against a scratch Postgres, started the real backend
and frontend dev servers, confirmed the API response shape directly with
curl first, then loaded `/predictions` with Playwright and screenshotted
it: "Likely scorers: Starman (32%), Fringe (2%)" rendered exactly where
expected, next to the match prediction it belongs to. Caught a real
issue doing this, not a hypothetical one -- the first seeded "upcoming"
fixture was dated 2024, which the real current date (2026) treats as
already in the past, so the page correctly showed nothing until the seed
data was redated forward.

## A real design system, not defaults (2026-08-15)

First real design pass on the frontend -- until now every page ran on
Vite's default scaffold styling (system-ui font, a generic purple
accent, no `button` element styled at all, no `:focus-visible` styling
anywhere). Brief: Chelsea's colors, British football flavor, an "old
school royal" feel.

**Palette**: `#034694` (Chelsea blue) as `--brand` -- a fixed color used
for solid elements (the nav bar, buttons) that stays the *same* in both
light and dark mode, plus `--accent`, the interactive/link color, which
*does* lighten in dark mode (`#7fb2f0`) since blue text needs more
lightness than a solid white-on-blue button does to stay readable
against a dark background. Worth being explicit about that distinction --
"the brand color" and "a color with enough contrast to read as a link"
aren't automatically the same requirement. A muted gold (`--gold`,
`#a9812e` light / `#c9a54c` dark) is trim only -- a rule under every
`h1`, the nav's bottom border -- not a second primary color competing
with the blue for attention.

**Typography**: Cinzel (a serif built on Roman inscriptional lettering --
genuinely what "old school royal" looks like, not just a generic serif)
for headings, set uppercase with letterspacing for the heraldic/crest
feel; EB Garamond (a classic book serif, based on Claude Garamond's
Renaissance-era type) for body text, chosen specifically because Cinzel
is a *display* face -- legible as a short heading, not as paragraphs of
running text. Never use a display font for body copy just because it's
the "theme" font; readability at length always wins there.

**Two real gaps fixed that existed before this pass, not introduced by
it**: no `button` element had any styling at all (every button in the
app, including "Log a bet" and "Settle", rendered as a raw browser
default), and no `:focus-visible` style existed anywhere -- keyboard
navigation had literally no visible indicator of where focus was. Both
are now real, app-wide rules, not per-page patches.

**British slang**: applied to page titles, loading states, and empty
states ("Hang about, fetching the sides…", "Nothing on the fixture list
just yet.", "Nothing on the books yet — fancy a flutter?") across all six
pages. Deliberately did *not* touch functional action-button labels
("Log a bet", "Submit", "Settle", "Delete") -- those need to stay
unambiguous for someone mid-workflow, and a cute label on a button you're
about to click to spend real logged-bet data is the wrong place to spend
personality.

**Explicitly out of scope for this pass, and why**: team logos and player
headshots. Both need a real schema change (`teams`/`players` have no
image-URL column yet) and a seed-pipeline change to actually capture them
-- API-Football already returns crest/photo URLs in its real responses,
so sourcing through the API we're already licensed to use is the right
call, not scraping them from somewhere else. That's real backend/pipeline
work, not something to squeeze into a CSS pass just because it was asked
for in the same breath -- follow-up units, not shortcuts taken here to
appear more "done."

**Verified in an actual browser, both themes, not just typechecked**:
seeded real data against a scratch Postgres, ran the real backend +
frontend dev servers, and screenshotted four real pages (team list,
predictions, team dashboard, login) with Playwright in light mode, then
re-screenshotted the predictions page with `colorScheme: 'dark'` to
confirm the dark-mode palette actually works, not just that it was
written. Both held up: real contrast, real gold rule under headings in
both themes, no broken layouts.

## 2026-08-15 -- Whitespace fix, team logos, player headshots

Two quick follow-ups from screenshots of the design-system pass above:
the layout had a lot of dead space on a normal-width screen, and logos/
headshots were explicitly deferred there as their own units. Both landed
together.

**The whitespace bug** was `.page`'s `max-width: 720px` -- reasonable for
a single column of prose, but the team-list grid and the prediction rows
both had real content that could use more width, and on anything wider
than ~760px the page just left a huge empty margin on both sides. Widened
to 1080px. The one thing that *would* have broken from a blanket widen:
the login/register form uses an inline `maxWidth: 320` style deliberately
(a wide text-input form looks bad), so simply widening `.page` would have
left it stranded on the far left with a huge gap to its right instead of
centered. Added a `.page-narrow` modifier class instead and applied it
only to `LoginPage`, so the width choice is explicit per page rather than
one global number trying to serve both a data-dense list page and a
three-field form.

**Team logos and player headshots**, the deferred work: this turned out
to be a "wire up data already being paid for" problem, not a "go get new
data" problem. API-Football's `/fixtures` response includes each team's
crest URL directly on the `teams.home`/`teams.away` objects, and its
`/fixtures/players` response includes each player's photo URL on the
`player` object -- both endpoints the seed pipeline was already calling
for lineups and player stats, so capturing two more fields off responses
already in hand costs nothing against the daily API-Football budget. Two
new nullable columns (`teams.logo_url`, `players.photo_url`, migration
022) and both fields threaded through the existing golden-record upsert
functions (`getOrCreateTeam` gained an optional `logoUrl` param;
`upsertPlayerGoldenRecord`'s `PlayerInput` gained `photoUrl`) using the
same `COALESCE(existing, new)` pattern every other enrichable field on
those functions already uses -- a later sighting of a team/player without
image data never blanks out a URL a previous sighting already captured.

**Why nullable and not required**: API-Football's crest/photo coverage is
real but not complete, especially outside the Premier League (same
messiness already seen with lineup data on lower-profile competitions).
Rather than have the frontend guess or show a broken-image icon when a
URL is missing or 404s, built two small components (`Crest`,
`PlayerPhoto`) that render nothing at all in either case -- a `useState`
flag flipped by the `<img>`'s `onError` handler. This is the same
degrade-gracefully instinct already used for missing predictions/squad
data elsewhere in the app, just applied to images: absence is a normal,
expected state, not an error to visibly complain about.

**What got touched**: every backend service that returns a team or player
object now threads the new columns through -- `teams.service` (team list,
team-by-id, next-match home/away teams, squad players), `fixtures.service`
(fixture list and fixture detail's home/away teams and top-scorer
entries), and `fpl.service` (My Team's players and their current club).
On the frontend: `TeamListPage`, `TeamDashboardPage`, `PredictionsPage`,
and `MyTeamPage` all render crests/photos now, with the same graceful-
absence behavior everywhere.

**Verified three separate ways, not just "it typechecks"**: (1) a real
scratch-Postgres round-trip calling the actual seed-pipeline functions
directly (`getOrCreateTeam`/`upsertPlayerGoldenRecord`), confirming a new
sighting captures a URL and a later sighting without one doesn't erase
it; (2) the migration's up/down/up round-trip; (3) real Playwright
screenshots, light and dark, showing a team with a real (data-URI, since
this sandbox has no network access to the real API-Football) logo
rendering correctly, a team with no logo rendering cleanly with no gap,
and a team with a deliberately-broken logo URL falling back the same way
as "no logo" rather than showing a broken-image glyph. The real API-
Football field names (`teams.home.logo`, `player.photo`) are documented
API-Football v3 response fields, not guessed, but still worth confirming
against a real `npm run db:seed` run before fully trusting the frontend
result -- unlike most of this project's verification, this one piece
couldn't be checked against real API-Football data from inside this
sandbox.

**Follow-up, same day**: `npm run db:seed:logos`. Team crest capture only
landed for *new* fixture-list fetches going forward -- it doesn't
retroactively fill in logos for the seasons a full `npm run db:seed` had
already pulled before this code existed, and rerunning the entire
pipeline just to backfill that is genuinely an hour-plus job, almost all
of it the per-fixture lineup/player-stats backfill that has nothing to do
with logos at all. Added a standalone script
(`backend/seed/backfill-logos.ts`, exported as `backfillTeamLogos` from
`seed/index.ts`) that only replays the fixtures-list call every full seed
already makes once per competition-season -- the cheap one, not the
expensive per-fixture one. The reason this is fast and not just "a
smaller slow thing": every one of those fixture-list responses is already
sitting in the on-disk cache (`backend/seed/raw/api-football/fixtures/
*.json`, `lib/cache.ts`'s fetch-if-absent pattern) from the original full
seed run, so on a machine that's already seeded once, this makes *zero*
new API-Football requests -- it's just re-reading cached JSON off disk
and re-running the (already-idempotent, COALESCE-based) team upsert.
Verified by priming a scratch cache file with synthetic fixture data
(same shape as a real API-Football response) and confirming
`seedApiFootballFixtures` -- the exact function the new script calls in a
loop -- reads it and lands real logo URLs on all four teams with no
network call at all.

**Follow-up, same day**: narrowed `backfillTeamLogos` to current season
only (was looping all 4 seasons + 3 FA Cup years), and added
`npm run db:seed:photos` for player headshots on the same "current season
only" principle -- a deliberate call, not a shortcut: a team/player's
crest or headshot is effectively static, so the only real reason to
reach into older seasons is to catch a team/player that's since dropped
out of PL/Championship entirely, and that's a small, acceptable gap in
exchange for a small, predictable, fast script.

Headshots specifically needed a different endpoint than the logo script
uses, not just a smaller loop: `/fixtures/players` (what the full lineup
backfill already calls) is scoped to one fixture, so reaching real
current-season coverage that way means looping every fixture -- thousands
of calls. API-Football's `/players?league=&season=` is a *different*
endpoint: it returns every player who appeared in a given league-season
directly, ~20 per page, each already carrying a headshot URL. A full
current-season PL/Championship pull this way is ~25-30 pages per league
(bounded, predictable), not thousands of per-fixture calls for the same
coverage -- the same "use the right endpoint for the shape of data you
actually need" lesson `seedApiFootballLineupsAndStatsBulk`'s bulk
`/fixtures?ids=` switch taught earlier in Phase 2, applied to a different
endpoint pair.

Verified the pagination loop and the golden-record upsert together: primed
a 2-page scratch cache (3 players total, split across pages) and confirmed
`seedApiFootballPlayerPhotosForSeason` walks both pages, lands
photo/nationality/position on all 3, and a second run is idempotent (same
3 rows, no duplicates) -- proving both the multi-page walk and the
external-id-matched upsert work correctly before trusting it against a
real API-Football key.

## 2026-08-16 -- Unit tests: what's worth testing, and the test pyramid

First real automated tests in the project -- everything up to now was
verified by hand each session (scratch Postgres, real screenshots, real
`npm run db:seed` output). That verification style is still right for
*integration-shaped* questions ("does this SQL actually return the right
rows," "does this render correctly in dark mode") -- it just doesn't scale
as a way to keep re-checking pure logic that has no I/O in it at all every
time something nearby changes. That's the gap unit tests fill.

**The test pyramid, briefly**: lots of fast, narrow unit tests at the
bottom (pure functions, no network/DB/filesystem, run in milliseconds),
fewer integration tests in the middle (a real DB, real HTTP calls between
services), and very few slow, brittle end-to-end tests at the top (a real
browser driving the whole real app). The shape matters because cost and
fragility both increase going up: a unit test either passes or it doesn't,
and when it fails you know exactly which function is wrong; an E2E test
can fail for a dozen reasons unrelated to the thing it's nominally
testing (a slow network, a flaky selector, timing), so you want as few of
them as will still catch real regressions in outcomes that only show up
once everything's wired together.

**What actually got unit tests here, and why those things specifically**:
functions with real branching logic and zero I/O -- the sweet spot for a
unit test, since nothing needs mocking and a failure points at exactly one
thing. `bets.service.ts`'s `rowsToBet` is the clearest example in the
whole codebase: given a parlay's leg rows, it derives the overall result,
combined odds, model probability, edge, and payout, with real rules that
are easy to get backwards (a void leg drops out of the combined *price*
but the rest of the parlay still has to win; "lost" beats "pending" beats
"won" when picking the overall result, not just "first leg's result
wins"). `dixon_coles.py`'s `time_weight`/`_tau`, `evaluate.py`'s
`brier_score`/`log_loss`, and `goal_scorer.py`'s `compute_player_shares`/
`allocate_team_goals` are the same shape of thing on the model-service
side: real math with a right and a wrong answer, not something you can
verify by glancing at the code.

**What deliberately did NOT get a unit test**: anything that's mostly a
SQL query (`teams.service.ts`, `fixtures.service.ts`'s `listFixtures`,
etc.) -- testing those meaningfully means testing the query against a
real database, which is an integration test, not a unit test; mocking
`pool.query` to return canned rows would just be re-asserting the mock,
not verifying the SQL is correct. Those stay covered by this project's
existing scratch-Postgres-plus-real-verification habit instead. Full
`DixonColesModel.fit()` end-to-end accuracy (does the model predict real
football well) is also explicitly NOT a unit-test question -- that's what
`python -m app.evaluate`'s backtest against real historical data is for
(see the Phase 5/2026-08-15 entries); a unit test here only checks that
`fit()`+`predict()` behave sanely on a small synthetic case (probabilities
sum to 1, a clearly stronger team is favored), not that the model is
*good*.

**Setup mechanics worth remembering**: both `bets.service.ts` and
`evaluate.py` transitively import a config module that reads
`DATABASE_URL` (and `JWT_SECRET` on the backend) at *import time*, not
lazily -- `requireEnv`/`_require_env` throw immediately if the variable
is missing. None of the functions under test touch the database, but
importing the file they live in still needs that env var to exist just to
not crash. Fixed with a dummy value set before test collection: vitest's
`setupFiles` (`backend/vitest.setup.ts`) on the Node side, a `conftest.py`
(`os.environ.setdefault(...)`) on the pytest side -- both patterns exist
specifically so "make the import not blow up" doesn't require an actual
running Postgres for a unit test suite that never opens a connection.

**Caught real bugs -- in the tests, not the app**: three of the new tests
failed on the first run, and none of them were app bugs. One used a
perfectly deterministic synthetic dataset (Strong always wins 3-0, every
single match, home and away) for the Dixon-Coles fit -- with literally
zero variance to explain, the correlation parameter `rho` is
unconstrained and the optimizer drove it somewhere that made one grid
cell's probability negative. Real numerical behavior of the log-likelihood
surface, not a bug in `dixon_coles.py` -- fixed by giving the synthetic
data actual match-to-match variance, the same way real football score
lines vary. The other two assumed a "prolific full-time starter" would
have a higher per-90 goal *rate* than a "rarely-used sub" -- not
necessarily true, and the constructed numbers happened to give the sub
1 goal in 100 minutes (a very high rate in a tiny sample) against the
starter's 5 goals in 900 (a lower, steadier rate). That's actually
correct, intended `goal_share` behavior (see the Phase 7 entry: it's a
rate, not a volume, on purpose) -- the test's assumption was wrong, not
the code. Fixed by reshaping the fixture data so the starter genuinely
had both the higher rate and the higher minutes share. Exactly the
"discover the fixture was wrong before trusting the code was right" loop
this project has run against real data all along, just now automated and
running in under 2 seconds instead of requiring a scratch Postgres.

## 2026-08-16 -- One E2E test, and why only one

Following straight on from the unit-test entry above: unit tests cover the
pure-logic bottom of the test pyramid, but there's a real, different
question they structurally can't answer -- does registering a user,
navigating between pages, submitting a real form, and having the result
persist and read back actually work, wired together, through the real
Express app and a real Postgres database. That's what
`frontend/e2e/bets-flow.spec.ts` (Playwright) is for: register → view a
team dashboard → log a bet → confirm it's tracked as pending.

**Why exactly one, not a suite**: E2E tests are the most expensive tier of
the pyramid -- slow (this one takes ~14s; the whole unit-test suite runs
in ~2s combined across both languages), and prone to failing for reasons
unrelated to the thing they're nominally checking (a slow network, a
flaky selector, timing races). The payoff for writing more of them drops
fast once you've covered the one thing only an E2E test can prove: that
the seams between frontend, backend, and database actually connect. Every
other page/flow in this app either has no meaningfully different "seam"
to test (same auth, same fetch-and-render pattern) or is already covered
by this project's standing habit of a real Playwright screenshot per UI
change -- more E2E specs here would mostly be paying the slow/flaky tax
again for marginal new coverage, not covering something actually new.

**What it doesn't do, on purpose**: spin up Postgres or the backend
itself. Playwright's `webServer` config only starts the Vite dev server;
Postgres and the backend are assumed already running, the same
prerequisite this project's manual verification passes have always had.
Reimplementing the scratch-Postgres-plus-migrate dance inside a test
config would either mean depending on Docker Compose being available in
whatever environment runs this test, or duplicating setup logic that
already exists as documented manual steps -- not worth it for one spec.
It also doesn't seed a special test fixture: it uses whatever upcoming
Premier League fixture is already in the database (true of any normal
local dev setup, since `npm run db:seed:current-season` pulls the live
schedule) -- an E2E test exercising real app data end-to-end is more
honest than one built entirely around fixtures invented to make the test
pass.

**Version-pinning gotcha, worth remembering**: `@playwright/test` (the
test runner, a new dependency here) and the `playwright` CLI package used
earlier in this project for one-off screenshots are two different npm
packages that can drift to different pinned versions -- installing
`@playwright/test` here pulled 1.62.1 against a pre-installed Chromium
built for 1.56.1. Playwright's test runner lets you override the browser
binary path per-project in `playwright.config.ts`
(`use.launchOptions.executablePath`) instead of triggering a fresh
download, which is what let this run at all in a sandboxed environment
with no browser-download access.

**Verified for real, and it genuinely wasn't a straight pass first try**:
against a real scratch Postgres, a real backend, and a real Chromium --
not just "the code looks right." The first run failed with a real
Playwright strict-mode violation: `.bet-result-pending` matched two
elements (the overall bet's status badge in the card header, and the
lone leg's own status badge, both "pending" with the same CSS class,
since neither had ever needed disambiguating before). Fixed by scoping
the locator to the card header specifically, then reran the full flow
twice more end-to-end to confirm it passes reliably, not just once by
coincidence -- the same discipline as every other "verify, don't assume"
pass in this project, just aimed at the test itself this time.

## 2026-08-16 -- Deciding not to schedule the daily refresh locally

Phase 2's daily-refresh script (`backend/scripts/daily-refresh.sh`) has
been sitting built-and-merged but not actually scheduled since it was
written -- the plan had always been a local `cron`/`launchd` entry as a
stopgap, since GitHub Actions can't run anything for an app that isn't
deployed yet. Revisited that plan today rather than just doing the
originally-planned local step by default: since Phase 10 (deployment)
was always going to replace that local scheduler with a GitHub Actions
workflow running the *exact same script and commands*, the only thing
that changes at deployment is which system presses the button. Scheduling
it locally now would mean setting up a crontab entry (or a launchd
.plist, plus granting cron Full Disk Access on macOS, plus knowing a
sleeping laptop just skips its scheduled runs) and then tearing all of
that down again a short while later at Phase 10 -- real setup effort
for a mechanism with a deliberately short shelf life.

**The actual call**: skip local scheduling entirely, run the refresh
script by hand when it's useful in the meantime (it's idempotent and
safe to run any time), and do the scheduling exactly once, for real, as
part of Phase 10's GitHub Actions setup. This is a genuinely different
decision from "haven't gotten around to it yet" -- the earlier entry
above (Phase 2, 2026-08-15) was honest that scheduling was still an open
manual step; this entry is the deliberate choice not to take that step
at all in its originally-planned form. Updated `docs/PHASES.md` to mark
the refresh-job item done (the real deliverable -- a working, resumable
script -- is complete; scheduling is intentionally deferred, not
missing) and `docs/architecture.md` plus the script's own header comment
to say so, rather than leaving three places in the docs quietly implying
"still meaning to get to this."

## 2026-08-16 -- Phase 10: deployment config, and where the line actually is

Phase 10 splits cleanly into two very different kinds of work, and it's
worth being explicit about why, since it's a real pattern for any project
that reaches "deploy this somewhere real": everything that's a *file in
the repo* (CI/CD workflow definitions, a Render blueprint, a Vercel SPA
rewrite rule) is something a coding session can build and actually verify
end to end. Everything that's an *account* -- creating one, connecting a
real GitHub repo to a third-party service, typing a real database
connection string or API key into someone else's dashboard -- fundamentally
can't be, not as a policy choice but as a hard capability boundary: this
session has no Render/Vercel credentials and shouldn't be handed any.
Built the first kind for real this session; the second kind is a runbook
(`docs/deployment.md`) for the parts that need actual hands.

**GitHub Actions CI** (`.github/workflows/ci.yml`) is the one piece of
this phase that's genuinely, fully done and verified, not just written --
it needs no external account at all (Actions is already part of any
GitHub repo) and no live database (backend and model-service's test
suites were built specifically to run without one -- see the unit-test
entry above). Verified by literally running every command the workflow
runs, by hand, against the actual current state of the repo, before
committing it: if `npx tsc --noEmit` or `npm run test` had failed locally,
the workflow file would have been correct but the repo it's checking
would have been broken, which is exactly the distinction that matters --
a CI config is only as good as what it actually catches, and the only way
to know that is to run the checks yourself first.

**The scheduled daily-refresh workflow**
(`.github/workflows/daily-refresh.yml`) is the direct payoff of
yesterday's decision not to schedule the script locally -- this is that
"schedule it exactly once, for real, at Phase 10" moment. It's real,
committed, cron-triggered config, but it genuinely cannot be verified end
to end from this session: it needs three repository secrets
(`DATABASE_URL`, `API_FOOTBALL_KEY`, `JWT_SECRET`) that only exist once
added by hand in GitHub's Settings UI. Marked done in `PHASES.md` anyway,
same reasoning as the local-refresh-script decision: the actual
deliverable (working, correctly-ordered, idempotent scheduled automation)
is complete -- adding the secrets is a five-minute manual step documented
in `docs/deployment.md`, not remaining engineering work.

**`render.yaml` and `frontend/vercel.json`** are the same shape of thing
for the hosting side: real, committed config that turns "deploy this" into
a few dashboard clicks instead of manually filling in every build setting
by hand, but neither one can actually deploy anything without a real
account behind it. The SPA rewrite in `vercel.json` is worth remembering
as a general lesson, not just a Vercel quirk: any client-side-routed app
(React Router here) breaks on a plain static host without an explicit
fallback rule, because a path like `/teams/5` isn't a real file on disk --
only `index.html` is, and the router only takes over *after* it loads.
Forgetting this is a classic "works in dev, breaks in prod" gap, since
`npm run dev`'s dev server already handles that fallback for you
invisibly.

**What's honestly still open**: the app isn't actually live yet, and
won't be until account creation and secret-typing happen on a real
machine with real credentials -- `docs/deployment.md`'s steps 1-4. The
load-check against the 50-concurrent-user target is explicitly blocked on
that: there's no meaningful way to load-test a URL that doesn't exist,
and pretending otherwise (e.g. load-testing `localhost`) would prove
nothing about the actual deployed stack's behavior. Left it unchecked
rather than substitute a fake version of the check just to close out the
box.

## 2026-08-16 -- First real production bug reports, and what they caught

First hotfix round found entirely by actually using the deployed app, not
by re-reading code -- the whole point of shipping something real. Two
things worth remembering from it.

**Tottenham's empty squad turned out to be the exact same bug class as
the Oxford/Sheffield duplicate-team fixture bug from Phase 5**, just in a
third importer. `seed/sources/fpl.ts` called `getOrCreateTeam` with FPL's
raw team name, never through `canonicalTeamName` the way
`football-data-co-uk.ts` and `api-football.ts` both already did -- the
file's own header comment even said FPL's names "match closely enough in
practice," a claim that was never actually checked against a live
response (this environment can't reach `fantasy.premierleague.com`, see
the same file's UNVERIFIED note). Once it ran against the real production
API, FPL's real value for Tottenham didn't match the canonical "Tottenham"
row already seeded from the other two sources, so it created a phantom
"Spurs" row and every real Spurs player's `current_team_id` pointed at
that instead -- the real Tottenham dashboard queries `players WHERE
current_team_id = <real Tottenham's id>` and correctly found nobody.
Fixed by applying `canonicalTeamName` in `fpl.ts` (matching the other two
importers) and correcting the alias map itself -- the *existing* `Spurs`
entry mapped to `'Tottenham Hotspur'`, which was also never verified and
turned out to not match the real canonical spelling either. Verified with
the same kind of direct reproduction used for the original bug: called
`getOrCreateTeam` with the raw buggy path first (confirmed it really does
create a second row), then with the fixed path (confirmed it resolves to
the same real row) -- not just read the diff and assumed it was right.

Added `npm run db:seed:fpl` (standalone FPL bootstrap rerun, same
reasoning as the earlier logos/photos scripts) so applying this fix in
production doesn't need a full reseed -- just rerun that one command
against the real database once the fix is deployed.

**The harder lesson: fixing the code doesn't retroactively fix data
already corrupted by the bug**, and worse, a naive rerun can outright
crash on it. `teams.external_fpl_id` is a real `UNIQUE` column -- the
phantom "Spurs" row already holds Tottenham's real FPL id from the buggy
run, so rerunning the fixed importer tries to write that same id onto the
*real* Tottenham row and hits a unique-constraint violation before it can
self-heal anything. The actual fix procedure (documented for the user,
since this session has no access to run it against the real production
database) is: null out the phantom row's `external_fpl_id` first (frees
the constraint, touches nothing else), rerun `npm run db:seed:fpl` (a
direct `UPDATE`, not a conditional one, so every affected player's
`current_team_id` gets correctly overwritten to the real team on this
pass), *then* delete the now fully-orphaned phantom row. Skipping straight
to "just delete the phantom row" first would instead fail on
`players.current_team_id`'s foreign key while players still pointed at
it. Order matters here in a way that isn't obvious from either bug in
isolation.

**Boston United appearing in the real Premier League standings** is still
an open investigation, not yet root-caused -- a real non-league club
paired against another real non-league club (Aldershot), tagged under the
*current* Premier League competition-season in the database. Ruled out
the two most likely explanations by reading the actual upsert code before
guessing further: `getOrCreateCompetition`/`getOrCreateSeason`/
`getOrCreateCompetitionSeason` all match on real unique keys (name,
label, and the (competition_id, season_id) pair respectively), so there's
no cross-contamination path through those functions themselves. Waiting
on one more real diagnostic query (whether the fixture's
`external_api_football_id` is set) before touching any code -- if it's
set, the bug is upstream, in what API-Football's own `league=39` query
actually returned; if it's null, it came from the football-data.co.uk CSV
importer instead, a completely different code path to investigate.

**Boston United, resolved.** `external_api_football_id` came back null,
ruling out API-Football. Asked for one more piece of real evidence before
writing any fix -- the actual cached CSV line -- rather than guess from
just the DB row. It was worth it: the real cached `E0_2627.csv` (Premier
League, current season) contains a genuine row whose own `Div` column
says `EC` (football-data.co.uk's code for the Conference/National
League), not `E0` -- "Boston Utd vs Aldershot", two real non-league
clubs. `seedFootballDataSeason` never checked a row's own `Div` column
against the division it was told to fetch; it just trusted every row in
whatever file it downloaded belonged to that competition. Whatever caused
football-data.co.uk to serve (or this environment's cache to hold) a
stray non-league row inside the Premier League file, the importer had no
guard against it -- so it seeded a real English club nobody's ever seen
in a Premier League table as literally... a Premier League team, with a
real (fake) league position.

Fixed structurally, not by special-casing this one match: skip (and
count, with a log line) any row whose own `Div` doesn't match
`config.div`. Verified with a direct reproduction of the exact failure --
a synthetic 3-row CSV with the real "EC,...,Boston Utd,Aldershot,..." line
mixed in among two genuine E0 rows -- confirming the bad row gets skipped
and logged, the two real rows still seed correctly, and (the sharpest
check) no "Boston Utd" team row gets created in the database at all.

**Same underlying lesson as the whole FPL bug above, from a different
angle**: this project's seed importers generally trust their sources'
shape rather than re-validating every field, which is usually fine (API-
Football and football-data.co.uk are established data feeds, not
adversarial input) -- but "usually fine" isn't "always fine," and both of
today's bugs were caught only because the app actually got used for real
and something looked wrong on screen. Real production data keeps
surfacing exactly the class of gap this project's whole "verify against
real data, not just no-exception-thrown" philosophy exists for.

**A third real production bug, same day, different shape**: relegated
teams (Luton, spotted by name on the live site) still showing up under
"Premier League" on the team list. Not corrupted data this time -- Luton
really did play in the Premier League, just in an earlier stored season
(3 years kept for model training). `listTeams`'s join only checked
competition, never season, so "played a Premier League fixture ever"
quietly stood in for "is a Premier League team right now." Fixed by
scoping to each competition's most-recent season by `start_date` -- the
same stand-in `getTablePosition` already uses elsewhere in this file,
since `competition_seasons.is_current` still isn't reliably set. Verified
with a real reproduction: a team seeded with a fixture only in an old
season, alongside one seeded in the current season, confirmed the old
one disappears from the filtered list and the current one doesn't.

**Player detail pages and team form**, the actual feature work requested
alongside the bug reports. Extended the already-existing (but unused by
the frontend) `GET /api/players/:id` rather than adding a parallel
endpoint -- nothing depended on its old minimal shape, so there was no
reason to fork it. Season stats picks the player's most-recently-played
season by matching against real `fixture_player_stats` rows, not "the
current calendar season," so a player with no recent appearances still
gets a real season's totals instead of an empty one. "Last 5 matches"
form is derived from the game log's own rows (already exactly 5, no
separate query); "last 30 days" form is a genuinely separate query, since
that window can hold a different number of matches than 5, not just a
shorter or longer prefix of the same list. Team-level form deliberately
spans every competition a team's played, not just its league season --
the everyday meaning of "form" is the last few results regardless of
competition, unlike table position, which only ever makes sense scoped to
one league table. Both reused `team_fixture_results`, the view already
built in Phase 2 for table standings, rather than duplicating its
win/draw/loss logic.

Verified end to end with a real Playwright screenshot against seeded
data with known values (5 matches, specific goals/assists/minutes/ratings
per match) -- confirmed the season totals and form numbers on screen
match hand-computed sums exactly, not just that the page rendered without
an error. Also caught and fixed a small pre-existing spacing bug while
verifying ("Arsenal vsCoventry" with no space) -- a missing crest and a
missing literal space between "vs" and the next team name had been
silently relying on each other for the visual gap.

**Predictions page: top picks, top goalscorer picks, and a matchweek
filter.** The one real design decision here: "next 2 matchweeks" is
capped by *date* (a 14-day window), not by parsing/matching API-Football's
`round` string ("Regular Season - 3") directly. Rounds aren't guaranteed
comparable across competitions or reliably numeric to sort on, but "the
next two weeks" is a robust stand-in for any competition that plays
weekly, with zero parsing risk. The matchweek dropdown is then just a
client-side narrowing of whatever rounds actually land inside that
already-fetched window -- sorted by each round's earliest kickoff, not
alphabetically (plain string sort would put "Regular Season - 10" before
"Regular Season - 2"). "Top picks" ranks fixtures by their single highest
outcome probability (whichever of home/draw/away is largest) across the
current filter, not always "home win" -- an 85% away win is a stronger
pick than a 75% home win, and the ranking has to reflect that. "Top
goalscorer picks" is the same idea applied to the `topScorers` already
embedded per fixture, just flattened across the filtered fixture set and
re-sorted globally instead of only within each fixture's own top-3/5.

Verified with a real Playwright screenshot against fixtures seeded across
three matchweeks with deliberately varied prediction confidence (75-85%
down to 40%) and a fixture placed 20 days out specifically to prove the
14-day cap actually excludes it (it does) -- then re-verified the
matchweek dropdown itself by selecting a specific round and confirming
both the top-picks lists and the full fixture list narrow to exactly
those 2 fixtures, not just the visible list.

**A fourth real production bug, and the biggest one yet: two different
symptoms, one root cause.** Started from Reece James's player page
showing zero appearances despite Chelsea having plenty of finished,
lineup-backfilled fixtures. First ruled out a duplicate-row theory by
searching for other players named "Reece James" -- found only one. That
was the wrong search. The real diagnostic, run at the user's request:
`SELECT count(*) FILTER (WHERE current_team_id IS NOT NULL AND
external_api_football_id IS NOT NULL) ... FILTER (WHERE current_team_id
IS NOT NULL AND external_api_football_id IS NULL) FROM players` came back
**12 vs. 561** -- almost every rostered player was missing its
API-Football link entirely. Reading `upsertPlayerGoldenRecord`
(`seed/lib/db.ts`) explained why: it matches an incoming API-Football
sighting by exact `lower(full_name) = lower($1)` against existing rows,
falling back to INSERT if nothing matches. API-Football regularly serves
a player under an abbreviated `"R. James"` form -- confirmed for a
current Premier League starter, not just an obscure squad player -- which
never equals `"Reece James"` under an exact compare. Every such sighting
fell through to INSERT, creating a brand-new orphan row that held the
real lineup/stats data but never got `current_team_id` (only the FPL
bootstrap ever sets that column). A follow-up query confirmed the scale:
**5,845 orphan rows** in production against 12 correctly-linked players,
and a targeted `full_name ilike '%james%'` search turned up the smoking
gun directly -- `"R. James"`, id 1333, external_api_football_id 19890,
current_team_id null, sitting right next to the real `"Reece James"` row.

This also resolved the open "backfill reports 0 remaining despite 49
unchecked Chelsea fixtures" mystery from earlier the same day: those
fixtures already had real `fixture_lineups`/`fixture_player_stats` rows
(correctly excluding them from `backfillLineupsForCompetitionSeason`'s
candidate query), just attached to orphan player ids -- and an older code
path (`seedApiFootballLineup`/`seedApiFootballPlayerStats`, since
superseded by the bulk `/fixtures?ids=` endpoint) never called
`markFixturesLineupsChecked`, leaving the flag stale on top of the
misattributed data. Two loose threads, one bug.

**The fix, in two parts, matching the two ways this data gets wrong:**
1. *Stop making new orphans.* `upsertPlayerGoldenRecord` gained a step
   between "exact `external_api_football_id` match" and "exact name
   match/insert": parse the incoming name as `"X. Surname"`, and if it
   parses, look for a *unique* current-roster player
   (`external_fpl_id IS NOT NULL`) sharing that first initial and surname.
   Deliberately conservative -- zero or multiple candidates falls through
   to the unchanged exact-match/insert path rather than guessing, so this
   can never misattribute one player's stats to another.
2. *Clean up the orphans already in production.* A new one-time script,
   `seed/repair-duplicate-players.ts` (`npm run
   db:seed:repair-duplicate-players`), finds existing orphans, applies the
   same unique initial+surname match against the current roster, and --
   inside a transaction per merge -- reassigns their `fixture_lineups`,
   `fixture_player_stats`, and `player_goal_predictions` rows onto the
   real player, merges in whatever the orphan had that the real row
   didn't (`external_api_football_id`, `photo_url`), and deletes the
   orphan. Also backfills `lineups_checked_at` on any fixture that already
   has full lineup/stats data but was never flagged, closing out the
   stale-flag half of the bug. Ambiguous matches (two current players
   sharing an initial+surname) are logged and left alone on purpose --
   verified with a synthetic scratch-Postgres case built specifically to
   prove that path doesn't merge them.

Building the scratch-Postgres reproduction caught a real bug in the fix
itself before it ever reached production: the merge script originally
copied the orphan's `external_api_football_id` onto the real player
*before* deleting the orphan row, which collided with that column's own
UNIQUE constraint (the orphan was still holding the value at that point).
Reordering to delete-then-copy fixed it -- exactly the kind of mistake
the "verify against a real reproduction before handing off a production
fix" discipline exists to catch.

**A related bug in the model service, found from a live screenshot the
same day:** a Brighton vs. Aston Villa prediction listed Joao Pedro (who
transferred Brighton -> Chelsea) as a likely Brighton scorer. Root cause,
in `model-service/app/data.py`'s `load_player_squad_appearances`: goal
and minutes shares are computed per `(team_id, player_id)` from historical
lineup data with no concept of "does this player still play for this
team" -- a transferred player's old-club appearances alone were enough to
clear `MIN_PLAYER_MATCHES` and keep them eligible as a scorer pick for
their former team indefinitely. The obvious fix, joining on
`players.current_team_id`, doesn't generalize: that column is
Premier-League-only (FPL-sourced), so it's NULL for every Championship
player and would have zeroed out Championship goal-scorer predictions
entirely -- a bigger regression than the bug it was fixing. Instead, a
player's "current club" is derived from the same appearance data already
being queried: a `most_recent_club` CTE picks whichever `team_id` a
player's most recent finished-match appearance was for (via `DISTINCT ON
(player_id) ... ORDER BY kickoff_date DESC`), and the outer query only
keeps appearance rows matching that club. Works uniformly across every
competition with no extra data source, and degrades safely for a fresh
transfer: too few appearances yet for the new club just means no
confident prediction for a while, not a confident wrong one. All 27
existing model-service tests still passed unchanged, since they exercise
`goal_scorer.py`'s allocation math directly against synthetic frames, not
this query -- a reminder that a passing test suite only proves what it
actually covers.

**Running the repair script for real, and what its own output taught.**
5,845 orphans checked in production, 421 merged, 1 correctly left alone as
genuinely ambiguous ("J. Dasilva" matched two current players), 5,055 had
no current-squad match (expected -- mostly lower-league/historical players
never on this season's roster), 368 weren't in the abbreviated form at
all. That last number was the interesting one: a random sample of it
included several unmistakably-current top-flight names -- Bruno
Fernandes, Bernardo Silva, Bruno Guimarães, André Onana, Andreas Pereira,
Adam Armstrong, Adama Traoré -- proving a *third*, different name-mismatch
shape existed alongside the abbreviation bug already fixed. Root cause:
`seed/sources/fpl.ts` builds a player's `full_name` as `` `${first_name}
${second_name}` `` straight from FPL's raw fields, and FPL sometimes
stores a player's full *legal* name there rather than the common
football name everyone else uses -- confirmed for real via a targeted
query showing "Bruno Fernandes" (API-Football, id 1374) sitting right
next to "Bruno Borges Fernandes" (FPL, id 444) as two disconnected rows.
Interesting complication found in the same query: those two rows even
carry *different* `external_api_football_id` values (1485 vs 459407) --
API-Football itself apparently holds two internal ids for the same real
person. That's outside anything this app's matching logic can safely
resolve (no shared numeric key, and a name-similarity guess risks a
false merge), so it's being left alone and logged here as a known,
accepted residual data-quality gap rather than something quietly patched
over.

The screenshot that prompted this (mixed "Alexander Isak" / "I. Thiago"
names in the same Top goalscorer picks list) pointed at a related but
safer-to-fix case: a player whose *first* API-Football sighting happened
to be abbreviated (lineups calls are the usual culprit) kept that name
forever, because `upsertPlayerGoldenRecord`'s existing-id branch left
`full_name` deliberately untouched on every subsequent call. Fixed by
comparing the stored name and the incoming one through
`parseAbbreviatedName` on every match-by-external-id hit: if the stored
name is abbreviated and the incoming one isn't, upgrade it; never the
reverse. This is safe in a way the FPL cross-source matching isn't --
both names are attached to the exact same `external_api_football_id`
already, so there's no identity guess involved, just picking the better
of two spellings already known to belong to the same row. Verified with a
scratch-Postgres round-trip proving both directions: an abbreviated-then-
full sequence upgrades the name, and a full-then-abbreviated sequence
does not regress it. Because it triggers on every future match (not just
new ones), rerunning the already-cached, idempotent `npm run
db:seed:photos` pass is expected to retroactively fix most of the
remaining abbreviated leftovers for free, no new API-Football budget
spent.

Also added kickoff time to the Predictions page's "Top picks" and "Top
goalscorer picks" sections (both previously showed only the fixture
matchup, unlike the "All fixtures" list below them) -- verified with a
real Playwright screenshot against a seeded fixture with a known kickoff
time, confirming it renders in both sections without breaking the
existing flex layout.

**Chasing the photo problem led to a team-level version of the same class
of gap.** Current-roster photo coverage was 57/573, and Cole Palmer --
about as prominent a player as exists, already correctly linked via
`external_api_football_id` -- had no photo at all. That ruled out identity
matching as the cause; something about the pull itself was the problem.
`seedApiFootballPlayerPhotosForSeason` pages through an entire league's
player-STATS list (~25-35 pages) to find a team's current squad, which
looked like a bad fit even before finding out why it was actually
failing. API-Football's dedicated `/players/squads?team={id}` endpoint --
one call per team, no season or pagination needed, current roster with a
photo on every player -- looked like a much better source, so per this
project's standing rule (confirm a new endpoint's real shape with one
live call before building anything on it, same as `check-lineup-depth.ts`
and `check-bulk-fixtures-endpoint.ts`), a `check:squads-endpoint` script
was added first.

Running it against Chelsea failed immediately: "Chelsea's row is missing
an external_api_football_id." Reading `getOrCreateTeam` (`seed/lib/db.ts`)
explained why -- it never accepted an external id parameter at all, and
grepping every call site in `api-football.ts` (fixtures, lineups,
player-stats, the bulk endpoint -- six call sites total) confirmed none of
them ever passed one through, even though every one of those API-Football
responses carries the source's own numeric team id right next to the name
and logo already being captured. `teams.external_api_football_id` has
existed in the schema since the Phase 1 migration and had never once been
written to -- a real gap, not a data-availability question, and the same
shape of bug as the player-identity issues found earlier in the day (a
column existing in the schema is not the same thing as anything actually
populating it).

Fixed by adding an optional `externalApiFootballId` parameter to
`getOrCreateTeam`, COALESCE'd into the upsert exactly like `logoUrl`
already was (never overwrites an existing value, only fills a gap), and
threading `.id` through from all six call sites. Verified with a
scratch-Postgres reproduction proving the important safety property: a
team row created without an external id in one process run gets that id
backfilled onto the *same* row (matched via the existing `natural_key`
upsert) when a later run sees it with one, not a duplicate row. No
dedicated repair script needed for production -- `seedCurrentSeasonFixtureLists`
(wired to `npm run db:seed:current-season`) already reseeds every current
Premier League and Championship fixture unconditionally on every run, so
one rerun backfills every current team's external id as a side effect,
for free.

**A real data point that changed the schema: API-Football isn't one id
space.** Running `check:squads-endpoint` against real Chelsea data (once
teams finally had an external id to query with) surfaced something worth
stopping for: "R. James" in the `/players/squads` response carried
`id: 19545` -- but Reece James's actual merged row already held
`external_api_football_id: 19890`, confirmed a few turns earlier from
`/fixtures/lineups`. Same real person, two different numbers, both from
API-Football, depending only on which endpoint answered. A second
confirmed instance of exactly the same shape of problem as the Bruno
Fernandes case found earlier the same day (`1485` vs. `459407`) -- enough
real evidence, twice independently, to treat it as a genuine
characteristic of the data rather than a one-off glitch.

Given that, `players.external_api_football_id` (a single column) can
structurally never represent "this player is known by more than one
number." Weighed two ways to handle it: keep the flat column and write a
bespoke, scoped matcher for every endpoint whose id disagrees (which is
what got built for squads specifically, out of necessity, before this was
fully understood as a pattern rather than a one-off) -- or build a proper
crosswalk table, `player_external_ids(player_id, source, external_id)`,
so every source's id space is recorded on its own terms and any future
disagreement is just another `source` value, not another special case in
code. Chose the crosswalk table: two independent confirmations of the
same failure mode in one day is a real pattern, not a hypothetical one,
and the alternative (a growing pile of bespoke matchers, one per endpoint
quirk) is exactly the kind of debt worth flagging rather than
accumulating.

`players.external_api_football_id`/`external_fpl_id` were deliberately
**not** migrated away -- they stay as the fast, correct lookup for the
`'api_football'`/`'fpl'` sources specifically (used everywhere they
already were, no reason to touch working code), and the new table is
purely additive: `upsertPlayerGoldenRecord` now checks
`player_external_ids` first (via a `findPlayerByExternalId` helper) and
records every external id it resolves through `linkPlayerExternalId`
(idempotent -- a no-op if already recorded) before returning, so a repeat
sighting under the exact same id resolves in one indexed lookup instead of
re-running the abbreviated-name/exact-name matching every time.
`upsertPlayerPhotoForTeam` (the squads-endpoint matcher) does the same
under its own `'api_football_squads'` source -- team-scoped name matching
only on a genuinely *new* id, an instant crosswalk hit on any repeat.

The migration (`1701000000023`) backfills the new table from the existing
flat columns in the same `up` step, so every player already linked keeps
that exact identity, just also recorded in the new table. Verified with a
scratch-Postgres reproduction built directly from the real Chelsea data:
Cole Palmer (whose squads-endpoint id agrees with his stored one) and
Reece James (whose id disagrees) both resolve to their real, single rows
-- and a second simulated squads pull for James, under the same
mismatched id, resolves via the crosswalk on the second call, proving the
"solve it once, not every time" property actually holds. Also replaced
the photo backfill's data source entirely: `seedApiFootballTeamSquadPhotos`
(one call per team via `/players/squads`) instead of
`seedApiFootballPlayerPhotosForSeason` (paged through an entire league's
player-stats list, ~25-35 pages, and was the reason coverage had stalled
at 57/573 rostered players) -- removed the old function outright rather
than leaving it as unused dead code.

**Predictions page, round two: calendar matchweeks, team abbreviations,
ranked scorer picks.** The matchweek filter moved from API-Football's
`round` string to real calendar weeks (Monday-Sunday) -- "Aug 17 - Aug
23" reads the same regardless of competition, unlike round numbers, which
aren't guaranteed to line up across Premier League and Championship.
Week 1 starts on the Monday of the week containing *tomorrow*, not today
-- picking today's own Monday would occasionally hand back a "matchweek"
that's already mostly elapsed (todays' date happened to be a Sunday while
building this, which made the off-by-one immediately obvious: today's own
week ends today, so "next matchweek" has to mean the week starting
tomorrow).

Also surfaced a second real "column exists, nothing populates it" gap,
the same shape as `teams.external_api_football_id` earlier the same day:
`teams.short_name` has existed since the Phase 1 schema, but nothing ever
wrote to it, so displaying "ARS" instead of "Arsenal" needed real data to
read first. Unlike the other two team-identity fields, there's no source
payload to read a short code from -- API-Football's fixtures/lineups
responses don't carry one -- so `backend/seed/lib/team-short-codes.ts`
hardcodes the well-known broadcast-style 3-letter codes for current
Premier League/Championship clubs (same reasoning as `team-aliases.ts`:
a few dozen clubs, seeding runs a handful of times, cheap to maintain by
hand), with a derived fallback (first 3 letters of the name) for anything
unmapped so the UI never shows a blank. `getOrCreateTeam` now computes and
persists this via the same COALESCE-fill-a-gap pattern as `logoUrl`/
`external_api_football_id`, and the frontend carries an identical fallback
so existing production teams display something reasonable immediately,
before the next `npm run db:seed:current-season` backfills the real code.

Other changes in the same pass: Home/Draw/Away labels replaced with each
team's short code (a real scoreboard reads "ARS 45%", not "Home 45%");
the predicted-score line now reads "ARS 2.10 - CHE 0.80" instead of a
bare "expected 2.10 - 0.80"; Top goalscorer picks are numbered 1-10 (up
from an unranked top 8) and each name links to that player's page.
Verified with a real Playwright script (not just a static screenshot this
time) that actually drove the matchweek dropdown -- confirmed the two
week labels render as "Aug 17 - Aug 23" / "Aug 24 - Aug 30" against a
known today, and that selecting each one correctly narrows to just the
fixture seeded inside that week while excluding one deliberately seeded
20 days out.

**Team dashboard: rounding, top performers, squad grouped by position.**
Model predictions (goals, home-win probability) are now consistently
`.toFixed(2)`, matching the same rounding rule applied to the predictions
page earlier -- previously this page showed raw, unrounded floats and a
whole-number `Math.round()` percentage, two different precisions on the
same page.

New "Top performers" section (goals, assists) reuses the same "most
recent season this team actually has fixtures in" pattern already used by
`getTablePosition`, but aggregates `fixture_player_stats` by `team_id`
(who a player actually turned out for in each specific match) rather than
`players.current_team_id` (who they're on today) -- same reasoning as the
"most recent club" fix in the goal-scorer model earlier the same week: a
mid-season transfer's stats split correctly between old and new club
instead of the current club claiming credit for goals scored elsewhere.

Squad grouping surfaced a real, previously-invisible data-quality wrinkle:
`players.position` isn't stored in one consistent format. FPL writes its
own short codes (`"GKP"/"DEF"/"MID"/"FWD"`), API-Football's lineup
responses use single letters (`"G"/"D"/"M"/"F"`), and its player-stats/
squads endpoints use full words (`"Goalkeeper"/"Defender"/"Midfielder"/
"Attacker"`) -- and since `upsertPlayerGoldenRecord` never overwrites an
existing `position` value, whichever source saw a player first is
whatever's stored, permanently. Rather than trying to normalize the
stored data itself (a bigger, riskier change touching production values),
grouping buckets by first letter only (folding API-Football's "Attacker"
into the same bucket as "Forward"/"FWD"/"F") -- correct regardless of
which format a given player happens to have, without touching the
underlying data. Verified with a scratch-Postgres squad deliberately
seeded with all three formats across all four positions plus a real
Playwright screenshot -- confirmed every player landed in the right
group, sorted alphabetically within it, and that the rounding and
top-performers numbers matched hand-computed values from the seeded
fixture stats.

**Teams nav dropdown.** The "Teams" nav link became a click-to-toggle
dropdown (`components/TeamsNavDropdown.tsx`) listing every current
Premier League/Championship team in two columns, linking straight to each
team's dashboard -- click-to-toggle, not hover-only, since a hover-only
mega-menu simply doesn't work on a touch device at all. Closes on
selecting a team, on Escape, or on an outside click (a `mousedown`
listener attached only while open, checking `contains()` against a ref --
removed again on close so it's not doing anything while the panel isn't
even rendered). Fetches both competitions' team lists lazily, only on
first open, and caches the result in state rather than refetching on
every toggle. Verified with a real Playwright script (not just a
screenshot) driving actual clicks: opened the panel, confirmed both
competition columns had the right teams, clicked a team and confirmed
both the URL navigated and the panel closed, then reopened it and
confirmed a click outside the panel closes it too.

**A fourth confirmed instance of the "same source, disagreeing name"
problem -- this time solved for real instead of deferred.** A real
squad-page screenshot showed several Brazilian/South American players
(João Pedro, Estêvão, Moisés Caicedo, Geovany Quenda, Pedro Neto) with no
photo and displayed under an awkward full legal name. Same root shape as
the Bruno Fernandes case flagged earlier as a deliberately-deferred hard
problem: FPL's `full_name` (`first_name + second_name`) is sometimes a
player's full legal name ("João Pedro Junqueira de Jesus") rather than
their common football name ("João Pedro"), which neither exact nor
abbreviated-initial+surname matching bridges. This time it was worth
solving rather than deferring, because the earlier deferral was about a
*global*, all-players match (real false-positive risk at that scale) --
this one only ever runs inside `upsertPlayerPhotoForTeam`, already scoped
to one team's ~25-30 player roster, where the risk profile is completely
different.

The fix, `namesLikelyMatch`: treat one name as a match for another if its
words appear, in order, as a subsequence of the other's words (accent-
stripped via NFD normalization first, so "João"/"Joao" compare equal).
Deliberately bidirectional -- confirmed for real that either source can be
the longer name: FPL had the fuller legal name for João Pedro, but
API-Football's squads endpoint had the fuller name ("Geovany Tcherno
Quenda") for a player FPL stores under the shorter "Geovany Quenda". Only
applied as a last-resort tier, after exact and abbreviated matching have
already failed, and only acted on when it resolves to exactly one
candidate on that team -- same non-negotiable safety rule as every other
fuzzy match added this session. When it fires, the stored name is
upgraded to whichever of the two is shorter, since the common football
name has consistently been the shorter one in every real case seen so
far, regardless of which source supplied it -- verified this holds in
both directions with a scratch-Postgres reproduction built directly from
the screenshot's real names (including the reversed Geovany Quenda case,
where the fix correctly left FPL's shorter name alone instead of
"upgrading" it to the longer squads-endpoint form), plus a control player
(Cole Palmer, already unambiguous) confirmed completely untouched.

**Team dashboard's "Next match" line got the same abbreviation treatment
as the predictions page.** "Model prediction: 1.34 - 1.27" doesn't say
whose score is whose without reading the fixture line above it first --
now reads "FUL 1.34 - CHE 1.27", matching the predictions page's format
exactly. `shortCode()` was duplicated between `PredictionsPage.tsx` and
this page's needs, so it moved to a small shared `lib/teamDisplay.ts`
instead of copy-pasting a third time -- both pages now import the same
function. Verified with a real Playwright screenshot against the exact
numbers from the screenshot that prompted the request.

**The Brazilian/South American name bug wasn't just a photo problem --
it was reaching the model.** Asked directly whether the squads-endpoint
fix from earlier could also be affecting predictions, and the honest
answer was no -- that fix only touches `/players/squads`, which never
writes to `fixture_lineups`/`fixture_player_stats`, the tables the goal-
scorer model actually trains on. Those get populated by a *different*
endpoint pair (`/fixtures/lineups`, `/fixtures/players`) through the
general-purpose `upsertPlayerGoldenRecord`, which never got either of the
day's two matching fixes. A real diagnostic confirmed it was live: Estêvão,
Moisés Caicedo, and Pedro Neto all had orphan rows holding 28-119 real
appearances and 34-71 real `player_goal_predictions` rows, while their
actual FPL-linked player showed zero of either -- goal-scorer predictions
for three of Chelsea's most important attackers were being computed
correctly, then written to the wrong `player_id`, disconnected from the
identity the rest of the app treats as canonical for them.

Two distinct root causes, not one:
1. **Moisés Caicedo Corozo** revealed a genuinely different bug from the
   full-legal-name case: the abbreviated-name matcher (`parseAbbreviatedName`
   + initial/surname) only ever compared against the *last* word of a full
   name. Hispanic naming convention stacks two surnames, paternal then
   maternal ("Caicedo" then "Corozo") -- API-Football's "M. Caicedo" only
   ever matched on "Corozo", the surname nobody actually calls him by.
   Fixed by matching the surname against *any* word after the first
   (`$2 = ANY((string_to_array(lower(full_name), ' '))[2:])`), not just
   the last -- a one-line SQL change, but one only found because a real
   diagnostic surfaced a real player it was failing for.
2. **Estêvão and Pedro Neto** were the same full-legal-name-vs-common-name
   gap already fixed for squads-endpoint photos, just never extended to
   the path that feeds the model. Fixed the same way: `namesLikelyMatch`'s
   word-subsequence check, gated behind an optional `teamId` on
   `PlayerInput` that only fires when the caller actually knows which team
   a sighting is for (every lineups/player-stats call site does, threaded
   through from the same `getOrCreateTeam` call already resolving it) --
   same non-negotiable uniqueness-within-one-team safety rule as before.
   Verified deliberately *without* `teamId` too, proving the safety net
   stays inactive (falls through to a fresh insert, not a guess) for any
   future caller that doesn't have team context.

**Production cleanup needed real disambiguation, not just a bigger
hammer.** Asked for one more diagnostic before writing any repair SQL:
were the confirmed cases isolated, or was there a genuinely ambiguous one
hiding in the data? There was -- two separate orphan rows both named some
form of "João Pedro" with substantial real appearance data each (70 rows
apiece). A team-appearance breakdown resolved it cleanly: one had 41
Chelsea + 29 Brighton appearances (exactly the shape of a real Brighton
-> Chelsea transfer), the other had 36 Hull City + 34 Brighton and *zero*
Chelsea -- a completely different real person who happens to share a very
common Portuguese first-and-second-name combination, not a split
identity. `repair-duplicate-players.ts` was extended (not replaced) with
this exact logic as a second pass: derive which team an orphan most
likely played for from its own `fixture_lineups`/`fixture_player_stats`
rows (a dominant team, more than half of total appearances, required --
not just a plurality), then fuzzy-match only against *that* team's
current roster. Verified against a scratch-Postgres reproduction built
directly from the real numbers in that diagnostic: the real transfer case
merged and renamed correctly, and the unrelated Hull City/Brighton player
was left completely untouched, still holding its own real data, exactly
as it should.

**Teams nav dropdown: colloquial names for clubs whose full name wraps.**
"Queens Park Rangers", "West Bromwich Albion", and "Wolverhampton
Wanderers" wrapped to a second line in the nav dropdown's fixed-width
columns, breaking the layout -- a real, deliberately different problem
from `shortCode()`'s 3-letter scoreboard codes ("QPR" happens to already
match, but "West Brom"/"Wolves" are not "WBA"/"WOL"). New
`navDisplayName()` in `lib/teamDisplay.ts`, a small hardcoded map (same
pattern as `team-aliases.ts`/`team-short-codes.ts`) for just the handful
of clubs whose canonical name is long enough to wrap -- everything else
passes through unchanged. Verified with a real Playwright script against
all three clubs plus a control (Watford, untouched).

**A second, subtler gap in the "most recent club" fix, found from a real
live prediction.** Harry Wilson showed up as a likely scorer for Fulham
vs. Chelsea, despite (per the user's real-world knowledge) no longer
playing for Fulham. A real diagnostic ruled out the obvious suspects
first: only one player row (no duplicate-identity issue), and the
prediction was freshly computed that same day (not stale data left over
from before any of the day's fixes). What it actually showed: every one
of his recorded `fixture_lineups` appearances was for Fulham -- but
`players.current_team_id` already pointed at Leeds United. FPL's
bootstrap-static data is live and reflects a transfer the instant it
happens; match/lineup data can only catch up once the new club has
actually played a fixture that's been backfilled. There's a real window
between those two moments, and the earlier "most recent club" fix
(deliberately built to ignore `current_team_id`, since it's null for
every Championship player) had no way to see across it.

Fixed in the same query, `model-service/app/data.py`'s
`load_player_squad_appearances`: now prefers `players.current_team_id`
when it's set -- a strictly more current signal than one derived from
match data, for the players FPL actually covers -- and only falls back to
the appearance-derived most-recent club when `current_team_id` is null
(Championship). A player transferred per FPL but with zero appearances
yet for the new club simply has no rows survive the join: he drops out of
`goal_scorer`'s shares table entirely and gets no prediction at all, until
real matches exist for that club -- the same "no confident answer yet,
not a confidently wrong one" outcome the original fix was already built
around, just triggered by a fresher, more authoritative signal. Verified
against a real reproduction of all three shapes at once, run through the
actual `load_player_squad_appearances` query rather than a mock: Harry
Wilson's transfer-with-no-new-club-data case correctly returns zero rows,
Joao Pedro's transfer-with-new-club-data case still correctly returns
only his new-club appearances (proving the original fix's intent survived
the change), and a Championship player with no `current_team_id` at all
still correctly falls back to the appearance-derived club, untouched by
this change.

**Then a real product question, not a bug report: should a transferred
player be invisible until he clears the reliability threshold at his new
club, or is a rate built partly on old-club history better than no
prediction at all?** Worth a deliberate decision, not a default -- talked
through the tradeoff (skill is somewhat portable, but a different club's
service/system/role is a real confound) before touching anything. Landed
on: yes, keep him in the model, but make sure the *comparison set* is
still his real current squad.

The mechanism already existed and didn't need inventing: `compute_player_shares`
already recency-weights every appearance with a 180-day half-life
(`time_weight`) -- an old club's appearances were always going to fade,
they just never got the chance to blend with anything, because
`load_player_squad_appearances` was filtering every appearance down to
only ones matching the player's *current* team_id (that's the fix from
the previous entry). The redesign was two lines of SQL: instead of
joining appearances to `effective_club` on both `player_id` AND
`team_id`, join on `player_id` alone and select `effective_club`'s
`team_id` as the label instead of the appearance's own. Every historical
appearance a player has ever made now counts toward his personal rate
(weighted by recency, so a transfer's-worth-old data already carries
less weight and keeps fading), but is always *grouped and normalized*
against whichever teammates share his current effective club --
`compute_player_shares`'s and `allocate_team_goals`'s own code needed
zero changes, since "team_id" already meant the right thing once the
query handed it the right value. The elegance here is a real lesson: the
recency-decay and team-normalization logic were both already correct in
isolation, the bug was purely in which rows reached them.

Verified end-to-end, not just the query in isolation: ran the real
`compute_player_shares`/`allocate_team_goals` pipeline against the same
Harry Wilson/Joao Pedro/Championship-player reproduction used for the
previous fix. Harry Wilson -- previously entirely absent from the shares
table -- now clears `MIN_PLAYER_MATCHES` on his 8 Fulham appearances
(all correctly labeled as Leeds, his effective club) and gets a real
`allocate_team_goals` prediction for a Leeds fixture. Joao Pedro's full
9-appearance history (3 old Brighton + 6 new Chelsea) now all count
toward his rate, all labeled Chelsea, instead of only the 6 Chelsea rows
counting as under the previous, stricter fix.

## 2026-08-17 -- Bets overhaul: USD, American odds, goalscorer legs, a real odds-override design fork, and auto-grading

Four asks bundled into one unit of work, but two of them turned into real
design decisions worth slowing down for rather than just building.

**USD display and American-odds input were the easy part.** The `£`
symbols throughout `BetsPage.tsx` became `$` -- purely cosmetic, since
`bets.stake`/`bet_legs.odds_decimal` never stored a currency, just a raw
number the user typed. American odds (`+150`, `-110`) needed a real
conversion, though, since decimal odds stay the backend's source of
truth (unchanged design from Phase 6): `americanToDecimal` in a new
`frontend/src/lib/odds.ts` (`1 + american/100` for positive, `1 +
100/abs(american)` for negative) runs client-side before a leg or the
parlay override ever reaches the API -- the backend never even knows
which format the user typed in.

**The real fork: what does a parlay's "combined odds" field actually
ask for?** The very first UI-overhaul request ("go back to only asking
for overall bet odds if it is a parlay") sounded like it meant dropping
per-leg odds entry for parlays entirely -- just one combined-price field.
But that would have broken something the schema was deliberately built
to support: a void leg dropping out of the combined price while the rest
still have to win (`docs/erd.md`'s original `bets`/`bet_legs` design
note). Without each leg's own price, there's no way to recompute a
correct reduced price if one voids after the fact. Talked through both
shapes directly rather than guessing which one "asking for full odds"
meant: keep asking for each leg's own odds (unchanged), and add one
*additional*, optional field -- the book's own quoted total for the whole
parlay, for when it differs from the pure product (rounding, a
parlay-level margin). Landed in the schema as `bets.odds_override_decimal`
(migration `1701000000024`), nullable, parlay-only. `rowsToBet` uses it
as `combinedOdds` only while every leg is still live; the instant any leg
voids, it falls back to the per-leg product (excluding the void leg),
since there's no way to know how the book's own total would have
repriced for that specific leg -- but the per-leg product is still a
real, defensible number. This is the same "derive, don't duplicate"
principle the original design already used for `bets.result`/`settled_at`,
just applied to one column that gets a deliberate, narrow exception
instead.

**Anytime-goalscorer bets proved out the free-text `market`/`selection`
design for real.** No migration needed for the bet shape itself --
`bet_legs.selection` is free text (mirrors `fixture_odds.market`/
`outcome`), so `market='anytime_scorer'` just stores a `player_id` as
text in the same column that stores `'home'`/`'draw'`/`'away'` for
`match_winner`. The only backend work was teaching `bets.service.ts` to
interpret it: `BET_LEG_SELECT` gained a `CASE WHEN bl.market =
'anytime_scorer' THEN NULLIF(bl.selection, '')::int END` guard so the
cast only ever runs on rows where `selection` is actually numeric (a
`match_winner` row's `'home'` never reaches the cast, since Postgres
doesn't evaluate the untaken branch of a `CASE`), joined to
`player_goal_predictions` for `modelProbability` and to `players` for a
real name to display -- a bet card was never going to show a bare
`player_id`. Frontend-side, the leg builder for this market picks team ->
that team's upcoming fixture -> a player from the team's actual squad,
reusing `/api/teams/:id/dashboard`'s existing `squad` field rather than
adding an endpoint. Filtered to outfield players only (excluding
`positionGroup(player.position) === 'Goalkeeper'`, per your steer --
vanishingly rare for a keeper to score, and it just clutters a picker
meant for realistic bets); that filter function got extracted from
`TeamDashboardPage.tsx` into a shared `frontend/src/lib/positions.ts`
since this is now its second real caller.

**Auto-grading: "did it hit" shouldn't need a manual click once the game
is over.** You asked directly whether the app could grade bets from real
post-game stats instead of only the existing manual Won/Lost/Void
buttons. It already had exactly the data needed: `fixtures.home_score`/
`away_score` for `match_winner`, `fixture_player_stats.goals` for
`anytime_scorer`. New `autoSettleFinishedLegs(userId)` runs one `UPDATE`
against every still-`pending` leg whose fixture has `status = 'finished'`,
computing the real result via `CASE` (home/draw/away vs. the actual
score; `goals >= 1` for a scorer leg) and writing it straight to
`bet_legs.result`/`settled_at` -- called at the top of `hydrateBets`, so
every read (`listBets`, `getBetById`, `getRoiSummary`, all three route
through it) grades first. No new table, no cron job, no "refresh"
button: the existing read path just does slightly more work now. One
real edge case needed a decision, not a default -- a player who's part of
an anytime-scorer bet but never actually took the pitch (an unused sub,
or not even in the matchday squad). Discussed it directly: **loss**, not
void/refund. The bet is "did he score," and he didn't get the chance to
-- closer to how most books' actual small print treats it, and it avoids
a harder question the void answer would have required (distinguishing
"unused sub" from "not selected at all," which needs a lineup-presence
check on top of the stats check). The manual Won/Lost/Void buttons stay
in the UI, now genuinely a fallback rather than the only path: any market
this function doesn't know how to grade, or a `match_winner` leg whose
fixture finished without a recorded score (an abandoned match), is left
`pending` for a human call.

Verified against a real Postgres reproduction covering every branch at
once, not just the happy path: a correct `match_winner` pick auto-graded
`won`, an incorrect one `lost`; a scorer who actually scored graded
`won` with `modelProbability` correctly pulled from
`player_goal_predictions`; a scorer who played but didn't score graded
`lost`; a scorer who never played the fixture at all also graded `lost`,
confirming the chosen edge-case behavior rather than assuming it; a
parlay spanning one finished and one still-upcoming fixture correctly
stayed `pending` overall while its finished leg settled on its own; a
parlay with an odds override and both legs winning used the override
(5.0) over the pure product (4.5) for `combinedOdds` and payout; the
same parlay shape with one leg manually voided afterward correctly fell
back to the live leg's own product (1.8), ignoring the stale 5.0
override. Also caught and fixed a real, unrelated regression while
driving the flow through an actual browser: the Bets E2E spec
(`e2e/bets-flow.spec.ts`) still targeted `getByRole('link', { name:
'Teams' })` from before the Teams nav dropdown shipped (Teams became a
`<button>` that opens a panel, not a link) -- it had silently never been
re-run since that change landed. Fixed the locator and confirmed the
whole register -> view a team -> log a bet -> see it tracked flow still
works end-to-end against the real backend.

## 2026-08-17 -- A dated exception to a documented decision, not a silent override

Small change, but worth logging on its own since it directly contradicts
something `docs/architecture.md` states as settled: "football-data.co.uk
and FPL bootstrap are *not* part of the daily refresh ... FPL's
bootstrap-static changes slowly enough that a manual rerun covers it."
That was true when written. It stops being true the moment a transfer
window opens -- FPL's bootstrap-static (and therefore
`players.current_team_id`) updates the instant a real transfer completes,
and the last two entries in this log are a full bug chain (Harry Wilson,
then the deliberate blend-history redesign) about exactly how much the
goal-scorer model's predictions depend on that column being current. Left
unaddressed, the daily refresh would keep training on a stale roster for
the entire window, right as transfers are actually happening.

The fix is one added step: `npm run db:seed:fpl` (already existed,
already idempotent -- no new code, just an existing command not
previously wired into the schedule) runs in both `daily-refresh.sh` and
`.github/workflows/daily-refresh.yml`, positioned right before `python -m
app.train` so a fresh roster always feeds the retrain that follows it.
Guarded by a hardcoded cutoff (`2026-09-02`, this window's close) checked
via a plain bash string comparison against `date -u +%Y-%m-%d` -- ISO
date strings compare correctly lexicographically, so no date-parsing
library or GitHub Actions expression trickery was needed. Deliberately
self-expiring rather than something to remember to revert: once today's
date passes the cutoff, the step just echoes and no-ops, so the original
"manual rerun is enough" reasoning in `architecture.md` becomes true
again on its own, with the note updated in place (not deleted) to explain
why the exception existed rather than leaving a silent contradiction for
future-me to puzzle over.

Scoped narrowly on purpose: only FPL, not football-data.co.uk (still
genuinely true that a CSV of already-played matches has nothing "current"
to re-pull) and not a Championship equivalent (`current_team_id` is
FPL/Premier-League-only by design -- see the golden-record note in
`erd.md` -- so Championship rosters have no matching staleness gap; the
existing daily lineup backfill already keeps their appearance-derived
club assignment current). Widening this to "refresh everything more
often" would have been solving a problem that doesn't exist for those
other cases.

## 2026-08-17 -- The Home page: a real-geography map without a real map file

The last piece of the original UI-overhaul request: a new "/" landing
page (competition filter, current standings, upcoming/recent fixtures)
plus the "team crests on a real map" idea from the very first ask.
`TeamListPage.tsx` (a bare team grid) is gone -- superseded now that the
Teams nav dropdown handles "browse teams" and this page does something
more useful with "/".

**New backend piece: `GET /api/teams/standings?competition=X`.**
`teams.service.ts` already had `getTablePosition(teamId)` (one team's
position, from a Phase-2 build) -- `getStandings(competitionName)` is its
whole-table sibling, same `team_fixture_results` view and same
"most-recent-season-by-start-date" stand-in for `is_current` (still not
wired up -- see `erd.md`), just grouped by every team in the season
instead of filtered to one. Had to register the route before `/:id` in
`teams.routes.ts`, or Express would parse `/standings` as an `:id` value.

**The map: no live/in-play scores (confirmed with you directly) and no
external basemap file.** Two decisions worth recording since both were
made deliberately rather than defaulted into:

1. The "games box" only shows upcoming fixtures and recent results, not
   live scores -- `docs/architecture.md` already documents that this app
   has zero live/in-play tracking (fixtures are only ever `scheduled` or
   `finished`), and building a live scoreboard would have been new scope,
   not a Home-page detail. Derived client-side from one shared
   `from`/`to` window fetch (today ± 10 days) rather than two separate
   backend endpoints -- `status === 'finished'` sorted descending is
   "recent results," everything else sorted ascending is "upcoming,"
   split out of the same array the existing `/api/fixtures` endpoint
   already returns.
2. Went looking for a real England+Wales boundary file first (Ordnance
   Survey/ONS open data, Wikimedia Commons SVG maps) rather than assuming
   a hand-drawn shape was the only option. Backed off once it became clear
   getting one meant either a large multi-MB file needing Scotland/NI
   cropped out programmatically, or scraping a specific SVG's raw `path`
   data through tools (WebFetch) that summarize content through a model
   rather than returning exact bytes -- a real risk of a garbled path
   string for a feature that's explicitly meant to be lightweight and
   self-contained (no attribution text to carry, no external asset to
   keep in sync). Chose instead to hand-build a stylized outline from ~76
   known coastline landmarks (Land's End, the Wash, Solway Firth, etc.),
   projected through the *same* lat/lon -> pixel function used for every
   team marker (`frontend/src/lib/teamGeo.ts`) -- explicitly documented in
   code as approximate, not survey-grade. The projection itself is a
   plain equirectangular one, but scaled by `cos(mean_latitude)` so a
   degree of longitude and a degree of latitude cover the same real-world
   distance at England's latitude; skipping that step is the single most
   common way these quick maps end up visibly squashed east-west.

**A genuine algorithm, not just data entry: fanning out crowded
clusters.** London alone has 10 Premier League/Championship clubs within
a few miles of each other -- plotted at literal coordinates, their crests
would total overlap at any readable icon size (confirmed the "auto-fan"
approach with you over a hardcoded "collapse to one badge" alternative,
specifically so it keeps working correctly no matter which teams are
actually in the league that season, promotion/relegation included, with
no per-team offset table to maintain by hand). `layoutMarkers` in
`teamGeo.ts` is plain union-find: any two markers projected within
`CLUSTER_RADIUS_PX` of each other merge into a group (transitively, so a
whole city-region like the West Midlands forms as one cluster without
being told to), then each group's members fan out evenly around a ring
centered on the group's own average position. First pass used a fixed
ring radius and had two real problems, both caught by an actual rendered
screenshot, not just by reading the code:
- A *fixed* radius crushed London's 10 members together while barely
  spreading a 2-member group -- fixed by scaling the ring radius with
  cluster size (`radius = max(minimum, count * arc_budget / 2π)`, i.e.
  aiming for a roughly constant arc-length gap between neighbors
  regardless of how many are in the group).
- Members were assigned ring positions in arbitrary (insertion) order,
  which occasionally swung a fanned-out member around to visually
  collide with an unrelated *singleton* marker sitting just outside the
  cluster -- fixed by sorting each cluster's members by their own true
  bearing from the group's centroid before assigning ring slots, so a
  member fans out roughly toward the real compass direction it actually
  sits in.

**Verification, in order:** a standalone script rendered the projected
outline + every current PL/Championship club's marker to a static SVG,
screenshotted it, and was checked both visually (does this read as
England and Wales, are the clusters legible) and numerically (a
brute-force pairwise-distance scan for any two markers left closer than
8px after fan-out -- went from 3 close pairs down to 1 after the
size-aware radius fix, and that remaining pair turned out to be a
genuinely separate club sitting just outside a cluster's boundary, not a
bug). Then the real thing end-to-end: scratch Postgres seeded with real
PL + Championship teams/fixtures, the actual dev backend/frontend running
together, `GET /api/teams/standings` checked directly, and a Playwright
script that clicked a real map marker and confirmed it navigated to that
team's dashboard, then switched the competition filter and confirmed the
standings/map/fixtures all refetched for Championship. Also checked in
dark mode -- the map's fill/stroke/marker colors are all CSS custom
properties (`--accent-bg`/`--accent-border`/`--bg`/`--gold`), so the
theme swap needed zero map-specific code.

## 2026-08-17 -- Fixing the map: city labels, and a real bug in how "relevant" was decided

Feedback on the Home page map, same day it shipped: the crest clusters
alone don't say "this is London" without already knowing the crests, and
the crowded areas were hard to read. Added `MAJOR_CITY_LABELS` -- text
labels rendered the same way as the crest markers (percentage-positioned
over the SVG outline), offset upward enough to clear a cluster's full fan
radius rather than sitting on top of it (the first attempt used a 24px
offset, comfortably clearing a 2-club pair but not London's ring of 7-8 --
had to actually screenshot it to see the label rendering half-hidden
behind a marker before realizing 24px wasn't enough; bumped to 44px).

**First version of "should this label even show" was wrong, and a real
bug, not just a rough edge.** Gated each label on whether any club
projected within some pixel radius of the city's reference point -- 35px,
picked to comfortably catch a fanned-out cluster. Screenshotting the
Championship-only view caught the actual problem: Blackburn (no
Manchester club anywhere in that competition) was close enough to the
Manchester reference point to trigger a "Manchester" label anyway, and
Derby did the same for "Nottingham" -- both real English cities sitting
close enough together (Blackburn-Manchester ~30km, Derby-Nottingham
~25km) that any distance threshold generous enough to still catch a real
cluster was *also* generous enough to mislabel a nearby-but-different
city. Distance from a reference point was never going to be the right
signal for "is this specific named city actually here" -- switched
`MAJOR_CITY_LABELS` to an explicit `triggerTeams` list per city (the
specific canonical team names that belong to it, e.g. Manchester ->
`['Manchester City', 'Manchester United']`), checked by literal set
membership against whichever teams are actually being shown. Same "a few
dozen clubs, cheap to hand-maintain" reasoning already used for
`team-short-codes.ts` and `TEAM_CITY_COORDINATES` itself -- this is a
genuinely more correct signal, not just a workaround, since "is club X
literally in the current team list" has no false-positive case the way
"is anything within N pixels" does.

Also widened the map's share of the page layout (1.3fr -> 1.7fr of the
two-column grid) since the crowded areas read as more cramped than
necessary at the original size -- a real crest image will still help
here (blank white circles in every scratch-Postgres screenshot are their
own worst-case for "can you tell these apart," real club badges look
nothing alike), but more on-screen room for the cluster rings costs
nothing and helps regardless.

Verified the same way as the original build: real screenshots (not just
reading the diff) against both competitions, confirming London/Manchester/
Liverpool/Birmingham/Newcastle label correctly for Premier League and
Sheffield/Birmingham/Cardiff/Bristol/Norwich label correctly for
Championship -- and specifically confirming Manchester and Nottingham no
longer appear on the Championship map now that the fix is in.

## 2026-08-17 -- Leader lines instead of zoom/pan

More map feedback: could a fanned-out cluster show where its members
*actually* are, and should the map support zooming in/out? Asked to pick
rather than default to the more ambitious option -- went with small
leader lines back to each cluster's true location instead of interactive
zoom/pan, and it's worth recording why, since "add zoom" was a completely
reasonable ask that got turned down.

Zoom/pan would have meant a real new interaction surface: wheel-zoom
conflicting with normal page scroll, pinch-to-zoom on mobile, panning
without losing which crest is which, keeping ~50 absolutely-positioned
HTML `<Link>` markers in sync with whatever transform state a zoomed SVG
viewBox was in, and testing all of that across pointer/touch/keyboard.
Real, but new, complexity for what's meant to be a lightweight page
decoration, not a primary navigation tool -- Teams are already one click
away via the nav dropdown, so the map's job is orientation and a fun
alternate way to browse, not the only way to reach a team.

Leader lines solve the actual complaint ("where exactly is this") with
none of that: `layoutMarkers` in `teamGeo.ts` already computed each
cluster's true centroid internally (used to fan members out around it) --
it just wasn't returned. Changed its return type from a bare marker array
to `{ markers, clusterAnchors }`, where each marker carries its own
cluster's center (`null` for an unclustered singleton, which needs no
line since its marker already IS its true position) and `clusterAnchors`
is the deduplicated list of real cluster locations. `EnglandWalesMap.tsx`
draws a short dashed `<line>` from each fanned member back to its
cluster's anchor, plus one small gold dot marking the anchor itself --
all inside the existing outline `<svg>`, no new element or interaction
required. Reads as a small starburst around each cluster: the real place,
with each crest connected back to it.

Verified visually again (screenshots, both competitions, both themes) --
London's ring of 7 crests now has visible dashed spokes converging on a
single gold dot, same for the smaller Manchester/Liverpool/Sheffield
pairs, and it holds up in dark mode without any theme-specific code
(`--accent-border`/`--gold` are already theme-aware tokens).

## 2026-08-18 -- Matchday lineup capture, a real caching bug it uncovered, and game pages

Two asks: get real starting lineups on game days (not just after full
time), and a match detail page showing team/player stats for a finished
game. A third -- "grab lineups and retrain models" -- turned out to
partly answer itself once I actually read `goal_scorer.py` again instead
of assuming: `allocate_team_goals` distributes a fixture's predicted
goals across every player who clears a season-level appearance-rate
threshold. It has **no per-fixture "is this specific player confirmed to
start today" input at all** -- so capturing today's lineup and
immediately retraining wouldn't change that day's predictions one bit,
since the model never looks at the lineup it would just have captured.
That's exactly the player/injury/form-driven redesign flagged as future
work, not something to fake with a no-op retrain now. Decided (and
explained, not silently skipped) to leave the daily retrain exactly as it
was -- once a day, on finished results -- and keep lineup capture as its
own thing.

**The real design fork was a caching bug, not a feature decision.**
`backfillLineupsForCompetitionSeason` (the existing post-match backfill)
only ever considers `status = 'finished'` fixtures, and migration
`1701000000020`'s own comment explains why: `fetchCached`'s disk cache
has no expiry, so a not-yet-played fixture swept into a backfill chunk
would get its (necessarily empty) response cached under that fixture's
key forever. Building a NEW check that runs on `scheduled` fixtures on
purpose -- the whole point here -- walks straight back into that same
landmine: check a fixture before its lineup is announced, and the empty
result gets written to `raw/api-football/lineups/{id}.json` with no TTL,
so *every later recheck, including the one that would finally see the
real lineup*, just replays that stale empty file forever. Caught this by
tracing `callApiFootball`'s actual caching mechanics before writing the
new selection query, not after something broke. Fixed with a `skipCache`
option on `callApiFootball`/`seedApiFootballLineup` -- bypasses the disk
cache entirely for this one call path (still goes through budget
tracking and retries) so a matchday recheck is always a real live call.
Correct default behavior for the *existing* finished-only backfill is
untouched -- `skipCache` is opt-in, and nothing about the post-match path
changed.

`seedTodaysLineups` (`backend/seed/sources/api-football.ts`) is the new
selection query: fixtures with `status != 'finished'` kicking off within
a generous ±3 hour window of now, with no `fixture_lineups` rows yet.
Deliberately does NOT touch `lineups_checked_at` -- that column's whole
meaning is "checked once finished, so empty is permanent" (the same
migration above), and a pre-match empty result means something
completely different ("not announced yet, try again soon"). A fixture
whose lineup isn't out yet just gets rechecked next run, at the cost of
one live call each time, until real rows land (then `NOT EXISTS` excludes
it) or the match finishes and the regular backfill takes over. New hourly
`.github/workflows/matchday-lineups.yml` runs it -- hourly is comfortably
affordable now that the account is confirmed on API-Football's paid
7500/day Pro tier rather than the free 100/day `docs/CLAUDE.md` still
described (fixed that stale note while I was in there; a non-matchday run
of this workflow costs one cheap DB query and zero API calls anyway,
since the selection query only matches something actually kicking off
soon).

**Game pages**: `GET /api/fixtures/:id` already computed almost
everything needed (team stats, odds, the model's prediction, top scorer
picks) -- it just never joined `fixture_lineups`/`fixture_player_stats`
together into one per-player list. Added exactly that (`FixtureDetail.lineup`),
one flat array carrying each player's `teamId` rather than pre-split into
home/away, the same shape `topScorers` already uses -- the frontend
splits it per team itself. New `/fixtures/:id` page (`FixturePage.tsx`)
adapts to whatever state the fixture is actually in rather than being two
separate pages: a finished match shows the real score, match stats, and
each player's actual minutes/goals/assists/cards/rating; an upcoming one
shows the model's prediction and the closing market price instead of a
score, and either the real lineup (if captured) or "no lineup yet" if
not -- same page, same query, just different fields populated. Linked in
from the Home page's upcoming/recent fixture lists and the Predictions
page's fixture rows, both of which pointed nowhere clickable before.

Verified against real seeded data end-to-end, not just each piece in
isolation: a finished fixture with a full lineup, per-player stats, team
stats, a prediction, and closing odds rendered correctly (score, stats
table, both teams' starting XI/subs with real goals/assists/cards/rating
per player); an upcoming fixture with a prediction but no lineup yet
correctly showed the pre-match state. `seedTodaysLineups`'s exact
selection query was run standalone against five seeded candidate
fixtures covering every branch (in-window, outside the lookahead,
kicked-off-but-not-finished, already-finished, and already-has-a-lineup)
and selected precisely the two that should have matched, nothing else.
Real click-through from both the Home page and the Predictions page
confirmed the new links actually land on a working game page.

## 2026-08-18 -- Apples to apples: model vs. market in the same unit

Quick follow-up on the game page: "Model vs. market" showed the model's
probabilities as percentages and the market's as raw decimal odds side by
side -- technically both real numbers, but not actually comparable
without doing the conversion in your head first, which defeats the point
of putting them next to each other.

Didn't invent a new conversion -- `model-service/app/data.py`'s
`load_closing_match_winner_probabilities` already does exactly this for
the evaluation baseline (`app.evaluate` compares the model against it),
just never surfaced to a page: decimal odds -> raw implied probability is
`1/price`; the three outcomes' raw implied probabilities don't sum to 1
(that gap is the bookmaker's overround, its built-in margin), so they get
renormalized to sum to 1 -- a "fair," vig-removed probability, the
correct thing to compare a model's own probability against, not the
bookmaker's actual quoted price. Reimplemented client-side in
`FixturePage.tsx` (`marketImpliedProbabilities`) rather than adding it to
`fixtures.service.ts` -- it's a presentation-only transform on data the
page already has (`FixtureDetail.odds`), the same reasoning that's kept
`yourImpliedProbability` in `bets.service.ts` as a plain function over
already-fetched rows rather than its own query.

Also added the "Predicted goalscorers" section that was supposed to be
part of the original game-page build and got missed -- `FixtureDetail.topScorers`
was already being fetched (same field the Predictions page's "Likely
scorers" uses) but the game page just never rendered it. Ranked list,
each player linking to their own page, team abbreviation, probability --
shown regardless of whether the match has finished yet, since "the
model's pre-match pick vs. who actually scored" (visible right below in
the lineup section, once the match is finished) is exactly the kind of
model-vs-reality comparison this app exists to surface.

Verified against the same seeded fixture as the original game-page build,
now with `player_goal_predictions` and `fixture_odds` rows added: model
and market both render as percentages (58.0%/24.0%/18.0% vs. the manually-
computed 53.7%/24.8%/21.5% from 1.80/3.90/4.50 -- checked the arithmetic
by hand, not just eyeballed it), predicted goalscorers list correctly
ranked by probability, and an upcoming fixture with no odds/scorer
predictions seeded degrades cleanly (both sections just don't render, no
crash) rather than showing an empty table or a NaN.

## 2026-08-18 -- Widening the Bets page to Championship, and a real "how did I do" default

Real bug report, with a screenshot: picking Queens Park Rangers as the
Team for an anytime-scorer bet left the Fixture dropdown permanently
stuck on "Select an upcoming fixture…". Two separate causes stacked on
top of each other, both real:

1. **The mismatch bug.** The Bets page's Team dropdown was always
   unscoped (`GET /api/teams`, every Premier League *and* Championship
   club), but its Fixture fetch was hardcoded to `competition=Premier
   League` only. Pick any Championship team and the fixture list the
   dropdown filters against never had anything from that competition in
   it in the first place -- not a loading glitch, a guaranteed empty
   result every time.
2. **A deeper gap underneath it.** Even with fixtures fixed, an
   anytime-scorer leg still needs a real player list, and `getSquad`
   (behind `/api/teams/:id/dashboard`) only ever returned players with
   `current_team_id` set -- FPL-only, so every Championship team's squad
   came back empty. Documented as a known gap back in Phase 2 (`docs/erd.md`),
   but "documented" and "actually fine to ship on" are different things
   once a real feature (this one) depends on it.

Asked before touching anything, since `docs/CLAUDE.md` explicitly flags
"Betting tracker: Premier League only for now" as a scope boundary to
revisit *deliberately*, not accidentally: widen fully (match-winner AND
anytime-scorer), match-winner only (skip the squad-data gap for now), or
revert to Premier-League-only and just stop the Team dropdown from
offering Championship teams. Chose the full widen.

`getSquad`'s fix reuses a pattern this codebase already trusted for
exactly this class of problem, rather than inventing a new one:
`model-service/app/data.py`'s `load_player_squad_appearances` resolves a
player's "effective club" for the goal-scorer model the same way --
prefer `current_team_id` when FPL has it, fall back to whichever team a
player's most recent *finished* `fixture_lineups` appearance was for when
it doesn't. `getSquad` now does the identical `COALESCE(current_team_id,
most_recent_finished_appearance.team_id)` resolution. Premier League
squads are untouched (their `current_team_id` always wins); Championship
squads now resolve for real instead of coming back empty. The Bets
page's fixture fetch was widened the same way `PredictionsPage.tsx`
already merges two competitions -- two parallel calls, not an unfiltered
one (deliberately still excluding FA Cup, never a real betting market
here).

**Separately, the Record section's summary had no useful default at
all** -- season was a blank free-text box ("e.g. 2024/25"), so the first
thing you saw on the page was every bet ever logged, lumped together,
with no competition filter to narrow it at all. Added a `currentSeasonLabel()`
helper (`frontend/src/lib/season.ts`) -- every season in this app is
seeded starting August 1st, so "the current season" is derivable from
today's date with that same cutover, no round-trip to the backend needed
just to ask what season it thinks it is. Pre-fills the season field
(still editable, not locked) so the very first thing you see is "how
have I done this season, overall" -- and added the competition filter
that was simply missing (the backend's `getRoiSummary`/`listBets` already
accepted a `competition` query param; nothing on the frontend ever sent
one).

Verified end-to-end against real seeded data, not just the query changes
in isolation: `getSquad`'s SQL confirmed directly against a Championship
player reachable only through appearance history (no `current_team_id`
at all); real browser flow registered a user, confirmed the season field
pre-filled to the correct current season and the competition dropdown had
the right options, confirmed both the match-winner and anytime-scorer
Fixture dropdowns now include a Championship fixture, confirmed the
anytime-scorer Player dropdown includes the Championship-only player, and
logged a full real anytime-scorer bet on that Championship fixture/player
through the actual UI end to end, confirming it appears correctly in "All
bets" afterward.

## 2026-08-18 -- My Team was still single-tenant under the hood

A real report: "my team is just broken." The page loaded, but the fix
wasn't a rendering bug -- it was that `GET /api/fpl/my-team` had never
actually been made multi-user.

**Root cause.** My Team was built in Phase 4, before real multi-user auth
existed (that came in Phase 6, pulled forward from Phase 9 for the bets
tracker). At the time, one server-wide `FPL_ENTRY_ID` env var was a
reasonable stand-in -- there was only ever one user, so "the app's team"
and "my team" were the same thing. When auth was added, `fpl.routes.ts`
picked up `requireAuth` the same way `bets.routes.ts` did, which correctly
gates "is *someone* logged in" -- but the handler underneath never read
`req.userId`. It kept reading the same env var. Every logged-in user saw
the exact same hardcoded team (or, in a deployment where `FPL_ENTRY_ID`
was never set, a config error). Adding `requireAuth` to a route is not
the same thing as making that route's *data* per-user -- the middleware
answers "who is asking," but nothing forces a handler to actually use
that identity once it's been gated. That's a distinct mistake worth
naming for future-me: it looks like the fix (a 401 for logged-out users!)
while leaving the real per-tenant bug completely intact underneath.

**The fix.** A nullable `users.fpl_entry_id` column (migration
1701000000025) replaces the env var entirely -- `env.fplEntryId` is
deleted from `config/env.ts`. Each user links their own team through a
new `POST /api/fpl/link`, which live-validates the ID against FPL's real
`/entry/{id}/` endpoint *before* saving it (catches a typo immediately
with a clear message, rather than silently saving a bad ID that only
surfaces as confusion later on the My Team page itself). `GET
/api/fpl/my-team` now calls `getMyTeamForUser(req.userId)`, which looks up
*that* user's own `fpl_entry_id` and returns a discriminated union:
`{ linked: false } | ({ linked: true } & MyTeam)`. That's a small but
deliberate type-design choice -- "hasn't linked a team yet" is the
*common* state for a fresh user, not an error, so it's modeled as a
normal variant the frontend branches on, not something caught out of a
thrown exception. It's the same "empty/absent means not confidently known
yet, not broken" convention this app already uses elsewhere (e.g.
`FixtureSummary.topScorers: []` when no scorer prediction exists yet).
The frontend (`MyTeamPage.tsx`) was rewritten from a plain `useFetch` read
to an owned fetch/refresh/mutate cycle (the same shape `BetsPage.tsx`
already established) because linking is a mutation that needs to
invalidate the same GET the page reads: unlinked users see a short
explainer plus a team-ID input; linked users see the existing squad view
unchanged, plus a small "not your team? link a different one" toggle.

**Verification, and an honest limit on how far it could go here.** Playwright
confirmed a fresh registered user sees the link prompt (not a stale or
shared team -- the actual bug, fixed), that blank submission is rejected
client-side, and that submitting a numeric ID reaches the backend and
attempts a real live FPL call. That live call currently can't succeed
*from this sandbox*: the app's own `fetch()` calls do leave the
container (confirmed they're not simply blocked outbound -- unlike a bare
`curl`, which returns nothing at all here), but FPL/Cloudflare returns a
`403` regardless of which entry ID is tried, including a low, deliberately
generic ID chosen specifically to avoid probing any real person's actual
account. This isn't a new gap this fix introduced -- `docs/PHASES.md`'s
original Phase 4 checklist already flagged exactly this: "Untested
against a real entry -- needs a real FPL_ENTRY_ID and a machine with
network access." Rather than leave the per-user read path unverified
because of that, I drove it through SQL directly: manually set one test
user's `fpl_entry_id`, then hit `/api/fpl/my-team` with that user's real
JWT and confirmed two things at once -- that user now gets a graceful
502 from the live-fetch attempt (proving the DB read and the downstream
call both fire on the right row), while a *second*, still-unlinked test
user hitting the same endpoint still correctly gets `{"linked":false}`
(proving isolation -- not just "it reads *a* row," but "it reads *this
user's* row and no one else's," which is the actual bug this fix needed
to close). Backend (`tsc --noEmit`, 31 `vitest` tests) and frontend
(`tsc -b`) all pass clean. The one E2E spec (`bets-flow.spec.ts`) fails in
this sandbox on an unrelated precondition -- the scratch DB has no
seeded fixtures, which its own README lists as a prerequisite it doesn't
set up for you -- and never exercises the FPL code path at all, so it's
a pre-existing environment gap, not a regression from this change.

## 2026-08-18 -- A departed player never actually left the squad page

A real report, and a sharp follow-up question that pinned down the actual
bug: a Championship team's squad page listed a player ("João Pedro" on
Hull City) who didn't look right. First instinct was to check whether this
was another instance of the name-collision problem this project has hit
several times before (see the 2026-08-16/17 entries) -- and it partly was:
his player page showed no current team and a game log of real 2025
appearances, which does match a genuinely different, lower-profile real
person who happens to share a common name with the famous Chelsea player,
not a duplicate-identity bug. That part of the system was working as
designed.

But the real question turned out to be different, and better, than "is
this the right person": *should he be listed as currently on this squad at
all*, given his only appearances were from the prior season? No -- and
that's true regardless of whether he's a name-collision or the genuine
Chelsea one. `getSquad`'s Championship fallback (added 2026-08-18 earlier
the same day, see the erd.md note on `players.current_team_id`) resolves
"who's on this team" from a player's *single most recent finished
`fixture_lineups` appearance*, with no bound on how old that appearance
could be. A player who's since transferred away, been released, or simply
stopped appearing keeps showing up on his old club's squad page forever,
as long as no one else's more recent appearance for that club supersedes
him -- which never happens for someone who's genuinely left.

The fix mirrors a pattern already established elsewhere in this codebase
rather than inventing a new one: `getTablePosition`/`getStandings` already
stand in for "current season" (since `competition_seasons.is_current`
isn't wired up yet) by picking whichever season has the latest
`start_date`. `getSquad`'s fallback CTE now joins through
`competition_seasons`/`seasons` and only counts an appearance if it falls
in that same latest season -- a departed player's stale appearance simply
no longer counts, so he drops off the list instead of showing under a club
he's left. This is the same "no confident answer yet, not a confidently
wrong one" tradeoff already accepted for the *identical* shape of gap in
the goal-scorer model (Harry Wilson, 2026-08-17): a genuinely current
squad member who hasn't played a finished match yet this season won't show
either, until real current-season lineup data exists for them -- an honest
gap, not a wrong answer.

Deliberately scoped narrow: `players.current_team_id` (FPL, Premier League
only) is untouched by this change and still wins outright via `COALESCE`
whenever it's set, so Premier League squads are completely unaffected.
Also deliberately *not* done here, flagged instead as a real, larger piece
of technical debt worth a future revisit: API-Football's own
`/players/squads?team=` endpoint already returns each team's actual
current roster (confirmed for real 2026-08-16, currently used only to
enrich `photo_url` via `upsertPlayerPhotoForTeam` -- see that function's
own comment, which explicitly notes "nothing here touches which team a
player is on"). That's a strictly more authoritative signal than deriving
current-ness from appearance recency, and could set `current_team_id` for
Championship players the exact same way FPL already does for Premier
League ones -- eliminating this entire class of staleness bug outright
instead of bounding it by season. Not attempted today: it would mean
teaching the squads-endpoint entity-matching path (which currently
requires a player to already have `current_team_id = teamId` to be
considered a match candidate -- see `upsertPlayerPhotoForTeam`'s WHERE
clause) to also handle first-time Championship sightings, a real,
separate piece of design work, not a one-line change.

Verified against a targeted scratch-Postgres reproduction built directly
from the report, not just reasoning about the query: seeded two seasons
(2025/26, 2026/27), a team, and two players -- one with only a 2025/26
appearance for the team ("Departed Player"), one with a 2026/27 appearance
("Current Player") -- then hit the real `/api/teams/:id/dashboard`
endpoint. Confirmed the departed player no longer appears in the squad at
all while the current one does, and separately confirmed a third player
with `current_team_id` set directly (the Premier League/FPL path) still
shows regardless of having no lineup appearance at all, proving that path
is untouched. Backend `tsc --noEmit` and all 31 `vitest` tests pass clean.

## 2026-08-18 -- Bounding the symptom vs. fixing the signal: giving Championship a real "current roster"

The season-bound fix above (same day, a few hours earlier) treated the
*symptom*: it stopped a departed player from showing up forever, by aging
out any appearance older than the current season. Offered to go further
and actually fix the *signal* underneath it, and got a "let's do this" --
so this entry is that follow-up.

**Why the season bound wasn't the real fix.** It only ever adds a
time limit to an inference ("this is probably still true because it was
true recently"), which has a real remaining gap: a player transferred
*within* the current season, who's already picked up a fresh appearance
for his old club this season, would still show there even after the
transfer, right up until his new club accumulates an appearance of its
own. Bounding by season narrows the window this can happen in; it can't
close it.

**The actual fix: stop inferring "current" from match history at all for
Championship, the same way Premier League never has to.** `GET
/players/squads?team={id}` -- already being called for player photos, per
the 2026-08-16 entries -- is API-Football's own definitive "who's on this
roster right now" answer, the exact same kind of live authority FPL's
bootstrap-static already provides for Premier League. It was sitting
right there, unused for the one thing that actually mattered. Extended
`setPlayerCurrentTeam` (previously FPL-exclusive by design, per its own
comment) to a second caller, `upsertPlayerForTeamRoster` -- the renamed,
rewritten `upsertPlayerPhotoForTeam` -- so a squads-endpoint sighting now
sets `players.current_team_id` directly, not just `photo_url`.

**The chicken-and-egg problem this created, and how the season-bound work
from earlier the same day solved it for free.** The old matching logic
required `current_team_id = teamId` just to find a *candidate* to match
a name against -- fine for Premier League (FPL always sets it first), but
circular for Championship, where `current_team_id` starts every single
row at NULL. Every squads-endpoint sighting would have fallen through to
inserting a fresh orphan row on first run, duplicating every player
already correctly populated by `/fixtures/lineups`. Fixed by widening the
candidate pool to the *exact same* "current_team_id if set, else this
season's most recent finished appearance" resolution `getSquad` had just
been given a few hours earlier in the same session -- built as a shared
SQL fragment (`ROSTER_CANDIDATES_CTE`) rather than copy-pasted, so the two
call sites can't quietly drift apart. A player's real, appearance-rich row
gets found and matched on the very first squads sync; from then on,
`current_team_id` is set and every future lookup (including `getSquad`
itself) can just use it directly, no inference needed.

**Clearing is the half a pure "add current_team_id" signal can't do on
its own, and it's the half that actually matters most.** Appearance-based
inference can only ever add a match, never say "this player is
definitively no longer here" -- there's no way to derive an absence from
data that simply stops arriving. A live roster endpoint can say that
directly: `clearStaleTeamRoster` runs once per team after processing its
full squads response, and clears `current_team_id` for anyone previously
recorded on that team but missing from this run's actual roster. Guarded
against acting on an empty roster list -- a flaky/malformed API response
returning zero players is far more likely than a real team having none,
and clearing everyone off one bad call would do a lot of damage for a
transient blip.

**Made this run daily, not just on a manual `npm run db:seed:photos`.**
The whole point was reliability matching FPL's; a fix that only applies
when someone remembers to run a script by hand doesn't clear that bar.
Added as a new step in both `.github/workflows/daily-refresh.yml` and the
local `backend/scripts/daily-refresh.sh` (kept in sync, per that script's
own note about being Phase 10's eventual GitHub Actions replacement),
right after the FPL roster step. Deliberately *not* gated to the
transfer-window cutoff the FPL step uses -- Championship transfers aren't
tied to FPL's fantasy calendar at all -- and the cost is flat regardless
of window (~44 calls/day for Premier League + Championship combined,
trivial against the paid API-Football tier's 7500/day budget).

**Scope check: `getSquad`'s season-bound fallback from earlier wasn't
wasted work.** Kept, not removed -- it's now the fallback for a player who
hasn't been through a squads sync yet (a brand-new signing between daily
runs, or before the very first sync completes after this deploys), same
"no confident answer yet, not a confidently wrong one" role it always had,
just demoted from primary signal to safety net now that a better primary
signal exists.

Verified against a targeted scratch-Postgres reproduction, calling the
real exported functions directly (`upsertPlayerForTeamRoster`,
`clearStaleTeamRoster`) rather than mocking anything: (1) a player with an
existing lineups-sourced row and a current-season appearance, no
`current_team_id` yet, correctly matched on first squads sync instead of
duplicating -- confirmed exactly one row exists afterward; (2) the same
player survives a fresh sync that still includes him; (3) a fresh sync
that *doesn't* include him (simulating a transfer or release) correctly
clears `current_team_id` to NULL; (4) re-sighted under a second team's
squads response (same external id, simulating the transfer landing)
correctly resolves to the same row and moves `current_team_id` to the new
team, not a duplicate; (5) an empty roster list is confirmed a no-op,
doesn't wipe a real player. Separately re-verified the abbreviated
("M. Test") and word-subsequence fuzzy ("João Fuzzy" for "João Fuzzy
Longname Silva") matching tiers still resolve correctly against the
widened candidate pool, no duplicates. Then checked the real
`GET /api/teams/:id/dashboard` endpoint end-to-end and confirmed a
simulated transfer correctly moved a player from one team's squad to
another's. Backend `tsc --noEmit` and all 31 `vitest` tests pass clean.

## 2026-08-18 -- A real production crash, and a latent bug the new roster sync finally triggered

First real production run of the new roster-sync logic (`npm run
db:seed:photos`, run for real against Neon by request) crashed partway
through Premier League, right after Liverpool:

```
error: duplicate key value violates unique constraint "players_external_api_football_id_key"
  ... at upsertPlayerGoldenRecord ... at upsertPlayerForTeamRoster ...
```

**Not a bug introduced by today's changes -- a pre-existing gap they were
simply the first thing to actually reach.** `upsertPlayerForTeamRoster`'s
fallback (when a squads-endpoint sighting doesn't match anyone in the
team's roster candidates) called the general-purpose
`upsertPlayerGoldenRecord`, passing the squads endpoint's own numeric
player id straight through as `externalApiFootballId`. But this file's own
comments, since 2026-08-16, explicitly document that the squads endpoint's
id space does NOT always agree with `/fixtures/lineups`'/`/fixtures/players`'
(the Reece James example: 19890 via lineups, 19545 via squads, same real
person) -- `upsertPlayerGoldenRecord` treats any id it's given as the
`'api_football'` source specifically, the one lineups/player-stats own.
When this particular squads-endpoint id happened to already be taken by a
*different* real player (linked under `'api_football'` from an earlier
lineups-sourced sighting), the raw INSERT hit the column's unique
constraint directly and crashed the whole batch -- stopping the run cold
before it ever reached Championship, which is why QPR/Preston/Lincoln
(reported as suddenly showing zero players) were actually just never
touched by this run at all, not actively wiped.

Why this never fired before today, despite the fallback code being
unchanged in shape from the original `upsertPlayerPhotoForTeam`: Premier
League's `current_team_id` was already reliably FPL-set, so nearly every
real sighting matched cleanly in an earlier, team-scoped tier and never
reached this fallback at all. It took a genuinely new-to-the-database name
mismatch to actually exercise this path for real.

**Fix matches what the code already said it should do, just didn't.**
Stopped passing `externalApiFootballId` into the fallback call entirely --
every exit path in `upsertPlayerForTeamRoster` already links this
endpoint's id under its own `'api_football_squads'` source right after
(collision-safe, since that's a separate namespace with its own unique
constraint), so the `'api_football'`-space id was never supposed to leak
into this call in the first place. The fallback now matches purely by
name, exactly like `upsertPlayerGoldenRecord`'s existing no-DOB,
no-external-id path already handles for any other caller that doesn't
have a trustworthy id to offer.

Verified against a scratch-Postgres reproduction built to match the exact
production shape: an existing player row with `external_api_football_id`
set but deliberately no corresponding `player_external_ids` row under
`'api_football'` (the gap that let the id lookup miss it), and a squads
sighting for a completely different name whose numeric id collides with
that existing row's. Confirmed the call now resolves cleanly instead of
throwing, creates a real new row under its own name and its own
`'api_football_squads'` link, leaves `players.external_api_football_id`
null on the new row (the colliding id never reaches that namespace at
all), and leaves the original, unrelated player completely untouched.
Re-ran every check from the earlier same-day roster-sync entry to confirm
nothing else regressed. Backend `tsc --noEmit` and all 31 `vitest` tests
pass clean.

Real, still-open follow-up worth a future pass, not fixed today (out of
scope for a crash fix, and no evidence yet it's actually biting anyone):
`upsertPlayerGoldenRecord`'s exact-name-match tier (`existingByName`) has
its own `COALESCE($4, external_api_football_id)` argument order, which
*overwrites* an already-set id whenever a caller supplies one, rather than
preserving it -- backwards from the "fill a gap, don't clobber a good
value" pattern used everywhere else in this file. Today's fix happens to
route around it (no id is passed from this call site anymore), but any
future caller that reaches this exact-name tier with a real id could still
hit the identical crash shape via an UPDATE instead of an INSERT.

## 2026-08-18 -- First real daily-refresh run, a DATABASE_URL red herring, and a genuine reschedule bug

Getting `daily-refresh.yml` actually running for real (not just
committed) surfaced three separate problems in quick succession, only one
of which was a real code bug -- worth recording all three, since telling
them apart under pressure is its own real skill.

**Problem 1, a real config issue: `DATABASE_URL` truncated when pasted
into the GitHub secret.** The workflow failed with `getaddrinfo ENOTFOUND
ep-nameless-frog-axyy8q2v-pooler.c-4.us-east-2.aws` -- a hostname missing
its `.neon.tech` suffix. Nothing to fix in the repo; a copy-paste gap in
GitHub's secret UI.

**Problem 2, a wrong diagnosis on my part.** Saw an `@` in the connection
string and jumped to "unescaped `@` in the password" without evidence --
plausible-sounding, but wrong. When re-encoding it to `%40` produced a
harder failure (`TypeError: Invalid URL`), the actual shape of the string
made the real issue obvious: the *mandatory* separator `@` between
password and host had been encoded, not an extra one *inside* the
password. There was never a special character needing escaping in the
first place. Lesson worth keeping: a single plausible-looking character
isn't evidence on its own, and the fix that makes an error message get
*more specific/fundamental* (a garbled host vs. total parse failure) is
worth treating as a signal the previous diagnosis, not just the previous
fix, was wrong.

Also flagged for real, not hypothetically: the user pasted the actual
production DB username and password into this conversation while
debugging. Advised rotating the Neon password afterward rather than
treating a credential that's touched a chat transcript as still private,
regardless of how the conversation is normally handled.

**Problem 3, once the connection string was finally right: a genuine,
new production crash.** `seedApiFootballFixtures` hit `duplicate key
value violates unique constraint "fixtures_external_api_football_id_idx"`.
`upsertFixture`'s `ON CONFLICT` only ever targeted the natural key
(`competition_season_id, home_team_id, away_team_id, kickoff_date`) --
the deliberate primary dedup target since Phase 1, so a CSV-seeded row and
a later API-Football pass can agree on the same real match with no shared
id space between sources (see migration 1701000000006's comment). What
that design never accounted for: a **rescheduled fixture** -- same real
match, same `external_api_football_id`, but a `kickoff_date` that's
genuinely different from whatever it was first seeded under (a
postponement, a TV-driven date change). The natural-key `ON CONFLICT`
target no longer matched the existing row, so Postgres attempted a fresh
INSERT -- which collided head-on with the *separate* partial unique index
on `external_api_football_id`
(`fixtures_external_api_football_id_idx`, migration
1701000000006), crashing instead of updating the date.

Fixed by checking `external_api_football_id` FIRST when the caller has
one, before ever touching the natural-key path -- the same "most reliable
identifier first" principle `upsertPlayerGoldenRecord` already uses for
players, just never extended to fixtures. A match by external id now
UPDATEs the existing row directly (including the natural-key columns
themselves, since a reschedule is exactly the case where those need to
change), and only falls through to the natural-key `ON CONFLICT` insert
path, unchanged, when there's no external id yet (a CSV-seeded row not
yet enriched).

Verified against a scratch-Postgres reproduction of the exact shape: seed
a fixture with an external id and one date, "reschedule" it (same
external id, a new date) through the same function, and confirm it
updates the same row (not a crash, not a duplicate) with the new date
correctly applied -- plus confirmed a genuinely new fixture with no
external id yet still inserts normally through the unchanged natural-key
path. Backend `tsc --noEmit` and all 31 `vitest` tests pass clean.

Real, deliberately out-of-scope observation for next time daily-refresh
actually runs end to end: this was the *first* real production run of
`db:seed:current-season` since deployment, so it's very possible more
of this shape of gap (things quietly true "one real production run" would
have caught, that a scratch-Postgres reproduction with synthetic data
never would) surface once fixtures/lineups/rosters are all flowing for
real. Worth treating the next few days' runs as still being watched, not
assumed clean just because this specific crash is fixed.

## 2026-08-18 -- A third crash in the same run, and the real question it raised: is the id scheme itself wrong?

Immediately after the fixtures reschedule fix, the very next daily-refresh
step (`db:seed:backfill-lineups`) hit a third crash, same day:
`duplicate key value violates unique constraint "players_natural_key_key"`
inside `upsertPlayerGoldenRecord`. Asked directly, given the pattern: is
the deterministic-hash id scheme itself the wrong approach?

**Answer: no, the scheme's fine -- three unrelated write paths shared the
identical unhandled failure mode.** `players.natural_key` (migration
1701000000013) is `md5(full_name | date_of_birth)`, a STORED generated
column -- Postgres recomputes and re-enforces its uniqueness on ANY write
that touches either input column, not just on INSERT. The crash was in
`upsertPlayerGoldenRecord`'s early-return branch: a player already
correctly identified by their own stable `external_api_football_id`
(never in doubt) was having its `full_name` upgraded from an abbreviated
form and/or its `date_of_birth` filled in for the first time -- and the
resulting name+DOB combination already belonged to a completely different
row (almost certainly the same real person's FPL-seeded duplicate,
created before this row ever got its own external id linked). The UPDATE
assumed success and let Postgres's own constraint be the check, exactly
like the two crashes before it today (`players_external_api_football_id_key`
from the squads-endpoint fallback, `fixtures_external_api_football_id_idx`
from a reschedule) -- three different columns, three different tables,
one identical root shape: *write first, let the database discover the
collision, crash instead of deciding what it means.*

**Fixed the same way as the fixtures crash: check before writing, not
after.** Before the UPDATE, compute what the row's final `full_name`/
`date_of_birth` would be and query whether a *different* row already owns
that exact natural_key. If yes, skip writing just those two columns (every
other field -- nationality, position, `external_fpl_id`, photo -- still
updates normally) and log the collision instead of crashing. Deliberately
did **not** attempt an automatic merge here, even though this file already
has one (`repair-duplicate-players.ts`'s `mergeOrphan`, built for exactly
this kind of duplicate): that script runs deliberately, once, with its own
review of what it's about to do -- reaching for the same machinery blind,
mid-batch, inside a live seed run that a whole daily pipeline depends on
completing, is a different risk profile than the same merge run on
purpose. A detected collision is real, useful signal (something worth
reconciling with that script) -- it doesn't have to be resolved in the
same moment it's discovered.

Verified against a scratch-Postgres reproduction of the exact shape:
seeded an api_football-linked row with an abbreviated name and no DOB,
plus a separate FPL-seeded row already holding the real full name and
real DOB, then replayed the exact call that crashes in production (a
later sighting under the same external id, now offering the upgraded name
and the colliding DOB). Confirmed it resolves without crashing, leaves
both the name and DOB untouched on the original row (no data silently
overwritten into a bad state), and leaves the other row completely
unaffected. Separately confirmed a genuinely non-colliding name/DOB update
still applies exactly as before. Backend `tsc --noEmit` and all 31
`vitest` tests pass clean.

**The actual, real answer to "should the ids work differently":** the
recurring gap across all three crashes wasn't the ids -- deterministic
hashes and stable external ids are still the right design, doing exactly
what they're for (letting independent sources agree on the same row
without a shared id space). It's that this file's UPDATE statements, in
three separate places, never checked whether a write would collide with
an already-claimed identity before attempting it. Worth treating as one
real, general lesson rather than three unrelated bugs: any UPDATE
touching a uniqueness-constrained (or generated-and-constrained) column
needs a check-first step, the same pattern now applied in all three
places today. Not auditing every remaining `UPDATE` in this file for the
same shape right now -- flagging it here as the thing to actually watch
for, rather than assuming these three were the only ones.

## 2026-08-18 -- The fourth crash, and doing the audit properly instead of a fourth patch

A fourth crash, same day, same shape: `players_external_fpl_id_key`, this
time in `seedFplBootstrap`. Asked directly, and rightly, to stop patching
one symptom at a time and check the whole file. That's what this entry
covers -- a real, systematic pass instead of another isolated fix.

**What the audit actually found.** Grepping every write to
`external_fpl_id`/`external_api_football_id` in `upsertPlayerGoldenRecord`
turned up **five** places doing the same unguarded write, not two. Today's
earlier natural_key fix only patched the branch that had already crashed
(the found-by-external-id early return); the other four were sitting
there un-triggered, waiting for the right data shape:

1. The abbreviated-name match branch -- `external_api_football_id = $2`
   written directly.
2. The team-scoped fuzzy-name match branch -- same, plus a **second,
   previously unflagged** risk: it also writes `full_name` without
   checking whether the resulting `natural_key` would collide, the exact
   same gap the early-return branch had before this morning's fix, just
   never triggered here yet either.
3. The `dateOfBirth`-present `INSERT ... ON CONFLICT (natural_key)` path
   -- today's actual crash. `ON CONFLICT (natural_key)` only resolves a
   *natural_key* collision; it does nothing for the two other UNIQUE
   columns riding along in the same statement, whether hit via a fresh
   INSERT (no natural_key collision, but the id's already claimed
   elsewhere -- exactly what happened) or via the `DO UPDATE`'s own
   `COALESCE(EXCLUDED.x, players.x)`, which overwrites whenever the
   incoming value is non-null and can just as easily collide.
4. The exact-name-match (`existingByName`) branch -- identical
   `COALESCE($n, column)` overwrite-and-maybe-collide shape.
5. The final natural-key-insert fallback (no DOB, no name match) -- same
   shape as #3.

**Fixed with one shared helper instead of five more one-off checks.**
`claimPlayerExternalId(pool, playerId, column, value)` -- looks up whether
a *different* row already has the value; if so, logs and skips (leaves
the row's existing value alone, same "check first, don't guess a merge
mid-batch" choice as the natural_key fix); if not, sets it directly. Every
one of the five sites now leaves `external_fpl_id`/`external_api_football_id`
out of its own INSERT/UPDATE column list entirely and calls this
afterward -- one code path owns "is this id already someone else's,"
instead of five statements each getting to independently forget to ask.
The fuzzy-match branch's `full_name`/`natural_key` risk (#2 above) got
the same inline check the early-return branch already had, adapted to
that branch's shape (no DOB available there, so the check is against
`p1.date_of_birth` as stored rather than a supplied one).

**Why a shared helper this time, not five more inline copies:** the
inline-checks approach from earlier today (three separate, slightly
different SQL blocks for three separate crashes) is exactly what made
this easy to under-scope in the first place -- each fix looked locally
complete without anyone re-deriving "does this same pattern exist
anywhere else." A single, small, well-named function that every call site
routes through is easier to audit for completeness (grep for the two
column names, confirm every hit either goes through the helper or has a
documented reason not to) than five bespoke blocks.

Verified against five scenarios in one scratch-Postgres script, one per
call site, each built to reproduce the exact collision that site is
vulnerable to (including a literal replay of today's real crash --
`external_fpl_id` already claimed, hit via the `dateOfBirth` path):
confirmed every one resolves without crashing, leaves the colliding id
unclaimed on the new/matched row, and leaves whichever row already held
it completely untouched. Re-ran every regression check written earlier
today (the natural_key collision reproduction, the full roster-sync
suite) to confirm nothing broke. Backend `tsc --noEmit` and all 31
`vitest` tests pass clean.

**Explicitly not fixed today, flagged instead:** `getOrCreateTeam` and
`setTeamExternalFplId` (teams' own `external_api_football_id`/
`external_fpl_id`, both also UNIQUE per migration 1701000000004) have a
structurally similar gap -- `getOrCreateTeam`'s `ON CONFLICT DO UPDATE`
happens to COALESCE in the safe direction already (existing value wins,
never overwrites), but a genuinely fresh team INSERT whose incoming id is
already claimed by a different team row would still crash the same way,
and `setTeamExternalFplId` is a bare direct `UPDATE` with no check at
all. Left alone because there's no evidence yet it's an active problem
(far fewer teams than players, ids don't reassign the way abbreviated
player names do) -- but it's the same shape of risk, worth applying
`claimTeamExternalId` (the obvious team-scoped sibling of today's
`claimPlayerExternalId`) to if a real report ever surfaces here too,
rather than rediscovering the same lesson a fifth time.

## 2026-08-19 -- A Fixtures tab: a day browser, not another matchweek dropdown

A new ask: a nav tab showing games (upcoming and recent both), toggled by
date, defaulting to today. `PredictionsPage.tsx` already has date-based
browsing (a 14-day window narrowed by a Monday-Sunday matchweek dropdown),
but that's the wrong shape for this -- it's a fixed forward-looking window
with no way to look backward, and it's tangled up with prediction
probabilities and scorer picks a plain fixtures browser doesn't need. This
is a genuinely different UI: one calendar day at a time, either direction,
with a real date picker for jumping anywhere.

**The "today" default needed a real decision, not an assumption.** Kickoff
dates throughout this schema are already anchored to a Europe/London
calendar day -- `fixtures.kickoff_date` is set explicitly by the seed
scripts for exactly this reason (migration 1701000000006). A day-browser's
"today" should mean the *same* calendar day the schedule itself uses, not
whatever the viewer's browser reports -- otherwise a Saturday 3pm London
kickoff could look like it happened "tomorrow" or "yesterday" depending on
where in the US someone's browsing from, which matters for CLAUDE.md's own
stated audience. New `frontend/src/lib/date.ts`: `londonToday()` via
`Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' })` (en-CA
formats as YYYY-MM-DD directly -- matches both `kickoff_date` and
`&lt;input type="date"&gt;`'s value format with no parsing needed), and
`shiftDate(isoDate, days)` for the prev/next-day buttons -- pure label
arithmetic on the date string via UTC, not a real timestamp shift, since
this only ever needs "what's the next date label," never "what time is
it."

**Backend got a new, deliberately narrow filter instead of reusing
`from`/`to`.** `listFixtures` already supported a `kickoff_at` range, but
computing "which fixtures happened on this one real calendar day" from a
timestamp range means re-deriving timezone-aware day boundaries that
`kickoff_date` already answers directly. Added `date?: string` to
`ListFixturesFilters`, matched with a plain `f.kickoff_date = $date` --
simpler and exactly matches the concept the schema already captures,
rather than working around it.

**Frontend reuses PredictionsPage's actual reusable pattern (parallel
fetch across competitions, merge, sort) without reusing its layout.**
`prediction-row`'s CSS grid is column-tuned for Home/Draw/Away probability
numbers and a scorers line this page has neither of -- forcing the new
page into it would've left three empty grid columns per row. New
`.fixture-list`/`.fixture-list-row`/`.fixture-list-status` classes
instead: a simple 3-column row (fixture · competition · time-or-score),
plus a `.date-nav` bar (Prev/Next buttons, a native date input, and a
"Today" shortcut that only renders once you've actually navigated away
from today).

Verified end-to-end with a real browser against a scratch-Postgres
reproduction seeded across four fixtures spanning yesterday, today (one
scheduled, one finished), and tomorrow: confirmed today's default view
shows exactly the right two fixtures with the right status display each
(a kickoff time for the scheduled one, a score for the finished one), Prev
day correctly surfaces yesterday's recent finished result, Next day
correctly surfaces tomorrow's upcoming fixture, the "Today" shortcut
correctly hides itself only while already on today, clicking a fixture
row navigates to its real detail page, and the manual date input jumps
to an arbitrary date and matches the same fixture reached via the
day-at-a-time buttons. Backend `tsc --noEmit`, frontend `tsc -b`, and all
31 backend `vitest` tests pass clean.

## 2026-08-19 -- A model-improvement roadmap, and the first real piece: blending xG into the fit

A real planning conversation before any code: how to make the match
outcome model smarter using data already being collected (player stats,
team stats, formations, injuries, lineups). Landed on five concrete
pieces, but first had to sort them into what they actually *are*, since
that determines how each one plugs in:

1. **Better baseline ratings** (xG/shots blended into the Dixon-Coles fit)
   -- still classic Dixon-Coles: one attack number, one defense number
   per team, just estimated from richer data than goals alone.
2. **Match-specific adjustments layered on top** (player availability,
   injuries, a corners-based set-piece-matchup proxy) -- the baseline
   rating from #1 stays what it is, but gets scaled up/down for a
   *specific* fixture based on context the baseline can't see. Still a
   Poisson model, still `attack x defense x home_advantage`, just with
   more multiplicative terms conditioned on the match instead of only the
   two teams' season identities.
3. **Penalty takers** -- a completely separate track, living in the
   goal-scorer allocation model, not touching match-outcome predictions
   at all.

Two ideas got tested against reality before being accepted into the plan,
not just taken on faith:

- **Head-to-head record** was flagged as a likely trap, not built:
  two teams typically meet 2x/season, so 3 seasons of history is 5-6
  games -- too small a sample for "Team A has beaten Team B 4 of the last
  5" to mean anything beyond noise, and Dixon-Coles' attack/defense
  ratings already capture the real reason one team beats another (they're
  just stronger). Deferred pending an actual backtest rather than either
  assumed-good or dismissed outright.
- **Goal-source tagging** (to actually name which goals came from set
  pieces vs. open play) was checked against real API-Football data before
  designing around it -- a real `GET /fixtures/events` response showed
  `detail` only ever distinguishes Normal Goal / Penalty / Own Goal, no
  play-pattern field at all. Confirmed the fallback plan (a corners-won/
  conceded proxy from `fixture_team_stats`, already in the DB) is the
  right one, rather than assuming true goal-tagging was available and
  discovering the gap mid-build.

**First piece actually built: xG blended into the Dixon-Coles fit.**
`DixonColesModel.fit()` only ever read `home_score`/`away_score` --
actual goals, a genuinely noisy signal (a team can dominate on chances
and lose 0-1 on one bad bounce). `fixture_team_stats.xg` has been sitting
unused since migration 1701000000014. New `app.data.blend_xg_into_scores(matches,
xg_weight)`: replaces each side's score with a blend of the real score and
that side's own xG wherever xG exists, falling back to the untouched real
score when it doesn't (xG coverage isn't complete -- older fixtures and
lower-tier competitions often lack it). `dixon_coles.py`'s actual fitting
math is completely untouched -- the blend happens one layer up, in
whatever gets passed to `.fit()`.

Wired into `app.evaluate` (not `app.train` yet) as a new `XG_BLEND_WEIGHT`
constant, exactly the same "experimentation sandbox, promote only once
validated" pattern `HALF_LIFE_DAYS` already established there -- default
0.0 (today's behavior, byte-for-byte unchanged) rather than guessing a
plausible nonzero starting value. `app.evaluate`'s backtest only ever
blends the *training* portion before fitting; the held-out test matches
used to score the backtest stay real, unblended scores throughout --
scoring a model against a distorted version of what actually happened
would defeat the entire point of a backtest.

**A real bug the new unit tests caught immediately, not a hypothetical
one:** `home_score`/`away_score` come back `int64` from Postgres, and a
blended value is inherently fractional -- assigning a float into an
int64 pandas column raises on a recent pandas version instead of
silently upcasting like older versions did. Fixed by explicitly casting
both the score and xG columns to float before blending (the all-null-xG
case, real whenever a whole competition/season predates xG coverage,
needed the same explicit cast -- pandas infers an all-null column as
`object` dtype, which hit the identical strict-upcast check even on a
fully empty assignment).

Verified in two layers: 7 new pure-logic unit tests in `tests/test_data.py`
(zero/full/partial blend weight, missing-xG fallback on one or both
sides, no mutation of the input frame, independent per-row blending), all
34 tests across the suite passing; then a separate synthetic
integration check exercising the real chain end to end -- built a team
that creates good chances but doesn't convert them (high xG, low actual
goals) across 10 matches, confirmed its Dixon-Coles attack rating comes
out *higher* under xG blending than under goals-only fitting, and that
the resulting `predict()` output reflects that higher rating -- proving
the mechanism does what it's supposed to, not just that the blend
function returns the right numbers in isolation.

**Deliberately not done yet, and can't be done from here:** finding out
whether xG blending actually improves the backtest against real 3-season
data. That needs `python -m app.evaluate` run against production data
with a few different `XG_BLEND_WEIGHT` values (0.25/0.5/0.75/1.0,
compared against the 0.0 baseline) -- this sandbox has no database
connection to run that for real. Next step is the user running that
comparison and reporting back the Brier/log-loss numbers, the same way
`HALF_LIFE_DAYS`'s value was chosen -- only once a value is shown to
actually help does it get promoted from `app.evaluate`'s sandbox constant
to `app.train`'s deployed one.

## 2026-08-19 -- xG doesn't exist here: pivoting to shots on target, and why the numbers looked identical

Ran the xG-blend backtest for real, at `XG_BLEND_WEIGHT=0.5` against
production data. The output was byte-for-byte identical to the
`0.0` baseline, down to the fourth decimal, across every metric for
every competition. That's not "xG made no difference" -- a real,
non-degenerate blend essentially never produces *exactly* the same
numbers as no blend at all. It's the signature of a no-op: the blend
function was correctly falling back to the untouched real score on every
single row, because `fixture_team_stats.xg` had no data to blend with at
all.

Confirmed why by reading the seed pipeline, not by guessing: migration
1701000000014 (Phase 2) added the `xg` column with its own comment
flagging it explicitly -- *"API-Football's fixture-statistics endpoint
**may** [have it] (UNVERIFIED)... nullable and unpopulated until that's
confirmed."* That confirmation never happened. The only code that writes
to `fixture_team_stats` at all is `football-data-co-uk.ts`'s CSV importer
(`upsertFixtureTeamStatsBatch`), and its own INSERT statement doesn't
even have an `xg` column in the list -- CSVs never carried it, and
nothing else was ever built to fetch it from anywhere. Every row's `xg`
has been `null` since the column existed; the mechanism I built was
correct, there was simply nothing behind it.

Rather than guess whether the underlying endpoint even carries xG at a
different tier or in a different field, checked for real: a live
`GET /fixtures/statistics?fixture=...` response pasted back showed the
full `statistics` type list API-Football actually returns -- Shots on
Goal/off Goal/Total/Blocked/insidebox/outsidebox, Fouls, Corner Kicks,
Offsides, Possession, cards, passes. No expected-goals field anywhere.
That settles what migration 1701000000014 left open over a year of
in-universe time ago: **xG is not available from this data source at
all**, not "unconfirmed."

**Pivoted to shots on target instead of abandoning the idea.** Same
underlying reasoning still holds -- a team's shot volume/quality is a
lower-variance read on its true attacking performance than the actual
goal count, a team can rack up chances and still lose 0-1 to one save
going the wrong way -- and unlike xG, shots on target is data that
genuinely exists: `football-data.co.uk`'s `HST`/`AST` CSV columns,
already parsed and written to `fixture_team_stats.shots_on_target` for
every real Premier League and Championship match.

**The real modeling wrinkle xG never would have had:** shots on target
isn't on the same scale as goals -- a team typically registers several
times as many shots on target as actual goals in a match, so blending it
in raw the same way xG would have been blended would badly inflate the
fitted attack/defense parameters (confirmed this mattered by reasoning
through the magnitudes before writing any code, not after debugging a
bad fit). Fixed by rescaling: `blend_shots_on_target_into_scores`
computes the training set's own pooled goals-per-shot-on-target ratio
(from whichever rows actually have both a real score and a real
shots-on-target figure, home and away sides pooled together) and
multiplies shots on target by that ratio before blending -- self-
calibrating to whatever `matches` is passed in, rather than hardcoding an
assumed conversion rate (real football analytics conventionally cites
~30%, but assuming that holds for this exact dataset/competition without
checking would be the same mistake as assuming xG existed without
checking).

Renamed the whole mechanism to match what it actually does now --
`blend_xg_into_scores` → `blend_shots_on_target_into_scores`,
`XG_BLEND_WEIGHT` → `SHOTS_ON_TARGET_BLEND_WEIGHT` -- rather than leaving
xG-flavored names on a shots-on-target mechanism, the same "a name is a
promise, keep it true" principle behind every rename earlier this
session (`upsertPlayerForTeamRoster`, etc.).

Verified the same two ways as the original xG version: rewrote
`tests/test_data.py`'s 6 unit tests for the new function (added explicit
coverage for the conversion-rate math itself -- hand-computed the pooled
ratio across two matches and asserted the blended values matched exactly
-- plus the zero-rows-with-data no-op guard, which the pure xG version
never needed since it had no derived scale factor that could divide by
zero), all 34 tests across the suite passing; then reran the same
synthetic integration check (a team with high shots-on-target, low actual
goals across 10 matches) confirming its fitted attack rating comes out
higher under shots-on-target blending, and that `predict()` reflects it.

Same next step as before, just pointed at a signal that actually has
real data behind it now: run `python -m app.evaluate` against production
at a few candidate `SHOTS_ON_TARGET_BLEND_WEIGHT` values and see if any
of them genuinely improve the backtest over the 0.0 baseline already
captured.

## 2026-08-19 -- The real backtest results disagreed by competition, so the config had to stop being shared

Ran the full sweep against production: 0.0, 0.25, 0.5, 0.75, 1.0. Full
table (Brier / log-loss, lower is better):

| Weight | Premier League | Championship | FA Cup |
|---|---|---|---|
| 0.0 | 0.6399 / 1.0617 | 0.6520 / 1.0787 | 0.6494 / 1.0769 |
| 0.25 | 0.6318 / 1.0487 | **0.6495 / 1.0739** | 0.6634 / 1.1007 |
| 0.5 | 0.6273 / 1.0421 | 0.6504 / 1.0745 | 0.6538 / 1.0805 |
| 0.75 | **0.6248 / 1.0383** | 0.6543 / 1.0799 | 0.6496 / 1.0721 |
| 1.0 | 0.6267 / 1.0422 | 0.6605 / 1.0893 | **0.6464 / 1.0648** |

Three competitions, three different real optima -- not close enough to
call a coincidence: Premier League improves steadily and consistently up
to 0.75 (a genuine ~2.4% Brier gain, not noise). Championship barely
moves at all, and its own best (0.25) is marginal -- past that it gets
measurably *worse* the more weight goes in. FA Cup is the strangest,
dipping badly at 0.25 before recovering to its own best at full weight --
the least trustworthy of the three, since the joint fit's 811 teams
include a lot of sparse-data FA Cup entrants that make its own backtest
naturally noisier.

**The real question this forced: is one shared value (`HALF_LIFE_DAYS`'s
pattern) still the right call, now that the evidence says the
competitions genuinely disagree?** Talked through it directly rather than
defaulting either way. A single compromise value (something like 0.5)
would have meant deliberately leaving Premier League's real, consistent
gain on the table just to avoid a small, likely-marginal Championship
regression -- and there's good reason to expect *more* of this as more
model pieces get added (the whole reason this got raised at all): three
competitions with different squad depths, different data coverage
(Championship's shots data is the same CSV source as Premier League's,
but the leagues' actual playing styles/finishing rates genuinely differ),
and different sample sizes are exactly the conditions where "what helps"
won't line up by competition. Decided: make it per-competition now, while
it's still one setting, rather than wait until there are three or four
settings all secretly wanting to vary by competition and no established
pattern for how to do that cleanly.

**`SHOTS_ON_TARGET_BLEND_WEIGHT` is now `dict[str, float]`, keyed by
competition name, in both `app.evaluate` and (newly, since this is the
first real validated result) `app.train`.** `HALF_LIFE_DAYS` stays a
single shared scalar, deliberately -- its own Phase 5 backtest found 180
won cleanly in *both* leagues, monotonically, with no comparable
disagreement, so there's no evidence yet that it needs the same
treatment. Not generalizing to a shared "per-competition config" wrapper
either -- a plain dict literal, the same idiom `app.train`'s own
`models_by_competition` dict already uses elsewhere in this file, is the
whole pattern. The next setting that turns out to want this same
treatment can just reach for the same shape, when there's real evidence
it needs it, rather than this becoming a speculative framework built
before a second real case exists.

One naming/scoping detail worth keeping straight: `"FA Cup"` in this dict
is the weight applied to the *whole joint training set* (Premier League +
Championship + FA Cup matches together) that the joint fit uses for FA
Cup predictions -- not a per-row-competition split *within* that joint
set. The joint fit already treats itself as one homogeneous training pool
everywhere else (`HALF_LIFE_DAYS` applies uniformly across it too), so
this stays consistent with that rather than inventing a second kind of
split just for this one setting.

Promoted directly to `app.train`'s deployed constant in the same pass,
not held back for a second round -- these are the first genuinely
validated values found (the earlier flat 0.0 was explicitly "not yet
validated," this is the actual backtested result), the same "test, then
promote" moment `HALF_LIFE_DAYS=180` went through originally. Worth
flagging honestly, though: Championship's gain is small enough to be
close to noise, and FA Cup's pattern is the least trustworthy of the
three given how sparse its joint fit's data really is -- these are the
best-tested values so far, not a closed question. Re-testing here as more
data accumulates (or after any of the other model-improvement tracks
land) is a reasonable thing to revisit, not a one-and-done tune.

All 34 tests still pass (the blend function itself didn't change, only
how its weight gets threaded through `main()` in both files); confirmed
both files still import cleanly.

## 2026-08-19 -- Team-level player-availability adjustment (track 2, part 1 of the model-improvement plan)

Match-outcome predictions were treating a team's strength as fixed
regardless of who's actually playing on a given matchday -- Man City's
predicted goals were the same whether or not Haaland was confirmed out.
This closes that gap for the team level (per-player scorer-odds
suppression for a confirmed bench player is a related but separate piece,
scoped as the deliberate next step, not built here -- see below).

**The timing constraint that shaped the whole design.** `app.train` is a
once-daily batch job, but a real confirmed starting lineup is typically
only known about an hour before kickoff (see
`backend/seed/sources/api-football.ts`'s `seedTodaysLineups`). A naive
"retrain daily, read confirmed lineups" design would almost always be
looking at no confirmed data yet. The fix wasn't a new schedule --
`matchday-lineups.yml` already runs hourly, checking for exactly this
data, and its own comment (written before this track even started)
already flagged the gap: "Making today's confirmed lineup actually
influence a fixture's own prediction is real future work... not something
to fake with a no-op retrain here." `app.train` makes zero external API
calls (pure DB read/compute/write), so rerunning it hourly from that same
workflow costs nothing against the API-Football budget -- most hourly
runs still find no new confirmed lineups and are a cheap no-op refit,
identical to today's daily-refresh.yml run.

**Rating-based compensation, not a flat "missing = pure loss."** The
naive version of this (a team missing any reliable player takes an
uncompensated hit to expected goals) undersells what actually happens: a
team missing its first-choice striker for a rotation option isn't losing
that striker's *entire* scoring share, since the replacement still scores
some. `fixture_player_stats.rating` -- confirmed real, populated data
(unlike `fixture_team_stats.xg`, see the earlier xG entry) -- gives a
genuine per-appearance quality signal to compare against.
`compute_team_availability` (new, `app/goal_scorer.py`) sums the
`goal_share` of every reliable player NOT in the confirmed matchday squad
(`missing_share`), then scales that loss down by a `compensation_factor`
-- the ratio of the confirmed squad's own average historical rating to
the team's normal reliable-pool average, clipped to [0, 1]. A team
fielding its usual-quality players loses almost nothing even with
personnel changes; a team missing its highest-rated players for genuinely
weaker fill-ins loses close to the full share.  Falls back to
`compensation_factor = 0.0` (the conservative, no-compensation case)
whenever there isn't enough rating data on either side to compute a
meaningful ratio -- consistent with every other missing-data case in this
app defaulting to "don't guess."

Deliberately keyed on `goal_share`, not `minutes_share` or a general
"presence" signal -- this is specifically a *scoring threat* adjustment
to the team's expected goals, so a squad player who's never scored
contributes ~0 to `missing_share` even if they're a nailed-on 90-minute
starter (confirmed with a synthetic check: swapping out a 0-goal-share
fringe player left availability at exactly 1.0, while swapping out the
team's top scorer for the same fringe player dropped it measurably). That
asymmetry is intentional, not a bug -- a team's defensive solidity when a
non-scoring player is missing isn't this adjustment's job; it's a fair
scope boundary for "team-level availability," not a gap to fix here.

**Mechanics, concretely (`app/goal_scorer.py`, `app/dixon_coles.py`):**
- `compute_player_shares` now also returns `avg_rating` per (team,
  player) -- a weighted mean of `rating` using the same time-decay weight
  as `minutes_share`/`goal_share`, but with a *separate* rating-specific
  weight denominator so appearances with no recorded rating are correctly
  excluded from the average rather than silently treated as a rating of
  0 (which would make an unrated player look terrible instead of just
  unknown). Hit the same dtype gotcha `blend_shots_on_target_into_scores`
  hit earlier this session: an all-null `rating` column infers as
  `object` dtype, not `float64`, and object-dtype division by zero raises
  a real `ZeroDivisionError` instead of producing `NaN` -- fixed with the
  same `.astype(float)` fix, caught by a unit test before it ever ran
  against real data.
- `compute_team_availability(team_id, confirmed_player_ids, player_shares)`
  is the new function implementing the mechanics above, returning a
  `[0, 1]` scale factor (1.0 = no confirmed squad yet, or a full-strength
  one -- both mean "no adjustment," not "penalize").
- `DixonColesModel.predict()` got refactored (not behaviorally changed) to
  split its Poisson-grid/tau/triangle-sum math into a shared private
  helper, `_predict_from_expected_goals`, so a new
  `predict_with_availability(home_team, away_team, home_availability=1.0,
  away_availability=1.0)` method can scale `lambda_home`/`lambda_away`
  before calling the same shared math, instead of duplicating it.
  `home_availability=1.0, away_availability=1.0` (the defaults) is an
  exact no-op, verified directly: `predict_with_availability(...)` with no
  availability args returns an object equal to `predict(...)`.
- `app/train.py`'s `predict_for_competition` bulk-loads
  `load_confirmed_lineups` once per competition (not per fixture -- most
  upcoming fixtures have no confirmed squad yet, so this is usually a
  near-empty frame and one query beats N), computes each side's
  availability, and only routes through `predict_with_availability`
  when at least one side's availability differs from 1.0 -- the common
  case (no confirmed lineup yet) still calls plain `predict()` directly.

**Verification.** Extended `tests/test_goal_scorer.py` (new
`avg_rating` coverage plus a new `TestComputeTeamAvailability` class: no
adjustment with no confirmed squad, no adjustment with a full-strength
confirmed squad, no adjustment for a team with no reliable-share players
on record, a real drop when the missing player is high-share, missing a
low-share player mattering less than missing a high-share one, and the
factor never going negative) and `tests/test_dixon_coles.py` (new
`TestPredictWithAvailability` class: default availability of 1.0 matches
plain `predict()` exactly, lowering either side's availability scales
only that side's expected goals and lowers that side's win probability,
probabilities still sum to 1 when both sides are adjusted, and the
missing-team `ValueError` still raises). Full suite: 48 passed.

Also ran a synthetic end-to-end check (no production DB in this session's
environment -- Postgres wasn't reachable here, unlike the local dev
machine track 1's verification ran against) mirroring the same "does the
mechanism behave sensibly" pattern: fit a tiny model where City clearly
beats Rivals, build a 4-player City squad with a clear star (id 9, 2/3 of
the team's goal_share, rating 8.7) plus two regulars and a weak fringe
player (rating 5.8, never scored). A full-strength confirmed squad left
predictions byte-identical to the baseline. Confirming the star OUT and
the weak fringe player IN dropped predicted home goals from 2.463 to
2.345 and home win probability from 0.747 to 0.727 (availability=0.952).
Confirming the *fringe* player missing instead (star and both regulars
still in) left availability at exactly 1.0, demonstrating the intentional
goal_share-only scope described above.

**Deliberately deferred, the agreed next piece:** `minutes_share` today
is one blended season-long average across every squad appearance
(including unused-sub appearances) -- it doesn't distinguish "confirmed
starting today" from "confirmed benched today" for goal-scorer
allocation, which matters for a different reason than team strength: a
team's *biggest name* shouldn't top that fixture's scorer odds if he's
confirmed on the bench for only ~20 minutes. The plan (agreed, not yet
built) is splitting historical minutes into
`avg_minutes_when_starting`/`avg_minutes_when_benched` (derived from real
`fixture_lineups.is_starting` + `fixture_player_stats.minutes_played`
data, not a guessed constant) and substituting the right one in
per-fixture once a confirmed role is known. Scoped as a separate,
closely-related follow-up to this team-level piece, not part of it --
team strength (this entry) and individual scorer-odds suppression are
two different signals that happen to share the same confirmed-lineup
data source.

## 2026-08-20 -- Confirmed starting-vs-bench minutes for per-player scorer odds (track 2, part 2)

The team-level availability adjustment (previous entry) fixed one half of
the "we're predicting player odds without knowing who's actually
playing" problem -- Man City's *team* expected goals now respond to a
confirmed Haaland absence. This closes the other half, at the individual
player level: a squad's biggest name shouldn't top that fixture's scorer
odds on the strength of a season-long average if he's confirmed on the
bench for a 15-minute cameo today.

**The gap.** `minutes_share` was always one blended number across every
squad appearance, starts and bench cameos both averaged together. That's
the right number when there's no confirmed lineup yet (most of the week --
the season-long blend is the best available estimate), but once a
specific fixture's squad is confirmed, it's actively misleading: a
usually-nailed-on starter who's confirmed on the bench today still carries
his "usually plays 90" blended average into that fixture's `lambda_player`
calculation.

**Fix: split the average by the role the player actually had, not just
average over all of them.** `compute_player_shares` (`app/goal_scorer.py`)
now also computes `avg_minutes_when_starting` and `avg_minutes_when_benched`
-- the exact same weighted-average machinery `minutes_share` already used,
just conditioned on `fixture_lineups.is_starting` first. Both are `NaN`
(not 0) wherever a player has zero appearances in that specific role --
e.g., a player who has genuinely never started -- so a caller has to
explicitly choose a fallback rather than this function silently guessing.

`allocate_team_goals` gained two new parameters, `confirmed_squad` and
`confirmed_starting` (both empty sets by default, mirroring
`compute_team_availability`'s "empty means no confirmed data yet"
convention from the previous entry -- one consistent idiom across both
functions rather than two different ways of saying the same thing).
Empty (the default) reproduces the exact old behavior: every reliable
player gets predicted with his blended `minutes_share`, unchanged. Once a
squad is confirmed:
- A reliable player NOT in `confirmed_squad` is skipped entirely --
  correct, since a player who isn't even named for the matchday squad has
  zero real chance to score, and showing up in scorer odds just because
  his season-long share still clears `MIN_PLAYER_MATCHES` would be wrong.
- A player IN the squad gets `avg_minutes_when_starting` if he's in
  `confirmed_starting`, otherwise `avg_minutes_when_benched` -- substituted
  in place of `minutes_share` for that one fixture's `lambda_player`
  calculation only. `goal_share` is untouched either way (it's a
  per-90 rate, not a playing-time signal -- see this file's existing
  goal_share/minutes_share note).
- Falls back to the normal blended `minutes_share` when the role-specific
  average is `NaN` (a player with no recorded appearances in that role
  yet) -- there's nothing role-specific to use, so falling back is more
  honest than guessing 0 and killing his odds outright.

`load_player_squad_appearances` and `load_confirmed_lineups`
(`app/data.py`) both now also carry `is_starting` (from
`fixture_lineups.is_starting`) to feed this. `app/train.py`'s
`predict_for_competition` reuses the same `home_confirmed`/`away_confirmed`
sets and per-fixture `fixture_lineup` slice the team-level availability
adjustment already loads -- no new query, just a `is_starting` filter on
data already in hand -- to build each side's `confirmed_squad` and
`confirmed_starting` sets and pass them into `allocate_team_goals`.

**Verification.** New tests in `test_goal_scorer.py`: the role split
itself (`avg_minutes_when_starting`/`avg_minutes_when_benched` diverge
correctly and bracket the blended `minutes_share`; `NaN` for a role never
recorded), and `allocate_team_goals`'s new behavior (no confirmed squad =
unchanged; a confirmed-out player is omitted entirely; a confirmed starter
uses the higher starting average; a confirmed bench player uses the lower
bench average and drops relative to no-confirmation; the NaN-role fallback
doesn't produce a NaN/broken prediction). Full suite: 55 passed.

Also ran a synthetic end-to-end check (same no-DB-access constraint as the
previous entry): a striker who starts 8/10 recorded matches at a full 90
but has been benched (15 min) his last 2, versus a steady 10/10 starter
teammate. With no confirmed lineup, the striker's blended `expected_goals`
(1.071) clearly leads the teammate's. Confirming the striker on the bench
today drops him to 0.215 -- now clearly behind the confirmed starter's
0.672, exactly the "don't let the big name top scorer odds on a confirmed
cameo" behavior this was built for. Confirming him out of the squad
entirely removes him from the predictions altogether.

Both pieces of track 2 (team-level availability, this per-player
follow-up) are now shipped. Track 3 (penalty takers -- a separate,
goal-scorer-only concern, not touching match-outcome predictions) is next.

## 2026-08-20 -- Shrinkage for sparse-data teams (West Ham's 97.1% Championship prediction)

Real production bug, reported directly ("the model LOVES West Ham,
do you know why?") with a screenshot: West Ham, relegated into the
Championship, predicted 97.1% to beat Charlton with a 6.62-1.13
scoreline -- in just their 2nd Championship match of the season.

**Root cause, confirmed by reading the code, not guessing.**
`load_finished_matches` pulls a team's history by competition name across
all 3 seasons of data -- West Ham has zero Championship rows from the
prior two seasons (they were in the Premier League then), so they entered
this fit with essentially one real data point. `MIN_MATCHES_TO_FIT = 50`
(`app.train`) only checks that the *competition as a whole* has enough
matches to bother fitting -- it says nothing about any individual team's
own sample size within that fit. And `DixonColesModel.fit()` was pure
maximum likelihood with **no regularization or prior anywhere** -- nothing
pulled a team's attack/defense estimate back toward league average when
its own evidence was thin. With one (likely lopsided) result and nothing
constraining it, the optimizer was free to push West Ham's attack rating
as high as it liked to explain that single match.

This isn't West-Ham-specific -- it's the same underlying gap the FA Cup
joint fit already got flagged for informally ("noisiest of the three,
811 teams, many with very sparse data," see the 2026-08-19 entry) --
except there it's diluted across hundreds of cup minnows nobody's
watching closely; here it surfaced starkly on one high-profile team's own
league predictions. Any newly-promoted or newly-relegated side hits this
early in a season.

**Fix: L2 shrinkage on attack/defense, toward league average.**
`DixonColesModel.fit()` gained a `shrinkage: float = 0.0` parameter (0.0 is
a complete no-op -- every existing caller's behavior is unchanged unless
it opts in). When positive, it adds `shrinkage * (sum(log_attack**2) +
sum(log_defense**2))` to the negative log-likelihood being minimized --
a penalty pulling every team's log-space attack/defense back toward 0
(1.0 in real space, exactly league-average).

The reason a single fixed-size penalty term automatically shrinks a
sparse-data team more than an established one, with zero per-team logic
needed: a team backed by a full recency-weighted season of results has a
likelihood gradient that dominates this fixed penalty at the optimum, so
its fitted value barely moves. A team with one or two matches has a
comparatively weak, underdetermined likelihood contribution, so the
penalty proportionally dominates and holds its rating close to average
until real results justify moving it -- standard ridge-regression/
MAP-with-a-Gaussian-prior behavior, just applied to this fit's own
log-space parameters. This is a genuinely new concept for this codebase
(first real prior/regularization anywhere in the fit), worth naming
plainly rather than just calling it "a tunable."

One real numerical wrinkle surfaced while writing the tests, worth
recording since it'll bite again: fitting a team off a single *shutout*
match (0 goals conceded) is its own separate Poisson MLE degenerate case
-- the away-goals likelihood term has no interior maximum at k=0, so
without shrinkage the optimizer can drive that side's defense parameter
toward an arbitrarily extreme value bounded only by convergence
tolerance, not a true minimum (a form of the same quasi-separation
pathology logistic regression hits with perfectly-separable data). Chose
a 5-2 scoreline instead of a shutout for the test's "lopsided newcomer
win" specifically to isolate the sparse-data shrinkage behavior from this
different, adjacent pathology -- both are real, but conflating them in
one test would have made a failure ambiguous about which one broke.

**Not yet the deployed default.** `app.evaluate.SHRINKAGE = 0.05` is an
untested starting candidate, wired into all three of that file's fits --
the same "sandbox in evaluate.py, backtest against real data, only then
promote to app.train" process `HALF_LIFE_DAYS` and
`SHOTS_ON_TARGET_BLEND_WEIGHT` went through. `app.train` is deliberately
untouched in this change -- production behavior is byte-identical to
before, so this is safe to ship ahead of a real backtest, same as the
very first `XG_BLEND_WEIGHT` sandbox-only PR. Also worth checking once
real numbers come back: whether this wants to vary by competition the way
`SHOTS_ON_TARGET_BLEND_WEIGHT` ended up needing to -- the FA Cup joint
fit's sparse entrants are the other obvious place this same mechanism
should help, and might want a different strength than the two clean
single-competition fits.

**Verification.** New `TestFitShrinkage` class in `test_dixon_coles.py`:
`shrinkage=0.0` matches omitting the argument entirely (regression
safety); a synthetic "established league + one newcomer with a single
lopsided win" fit shows shrinkage measurably pulls the newcomer's attack
toward 1.0 while barely moving an established team's (15 real matches);
probabilities still form a valid distribution with shrinkage on. Full
suite: 59 passed.

Also ran a synthetic reproduction of the actual production shape (a
6-team established league plus a "Newcomer" with one win) confirming the
right qualitative behavior end to end: at `shrinkage=0.1`, Newcomer's
fitted attack moved from 2.733 toward 2.584 while an established team
with real history barely moved (0.634 -> 0.655), and Newcomer's very
next predicted match dropped from 3.24 to 3.06 expected goals. A follow-up
sweep (0.0 through 1.0, not part of the committed tests, just sanity-
checking the mechanism scales as expected) showed a stronger candidate
value pulls harder -- at 1.0, that same newcomer's attack came back to
1.9 and predicted goals to 3.39 from an unshrunk 5.2 -- confirming the
mechanism is strong enough to meaningfully fix this class of bug once a
real value is validated, not just nudge it slightly. The real strength
needed against production (hundreds of Championship matches for
established teams vs. West Ham's actual 1-2) is a real backtest to run,
not something to guess from a small synthetic league.

## 2026-08-20 -- Real incident: hourly retrain exhausted GitHub Actions minutes, broke the lineup check

Reported live: "the lineup is failing" -- `matchday-lineups.yml` runs
had gone from finishing in seconds to failing outright, no runner ever
assigned. Root-caused via the GitHub Actions run history (couldn't fetch
raw job logs directly from this session -- the log-download host is
blocked by this environment's egress proxy -- so this leans on run
timestamps/durations/conclusions instead, which turned out to be enough):

- Before 2026-08-19's player-availability PR, `matchday-lineups.yml` was
  just `npm run db:seed:matchday-lineups` -- a few seconds, hourly.
- That PR added a `python -m app.train` step after it, reasoning "app.train
  makes zero external API calls, so an hourly rerun costs nothing against
  the API-Football budget." True, and completely beside the point --
  `app.train` refits three Dixon-Coles models AND rewrites a
  `player_goal_predictions` row per reliable player per upcoming fixture
  across all three competitions, one `upsert_player_goal_prediction` call
  (one DB round trip) per row, unbatched. That's a real cost, previously
  paid once a day by `daily-refresh.yml`. Multiplying it by 24 (this job's
  actual cadence) was never "free" just because no external API got
  called.
- Runs immediately after that PR: `matchday-lineups.yml`'s own duration
  went from a few seconds to 46 minutes (run 58), then 1h31m (run 57).
  `daily-refresh.yml`'s total runtime was independently trending up too
  (55 -> 98 -> 121 minutes across three consecutive days) -- a real,
  separate, worth-revisiting-later slowness in the whole daily pipeline as
  three seasons of data accumulate, not something this incident fixes.
- Runs 59/60/61 (starting a few hours after run 58) failed in 3-4 seconds
  each, with `runner_id: 0` and `runner_name: ""` in the job data -- no
  runner was ever assigned. That specific signature, arriving right after
  a stretch of unusually long runs on an hourly cron, points at the
  account's GitHub Actions minutes (or a configured spending limit)
  running out from the cumulative overage, not a bug in the job's own
  steps -- `daily-refresh.yml`'s prior run (2 hours, same day) had still
  completed successfully, so this wasn't a blanket, from-the-start outage.

**Fix:** reverted `matchday-lineups.yml` to exactly its pre-2026-08-19
form -- just the lineup check, no retrain. The "make a confirmed lineup
reach that fixture's prediction within the hour" goal from that PR is
still real and still wanted, it just needs a genuinely cheap
implementation before it belongs on an hourly cron: batch the
`player_goal_predictions` upserts (a single multi-row statement instead
of one round trip per player per fixture), and/or only recompute
predictions for fixtures whose confirmed lineup actually changed since
the last hourly check, instead of a full refit + full rewrite regardless
of whether anything changed. Until then, the once-a-day
`daily-refresh.yml` retrain is the only place a confirmed lineup's effect
on predictions lands -- a real regression in freshness versus what
2026-08-19's PR intended, but the right tradeoff until the retrain itself
is actually cheap enough to run hourly.

**What still needs a human:** whether the account actually hit a GitHub
Actions spending limit (Settings > Billing > Actions usage) rather than
just the free tier's included minutes, and if so, either raising it or
waiting for the next billing cycle -- not something checkable or
fixable from here.

Worth remembering as a general lesson, not just for this one workflow:
"makes no external API calls" and "cheap enough to run 24x more often
than it currently does" are two completely different claims, and this PR
conflated them without ever actually measuring how long the new step
took before shipping it on an hourly schedule.

## 2026-08-20 -- Track 3: penalty-taker attribution in the goal-scorer allocation model

Last of the three original model-improvement tracks (better baseline
ratings, match-specific availability adjustments, penalty takers).
Scoped from the start as goal-scorer-only, never touching match-outcome
predictions -- `dixon_coles.py` and `train.py`'s match-outcome fitting
are untouched here, only `goal_scorer.py`'s player-level allocation.

**Verified before building, same discipline as the xG/shots-on-target
story:** `fixture_player_stats.penalties_scored`/`penalties_missed` is
real, populated data -- confirmed against the actual API-Football seed
code (`stats.penalty.scored`/`stats.penalty.missed`, written on every
`upsertFixturePlayerStats` call in `backend/seed/sources/api-football.ts`),
not another `xg`-style column that turns out to be always null.
`fixture_player_stats.goals` is API-Football's own `goals.total`, which
already includes penalty goals -- `penalties_scored` is a breakdown of
that total, not an addition to it.

**The actual gap.** A designated penalty taker's scoring odds came from
one blended per-90 goal rate (`goal_share`) that mixes penalty and
open-play goals together. Two real misattribution problems follow: (1) a
player's rate stays inflated by penalties he took for a PREVIOUS club (or
an earlier spell at the same club where he, not the current taker, had
the job) even after the role has moved on -- the existing "current
effective club" transfer-handling in `load_player_squad_appearances`
already lets recency-decay blend a moved player's old-club data
automatically, but it does nothing to separate "his job" stats from
"anyone's job" stats; (2) the actual current taker's odds were never
boosted beyond what his open-play rate alone implies, even though a
penalty is close to a guaranteed hand-off to one specific player, not
something shared across the squad the way open-play chances are.

**Mechanism, entirely in `app/goal_scorer.py`:**
- `compute_player_shares` now also returns `non_penalty_goal_share`
  (`goal_share` recomputed from `goals - penalties_scored`, so a
  player's open-play share isn't inflated by penalty history),
  `penalty_attempts` (recency-weighted `penalties_scored +
  penalties_missed` -- attempts, not just conversions, since even a
  missed penalty confirms who currently gets picked; zeroed out below a
  new `MIN_PENALTY_ATTEMPTS = 2` raw-attempt reliability gate, mirroring
  `MIN_PLAYER_MATCHES`'s existing pattern), and `penalty_goal_fraction`
  -- what share of the TEAM's own weighted goals came from penalties, the
  same value on every row for that team. This last one deliberately isn't
  an absolute "expected penalties per match" rate (that would need a
  fixture-count denominator `load_player_squad_appearances`'s output
  doesn't carry, and predicting raw penalty *frequency* is a genuinely
  noisy, low-signal problem of its own) -- a share, like `goal_share`
  already is, sidesteps that entirely and fits the file's existing idiom.
- New `compute_primary_penalty_taker(team_id, player_shares)` returns the
  player with the highest `penalty_attempts` for that team, or `None` if
  no one clears the reliability gate -- `None` means "no confident
  answer," never "this team doesn't get penalties," the same convention
  `compute_team_availability`'s 1.0 default already established.
- `allocate_team_goals` carves `team_expected_goals * penalty_goal_fraction`
  out as `penalty_expected_goals`, hands it (almost) entirely to the
  identified taker on top of his own open-play share, and allocates the
  remainder (`open_play_expected_goals`) via `non_penalty_goal_share *
  minutes_share` for everyone, taker included -- so his own penalty
  history no longer double-counts into his open-play odds. Only carves
  anything out when there's both a confident taker AND he isn't himself
  confirmed out of the matchday squad (reusing track 2's
  `confirmed_squad` parameter) -- with no attribution possible either
  way, `team_expected_goals` is left whole and allocated the old way,
  rather than a real chunk of expected goals silently vanishing.

**Verification.** 13 new tests across `TestComputePlayerShares` (the
`non_penalty_goal_share`/`penalty_attempts`/`penalty_goal_fraction`
mechanics, including the reliability gate and that misses count),
`TestComputePrimaryPenaltyTaker` (correct identification, attempts
outrank raw conversion rate, `None` for no reliable taker or no data),
and a new `TestAllocateTeamGoalsPenalties` class (the taker gets a real
boost, the team's total expected goals still roughly conserves, a
non-taker teammate isn't inflated by the taker's penalties, a team with
no reliable taker behaves exactly like before this track existed, and a
taker confirmed OUT of the squad is omitted with his penalty share
correctly NOT discarded). Every pre-existing test in the file (which
never gave any player penalty data) still passes unchanged, confirming
`penalty_goal_fraction=0`/no-confident-taker degrades to the exact
pre-this-track behavior -- full suite: 72 passed.

Also ran a synthetic end-to-end reproduction: a club's real mixed
striker (4 penalty goals, 4 open-play goals, 1 missed penalty) versus a
pure open-play teammate (10 goals, no penalties) and a rarely-used third
player. `penalty_goal_fraction` came back at 0.220 (4 of the team's 18
total goals were penalties, matching by hand). The mixed striker's
`non_penalty_goal_share` (0.321) came in well below his plain
`goal_share` (0.484), while the pure-open-play teammate's rose the other
way (0.679 vs 0.516) -- exactly the intended de-inflation. A second
scenario simulated a real transfer-window handover: the original
taker's penalty-taking stint pushed far enough into the past (400 days,
more than two full half-lives) relative to a new signing's few recent
appearances, and `compute_primary_penalty_taker` correctly flipped
attribution to the new signing -- confirming the same `HALF_LIFE_DAYS`-
driven "role strength changes slowly, but it does change" property
already relied on elsewhere resolves a real penalty-taker handover too,
not just team-level form.

All three original model-improvement tracks (baseline ratings,
match-specific availability, penalty takers) are now shipped. No
`app.evaluate`/`app.train` backtesting angle here the way the other two
tracks needed -- there's no match-outcome probability to backtest
against a market baseline for an individual player's scorer odds, so
"is this actually better" for this track rests on the mechanism being
sound (verified above) and, eventually, on how it looks against real
scorer outcomes once enough matches accumulate under it -- worth
revisiting if real predicted-scorer accuracy ever gets tracked as its
own metric.

## 2026-08-20/21 -- GitHub Actions billing incident: self-inflicted, fixed, and the repo went public

Reported live: `matchday-lineups.yml` started failing outright (runs
completing in 3-4 seconds with no runner ever assigned), then spread to
every workflow including `ci.yml` on unrelated PRs.

**Root cause, self-inflicted:** the player-availability PR (#77, earlier
2026-08-19/20) added a `python -m app.train` step to `matchday-lineups.yml`
-- already-hourly -- reasoning that `app.train` makes zero external API
calls, so rerunning it hourly "costs nothing against the API-Football
budget." True, and beside the point: `app.train` refits three Dixon-Coles
models and writes a `player_goal_predictions` row per reliable player per
upcoming fixture across all three competitions via one unbatched
`upsert_player_goal_prediction` DB round trip per row -- a real,
non-trivial cost, previously paid once a day by `daily-refresh.yml`.
Running it every hour instead multiplied that cost 24x. The run history
made the damage visible before any log needed reading: `matchday-lineups.yml`
went from a few seconds -> 46 minutes -> 1h31m -> outright failures with
no runner assigned, the signature of the account's Actions minutes/
spending limit running out.

**Fix, in two parts:**
1. Reverted `matchday-lineups.yml` to its exact pre-#77 form (PR #81) --
   stop the bleeding immediately. The "confirmed lineup reaches its
   fixture's prediction within the hour" goal is still real and wanted,
   but needs a genuinely cheap implementation (batched upserts, and/or
   only recomputing predictions for fixtures whose confirmed lineup
   actually changed) before it belongs back on an hourly cron -- not
   attempted yet.
2. The account's Actions minutes were still exhausted even after the
   revert (past usage doesn't retroactively free up) -- flipped the repo
   from private to public, which moves it onto GitHub's free-and-
   unlimited Actions minutes for public repos on standard runners.
   Confirmed working: `matchday-lineups.yml` run #69, the first one after
   going public, succeeded in seconds again.

**Before recommending going public, checked what going public would
actually expose** (see `docs/CLAUDE.md`'s new "Repo visibility" section
for the durable version of this): grepped the full git history for
hardcoded secrets/connection strings/API keys -- clean, only a harmless
`postgres://test:test@localhost/test` placeholder in test setup. Confirmed
`.env` was never committed (properly gitignored throughout). Confirmed
`backend/seed/snapshot/mentat_fc_seed.dump` (the one real data snapshot
committed to the repo) predates the `users`/`bets` tables entirely, so it
carries zero real user data. Confirmed no workflow uses
`pull_request_target` (the pattern that would hand a stranger's fork PR
access to real secrets). Repo went public with a real, checked answer to
"what's the worst that can happen," not a guess.

**Going forward:** `docs/CLAUDE.md` now carries a standing "be extra
careful about secrets while this repo is public" rule -- real credentials
only ever live in Actions secrets or a local gitignored `.env`, never
hardcoded in a script or scratch file that could get committed, and
double-check `git status`/`git diff` before committing anything
`.env`-adjacent, a seed dump, or a debug script written against a real
key. Worth revisiting whether to flip back to private once the app is
past needing free unlimited Actions minutes as urgently.

## 2026-08-21 -- Temporary Actions workflow to backtest SHRINKAGE from a phone

No laptop available to run `app.evaluate` locally against production, so
built `.github/workflows/backtest-shrinkage-temp.yml`: `workflow_dispatch`
only (never scheduled, no cron), takes a comma-separated list of
candidate `SHRINKAGE` values as an input (defaulting to
`0.0,0.02,0.05,0.1,0.2,0.5`), and runs one matrix job per value -- each
shows up as its own collapsible section in the Actions run, easy to
scan on mobile instead of one long concatenated log. Safe to run several
at once against the same real `DATABASE_URL`: `app.evaluate` only ever
reads (confirmed -- no `conn.commit()`/writes anywhere in it), so
concurrent jobs can't step on each other or on production data.

Needed one small, permanent addition to make this possible:
`app.evaluate.SHRINKAGE` now reads an optional `SHRINKAGE_OVERRIDE`
environment variable first, falling back to the existing `0.05` constant
when unset -- a normal local run (`python -m app.evaluate`, no env var
set) is completely unaffected, this is purely additive for the temporary
workflow to set per matrix job.

Explicitly temporary and labeled as such in the workflow's own header
comment: delete this file (and the `SHRINKAGE_OVERRIDE` support) once a
value has been chosen from a real backtest and promoted to `app.train`,
the same "sandbox, backtest, promote" arc `HALF_LIFE_DAYS` and
`SHOTS_ON_TARGET_BLEND_WEIGHT` already went through.

## 2026-08-21 -- SHRINKAGE backtest results: per-competition, like the shots-on-target weight before it

Ran the temporary Actions workflow twice from a phone (no laptop available),
first sweeping 0.0/0.02/0.05/0.1/0.2/0.5, then a follow-up sweep of
0.5/1.0/2.0/3.0/5.0/10.0 once the first round showed every competition
still improving at its largest tested value. Full 11-value table (Brier
score, lower is better):

| SHRINKAGE | Premier League | Championship | FA Cup |
|---|---|---|---|
| 0.0 | 0.6248 | 0.6495 | 0.6464 |
| 0.02 | 0.6246 | 0.6495 | 0.6463 |
| 0.05 | 0.6244 | 0.6494 | 0.6462 |
| 0.1 | 0.6241 | 0.6492 | 0.6459 |
| 0.2 | 0.6237 | 0.6490 | 0.6454 |
| 0.5 | 0.6230 | 0.6483 | 0.6440 |
| **1.0** | **0.6226** | 0.6475 | 0.6421 |
| 2.0 | 0.6228 | 0.6464 | 0.6397 |
| 3.0 | 0.6235 | 0.6458 | 0.6389 |
| **5.0** | 0.6253 | **0.6456** | 0.6358 |
| 10.0 | 0.6303 | 0.6466 | **0.6258** |

**Genuinely surprising, worth naming honestly:** shrinkage didn't just
help the sparse-data cases (a newly-relegated West Ham, FA Cup's ~800
minnows) the way the original hypothesis expected -- it improved ALL
THREE competitions monotonically well past the untested 0.05 starting
guess, including Premier League and Championship's own well-established
teams. Makes sense in hindsight: every team's fitted parameters are
estimated from a finite, noisy sample (even a full PL season is only
~30-ish matches per team), so mild regularization toward the mean is a
genuine bias-variance win broadly, not just a fix for the one-match
extreme case it was built for.

**Real per-competition divergence, not noise -- same shape of finding as
`SHOTS_ON_TARGET_BLEND_WEIGHT`'s own backtest:** Premier League peaks
cleanly at 1.0 and gets measurably worse on both sides of it (0.6248 at
0.0, 0.6226 at 1.0, 0.6303 at 10.0 -- a real U-shape, not a plateau).
Championship follows the same shape but its optimum sits much further
out, at 5.0 (worse again by 10.0). FA Cup never turned in the tested
range at all -- still improving at 10.0, the largest value tried, with
the biggest gain of the three (0.6464 -> 0.6258). That's consistent with
FA Cup's joint fit being the sparsest of the three (811 teams, many
with almost no data) -- it can absorb far more shrinkage before losing
real signal than a clean two-division fit can.

**Promoted `SHRINKAGE: dict[str, float] = {"Premier League": 1.0,
"Championship": 5.0, "FA Cup": 10.0}` to both `app.evaluate` and
`app.train`` in the same pass** (both files' constants, plus threading
`shrinkage` through `fit_and_report`/the three `DixonColesModel.fit()`
calls). FA Cup's value is explicitly flagged in both files' comments as
"best-tested-so-far," not converged -- worth another sweep (20/50/100) if
FA Cup predictions ever get surfaced in the app; not chasing it further
right now since nothing user-facing depends on that number today, and
the backtest itself is cheap to rerun later.

**Deleted `.github/workflows/backtest-shrinkage-temp.yml` and its
`SHRINKAGE_OVERRIDE` env var support** now that a value has been chosen
and promoted -- exactly as both were labeled to do when built. If FA
Cup's number needs revisiting later, recreate the workflow from this
commit's git history rather than reinventing it.

All 72 tests still pass (the shrinkage mechanism itself, `TestFitShrinkage`,
was already covered by #80 and is unchanged -- only the promoted values
and how they're threaded through changed here).

## 2026-08-21 -- Odds format toggle: percent / decimal / American

Requested directly ("a toggle to switch between decimal odds on
predictions vs American odds (-100, +120, etc) ... across anything with
predictions odds on it"). Every prediction surface had been rendering
raw percentages, via **three separate copies** of the same
`formatPercent` helper (PredictionsPage, FixturePage, TeamDashboardPage)
that had quietly drifted apart -- FixturePage's used one decimal place
where the others used two. Consolidating them behind one shared
formatter fixed that inconsistency as a side effect, settling on the
2dp the rest of the app already used.

**The conversion, and one thing worth being precise about.** Probability
to decimal is just `1 / p`. Decimal to American pivots at even money
(2.00): above it the number is profit on a 100 stake (+150), below it the
stake needed to profit 100 (-150). Verified against real values before
wiring any UI: 50% -> 2.00 -> +100, 40% -> 2.50 -> +150, and a
round-trip through the pre-existing `americanToDecimal` (which the bets
form already used for input) returns the original American number
exactly for -250/-110/+100/+150/+900.

The thing worth naming, since the app shows these next to real bookmaker
lines: converting a probability straight to odds gives **fair** odds,
with no margin. A real sportsbook's price on the same outcome is always
somewhat worse than its own implied probability implies -- that gap is
the vig. So the model's odds looking "better" than a book's is partly
just this, not pure edge. Written into `lib/odds.ts` rather than left as
folklore.

**Two formatters, not one**, because there are genuinely two kinds of
number on screen: `formatOdds(probability, format)` for model
probabilities, and `formatPrice(decimal, format)` for a real bookmaker's
already-decimal price (the Bets page's `@ 2.50`). They differ in what
"percent" means -- an implied probability that, for a real price,
includes the book's margin. Both return an em dash for anything with no
finite price (probability of exactly 0 or 1, a decimal <= 1.00)
deliberately, rather than a fake-looking "+99900" that would read as a
real prediction.

State lives in one app-wide context (`odds/OddsFormatContext`), mirroring
`auth/AuthContext`, persisted to localStorage behind try/catch -- reading
localStorage *throws* (not returns null) in a browser set to block site
data, which would take the whole app down on load rather than just losing
a preference. Global rather than per-page on purpose: the same fixture's
numbers appear on the Predictions list, its own detail page and a team
dashboard, and having those disagree would be actively misleading.

Deliberately NOT toggled: predicted goals (2.10 - 1.10 is a scoreline,
not a price), ROI and edge percentages on the Bets page, and "your
implied probability" -- that one is explicitly the probability reading of
a price already shown as odds a few characters earlier on the same line.

Verified in a real browser across all three formats: 55% renders as
55.00% / 1.82 / -122 and 25% as 25.00% / 4.00 / +300, the choice survives
a full reload, and it carries across to the fixture detail page and its
scorer picks.

## 2026-08-21 -- Promoted teams silently suppressed ~114 fixtures' predictions

Reported as "no goal predictions on Arsenal's game tomorrow with
Coventry." Rather than guess between the several things that produce an
empty scorer list, ran the `app.diagnose_coverage` tool built earlier the
same night. It answered immediately:

```
[10051] 2026-08-21  Arsenal vs Coventry: 1 prediction(s), 0 scorer pick(s)
    home Arsenal (id=3): in Premier League fit: yes
      reliable players (>= 5 apps): 42
    away Coventry (id=780): in Premier League fit: NO
      reliable players (>= 5 apps): 36
```

**Root cause.** Coventry and Hull City were newly promoted, so they had
zero *finished Premier League* matches -- and `load_finished_matches`
scopes the Premier League fit to Premier League results. Neither club
existed in that model's team list, so `model.predict()` raised
`ValueError` and `predict_for_competition` hit its `continue`, skipping
the fixture whole. The damage wasn't limited to the promoted side: the
skip happens *before* goal-scorer allocation, so Arsenal's 42 perfectly
reliable players produced nothing either. One team's missing history was
suppressing its opponent's picks.

Scale is what made this urgent rather than cosmetic: it's not four
fixtures, it's every fixture involving a promoted club -- roughly 38 each,
around 114 across the three promoted sides -- on the morning the season
started.

**Fix: fall back to the joint fit.** That model already exists and spans
all three competitions, so a promoted club with a full Championship
record *is* in it even when the Premier League's own fit has never seen
them. This is the same cross-league comparability argument that makes the
joint fit the right model for an FA Cup tie (see `app.train`'s 2026-08-15
note) -- a Premier League side against a just-promoted one is the same
situation, one team's strength known only from another division. Falling
back is strictly better than skipping: it uses real data instead of
none. A team in neither fit (a non-league FA Cup entrant with no
appearances anywhere) still skips, which is correct.

`_predict_fixture` was extracted so the primary and fallback paths share
one implementation -- a fallback that silently skipped the availability
adjustment would be a subtle, hard-to-spot inconsistency -- and the
per-competition report now counts how many predictions came via the
fallback, so this staying high once a promoted side has real top-flight
results would itself be a signal something's wrong.

**A second, unrelated bug fell out of verifying the first.** The
synthetic check returned `draw = -0.048` -- a negative probability. Not
the test data's fault: `fit()`'s likelihood clips tau against a
pathological rho (`np.clip(tau_values, 1e-10, None)`) but `predict()`
never did. tau is `1 - rho` at 1-1 and `1 - lambda_home*lambda_away*rho`
at 0-0, so a large enough rho makes one of the four low-score cells
negative; normalizing preserves the sign, and the triangle sums then
return values outside [0, 1] that still sum to 1 (which is why nothing
caught it). Real fits land near rho ~= 0.07 and never trip it, but the
joint fit now backstops other competitions, so `predict()` got the same
guard `fit()` always had. Pinned with a test that sets rho past the
threshold directly -- confirmed it fails without the guard and passes
with it, rather than trusting that it would.

Both were found the same way: build the diagnostic instead of guessing,
then actually run the verification rather than assuming it passes.

## 2026-08-21 -- Shot location (inside vs outside the box): the data pipeline

Requested as a model idea, and a good one: a shot from inside the penalty
area converts at a far higher rate than one from outside, so the same
"total shots" number means very different things depending on where they
came from. `blend_shots_on_target_into_scores` already proved a
shot-volume proxy beats raw goals for fitting (a real ~2.4% Brier gain in
the Premier League), and location should sharpen exactly that signal --
it's the closest thing to real xG this project can actually get.

**Verifying first, again.** `fixture_team_stats` is populated
*exclusively* by football-data.co.uk's CSV importer, which has no
shot-location columns at all -- so this needed a whole new API-Football
seed path, not just a column. Before building it, confirmed
`Shots insidebox` / `Shots outsidebox` are real fields on
`/fixtures/statistics` (from the endpoint's own documentation).

That answers "does the field exist" but NOT the question that actually
matters here: **are those fields populated for three-season-old fixtures,
or only recent ones?** A stat that only exists for the current season is
close to useless for a model that fits on three. Rather than make that a
separate blocking step, the backfill answers it as a side effect: it
processes **oldest fixtures first** and prints a running "N had
shot-location data (X%)" every 25 fixtures. Thin historical coverage
therefore shows up in the first handful of calls, and the run can be
cancelled -- instead of spending a few thousand calls and discovering it
in a backtest weeks later. That's the `xg` lesson applied one level
deeper: it isn't enough to check that a field exists, the check has to
cover the range the model will actually train on.

**The one genuinely risky part: not clobbering the CSV.**
`fixture_team_stats` rows for the two leagues are owned by the CSV
importer (shots / shots_on_target / corners / fouls / cards), which is
the more complete source for what it covers, and its numbers disagree
slightly with API-Football's on definitions. A blanket upsert from the
new source would silently overwrite all of it. So
`upsertFixtureShotLocation` touches **only** its own two columns:

```sql
ON CONFLICT (fixture_id, team_id) DO UPDATE SET
  shots_inside_box = EXCLUDED.shots_inside_box,
  shots_outside_box = EXCLUDED.shots_outside_box
```

Its INSERT branch only ever fires for a fixture the CSV never covered (an
FA Cup tie), where the other columns legitimately stay null. Proved
rather than assumed: wrote a CSV-shaped row (14 shots, 6 on target, 7
corners, 11 fouls, 2 yellows), ran the shot-location upsert over it, and
confirmed every one of those values survived untouched while the box
columns filled in.

Team identity resolves through `teams.external_api_football_id` and is
then checked against the fixture's own home/away ids before writing --
the statistics endpoint identifies teams by API-Football's id space, and
this project has already been bitten once by trusting a second id space
to line up (see the player entity-resolution entries).

Cost shape differs enough from the lineup backfill to justify its own
entry point: one call per fixture with no bulk form, so a full
three-season catch-up is a few thousand calls and will usually span more
than one day's 7500 budget. Resumable with no flags -- every run
re-queries for fixtures still missing the columns, so stopping on budget
and rerunning tomorrow continues exactly where it left off.

Migration verified to round-trip (`up` -> columns present -> `down` ->
columns gone -> `up` again), which matters more than usual here because
the column being added is the same *shape* as the `xg` column that turned
out to be permanently null.

**Not yet wired into the model.** That's deliberate and is the next step:
there's no point blending a column that's still empty. Once the backfill
has real coverage, the natural experiment is a
`SHOT_LOCATION_BLEND_WEIGHT` sandboxed in `app.evaluate` exactly like
`SHOTS_ON_TARGET_BLEND_WEIGHT` was -- and the honest possibility that it
adds nothing beyond shots-on-target is a real outcome worth measuring,
not assuming away.

## 2026-08-21 -- Shrinking toward an informative prior, not the league mean

Asked directly, and it's the right question: "could we not add a
coefficient and use prior data or something to give a better prediction?"

**The gap it identifies.** The shrinkage shipped earlier pulls every
team's attack/defense toward *league average*. That's a reasonable
default when nothing better is known, but it's a genuinely poor prior for
the exact case shrinkage was added to fix. West Ham, relegated into the
Championship, have three seasons of Premier League results saying they
are well ABOVE that division's average. Shrinking them to 1.0 throws all
of it away -- it trades an overrating for an underrating rather than
actually improving the estimate.

**The better prior already existed.** The joint fit spans all three
competitions and is calibrated across divisions by the cup ties that
connect them, so a relegated club's joint rating is effectively "their
top-flight strength expressed on a scale comparable to this division."
`DixonColesModel.fit()` now takes an optional `prior_model`, and the L2
penalty becomes `(log_attack - prior)^2` instead of `log_attack^2`.
Textbook hierarchical / partial pooling: the shrinkage target goes from
global to team-specific. A team with plenty of matches here is barely
moved either way; a team with almost none now lands near their
cross-competition strength instead of near the league mean.

**The fiddly part is re-centring, and getting it wrong would be silent.**
The joint fit centres its own attack mean to 0 across ~800 teams, so its
raw values mean nothing inside a 25-team Premier League fit -- every
Championship side sits below the joint mean, which says nothing about
where they rank among Championship sides. The prior is therefore shifted
by the mean over *just this competition's* teams before use. Crucially
that shift is applied as `attack -= offset` **and** `defense += offset`
together, which is a move along the `(attack + c, defense - c)` ridge the
model is invariant to -- so it re-centres the prior without distorting
what it actually claims about any team. Teams absent from the prior keep
a target of 0, i.e. they fall back to plain league-average shrinkage,
which is the honest default when there's genuinely no information.

**Synthetic check on the real shape** (a strong top-flight club relegated
into a weaker division, one match played there):

| shrinkage target | fitted attack | P(beat a mid-table side) |
|---|---|---|
| none | 2.596 | 98.2% |
| league average | 1.216 | 63.4% |
| joint fit (prior) | 1.835 | 84.3% |

The 98.2% reproduces the production pathology almost exactly (the real
one was 99.49%). What the middle row shows is the thing worth
remembering: plain shrinkage *does* fix the runaway number, but plausibly
overshoots in the other direction. The prior lands between them, which is
where a recently-relegated side belongs.

Worth stating plainly: that ordering is *plausible*, not *validated*. A
synthetic fixture built to have a hierarchy will show a hierarchy. Only a
backtest against held-out real matches can say whether it predicts
better, so this ships as `SHRINK_TOWARD_JOINT` (default False --
production behaviour unchanged) with a temporary A/B workflow, exactly
the same sandbox-then-promote arc `HALF_LIFE_DAYS`,
`SHOTS_ON_TARGET_BLEND_WEIGHT` and `SHRINKAGE` each went through. It is
entirely possible the backtest says league-average shrinkage is already
good enough, and that's a real result.

One structural change fell out of this: `app.evaluate` now fits the joint
model FIRST rather than last, since the two single-competition fits may
now depend on it as their prior. The joint fit itself never takes a prior
-- there is nothing broader to pull it toward.

## 2026-08-21 -- The shrinkage-prior A/B came back too close to call, so: paired testing

Ran the prior-vs-league-average A/B against production. Result, Brier
(and log-loss agreed with Brier in every case, which is at least
internally consistent):

| | off (current) | on (candidate) | |
|---|---|---|---|
| Premier League | 0.6226 | **0.6209** | better |
| Championship | 0.6474 | 0.6484 | worse |
| FA Cup | 0.6258 | 0.6258 | identical |

FA Cup coming back byte-identical is a genuinely useful signal, not a
boring one: the joint fit never takes a prior, so it MUST be unchanged.
That it is confirms both that the runs are deterministic and that the
flag is plumbed only where intended.

**The problem: these differences are tiny.** Premier League gains 0.0017
Brier -- 0.27%. For scale, the shots-on-target blend moved the same
number 0.6399 -> 0.6248 *monotonically across five values*, which no
amount of noise explains. This is a single A/B with a fraction of that
effect, in opposite directions in two competitions.

The tempting move was to do what `SHOTS_ON_TARGET_BLEND_WEIGHT` did when
competitions disagreed -- go per-competition, Premier League on,
Championship off -- and call it validated. That would have been wrong,
or at least unjustified: picking per-competition winners off differences
this small is precisely how you overfit a backtest to its own test set.
The earlier per-competition decision was defensible because the trend was
large and monotonic across a sweep; this one is two numbers.

**So the real gap was in the measurement, not the model.** `app.evaluate`
prints one aggregate number per competition per run, which cannot answer
"would this hold up on a different sample of matches?" New `app.compare`
scores both configurations on THE SAME held-out fixtures and compares
them **per match, paired**, then bootstraps over fixtures for a
confidence interval on the mean difference.

Pairing is what makes small effects measurable at all here. Most of the
variance in a Brier score is "some matches are just inherently harder to
predict", and that component is *identical* for both configurations, so
differencing per match cancels it. Comparing two independent aggregates
throws that cancellation away and buries a 0.0017 effect under noise
that was never relevant to the comparison.

The bootstrap resamples whole fixtures rather than assuming normality --
per-match Brier values are bounded and heavily skewed (most cluster in
the middle, a few confident-and-wrong predictions score terribly), so a
normal-approximation interval would be the wrong shape. Seeded, so the
same data always yields the same verdict rather than a slightly different
one each run.

Sanity-checked the machinery against known answers before trusting it:
fed it 400 samples of pure noise (true effect zero) and 400 with a real
-0.05 effect. The noise case produced a sample mean of -0.0328 -- which a
naive comparison would have happily called a win -- and the interval
correctly spanned zero anyway. The real effect was correctly detected.
That first case is the entire argument for building this.

Verdict on the prior itself: **still unknown, deliberately.**
`SHRINK_TOWARD_JOINT` stays default-False and production is unchanged
until the paired comparison says the interval excludes zero. "The
difference is not distinguishable from noise" is a completely legitimate
outcome here, and much better than shipping a per-competition rule
fitted to sampling error.

## 2026-08-21 -- Verdict on the shrinkage prior: not distinguishable from noise

Ran the paired comparison built for exactly this question:

```
Premier League: 350 paired matches (350 scored differently)
  A Brier 0.6226   B Brier 0.6209
  mean difference (B - A): -0.00171   95% CI [-0.00468, +0.00141]
  -> INCONCLUSIVE

Championship:   516 paired matches (516 scored differently)
  A Brier 0.6474   B Brier 0.6484
  mean difference (B - A): +0.00108   95% CI [-0.00165, +0.00394]
  -> INCONCLUSIVE

FA Cup:         303 paired matches (0 scored differently)
```

Both intervals span zero. `SHRINK_TOWARD_JOINT` stays False; production is
unchanged.

**This is the entry to remember.** The raw aggregates looked like a
Premier League win and a Championship loss, and the obvious move was to
go per-competition -- which is a pattern this project has legitimately
used before, for `SHOTS_ON_TARGET_BLEND_WEIGHT`. Doing it here would have
been fitting sampling error and calling it a validated improvement. The
difference between the two cases is worth stating precisely, because
"per-competition" is not itself the lesson: shots-on-target showed a
*large, monotonic trend across five values* (0.6399 -> 0.6248, ~2.4%);
this showed *two numbers* a third that size with no trend behind them.
Same shape of conclusion, completely different strength of evidence.

**What the confidence interval is really telling us.** Its half-width is
roughly 0.003 Brier, which is a property of the test set, not of this
change: with ~350-500 held-out matches, anything smaller than about
0.003 simply cannot be resolved. That is a standing calibration for
future work here -- chasing sub-0.003 effects with this backtest is not
a modelling problem, it's a measurement-floor problem, and more clever
model changes will not fix it. `app.compare` now prints that floor
alongside an inconclusive verdict so the limit is visible at the moment
someone would otherwise over-read a result.

**Kept, not deleted.** The mechanism is sound and well-tested, and the
most plausible reason it doesn't register is that the held-out window
contains very few newly-promoted or relegated clubs -- precisely the
teams it helps. An effect concentrated in ~2 of 25 teams is easily
swamped when averaged over every match in the division. Worth re-running
after a season whose test window has more division changes, or with a
better prior. Flipping the constant re-tests it.

Also fixed a real wording bug the run exposed: FA Cup reported
"INCONCLUSIVE -- not distinguishable from noise" while showing `0 scored
differently` and an exactly-zero interval. That fit takes no prior, so it
is a *control* proving the flag is plumbed only where intended -- calling
it a null result was technically true and actively misleading. It now
reports UNCHANGED, and distinguishes "we couldn't tell" from "nothing
happened."

The temporary A/B workflow and the `SHRINK_TOWARD_JOINT_OVERRIDE` env var
are both deleted, as their own comments said they should be once a
verdict existed. `app.compare` stays -- it is now the standard way to
judge a model change here, and its first real use was talking this
project out of a change it would otherwise have shipped.

## 2026-08-21 -- Shot location, wired into the model: learning the coefficient

The shot-location backfill has real data now, so the column stopped being
a no-op and the model work could actually begin.

**The interesting problem.** The shots-on-target blend works by reading a
single pooled ratio straight off the data: total goals divided by total
shots on target. Shot location can't be done that way. The data records
how many shots a team took from inside and outside the box, and how many
goals it scored -- but never WHICH shots became goals. There is no
per-location conversion rate sitting in a column waiting to be read.

It can be *estimated*, though, and this is where the "add a coefficient"
idea from earlier lands properly. Across many matches,
`goals ~= inside * rate_inside + outside * rate_outside`, which is
ordinary least squares with two unknowns and one row per team-match.
The model learns the relative value of location instead of being told
it. No intercept: a team taking zero shots scores zero goals, and a
constant term would hand out goals for nothing, flattening exactly the
between-team differences the fit needs to see.

**Verified against known answers before trusting it**, which turned out
to matter. Generated synthetic matches from known rates (0.130 inside,
0.035 outside, Poisson noise) and checked what came back. The first
single run recovered 0.1385 and 0.0179 -- the inside rate close, the
outside rate off by half, which initially looked like bias in the
estimator. Running 12 trials instead of one showed it wasn't: the means
were 0.1291 and 0.0367, both essentially unbiased. The outside rate is
simply about twice as noisy (sd 0.0123 vs 0.0065), because outside-box
shots are fewer and, with no intercept, the two columns are somewhat
collinear so the pair trades off run to run.

The lesson worth keeping: one sample is not an estimate. A single draw
1.4 standard deviations out looked exactly like a systematic flaw, and
would have sent me rewriting a function that was already correct.

**And the noisy coefficient turned out not to matter**, which is the
part that decides whether this is usable. Callers never use either rate
on its own -- they use the combination, which is precisely what least
squares optimises. Across those same trials the resulting proxy
correlated **0.997** with true expected goals and sat within **0.036
goals** of it on average. The individual coefficients are interesting to
look at; the proxy is what's reliable, and the docstring now says so
rather than inviting someone to read a single run's "inside-box shots are
worth 7.7x outside ones" as a fact about football.

**Not promoted, deliberately.** `SHOT_LOCATION_BLEND_WEIGHT` ships at 0.0
for every competition -- production behaviour unchanged -- because the
hypothesis that location beats shot-count is genuinely untested on real
data. `app.compare` is repointed at this question (its config block is
now explicitly the thing to edit for a new comparison), so the verdict
comes from a paired, bootstrapped test rather than from eyeballing two
aggregate numbers, which is the mistake the previous change nearly
caused.

`app.evaluate` now also prints shot-location coverage and the learned
rates up front. Partial coverage silently makes the blend a partial
no-op, which is precisely how the `xg` column managed to look wired up
while touching nothing -- printing it means that failure announces itself
instead of hiding inside an unchanged Brier score.

## 2026-08-21 -- A confident verdict that was measuring the wrong thing

Ran the shot-location comparison. It came back with what looked like a
clean, statistically detected result:

```
shot-location coverage: 2618/5442 matches (48%)

Premier League: A 0.6226  B 0.6160   diff -0.00658  CI [-0.01563, +0.00212]  INCONCLUSIVE
Championship:   A 0.6474  B 0.6566   diff +0.00921  CI [+0.00296, +0.01527]  A is better
FA Cup:         A 0.6258  B 0.6293   diff +0.00344  CI [-0.00002, +0.00695]  INCONCLUSIVE
```

The Championship interval **excludes zero** -- by the standard this
project just adopted, that is a real detected effect, and the obvious
reading is "shot location is genuinely worse in the Championship."

**That reading was wrong, and the fault was in the comparison, not the
data.** Configuration B set the shots-on-target weight to 0 and the
location weight to 1. Location coverage is 48%. So on the other ~52% of
matches, B fell back to *raw, completely unsmoothed goal counts* -- while
A had shots-on-target smoothing applied to every single row. B wasn't
"location instead of shots on target"; it was "location on half the
matches, and nothing at all on the rest." The candidate was handicapped
on half the sample, and the detected Championship effect was at least
partly measuring coverage rather than signal.

The uncomfortable part is that the statistics were *fine*. The pairing
was correct, the bootstrap was correct, the interval genuinely excluded
zero. A correct test of a badly-specified comparison produces a
confident, precise, wrong answer -- and it looks exactly like a real
finding. Rigour in the measurement does not protect against asking the
wrong question, and having just built the paired test made it MORE
tempting to trust its output uncritically.

The 48% coverage number was printed right there at the top of the output,
which is the only reason this got caught. That was added for an unrelated
reason (so partial coverage couldn't silently no-op the blend, the way
the `xg` column once did). It ended up being the thing that invalidated
the headline result. Printing the boring context next to the answer earns
its place.

**The fix is also the right production design.** New
`blend_goal_proxies_into_scores` applies an explicit precedence per side
per match: shot location where it exists, shots on target where it
doesn't, real score where neither does. B is now "A, upgraded to location
on the rows that have it", which is a fair comparison and the only
sensible way to actually deploy this.

A second trap avoided while writing it: chaining the two blends naively
would estimate the location conversion rates from *already-blended
pseudo-goals*. Both calibrations are now estimated from the original
scores before anything is modified -- fitting a goals-per-shot rate
against a number that is no longer a goal count would be quietly
meaningless.

Pinned with a regression test, verified to fail against a deliberately
reintroduced version of the bug rather than assumed to work.
`app.compare` now also prints coverage **per competition**, since that's
the most likely confounder for any per-competition difference and
belongs next to the verdict, not as one global number. Verdict on shot
location itself: still open, pending a rerun of the corrected comparison.

## 2026-08-21 -- Shot location: a well-supported negative result

Corrected comparison, with per-competition coverage this time:

```
coverage: Premier League 1102/1140 (97%)  Championship 1404/1683 (83%)  FA Cup 112/2619 (4%)

Premier League: A 0.6226  B 0.6164   diff -0.00626  CI [-0.01499, +0.00209]  INCONCLUSIVE
Championship:   A 0.6474  B 0.6566   diff +0.00926  CI [+0.00259, +0.01582]  A is better
FA Cup:         A 0.6258  B 0.6305   diff +0.00469  CI [+0.00113, +0.00829]  A is better
```

**The coverage hypothesis was wrong.** Having found the fallback bug, the
natural expectation was that fixing it would dissolve the Championship
result. It didn't: +0.00921 became +0.00926, essentially unmoved, on 83%
coverage. Worth recording because the previous entry's lesson could
easily be over-applied -- "the comparison was flawed" and "the finding was
false" are different claims, and here only the first was true. The bug was
real and worth fixing; it just wasn't what produced the result.

(FA Cup shifting from inconclusive to a detected effect despite 4% own
coverage is not a contradiction: FA Cup predictions come from the joint
fit, whose training data is mostly Premier League and Championship
matches, which ARE covered.)

**Why location loses, and it's structural rather than incidental.**
Inside-box + outside-box sums to TOTAL shots. So using location as the
signal silently discards the on-target filter: a shot blocked from six
yards counts the same as one that beat the keeper. And every goal is by
definition an on-target shot, so shots-on-target strictly contains the
goals in a way location never can. Location says where a shot came from;
on-target says whether it actually threatened.

**The obvious rescue also failed, which is the useful part.** If they
measure different things, regress on all three and let the data weight
them -- strictly more information than either alone. Built
`estimate_goal_weights` to do exactly that, then tested it on synthetic
matches with known structure before running anything against production:

| config | corr to true xG | MAE |
|---|---|---|
| location only | 0.6746 | 0.3373 |
| shots on target only | **0.9458** | **0.1477** |
| all three | 0.9450 | 0.1475 |

Adding location to shots-on-target changed nothing, and the regression
said so itself by driving the weights to 0.0071 and 0.0000. The
information location carries is almost entirely already inside
shots-on-target. Beating it would need *on-target shots by location*,
which is the one cut API-Football doesn't provide.

**Consolidated rather than accumulated.** A negative result that leaves
three unused functions behind is a tax on everyone who reads the file
later. `estimate_shot_location_conversion`,
`blend_shot_location_into_scores` and `blend_goal_proxies_into_scores`
are all removed, subsumed by the one general
`estimate_goal_weights` / `blend_learned_shot_proxy_into_scores` pair,
which takes any combination of signals and is what a future experiment
should reach for. Net effect: the codebase is smaller than before this
experiment started, while being able to do strictly more. The
`SHOT_LOCATION_BLEND_WEIGHT` constant and its wiring are gone, with a
comment in their place recording why, so nobody re-derives this from
scratch.

The database columns and the backfill stay. The data is real, cheap to
keep, and may earn its place somewhere other than team-strength fitting
-- it just isn't a better input than shots on target for this.

`app.compare` is reset to a neutral state (A == B) rather than left
pointed at a settled question, so the next run of it is a self-check
whose intervals should collapse to exactly zero.

## 2026-08-21 -- Reopening shot location: the rejection test wasn't a fair fight

Caught on re-reading my own work, and it's a methodology error worth
naming: shot location was rejected by comparing **shots-on-target at its
tuned weight** (0.75 Premier League / 0.25 Championship / 1.0 FA Cup,
each chosen from a five-value sweep) against **location at a flat 1.0**,
a value that was never tuned at all. The incumbent got to play its best
card and the challenger got whatever was convenient.

The structural argument against location still stands -- inside + outside
sums to total shots, so it discards the on-target filter, and every goal
is by definition an on-target shot. But that argument predicts location
is a *weaker* signal, not that it's worthless at every mixing weight, and
the Premier League (the one competition at 97% coverage) leaned positive
at -0.00626. Rejecting on an untuned comparison was premature.

`app.compare` is now a **sweep**: one baseline, several candidate weights,
every candidate paired against the same baseline on the same held-out
fixtures, with its own bootstrapped interval. That is strictly better
tooling than the original shots-on-target sweep had -- those weights were
chosen from point estimates with no confidence intervals at all, which
means "0.75 is the Premier League optimum" has never actually been shown
to be distinguishable from 0.5 or 1.0. Worth revisiting on the same
machinery later.

**A real bug fell out of building the fair comparison**, and it was the
same failure mode as the one this whole thread started with. The
fallback-aware blend overrides covered rows with the primary proxy -- but
at `primary_weight = 0` the primary blend returns the ORIGINAL scores, so
the override stripped the fallback's smoothing from precisely the
best-covered rows. The boundary case silently produced *less* smoothing
than the baseline it was supposed to equal. Caught by asserting the
property that should obviously hold (primary weight 0 == pure fallback)
rather than by reading the code, which is the second time that exact
class of bug has appeared and the reason it now has three tests around it.

Also worth noting what didn't change: `blend_shot_proxies_with_fallback`
is a general replacement for the function removed in the previous entry,
not a revival of it. It takes any two signal sets rather than hardcoding
location-versus-shots-on-target, so the next proxy comparison reuses it.

## 2026-08-21 -- Three bugs found by actually running the thing

The sweep crashed in production on `NameError: BOOTSTRAP_SAMPLES`. My
pre-ship check had been `python -c "from app import compare"`, which
passed, because the name is only referenced inside a function body.
**Importing a module proves almost nothing about whether it runs.** The
constant had been deleted by an earlier refactor that sliced out a block
of the file, and nothing caught it because `app.compare` had no tests at
all -- the one module whose entire job is deciding what gets shipped.

It has tests now, including one that fails if the constant goes missing
again (verified by deleting it and watching collection fail, rather than
assuming). But the more useful outcome was fixing *why* it couldn't be
caught locally, which turned up two further problems.

**Second: the module couldn't be run outside production.** A database
holding only some of the three competitions -- the local snapshot is
Premier League only -- crashed deep inside scipy with
`IndexError: arrays used as indices must be of integer type`, because an
empty competition frame was being fitted. So the only place `main()`
could execute was against real data, which is exactly how a NameError
survived to a real run. Competitions below a match floor are now skipped
with a printed note. This is the actual lesson: an unhelpful crash on
partial data isn't a cosmetic problem, it's what removes your ability to
test anything cheaply.

**Third, and the one that would have quietly corrupted the result:**
with `main()` finally runnable locally, the 0%-coverage snapshot produced
a difference of exactly `+0.00065` at every single weight. With no
location data the candidate must be *identical* to the baseline, so a
nonzero constant meant something other than location was varying.

It was. The baseline used `blend_shots_on_target_into_scores` (pooled
mean-ratio calibration) while the candidate's fallback used
`blend_learned_shot_proxy_into_scores` (least squares). Both rescale
shots on target to goals, by different methods. Every "does location
help?" verdict would have been a mixture of that question and "which
shots-on-target calibration is better?" -- a small, systematic, entirely
invisible confound, on the same order as the effects being measured.

Holding the calibration fixed makes the zero-coverage difference exactly
`+0.00000` at every weight, which is now a genuine self-check: run the
comparison against data with no coverage and it must report a control.
A test that can't detect its own null case can't be trusted on a real one.

(Incidental finding worth keeping: least squares came out very slightly
worse than the pooled mean ratio for shots on target. Not chased -- it's
a different question, and this file now has the machinery to ask it
properly whenever it's worth asking.)

Three bugs, all in the measurement rather than the model, all found by
running the code instead of reading it. The pattern across this whole
session is consistent enough to state plainly: every serious error here
has been in how something was measured, not in the modelling idea, and
none of them were visible without execution.

## 2026-08-21 -- Shot location, promoted (and what nearly buried it)

The sweep ran clean and answered the question:

| location weight | Premier League (97% cov.) | Championship (83%) | FA Cup (4%) |
|---|---|---|---|
| 0.25 | +0.00104 `[-0.00708, +0.00954]` | **+0.00138** `[+0.00022, +0.00257]` | +0.00041 `[-0.00355, +0.00429]` |
| 0.50 | -0.00303 `[-0.00918, +0.00339]` | **+0.00308** `[+0.00060, +0.00559]` | +0.00027 `[-0.00282, +0.00332]` |
| 0.75 | **-0.00693** `[-0.01384, +0.00001]` | **+0.00588** `[+0.00117, +0.01049]` | +0.00137 `[-0.00152, +0.00428]` |
| 1.00 | -0.00615 `[-0.01471, +0.00219]` | **+0.00915** `[+0.00245, +0.01572]` | **+0.00447** `[+0.00096, +0.00802]` |

(Mean per-match Brier difference vs. the shots-on-target baseline, 95%
bootstrap CI. Negative is better. Bold = interval excludes zero.)

Shipped as `SHOT_LOCATION_BLEND_WEIGHT` = Premier League 0.75,
Championship 0, FA Cup 0.

**The Championship and FA Cup zeros are the strong part of this result,
which is the opposite of how it feels.** A zero usually means "we found
nothing." Here it means the opposite: the Championship is significantly
worse at all four weights, monotonically, with the interval excluding
zero every time. That is a detected effect pointing the wrong way -- a
far firmer reason to leave a feature off than never having measured it.
Distinguishing "measured, and it hurts" from "unmeasured, so off by
default" matters, because only one of them is worth revisiting.

**The Premier League 0.75 is the weak part, and it got promoted anyway.**
Its interval touches zero (`+0.00001`), so it fails a strict 95%
significance test by the narrowest possible margin. I promoted it because
significance is the wrong decision rule here. Significance answers "can I
publish this?"; the question in front of me is "which of two values do I
deploy tomorrow?", where the loss is symmetric and there is no privileged
null. About 97.5% of the bootstrap mass sits below zero, and the point
estimate is the largest effect anything has produced this season. Under
symmetric loss you take the better expected value; refusing to move
because a threshold wasn't cleared is itself a choice, and a worse one.

Recorded rather than buried, because I would want to know it later: the
Premier League curve is *not* clean. A smooth real effect should show
about a third of 0.75's gain at 0.25, and instead 0.25 came back slightly
**positive**. And the sweep's baseline used least-squares shots-on-target
calibration while production ships the pooled-mean-ratio one, so a small
unmeasured delta separates the tested baseline from the live one. Neither
is enough to overturn the decision; both are enough that this gets re-run
when the season adds held-out matches.

### The mistake this corrects, which is the actually reusable part

Location was **rejected** four days of commits ago, on a comparison
between shots on target at its tuned per-competition weight
(0.75/0.25/1.0, chosen from a five-value sweep) and location at a flat
1.0 that had never been tuned at all. Both numbers were real. The
comparison was still meaningless, and the Premier League optimum turned
out to be nowhere near the value location had been tested at.

Generalised: **when a new signal loses to an incumbent that has been
tuned and the challenger has not, the experiment measured tuning, not
signal.** This is easy to miss precisely because the incumbent's tuning
was legitimate work -- it doesn't feel like stacking the deck, it feels
like comparing against your best current setup, which is the right
instinct applied at the wrong level.

The thing that actually saved it was Nolan pushing back on the rejection
rather than accepting a confidently-worded negative result. Worth
remembering that the write-up quality of a wrong conclusion is completely
uncorrelated with whether it's right.

### The `location_weight == 0` branch that looks redundant

`blend_fitting_signals` special-cases zero instead of just passing 0
through to `blend_shot_proxies_with_fallback`, which already handles it.
Both paths use shots on target alone, so the branch reads like clutter.

It isn't. The two paths rescale shots on target to goals by *different*
methods -- pooled mean ratio vs. least squares -- and only the
pooled-mean-ratio version has ever been backtested for the two
competitions now shipping at 0. Collapsing the branch would ship an
unmeasured change to the Championship and FA Cup disguised as a no-op,
which is the same shape as the confound that corrupted the sweep itself
two entries ago. There's a test pinning both halves: that zero-weight
matches the backtested calibration, *and* that the two paths genuinely
differ (if they ever coincided, the branch would be dead code and its
comment would be a lie).

Also added: a test that runs `app.train._blend` and `app.evaluate._blend`
on the same frame and asserts they agree, plus one asserting the two
modules' hand-synced weight dicts are actually in sync. Hand-syncing is
deliberate -- the sandbox has to be editable without touching production
-- but "deliberate" and "unverified" are different things.

## 2026-08-21 -- The goal-scorer model finally gets measured

Every team-level change in this project went through a held-out
comparison. The goal-scorer model -- the thing the app puts most
prominently on screen -- shipped on plausibility and was never scored
against what actually happened. `app/evaluate_scorers.py` fixes that.

### Three numbers, deliberately kept apart

The instinct is to report one score. That would have hidden the actual
problem, because **calibration and ranking fail independently**:

- **calibration** = predicted scorers ÷ actual scorers. If we say 0.20 to
  a hundred player-fixtures, about twenty should score. This is the
  headline, because a scorer probability is read directly as a price.
- **AUC** = do we rank the right players higher? Invariant to any monotone
  rescale, so it says *nothing* about the level.
- **Brier / log loss** = the two mixed.

Both are scored against a base-rate baseline: one constant probability for
everybody. It is perfectly calibrated by construction and ranks nobody, so
it is exactly the right thing to beat -- if the per-player machinery can't,
it earns nothing over "someone scores sometimes."

Two findings from the synthetic run, both about *reading* the output:

**Brier is nearly useless for this question.** With a base rate around 8%,
a 20% error in the probability level barely moves it. The allocation fix
below took calibration from 0.75 to 0.91 and made Brier *slightly worse*.
Log loss moved the right way. A metric being proper doesn't make it
sensitive to the failure you're chasing.

**AUC cannot distinguish the two allocation settings at all**, and that's
not a limitation, it's the proof the diagnosis is right: normalising is a
monotone rescale, so by construction the ranking is identical and only the
level changes.

### The leakage that would have flattered it most

`load_player_squad_appearances` derives a player's club partly from
`players.current_team_id`, which is live -- FPL reflects a transfer the
instant it happens. In a backtest at cutoff date T, that column is
reporting club moves from the future. Left in, it would have flattered the
result **most for the players who moved**, i.e. the hardest cases. So the
`as_of` cutoff applies inside the appearances CTE and, when set, stops
trusting `current_team_id` in favour of what the appearance history itself
said at the time.

The join to ground truth is a LEFT join with goals filled to zero. The
tempting version is an inner join, which quietly deletes every predicted
player who wasn't in the squad -- i.e. deletes *only* confident predictions
that turned out wrong. That is the single most flattering thing a backtest
can do to itself, and it looks completely innocent in code.

### The leak, now with a fix

Two causes, both arithmetic, both confirmed:

1. `goal_share` is normalised across all of a team's players and
   `MIN_PLAYER_MATCHES` is applied *afterwards*, so surviving shares sum
   to under 1 by construction.
2. A per-90 **rate** share is multiplied by `minutes_share` (< 1),
   discounting a second time.

One change fixes both: divide each weight by the sum of the weights
actually being allocated for that fixture. And it fixes a third thing that
was never the point -- today a confirmed-out player's share vanishes into
nothing, and under normalisation his team-mates absorb it, which is right
because `compute_team_availability` has already reduced the team's expected
goals for his absence.

Shipped as `NORMALIZE_ALLOCATION = False`. The fix raises every scorer
probability by ~1/0.76, and before the backtest existed there was no way to
know whether that moves toward the truth or straight past it. The backtest
scores both settings on the same held-out player-fixtures in one run.

### The test that runs the whole pipeline with no database

`app.compare`'s NameError reached production because the only way to
execute that module was against the production database. The same was true
of this one on the day it was written. So `TestMainEndToEnd` fakes the four
loaders and runs `main()` top to bottom on synthetic data.

It earned its keep immediately, catching two real bugs in itself before a
single real row was read: the synthetic fixtures were dated in generation
order, so the held-out tail contained exactly one competition and the
per-competition reporting was never exercised; and with a fixed starting
XI the two prediction modes produced byte-identical output, so the mode
split was silently measuring nothing. Both are now asserted against.

Neither would have been visible from reading the code, and both would have
made the first production run quietly wrong rather than loudly broken.

## 2026-08-21 -- A log line that could not answer its own question

"Ran the matchday check, the lineup still isn't showing." The log said:

```
Matchday lineups: checked 1 fixture(s) kicking off soon, 0 had a confirmed lineup.
```

That message is useless, and worse than useless, because it reads like an
answer. `seedTodaysLineups`' query had `NOT EXISTS (SELECT 1 FROM
fixture_lineups ...)` -- so **a fixture whose lineup landed successfully is
excluded from the very message you would read to find out what happened.**
"checked 1, 0 confirmed" is identical whether the fixture you care about
was the one checked, was already captured, or was never in the window.

Three completely different situations, one indistinguishable sentence. The
actual answer turned out to be timing (kickoff 19:00 UTC, checked at 18:24,
so T-36min when lineups land at roughly T-60min) -- but I could not have
known that from the log, and neither could anyone else.

Fixed by making the log say what it did: per-fixture name, how far from
kickoff, whether anything was published, plus a count of in-window fixtures
skipped *because they already had a lineup*, and an explicit note when
nothing was in the window at all. `app.diagnose_lineups` covers the rest.

**The general lesson: a summary that aggregates away the thing being asked
about is not a summary, it is a disguise.** Counting is the cheap part;
the work is making sure the count answers a question someone will actually
have at 3am.

### A real bug found by reading that code

```ts
return { checked: announced, announced, stoppedOnBudget: true };
```

`checked` set to `announced` on the budget-exhausted path -- so running out
of budget reported *zero fixtures examined* whenever nothing had been
confirmed yet, understating the work done and hiding that fixtures had been
looked at at all. Never fired here, would have been baffling when it did.

### Restoring the retrain, properly this time

The other half of the report: even once the lineup lands, the scorer odds
don't change, because `app.train` was removed from this workflow during the
2026-08-20 Actions billing incident. Capturing a lineup and acting on it
became two things and only the first was automated.

The reverted version ran `app.train` unconditionally, hourly: three model
fits plus ~77,000 unbatched `player_goal_predictions` upserts, about twenty
minutes, twenty-four times a day. That comment ended by naming what a safe
version would need -- "only recomputing predictions for fixtures whose
confirmed lineup actually changed." That now exists:

1. The retrain step is **conditional** on the check having confirmed
   something (the script writes `announced=N` to `GITHUB_OUTPUT`). Most
   hours confirm nothing and cost one DB query, exactly as before.
2. When it does run, `app.apply_lineups` reuses `train.predict_for_competition`
   with `only_with_confirmed_lineups=True` -- a handful of fixtures, not the
   ~900 whose predictions a lineup cannot possibly have changed.

Worth being explicit about the reasoning, because there was a tempting
wrong version available: the repo is public now, so Actions minutes are
free, and "just put it back" would have worked. It would also have been
wrong. Twenty minutes of pointless hourly work was wrong when it was
billed and is still wrong when it is not -- the bill was the symptom. This
went back only once it was *fixed*, not once it became affordable.

`apply_lineups` deliberately calls `train`'s own loop rather than a fast
copy. A separate implementation would be free to drift, and then the hourly
job and the daily one would quietly disagree about the same fixture, which
is a much worse failure than being slow.

## 2026-08-21 -- Two columns, both about a distinction the data couldn't make

### `fixture_lineups.pre_match_captured_at`

Prompted by a question I had answered too confidently. Asked whether the
lineup we store is the pre-game one, I said yes -- correctly, as far as it
went. Both writers call API-Football's `/fixtures/lineups`, which returns
the announced XI plus bench and does *not* morph into "who actually played"
(minutes come from a separate endpoint). So the content is pre-game either
way.

What I missed on the first pass is that **content being identical is not
the same as the information being available**. Two jobs write this table:

| job | fixtures | timing |
|---|---|---|
| `seedTodaysLineups` | `status != 'finished'`, ±3h of kickoff | pre-match |
| `backfillLineupsForCompetitionSeason` | `status = 'finished'` | post-match |

Nothing recorded which one wrote a row. That matters twice over. The
availability adjustment and starter-vs-bench scorer odds are only worth
anything if the lineup arrived before kickoff. And -- the one that actually
stings -- `app.evaluate_scorers`' "confirmed lineup (matchday)" mode runs on
**finished** fixtures, whose rows came from the post-match backfill. Written
that same day, it silently assumed we would have had every one of those
lineups in time.

**That is an optimism bias aimed exactly at the fixtures where pre-match
capture fails**, which is the worst place for one, and it looked completely
correct in code. It joins the list of measurement bugs this project keeps
producing: none of them were visible from reading, all of them flattered the
result.

Not corrected for, because there is nothing to correct with -- every
historical row predates the column. The backtest now *reports* pre-match
coverage instead, so a run at 0% is legible as a ceiling on the matchday
mode rather than a measurement of it.

Small thing worth stating: the upsert is `COALESCE(existing, incoming)`, the
opposite order from a normal merge. Once a lineup has been captured
pre-match that is permanent, and the post-match backfill re-upserting the
same rows must not overwrite it with NULL. Verified against a real Postgres
by running both upserts in sequence rather than by reading the SQL.

### `bet_legs.line`, and where "free text avoids migrations" runs out

`bet_legs.market`/`selection` are deliberately free text so a new bet type
never needs a migration. That was a good decision and it still is -- for
markets whose selection is a single label (`home`, a player id).

A spread breaks the pattern in a way worth naming: the **same** market and
the **same** selection settle differently depending on a number. `home` at
-2.5 and `home` at -0.5 are different bets. The tempting move is to keep the
schema untouched and encode it as `home -2.5`, which works right up until
the settlement SQL has to parse it -- and there a formatting slip is a
**mis-graded bet**, not a validation error. `fixture_odds` had already
reached this conclusion and has the identical column.

The general shape: free-text extensibility holds while the new thing is
another *value* of an existing dimension, and breaks when it adds a
dimension.

Spreads also introduced the first market here that can genuinely **push**.
A whole line (Arsenal -2, winning by exactly 2) ties, settles `void`, and
the existing result derivation already excludes voids from the parlay
product -- so the machinery was there, unexercised. Half lines cannot tie,
which is the whole reason books quote them. Quarter lines are refused
rather than rounded: settling one means grading a leg half-won, which
`won`/`lost`/`void` cannot express, and silently rounding would settle a
bet the user didn't place.

Graded by extracting the real settlement SQL from the source and running it
against real rows on a throwaway Postgres -- all four legs on Arsenal 3-0
Coventry, including both push directions and a match_winner regression
check. Reading that CASE expression and believing it would have been the
same mistake this log keeps recording.

### The spread's model probability is reconstructed, and says so

`model_predictions` stores three match-winner probabilities and two lambdas
-- not the scoreline grid a spread needs. So the cover probability is
rebuilt from two independent Poissons, which omits the Dixon-Coles low-score
correction (see `docs/models.md` §2).

Checked against the live Arsenal-Coventry numbers (1.76-0.89): reconstructed
57.93% vs 58.18% stored for the home win, 18.77% vs 19.08% away. Under a
percentage point, and much of even that is the 2dp rounding on the displayed
lambdas rather than the missing tau. Good enough to be indicative, labelled
as such in the code, and exactly fixable by storing rho alongside the
prediction if it ever matters.

Nice confirmation the maths is right: -1 and -1.5 return the identical cover
probability (both need a 2+ win). The difference between them isn't the
chance of covering, it's that -1 can push and refund.

## 2026-08-22 -- Hull City to beat Manchester United

Opening weekend, and the model picked a just-promoted club to beat one of
the biggest sides in the country. Nolan asked whether we need better data
or better maths. The honest answer is neither: **the maths was fine and the
data was fine, but a correct component was being used outside its design
envelope.** Third bug on the promoted-team path, and the most instructive.

The chain: Hull have zero finished Premier League matches, so the PL fit
has no parameters for them, so the fallback (added 2026-08-21 to stop
promoted-team fixtures vanishing entirely) predicted the fixture with the
joint fit. Each link defensible. But the joint fit is tuned FOR THE FA CUP:

- **kappa = 10 shrinkage** flattens every team toward average -- which
  costs Manchester United far more than Hull, because United are the ones
  far from average. Shrinkage takes most from those who have most.
- **home advantage ~1.5** (vs the PL fit's own 1.184), inflated by cup
  ties, then decides the flattened fixture for whoever is at home.

So every one of the ~74 fallback fixtures this season quietly favoured the
home side; Hull-United was merely the one absurd enough to notice. A
synthetic reconstruction flipped exactly as predicted: whole-fixture joint
fallback 41.3% home / 38.0% away, imputation 32.2% / 45.1%.

The fix (`DixonColesModel.impute_team_from`): borrow ONLY the missing
team's rating, translated onto the competition's own scale, and let that
competition's fit -- the opponent's real rating, its own home advantage
and rho -- predict the fixture. The translation is the identifiability
ridge move again (docs/models.md section 3): each fit centres "1.0 =
average of my own training set", and the joint fit's average is ~800
mostly non-league clubs, so raw numbers mean nothing across fits until
shifted. Third time that ridge has been the crux of a real change, which
is a strong argument for having written it down properly the first time.

Pinned by a regression test encoding the exact scenario (giant away to a
promoted side: imputation must recover the giant as favourite, verified to
fail under the old fallback) and a ridge-invariance test (sliding the
prior's arbitrary centring must not change what gets imputed).
app.evaluate_scorers' fallback now mirrors production exactly, for the
same reason the backtest exists at all.

Two honest residuals. The imputed rating inherits the joint fit's kappa=10
compression, so promoted sides will run somewhat optimistic until they
accumulate real matches -- measurable via app.compare once they have some.
And the deeper lesson generalises: **a model tuned for one job was silently
load-bearing for another.** The FA Cup shrinkage sweep never evaluated
"how well does this joint fit backstop a Premier League fixture", because
that role didn't exist when the sweep ran. When a component grows a second
consumer, its tuning is unvalidated for the new one by default.

## 2026-08-22 -- Three improvements, one theme: stop needing a human to notice

The Hull incident's postmortem listed three improvements. All three built
in one pass, and they share a root: every serious model bug so far was
caught by a person looking at a screen, and every measurement that
mattered was starved for held-out data. These attack both.

### 1. The market divergence tripwire

New workflow "Market divergence check", daily after the refresh. Seeds
fresh pre-match 1X2 odds from API-Football for fixtures in the next 4 days
(fixture_odds previously held ONLY historical football-data.co.uk CSVs --
odds for matches already played, useless for catching a bad live
prediction), de-vigs them (divide each implied probability by their sum,
removing the bookmaker's margin), averages across bookmakers, and compares
against the model. More than 15 points of disagreement on any outcome ->
the process exits nonzero.

**The failing exit code is the entire alerting mechanism.** The run goes
red, GitHub sends its standard failed-workflow email, no new
infrastructure. A red run of this workflow is it WORKING -- the log names
the fixture and both probability vectors. Corollary worth writing down: do
not "fix" a red run of this workflow by re-running it.

Two design points that matter more than they look:
- The threshold is deliberately loose (15 points). This is a tripwire for
  pipeline bugs, not a value-betting signal -- the bugs it exists for
  diverged by 25+ points, a real edge is a few. If it fires constantly,
  raise the threshold rather than learning to ignore it; an ignored alarm
  is worse than none.
- A run that skipped more fixtures than it compared says so explicitly
  ("mostly blind"). A divergence check that quietly checks nothing reads
  as a green light, which is worse than no check.

### 2. The promotion penalty, with its estimator

The Hull fix's honest residual: an imputed rating inherits the joint fit's
kappa=10 compression, plus promoted clubs historically underperform their
old-division form. Both fold into one multiplicative factor, and
critically the factor is MEASURABLE from data we already have: for every
club that changed divisions in our three seasons, reconstruct the rating
production would have imputed on day one (fit joint + competition models
on only the matches before that season), and compare with the rating
their actual season earned. The gap, averaged in log-strength space, is
the bias; s = exp(gap/2) because the penalty moves attack AND defense.

One subtlety worth remembering: the penalty is deliberately the OPPOSITE
shape from the identifiability ridge. attack*s with defense/s moves both
against the invariant direction, so it genuinely weakens the team -- and
there's a test asserting predictions actually change, because a penalty
accidentally implemented as a ridge move would be a knob connected to
nothing.

Ships as PROMOTION_PENALTY = 1.0 (no-op) with a manual workflow to run
the estimator -- sandbox-then-promote, same as every constant before it.
The estimator refuses to suggest a value from fewer than 3 club-seasons
and prints its own caveats next to its answer.

### 3. Walk-forward evaluation in app.compare

The structural fix for the noise floor. One 80/20 split gave ~350-500
held-out matches and a ~0.003 Brier floor that the shot-location decision
had to be made underneath. app.compare now walks forward: the last ~40%
of matches in four consecutive windows, each predicted by a model fitted
only on earlier data, per-match paired differences pooled across windows.
Causal in every window, disjoint so the bootstrap never double-counts,
roughly double the sample, intervals ~1/sqrt(2) tighter.

The fold boundaries are DATES, not row indices -- two fixtures on the
same afternoon must never end up one in training and one in test, which
an index split silently allows.

Its configured question is now the re-test this upgrade exists for: the
Premier League shot-location 0.75 was promoted with its interval touching
zero. Baseline = deployed config, candidate 0.0 = "revert the
promotion", 0.5/1.0 bracket it. The temporary sweep workflow became the
permanent "Paired model comparison" workflow, since the tool is now the
standing way changes get decided.

### What did NOT get built

No new external data source. The last four bugs were all in plumbing and
measurement, not in missing signal -- better instrumentation of what we
have beat new inputs every time so far. That priority gets revisited once
the market check has run quietly for a while.

## 2026-08-22 -- The bug my tests were structurally unable to catch

`app.estimate_promotion_penalty` failed on its first production run:

```
psycopg.errors.UndefinedTable: missing FROM-clause entry for table "home_stats"
```

I had copied `load_finished_matches`' SELECT list into a new loader and
not its two `LEFT JOIN`s. It passed review, passed CI, and passed a
nine-test suite that included an end-to-end run of `main()` -- because
that test monkeypatches the loader, so **the query executed nowhere except
production.**

This is the third instance of one pattern, and the pattern is now the
lesson rather than any individual bug:

| bug | what "tested" it | why that proved nothing |
|---|---|---|
| `app.compare` NameError | `import app.compare` | names inside function bodies never evaluate on import |
| matchday log ambiguity | reading the code | the query excluded the rows the message was about |
| this one | end-to-end test of `main()` | the loader was monkeypatched away |

**Faking a dependency tests everything except the dependency.** Each time,
the mock sat exactly where the bug was.

### The fix, and the fix for the class

The loader now *reuses* `load_finished_matches` and merges season labels
from a trivial second query, rather than reimplementing a query with one
extra column. Duplicated SQL that can drift is the hazard; deleting the
duplicate removes it by construction rather than by vigilance.

The class fix is a new CI job. Every job was deliberately database-free --
correct for logic, fast, laptop-runnable -- but **nothing database-free
can ever check that SQL matches the schema.** The `database` job now
starts a real Postgres, applies the actual migrations, round-trips the
newest one down and up, and executes every read query against it via
`tests/test_queries_against_schema.py`. The tables stay empty on purpose:
an empty result still proves the SQL parses, the tables and columns exist,
and the joins resolve, which is the entire bug class.

It earned its place within a minute of existing, by finding a second live
bug I had shipped two days earlier:

```
psycopg.errors.IndeterminateDatatype: could not determine data type of parameter $1
```

`app.diagnose_lineups` used `%(team)s IS NULL` for its optional filter.
With a NULL parameter and no cast Postgres cannot infer the type -- so the
diagnostic crashed on *any unfiltered run*, which is the workflow's
default. I had "verified" that module with tests that monkeypatch
`_query_df`. Same mock, same blind spot, same day.

The rule worth keeping: **when a test replaces the thing that talks to the
outside world, it has stopped testing the part most likely to be wrong.**
At least one test per integration point has to touch the real thing.

## 2026-08-22 -- Walk-forward's first verdict: revert my own promotion

The tool built this morning immediately overturned a decision made
yesterday, which is the best possible thing it could have done.

**Premier League shot location, single 80/20 split (2026-08-21):**
0.75 better than 0 by 0.00693, CI [-0.01384, +0.00001]. Promoted.

**Same comparison, walk-forward (2026-08-22):**
0.75 better than 0 by 0.00129, CI [-0.00359, +0.00606]. Noise.

The effect shrank **5.4x**. Reverted to 0; the whole
SHOT_LOCATION_BLEND_WEIGHT dict is now zero.

### The machinery validated itself

CI width went 0.01385 -> 0.00965, a ratio of **0.697** against the
theoretical 1/sqrt(2) = 0.707 that doubling the held-out sample predicts.
So the intervals tightened exactly as designed and the effect still
evaporated -- it was never there, rather than the test being weaker.

The two `unchanged (control)` rows are the other half of that
confirmation: Championship and FA Cup deploy at 0, so candidate 0 must be
byte-identical to baseline, and it reported exactly +0.00000 with a
zero-width interval. The null self-check built after the calibration
confound still holds.

### What I got wrong, precisely

Not the arithmetic -- the argument. I justified promoting on: "the
deployment question is not 'is it significant' but 'which value has the
better expected loss', and ~97.5% of the bootstrap mass sits below zero."

That reasoning is *correct in general* and was *misapplied here*. The
symmetric-loss framing is right when the estimate is unbiased and you must
choose today. It says nothing about whether the estimate is stable, and a
single-split estimate at the edge of the noise floor is exactly the case
where it is not. I even wrote down the evidence of instability -- the
non-monotone 0.25 point -- and then reasoned past it.

**Generalised: an effect that needs a symmetric-loss argument to justify
shipping is an effect that has not been measured yet.** If the interval
comfortably excluded zero you would not need the argument. Reaching for it
is the signal to get more data, not to ship.

Second-order lesson: the tie-break. With 0.0, 0.5 and 0.75 mutually
indistinguishable, expected loss alone cannot choose. Parsimony can --
0 removes an operational dependency on shot-location columns staying
backfilled, for a benefit an order of magnitude below anything else this
model has adopted. Fewer moving parts is a real criterion when the
measurements are tied, not an aesthetic one.

### A near-miss in the edit itself

Reverting the constant, an index-based string edit anchored on the wrong
occurrence (the module docstring mentions the constant by name) and left
**two** definitions of SHOT_LOCATION_BLEND_WEIGHT in app.evaluate.py --
the second, stale one silently winning. Production would have been 0 while
the backtest sandbox still ran 0.75, so every future comparison would have
been measured against a configuration nobody was running.

Caught in seconds by `test_the_two_weight_dicts_are_in_sync`, written a
day earlier for exactly this: the two files duplicate constants
deliberately, and "deliberate" and "unverified" are different things. That
test justified itself the first time the duplication was touched.

## 2026-08-22 -- "Do we need the other direction too?" -- a better question than it looked

Nolan asked whether the promotion penalty needs a relegation counterpart.
The answer is that we were *already* measuring both, mixed together, and
that mixing is what made one of the two numbers meaningless.

### What the estimator said

```
Premier League:  0.725   6 club-seasons, gap mean -0.643, ALL SIX negative
Championship:    1.025  12 club-seasons, gap mean +0.050  -> "no bias"
```

The Premier League number is strong: every promoted club underperformed
its translated rating, several enormously (Southampton imputed 1.145,
realized 0.395). Promoted at 0.725.

The Championship's 1.025 is the trap. A club entering the Championship
arrives by one of **two opposite routes**, and the estimator was averaging
them:

| intake route | penalty | n | t | example |
|---|---|---|---|---|
| relegated from the Premier League | 1.146 | 6 | +1.2 | Burnley +1.067 |
| arrived from League One | 0.918 | 6 | -2.2 | Charlton -0.478 |

Relegated clubs come out **stronger** than the translation says. Clubs
arriving from League One come out **weaker** -- and that makes sense the
moment you look at what the imputation had to work with: this database
tracks the Premier League, the Championship and the FA Cup, so a League One
club's only appearances are a handful of cup ties. A relegated club brings
38 top-flight matches; a League One club brings almost nothing. Those are
not the same estimation problem and should never have shared a number.

Pooled, +0.272 and -0.171 average to +0.050. **"No measurable bias" was an
artifact of the grouping, not a fact about the world.**

The Premier League avoided this entirely for a structural reason worth
stating: **there is exactly one way into the Premier League.** Its
population is homogeneous by construction, which is why its signal is
clean and the Championship's was not.

### The generalisable version

Grouping by *destination* felt natural because that is how the constant is
keyed -- `PROMOTION_PENALTY[competition]` -- and the analysis silently
inherited the shape of the data structure it was going to feed. The right
grouping was by *origin*, which the code had no slot for.

**When an aggregate comes back at exactly "no effect", check whether the
group is actually one population before believing it.** A null is a claim
about a homogeneous group; on a mixed one it means nothing at all. And be
suspicious when the grouping matches the shape of an existing config key
rather than the shape of the phenomenon.

### What shipped, and what deliberately did not

Shipped: Premier League 0.725, and the estimator now reports per-origin
with standard errors and sign consistency alongside the pooled number,
plus an explicit warning whenever a competition has more than one intake
route.

Did NOT ship: an origin-keyed penalty. The two Championship sub-effects
are t +1.2 and t -2.2 -- neither convincing, pointing opposite ways. After
this week's lesson about promoting on a symmetric-loss argument at the
edge of the noise floor, building `(competition, origin)` plumbing to act
on that would be repeating the exact mistake. The measurement machinery is
in place; the values can follow when they earn it.

Effect on the fixture that started all this, Hull at home to Manchester
United: 41.3% Hull under the original whole-fixture fallback, 32.2% after
yesterday's imputation fix, **13.1% now** with United at 70.4%.

## 2026-08-22 -- The goal-scorer model's first score, and why the fix was wrong too

68,591 held-out player-fixtures. Three findings, in order of how much they
changed my mind.

### 1. The ranking is good. The numbers are not.

AUC **0.78** days ahead, 0.76 on matchday, against 0.50 for a constant.
The per-player machinery genuinely picks the right players.

And yet **log loss is WORSE than the base rate everywhere** (0.137 vs
0.112 pooled). That combination is only possible one way: the ordering is
right and the probabilities attached to it are wrong. Splitting
discrimination from calibration was the design decision that made this
legible -- a single Brier number would have shown "slightly better than
base rate" and hidden both halves.

### 2. Neither configuration was calibrated -- including my fix

| mode | days ahead | confirmed squad |
|---|---|---|
| `none` (shipped) | 0.736 | 0.399 |
| `allocated` (the "fix") | 1.391 | 1.268 |

**Flipping the flag would have made the Predictions page worse.** Days
ahead -- the path almost every displayed number comes from -- `none` is
0.264 off calibration and `allocated` is 0.391 off. I built that fix
yesterday, documented it as correcting a real leak, and it does correct the
leak; it just lands further from the truth. Had I shipped it on the
arithmetic alone, every scorer probability in the app would have moved 30%
in the wrong direction and looked more principled while doing it.

That is the entire argument for measuring before shipping, in one number.

### 3. The over-call names the missing quantity

`allocated` forces 100% of a team's expected goals onto its reliable
players -- asserting nobody else ever scores. Invert the over-call and you
get the coverage that assumption is wrong by, and it is strikingly stable:

    Premier League  0.738 days ahead   0.792 confirmed squad
    Championship    0.731              0.796
    FA Cup          0.525              0.704

Reliable players account for ~73% of goals days ahead, ~79% once a squad
is known (a confirmed squad captures more of the real scorers). FA Cup is
lower, as expected -- non-league entrants have no reliable players at all.

So the correct divisor is not "the players being allocated" but "every
player, including the fringe ones the reliability filter drops". That is
mode `expected`, and it needs no tuned constant: the coverage falls out of
data the model already has.

### 4. `none` gets WORSE when a lineup lands (0.736 -> 0.399)

Backwards, and worth calling out as its own defect. Learning who is
actually playing should sharpen a prediction, not halve it. Two causes
compound: unnamed players' share is dropped without redistribution, and
bench players get their (small) bench-specific minutes. Both are artifacts
of not normalising, so `expected` should fix this too -- its divisor is
fixed, so a squad that excludes fringe players genuinely receives a larger
share rather than being renormalised back to everything.

### The units bug, in passing

First implementation of the `expected` divisor summed
`goals_per_90 * minutes_share` while the weights it divides are
`goal_share * minutes_share` -- a rate versus a normalised share. Off by
the team's total scoring rate, under-allocating ~4x. Caught immediately by
a unit test asserting `expected` sits between `none` and `allocated`, which
is a property worth asserting precisely because it pins the units without
pinning a magic number.
