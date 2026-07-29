# Mentat FC

Premier League fantasy, betting tracker, and prediction model — one app, built to
learn the full stack of a real product (not just the football part).

Named after the Mentats in Dune — humans trained to perform the computation and
analysis that machines were forbidden from doing. The prediction model does the
analytical heavy lifting; the person using it makes the call.

## What it does

- **Fantasy** — official FPL rules and scoring, pulling live data from the public
  FPL API. Not a custom scoring system — the real thing.
- **Betting tracker** — logs bets placed elsewhere (pick, odds, stake, result) and
  tracks ROI/record over time. Personal tracker only — no real-money wagering
  happens inside the app.
- **Prediction model** — a model trained on historical Premier League data predicts
  match outcomes (and eventually goal scorers), surfaced next to logged bets so it's
  easy to see where the model and the betting market disagree.
- **Team dashboards, storylines, formation/position explainer** — secondary
  features aimed at a fan still learning the league.

This is a learning project first, a product second — see [`docs/CLAUDE.md`](docs/CLAUDE.md)
for the full reasoning and how the project is meant to be worked on.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React + TypeScript (Vite) |
| Backend | Node.js + Express + TypeScript — serves the app, reads predictions from Postgres |
| Model service | Python + FastAPI — trains the prediction model, writes predictions to Postgres on a schedule (separate from the backend on purpose; see `docs/architecture.md`) |
| Database | PostgreSQL (Docker Compose locally, Neon — serverless, autosuspending — once deployed) |
| AI explainer | Groq API (Llama 3.3 70B), behind our own service layer |

## Repo structure

```
frontend/       React + TypeScript SPA (Vite)
backend/        Express + TypeScript API
model-service/  Python + FastAPI — prediction model training & batch inference
docs/           Architecture, ERD, phase plan, learning log
```

## Local development setup

Each service pins its own runtime version so `nvm use` / `pyenv local` gets you the
exact version this code was built against — see `docs/learning-log.md` for why.

### Prerequisites

- [nvm](https://github.com/nvm-sh/nvm) — Node version manager
- [pyenv](https://github.com/pyenv/pyenv) — Python version manager
- [Colima](https://github.com/abiosoft/colima) + Docker CLI (`brew install colima docker docker-compose`) — this project uses Colima rather than Docker Desktop (lightweight, open-source, CLI-only)

### Postgres

```bash
cp .env.example .env      # adjust credentials if you want
colima start               # starts the Colima VM (once per machine reboot)
docker compose up -d       # starts Postgres, per docker-compose.yml
```

### Backend

```bash
cd backend
nvm use                    # reads .nvmrc
npm install
cp .env.example .env       # fill in DATABASE_URL and any API keys you have
npm run dev                # http://localhost:4000 — /health checks DB connectivity
```

### Frontend

```bash
cd frontend
nvm use
npm install
cp .env.example .env
npm run dev                # Vite dev server, default http://localhost:5173
```

### Model service

```bash
cd model-service
pyenv local                # reads .python-version (3.12.13)
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000   # http://localhost:8000/health
```

## Project status

Currently finishing **Phase 1 — data layer & schema**. See
[`docs/PHASES.md`](docs/PHASES.md) for the full checkboxed roadmap and
[`docs/learning-log.md`](docs/learning-log.md) for a running study log of what's been
built and why, phase by phase.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — system diagrams, updated as components are added
- [`docs/erd.md`](docs/erd.md) — database schema (created in Phase 1)
- [`docs/PHASES.md`](docs/PHASES.md) — the build plan
- [`docs/learning-log.md`](docs/learning-log.md) — what each phase taught, for reviewing later
