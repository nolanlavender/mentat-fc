# Deploying Mentat FC

See `docs/architecture.md`'s "Deployment target" section for the *why*
behind this stack (Vercel/Cloudflare Pages + Render + Neon over the
original Azure plan). This doc is the *how* -- a concrete runbook for
going from "everything works locally" to "live on the internet."

Everything in this doc that touches a third-party account, a dashboard
click, or a real secret value is a manual step. Nothing in this repo can
create a Render/Vercel account or type a production database URL into a
form on your behalf -- that's deliberate, not a gap: those are exactly the
kind of real-money, real-credential actions that should go through your
own hands, not an agent's.

## 0. Database -- Neon (already done)

You've been developing against a real Neon Postgres project throughout
this build (`backend/.env`'s `DATABASE_URL`), so there's no separate
"set up production Postgres" step -- the same project **is** production.
If you'd rather keep a hard split between a dev branch and a prod branch,
Neon supports branching a database the same way git branches code; not
required, just an option if you want it later.

## 1. Backend -- Render

1. Push this repo to GitHub if it isn't already (Render deploys from a
   GitHub connection).
2. In the Render dashboard: **New +** → **Blueprint**, point it at this
   repo. Render reads `render.yaml` at the repo root and proposes one web
   service (`mentat-fc-backend`, rooted at `backend/`, free tier).
3. When prompted for env vars, provide:
   - `DATABASE_URL` -- the same Neon connection string from your local
     `backend/.env`.
   - `JWT_SECRET` -- generate a new one for production, don't reuse your
     local dev value (e.g. `openssl rand -base64 32`).
   - `API_FOOTBALL_KEY` -- your real key.
4. Deploy. `startCommand` in `render.yaml` runs `npm run migrate:up`
   before `npm start` on every deploy -- safe to leave that way
   permanently, since already-applied migrations are a no-op.
5. Once live, note the service's `.onrender.com` URL -- the frontend needs
   it next.
6. Optional: add `FPL_ENTRY_ID` afterward (Environment tab) if you want
   `/api/fpl/my-team` to work in production. Left out of the blueprint's
   required prompts since the app runs fine without it.
7. Free tier spins down after ~15 minutes idle, adding cold-start latency
   to the next request -- expected, not a bug. Bump to the $7/mo starter
   tier later if that latency ever actually bothers you (see
   architecture.md's scaling table).

## 2. Frontend -- Vercel

1. In the Vercel dashboard: **Add New** → **Project**, import this repo.
2. Framework Preset: **Vite** (should auto-detect). Set **Root Directory**
   to `frontend` -- this is the one setting that actually matters for a
   monorepo like this; without it Vercel tries to build from the repo
   root and fails.
3. Add one environment variable: `VITE_API_BASE_URL` = the Render backend
   URL from step 1 (e.g. `https://mentat-fc-backend.onrender.com`).
4. Deploy. `frontend/vercel.json`'s rewrite rule (`/(.*)` → `/index.html`)
   is already in the repo -- without it, refreshing or deep-linking to a
   client-routed page like `/teams/5` would 404 on a static host, since
   there's no `/teams/5` file to serve; React Router only takes over once
   `index.html` has loaded.
5. Prefer Cloudflare Pages instead? Same two settings apply (root
   directory, one env var) -- swap in a `_redirects` file
   (`/*    /index.html   200`) in place of `vercel.json` for the same SPA
   fallback behavior.

## 3. GitHub Actions secrets

`.github/workflows/daily-refresh.yml` needs three repo secrets (**Settings**
→ **Secrets and variables** → **Actions** → **New repository secret**):

- `DATABASE_URL` -- same Neon connection string as the backend's.
- `API_FOOTBALL_KEY` -- same key as the backend's.
- `JWT_SECRET` -- any non-empty string; not actually used by the seed/
  train scripts, just required at import time (see
  `backend/src/config/env.ts`, and the same gotcha documented in the
  unit-test learning-log entry).

`.github/workflows/ci.yml` needs no secrets at all -- the test suites
deliberately never touch a real database (see `backend/vitest.setup.ts`
and `model-service/tests/conftest.py`).

## 4. Verifying it's actually live

Don't take a green Render/Vercel dashboard as proof -- confirm for real:

1. `curl https://<your-render-url>/health` -- expect
   `{"status":"ok","db":"connected"}`.
2. Load the Vercel URL in a browser, confirm the team list renders real
   data (proves the frontend can actually reach the backend, i.e. CORS
   and `VITE_API_BASE_URL` are both right).
3. Refresh on a deep-linked page (e.g. `/teams/5`) -- confirms the SPA
   rewrite works, not just the initial load.
4. Manually trigger `.github/workflows/daily-refresh.yml` once (Actions
   tab → the workflow → **Run workflow**) rather than waiting a full day
   for the first scheduled run, and check it completes green.

## 5. Load-checking against the 50-concurrent-user target

Once the backend has a real public URL, this is genuinely checkable, not
just a documented assumption -- ask to have this run against your live
URL once steps 1-4 are done.
