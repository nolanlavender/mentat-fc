#!/usr/bin/env bash
set -euo pipefail

# Keeps the current season current, day to day. Every step here is
# idempotent (upserts / DB-checkpointed resume), so running this more than
# once a day, or after a failed run, is always safe -- it just does
# whatever's new since the last run.
#
# Order matters: current-season fixtures must be refreshed BEFORE the
# lineup backfill runs, because backfillLineupsForCompetitionSeason only
# considers fixtures with status = 'finished' -- a match that went final
# since yesterday needs its status updated first, or the backfill won't
# see it as a candidate yet.
#
# --- Scheduling ---
# Decided 2026-08-16: not scheduled locally. This script was always going
# to get replaced by an equivalent GitHub Actions scheduled workflow once
# the app is deployed (Phase 10) -- same commands, just a different
# trigger -- so a local cron/launchd entry now would mean setting one up
# and tearing it down again shortly after. The one-time-setup notes below
# are kept for reference (e.g. if you want to run this unattended before
# Phase 10 for some reason), not because it's the current plan.
#
# --- One-time setup (macOS) ---
# cron is the simplest option, but two things to know: (1) modern macOS
# requires granting cron's process (/usr/sbin/cron) Full Disk Access in
# System Settings > Privacy & Security before it can run anything useful,
# and (2) cron does not wake a sleeping Mac -- if your laptop is asleep at
# the scheduled time, that run is just skipped until the next one.
#
#   crontab -e
#   # Every day at 6am:
#   0 6 * * * /absolute/path/to/mentat-fc/backend/scripts/daily-refresh.sh >> /absolute/path/to/mentat-fc/backend/scripts/daily-refresh.log 2>&1
#
# launchd (more native to macOS, and can be paired with `pmset repeat wake`
# to actually wake the machine for the run) is more setup -- ask if you
# want a launchd .plist written out instead.

cd "$(dirname "$0")/.."  # backend/

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) Daily refresh starting ==="

echo "--- Refreshing current-season fixtures (Premier League + Championship) ---"
npm run db:seed:current-season

echo "--- Backfilling lineups/player-stats for newly-finished fixtures ---"
npm run db:seed:backfill-lineups

# Transfer-window-only, through 2026-09-02 -- see the matching comment in
# .github/workflows/daily-refresh.yml for why this is normally NOT part of
# the daily job. Self-expiring: once today's date passes the cutoff this
# just echoes and skips, no manual cleanup required.
TRANSFER_WINDOW_CUTOFF="2026-09-02"
TODAY="$(date -u +%Y-%m-%d)"
if [[ "$TODAY" < "$TRANSFER_WINDOW_CUTOFF" || "$TODAY" == "$TRANSFER_WINDOW_CUTOFF" ]]; then
  echo "--- Refreshing FPL rosters (transfer window, through $TRANSFER_WINDOW_CUTOFF) ---"
  npm run db:seed:fpl
else
  echo "--- Skipping FPL roster refresh -- past transfer window cutoff ($TRANSFER_WINDOW_CUTOFF) ---"
fi

echo "--- Syncing current team rosters (Championship, via API-Football squads) ---"
# As of 2026-08-18, not just photos -- GET /players/squads?team={id} is the
# authoritative "who's on this roster right now" signal for Championship
# teams (FPL only covers Premier League, see the FPL step above). Not
# gated to the transfer window: Championship transfers aren't tied to
# FPL's calendar. See the matching step in .github/workflows/daily-refresh.yml
# and docs/learning-log.md's 2026-08-18 entry.
npm run db:seed:photos

echo "--- Refitting the prediction model on fresh data ---"
(cd ../model-service && .venv/bin/python -m app.train)

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) Daily refresh complete ==="
