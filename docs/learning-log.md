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
