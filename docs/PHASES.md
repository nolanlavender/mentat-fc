# Build phases

Whole-league data scope from the start (all 20 PL teams), but features built
and tested against a small slice first (e.g. one gameweek) before
generalizing to a full season.

After every phase: append a summary to `/docs/learning-log.md` — what we
built, what concept(s) it taught, key design decisions. This is required,
not optional.

## Phase 0 — Environment & planning
- [x] Repo scaffold: `/frontend`, `/backend`, `/model-service`, `/docs`
- [x] Docker Compose for local Postgres (Postgres runtime: Colima, pending
      your Homebrew install — see learning-log.md)
- [x] Python virtual environment set up for `/model-service` (pyenv-pinned
      Python 3.12.13)
- [x] Confirm API-Football / Football-Data.org tier and rate limits
- [x] Confirm The Odds API tier and rate limits
- [x] Confirm Groq free tier limits (requests/min, tokens/min) for Llama 3.3 70B
- [x] Confirm the official FPL API's structure (no key needed, but map out
      the endpoints we'll actually use)
- [x] Pull and inspect a sample of football-data.co.uk historical CSVs —
      confirm what columns/seasons are available
- [x] `.env.example` for frontend, backend, and model-service
- [x] `CLAUDE.md`, `PHASES.md`, this checklist, and `/docs/architecture.md`
      in place (done)
- [x] Create `/docs/learning-log.md` (empty, ready for Phase 0 entry)

## Phase 1 — Data layer & schema
- [x] Design schema: leagues, teams, players, fixtures, lineups (scope grew
      to Premier League + Championship + FA Cup, 3 seasons, full depth --
      see learning-log)
- [x] Design schema: FPL data (player prices, ownership, gameweek points)
- [x] Design schema: my logged bets (pick, odds, stake, result, timestamp)
      -- design sketch only, in erd.md notes; no migration yet, deferred to
      Phase 6 per its actual sequencing
- [x] Design schema: model predictions (per fixture, per gameweek)
- [x] Write `/docs/erd.md` (mermaid ERD)
- [x] Migrations set up (e.g. node-pg-migrate or Prisma migrate) --
      node-pg-migrate, plain `.sql` migrations
- [x] Seed script pulling real data for all 20 PL teams -- built and
      verified end-to-end for the 2023/24 season (380 real fixtures, odds,
      stats, FPL players/gameweeks). Remaining seasons, Championship, FA
      Cup, and the lineup backfill need to run on a machine with real
      internet access and a real `API_FOOTBALL_KEY` -- not available in the
      cloud session this was built in. See learning-log for the exact
      commands to run.
- [x] Explain: why this schema shape, what a migration is and why we don't
      just edit the DB by hand

## Phase 2 — Backend API core
- [x] Express + TypeScript project structure (routes/controllers/services)
- [x] Read-only endpoints for teams, fixtures, players -- not full CRUD, see
      learning-log for why
- [x] Team dashboard endpoint (next match, table position, squad)
- [x] Explain: REST resource design, error handling conventions, why we
      structure routes/controllers/services the way we do
- [ ] Recurring refresh job to keep current-season data current (new
      fixtures/results, FPL prices/ownership) -- designed in Phase 1, see
      `docs/architecture.md`'s "Keeping data current" section; build it once
      there's an actual API/frontend consuming the data, not before. Phase 5
      added a manual path in the meantime (`seedCurrentSeasonFixtureLists`
      in `backend/seed/index.ts`, runs as part of `npm run db:seed`) so
      `app.train` has real upcoming fixtures to predict -- this item is
      about turning that into an actual schedule, not a from-scratch build

## Phase 3 — Frontend shell
- [x] React + TypeScript app scaffold (routes/pages/components split, added
      react-router-dom)
- [x] Team dashboard page (table position, next match + prediction if one
      exists, squad)
- [x] Team switcher (all 20 Premier League teams)
- [x] Explain: component structure, where state lives, client vs server state

## Phase 4 — FPL fantasy integration
- [x] Pull and normalize official FPL API data (players, prices, ownership,
      live gameweek points) -- per-gameweek player stats backfill built
      (`seedFplPlayerGameweekHistory`), untestable in this cloud session
      (network blocked, see learning-log); needs to run on a real machine
- [x] Endpoints + UI to view my squad and gameweek scoring against real FPL
      rules -- `GET /api/fpl/my-team`, live per-request (not batch-seeded,
      see architecture.md), + a frontend page. Deliberately surfaces FPL's
      own computed points rather than reimplementing scoring rules
      ourselves. Untested against a real entry -- needs a real FPL_ENTRY_ID
      and a machine with network access
- [x] Explain: consuming a third-party API we don't control (no key, but
      also no SLA/support) and what that means for error handling
- [ ] **Not done yet, pick up next session:** set up a free Neon Postgres
      project and point `backend/.env`'s `DATABASE_URL` at it (local Docker/
      Colima unavailable on the current dev machine -- unsupported macOS
      version blocks the Homebrew build). Then `npm run migrate:up` and
      `npm run db:seed` (not `db:restore` -- no local `pg_dump`/`pg_restore`
      needed that way). See `docs/seeding-runbook.md`'s "No Docker
      available?" section. This also becomes the actual first full
      historical seed run, PL + Championship, 2024/25 and 2025/26 included.

## Phase 5 — Prediction model service (match outcome)
- [x] Stand up `/model-service` as a Python FastAPI project (scaffolded
      Phase 0; the FastAPI app itself stays a health-check stub -- the real
      Phase 5 work is a batch script, not a live endpoint, per the
      batch-vs-real-time decision below)
- [x] Load and clean historical data from football-data.co.uk -- reads it
      from Postgres (`model-service/app/data.py`), not raw CSVs directly;
      "cleaning" already happened at seed time in Phase 1
- [x] Pick and justify an approach: Dixon-Coles, chosen over XGBoost for
      producing expected-goals output natively, fitting the data volume,
      and being interpretable -- see `docs/learning-log.md`'s Phase 5 entry
      for the full reasoning
- [x] Train a first model on match outcome (`model-service/app/dixon_coles.py`)
      -- fit and verified against real 2023/24 Premier League data: Man
      City highest attack strength, Arsenal best defense, both matching
      the real table that season
- [x] Batch job: model writes predictions to Postgres (`app/train.py`,
      `python -m app.train`) -- tested end-to-end (idempotent upsert
      confirmed) against real data; run on a schedule once deployed
      (Phase 10, GitHub Actions), not built yet
- [x] Explain: batch inference vs. real-time serving, and why we chose
      batch here -- documented in `docs/architecture.md` since Phase 1
- [x] Basic model evaluation (`app/evaluate.py`): backtest vs. a held-out
      portion of real matches, and vs. a closing-odds market baseline.
      Real, honest result on the one season available to test with: the
      model currently loses to the market (Brier 0.5416 vs. 0.4904) --
      expected, not a bug, see the learning-log entry for why that's the
      correct outcome to expect from a first pass
- [ ] **New, not in the original plan:** FA Cup predictions need Premier
      League and Championship team strengths reconciled onto one shared
      scale (two independent per-competition fits don't give you that) --
      deliberately deferred, real follow-on modeling work

## Phase 6 — Betting tracker
- [ ] Endpoints + UI to log a bet: pick, odds, stake, fixture, result
- [ ] ROI / record tracking over time
- [ ] Surface model prediction next to my logged bet and the market odds —
      where do they disagree?
- [ ] Explain: what "value" means when comparing model probability to
      market odds

## Phase 7 — Goal scorer prediction
- [ ] Extend the model service to predict likely goal scorers
- [ ] Explain: why this is harder than match outcome (minutes/rotation
      variance) and how we're accounting for it
- [ ] Surface in the app alongside match predictions

## Phase 8 — Explainer, storylines, odds display
- [ ] AI explainer feature: backend endpoint calling Groq API
- [ ] Prompt design for position/formation explanations
- [ ] Response caching for repeated queries (cost control)
- [ ] Storyline aggregation (RSS or news API) with caching
- [ ] Explain: caching strategy/TTL choices, handling a flaky external API,
      streaming vs. non-streaming LLM responses

## Phase 9 — Auth, testing, polish
- [ ] Auth (JWT), login/register flow
- [ ] Unit tests on model evaluation / aggregation / business logic
- [ ] One E2E test (Playwright): log in → view dashboard → log a bet → see
      it tracked
- [ ] UI polish pass against a real design system, not defaults
- [ ] Explain: what's worth testing vs not, test pyramid basics

## Phase 10 — Deployment & scaling plan
- [ ] Vercel or Cloudflare Pages (frontend) + Render (Node backend) + Neon
      (serverless Postgres) -- switched from the original Azure plan for
      cost: Azure's cheapest always-on tiers run ~$25-40/mo before any real
      traffic, versus this stack scaling down to near-$0 between visits.
      See `docs/architecture.md`'s "Deployment target" section for the
      full reasoning.
- [ ] GitHub Actions CI/CD pipeline for frontend + backend
- [ ] GitHub Actions scheduled workflow for the model service (batch
      inference, no hosted compute needed -- see architecture.md)
- [ ] Document the next scaling step for each component
- [ ] Load-check against the 50-concurrent-user target

## Phase 11 (stretch) — Lineup optimizer
- [ ] Predict expected fantasy points per player, per gameweek
- [ ] Constrained optimization (linear/integer programming) for optimal
      squad under FPL budget and position constraints
- [ ] Explain: how this differs from the prediction problems so far, and
      what an LP solver is actually doing
