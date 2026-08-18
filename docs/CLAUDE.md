# Mentat FC — Premier League Fantasy, Betting & Prediction App

Named after the Mentats in Dune — humans trained to perform the
superhuman computation and analysis that machines were forbidden from doing.
That's the spirit of this app: a model doing the analytical heavy lifting
so the person using it can make sharper calls.

## Purpose (read this first, every session)

**This is a learning exercise first, a product second.** I'm an experienced
data engineer (Databricks, Delta Lake, Python, SQL, Azure) but new to:
React/TypeScript, Node/Express backend design, relational schema design for
a live product, auth, caching, background jobs, cloud deployment of a full
app, and — for the prediction model piece — applying ML to a new domain
(sports prediction) rather than data engineering pipelines.

**Documentation and explanation are not optional polish — they are the
point of this project.** Concretely, that means:

- Before implementing any concept I haven't used yet in this repo (JWT auth,
  caching, background jobs, a specific ML approach, constrained optimization,
  etc.), explain it first: what it is, why it's needed here, what the
  alternative would be. Then implement it.
- After finishing each phase (see `PHASES.md`), append an entry to
  `/docs/learning-log.md` summarizing: what we built, what concept(s) it
  taught, and any design decision worth remembering. This is my study
  material for reviewing later — write it for future-me, not just as a
  changelog.
- Prefer clear, conventional code over clever code. Comment non-obvious
  decisions in the code itself, not just in chat.
- If a "quick fix" would create real technical debt, flag it even if I don't
  ask.
- Keep `/docs/architecture.md` and `/docs/erd.md` accurate any time the
  system design or schema changes — these are my reference diagrams.

## What the app actually does

1. **Fantasy** — official FPL rules and scoring, pulling live data from the
   public FPL API (players, prices, ownership, gameweek points). Not a
   custom scoring system — the real thing.
2. **Betting tracker** — I log bets I've placed elsewhere (pick, odds,
   stake, result), including parlays/accumulators (multiple legs, one
   bet). The app tracks ROI and record over time, filterable by season and
   by team. Multi-user (real login, added Phase 6) — no real-money
   wagering happens inside the app, it's a record-keeping tool.
3. **Prediction model** — a model I build and own predicts match outcomes
   (score/result), and eventually goal scorers. Predictions surface in the
   app next to my logged bets, so I can see where the model and the market
   (bookmaker odds) disagree.
4. **Team dashboards, storylines, formation/position explainer** — carried
   over from the earlier scope, still in as secondary features.

## Audience

Still built for an American fan getting into the Premier League, but the
center of gravity has shifted from "help me learn the league" to "give me a
sharper edge on fantasy and betting picks, and let me see my own model's
reasoning."

## Tech stack

- **Frontend:** React + TypeScript
- **Backend:** Node.js + Express + TypeScript — serves the app, reads
  predictions from Postgres (does not run the model itself)
- **Model service:** Python (FastAPI to start) — trains the prediction
  model, writes predictions to Postgres on a schedule. Kept as a separate
  service on purpose: it's a real-world pattern (batch inference vs. a
  request/response API) and keeps ML code out of the Express app.
- **Database:** PostgreSQL (Neon, serverless/autosuspending — once deployed)
- **AI features (explainer only):** Groq API — Llama 3.3 70B to start.
  Kept behind our own service layer so swapping providers later is cheap.
- **Local dev:** Docker Compose for Postgres, `.env` for secrets
- **Hosting (eventual):** Vercel or Cloudflare Pages (frontend) + Render
  (Node backend) + a GitHub Actions scheduled workflow (Python model
  service, batch only — no hosted compute needed) + Neon (PostgreSQL).
  Chosen over the original Azure plan for cost: this stack scales down to
  near-$0 between visits instead of a fixed monthly floor — see
  `docs/architecture.md`'s "Deployment target" for the full reasoning.

## Non-functional targets

- Comfortably support 50 concurrent users
- UI should look and feel like a real, professionally-built product
- Cost-conscious cloud scaling: start cheapest-tier-that-works, document
  the next scaling step at each phase rather than over-provisioning early.
  Budget roughly $10–30/mo for paid data APIs if free tiers are too limited.

## Data sources

- **Fixtures / lineups / standings:** API-Football. Started on the free
  tier (100 requests/day); now on a paid Pro plan (7500/day, confirmed via
  the account's api-sports.io dashboard — see `api-football.ts`'s
  `DAILY_BUDGET`), upgraded once per-fixture player-stats and a matchday
  lineup check made the free tier's budget too tight. Pulled for Premier
  League, Championship, and FA Cup, 3 seasons — see "Data scope vs. app
  scope" below for why it's wider than what the app shows.
- **Fantasy:** Official FPL public API (`fantasy.premierleague.com/api/...`)
  — free, no key required. Premier League only, current season only — that's
  inherent to what FPL is, not a gap.
- **Historical match data for model training:** football-data.co.uk — free
  CSVs, Premier League (E0) and Championship (E1), 3 seasons, including
  historical odds. No FA Cup coverage (league-division CSVs only) — FA Cup
  comes from API-Football instead.
- **Odds (for the betting tracker/model comparison):** The Odds API
- **News / storylines:** TBD — likely RSS aggregation or a news API, with
  caching
- **AI explanations:** Groq API, with caching on common queries

## Data scope vs. app scope

The database holds **Premier League + Championship + FA Cup**, 3 seasons,
full player/lineup depth. What the app actually shows is narrower, but not
PL-only:

- **Team dashboards:** Premier League **and** Championship.
- **Match predictions:** Premier League, Championship, **and FA Cup**, via
  **three Dixon-Coles fits, not one** (revised 2026-08-15 from the original
  single-joint-model design) — Premier League and Championship each get
  their own fit on just their own results, and a third joint fit across
  all three competitions is used *only* for FA Cup predictions, since
  that's the one competition where a Premier League side and a
  Championship (or lower-tier) side actually play each other, making
  cross-league comparability necessary. A pure Premier-League-vs-Premier-
  League or Championship-vs-Championship prediction never needs that
  connection, and the joint fit's ~800 mostly one-off FA Cup entrants
  (non-league clubs API-Football has almost no data for) were measurably
  hurting Premier League/Championship's own predictions by diluting the
  fit with noise that had nothing to do with either league. See
  `docs/learning-log.md`'s Phase 5/7 entries for the original joint-fit
  reasoning and synthetic validation (still the right call for FA Cup),
  and its 2026-08-15 entry for why splitting the rest back out was
  correct, not a regression. The frontend still only ever *displays*
  Premier League and Championship — FA Cup predictions exist in
  `model_predictions` but aren't surfaced as an app feature yet, a
  deliberate scope boundary, not a data gap.
- **Fantasy:** Premier League only — not a scope choice, just what FPL is.
  There's no Championship fantasy data to show.
- **Betting tracker:** Premier League **and Championship**, widened
  2026-08-18 — the deliberate revisit this note asked for, prompted by a
  real report that Championship teams were selectable but had no
  fixtures/players to actually bet on. Match-winner and anytime-scorer
  bets both cover both competitions now; anytime-scorer needed a real
  fix alongside the widening, not just a fixture-list change — see
  `docs/erd.md`'s `players.current_team_id` note for why Championship
  squads used to come back empty. Still not FA Cup — never a real
  betting market here, same as Team dashboards/predictions.
- Championship/FA Cup data involving lower-tier opponents feeds the joint
  model as training signal even for matchups the app never predicts or
  displays.

Don't build Championship/FA Cup fantasy/betting features without a
deliberate decision to expand app scope further — this note is about
dashboards and predictions specifically, not a blanket app-wide expansion.

## Database

PostgreSQL fits well — the core data (leagues, teams, players, fixtures,
FPL data, my bets, model predictions) is genuinely relational. Predictions
and odds are time-series-ish (a new prediction/odds snapshot per gameweek
or per line movement); start with plain, well-indexed tables and only
reach for something like the TimescaleDB extension later if querying
history naively actually becomes painful.

See `/docs/erd.md` once schema work starts in Phase 1.

## The prediction model — sequencing and why

1. **Match outcome prediction first** (score / win-draw-loss). Cleanest
   labels, richest free historical dataset, and it's the piece that
   directly powers the betting comparison feature.
2. **Goal scorer prediction next** — harder (more variance: minutes played,
   rotation, red cards), but gives us player-level prediction data as a
   byproduct.
3. **Lineup optimizer later, as a stretch phase** — this is really two
   problems stacked (predict expected fantasy points per player, then run
   constrained optimization — likely linear/integer programming — under
   budget and position constraints). Doing this after player-level
   predictions already exist turns it into "just" the optimization layer,
   rather than an unfamiliar technique plus a from-scratch data problem at
   the same time.

Classic soccer-specific approaches worth learning about when we get there:
Poisson regression / Dixon-Coles for score prediction, versus a more
general ML approach (XGBoost) framed as classification. We'll pick one
deliberately in Phase 5, not by default.

## Phases

See `PHASES.md` for the detailed, checkboxed breakdown.

## Diagrams

- `/docs/architecture.md` — system architecture, updated as components are added
- `/docs/erd.md` — database schema, created in Phase 1 and updated as it evolves
- `/docs/learning-log.md` — concept summary per phase, my study reference
