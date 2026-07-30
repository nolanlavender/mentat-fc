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
