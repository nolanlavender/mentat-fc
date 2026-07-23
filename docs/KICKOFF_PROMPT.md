I'm starting a new project called Mentat FC — a Premier League app combining
official-rules fantasy, a personal betting tracker, and a prediction model I
build myself for match outcomes (and later, goal scorers). Full context, how
you should work with me, tech stack, and the phase-by-phase plan are already
written in CLAUDE.md and PHASES.md at the root of this repo, and
docs/architecture.md has the system diagrams. Read all three fully before
doing anything else.

The most important thing in CLAUDE.md, and I want to be explicit about this:
**this project exists first to teach me, second to be a working product.**
I'm an experienced data engineer but new to React/TypeScript, Node/Express,
relational schema design for a live product, auth, caching, and — for the
model piece — applying ML outside of data engineering pipelines. Before you
implement any concept I haven't used yet in this repo, explain it briefly
first: what it is, why it's needed here, what the alternative would be. Then
implement it. Don't just hand me working code silently.

**Documentation is not optional here.** After we finish the work below,
create `/docs/learning-log.md` if it doesn't exist yet, and write an entry
for today covering: what we set up, what I should understand as a result,
and any decisions we made and why. I'll be referring back to this file to
study, so write it for that purpose, not as a changelog.

Today I want to knock out Phase 0 from PHASES.md: environment and planning.
Specifically:

1. Set up the repo structure: /frontend, /backend, /model-service, /docs.
   (/docs already has architecture.md — leave it in place.)
2. Scaffold the backend as a Node.js + TypeScript + Express project. Explain
   the folder structure choice as you set it up, and why.
3. Scaffold the frontend as a React + TypeScript project. Explain the
   tooling choice (e.g. Vite) before you pick one.
4. Scaffold /model-service as a Python project with a virtual environment,
   FastAPI installed, and a minimal "hello world" endpoint just to confirm
   it runs. We're not building the model yet — just standing up the service
   shell. Explain why this is a separate service from the Node backend
   rather than a Python script called from Express.
5. Set up Docker Compose for local Postgres — a single service is fine for
   now. Explain what Docker Compose is actually doing for us, since I don't
   have hands-on Docker experience.
6. Create .env.example files for frontend, backend, and model-service with
   placeholder values for: Postgres connection, API-Football (or
   Football-Data.org) key, The Odds API key, Groq API key. The official FPL
   API needs no key. Don't put real keys in anything that's not gitignored.
7. Make sure .gitignore is set up correctly for node_modules, .env,
   Python's venv/__pycache__, build output, etc.
8. Confirm at the end:
   - What free tier limits does API-Football (or Football-Data.org,
     whichever you think is the better fit) actually give us for pulling
     all 20 Premier League teams' fixtures/lineups/standings?
   - Same question for The Odds API.
   - Same question for Groq (requests/min, tokens/min for Llama 3.3 70B).
   - Pull a small sample from the official FPL API and from a
     football-data.co.uk historical CSV, and summarize what fields are
     actually available in each — I want a real sense of what we're
     working with before Phase 1 schema design.

Don't jump ahead into Phase 1 (schema/data layer) yet — stop after Phase 0
is done, write the learning-log entry, and give me a summary of what you set
up, what you learned about the data sources, and what decisions you made
along the way so I can review before we move on. Update the checkboxes in
PHASES.md for anything completed.
