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

echo "--- Refitting the prediction model on fresh data ---"
(cd ../model-service && .venv/bin/python -m app.train)

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) Daily refresh complete ==="
