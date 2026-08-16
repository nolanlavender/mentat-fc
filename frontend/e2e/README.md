# End-to-end tests

One Playwright test (`bets-flow.spec.ts`, Phase 9): register → view a team
dashboard → log a bet → see it tracked, driving the real app through a real
browser against the real backend and database. Everything else in this
project is covered by unit tests (pure logic, see `backend/src/services/
bets.service.test.ts` and `model-service/tests/`) or by manual real-browser
verification per change -- this is the one flow worth an actual E2E test,
since it's the one thing no unit test can answer: does registering,
navigating, and submitting a form actually work together, through the real
stack.

## Prerequisites

This does **not** spin up Postgres or the backend for you -- only the
frontend dev server (via Playwright's `webServer` config). Before running:

1. Postgres running and migrated (`docker compose up -d` in the repo root,
   then `npm run migrate:up` in `backend/`).
2. The backend dev server running (`npm run dev` in `backend/`).
3. At least one upcoming Premier League fixture seeded -- true of any
   normal local dev setup (`npm run db:seed:current-season` in `backend/`
   pulls the live schedule), no special test fixture needed.

## Running

```
cd frontend
npx playwright test
```

Runs headless against `http://localhost:5173` by default (starts the Vite
dev server itself if one isn't already running). Set `E2E_BASE_URL` to
point at a different frontend instance.
