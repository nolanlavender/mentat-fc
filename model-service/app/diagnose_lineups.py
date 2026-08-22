"""
Read-only diagnostic: the matchday lineup check ran and a fixture's lineup
still isn't showing.

Built 2026-08-21 after exactly that report. "Matchday lineups: checked 1
fixture(s) kicking off soon, 0 had a confirmed lineup" is genuinely
ambiguous -- it is the same message whether the lineup isn't published
yet, or the fixture was never in the window, or the lineup is already
captured and something downstream is stale. Those need completely
different responses and the log line cannot tell them apart, because
seedTodaysLineups' query excludes any fixture that ALREADY has
fixture_lineups rows. A fixture whose lineup landed successfully is
therefore invisible to the very message you'd check to find out.

The four states this separates, in the order they're worth ruling out:

  1. OUTSIDE THE WINDOW -- seedTodaysLineups only looks at fixtures within
     MATCHDAY_LOOKBACK/LOOKAHEAD_HOURS (+/- 3h) of now. A fixture further
     out was never checked at all, and running the workflow again right
     now will do nothing. Wait, or widen the window.
  2. IN THE WINDOW, NOTHING PUBLISHED -- the normal state until roughly an
     hour before kickoff. Nothing is broken; run it again later.
  3. LINEUP CAPTURED, PREDICTIONS STALE -- fixture_lineups has rows, but
     model_predictions.predicted_at is OLDER than when those rows landed,
     so nothing the lineup should have changed (availability adjustment,
     starter-vs-bench scorer odds, dropping unnamed players) has actually
     been applied yet. app.train has to run again for that. This is the
     state that looks most like a bug and isn't one -- see the note below.
  4. LINEUP CAPTURED AND APPLIED -- if it still isn't on screen, the
     problem is in the API or the frontend, not the data.

The reason 3 is likely: the hourly matchday workflow used to re-run
app.train after each lineup check, and that was REVERTED on 2026-08-20
during the Actions billing incident (see docs/learning-log.md). Capturing
a lineup and acting on it became two separate things, and only the first
one is automated.

Writes nothing, so it's safe against production any time.

Usage: python -m app.diagnose_lineups [team name substring]
"""

from __future__ import annotations

import sys

import pandas as pd

from app.data import _query_df
from app.db import get_connection

# Kept in sync by hand with api-football.ts's MATCHDAY_LOOKBACK_HOURS /
# MATCHDAY_LOOKAHEAD_HOURS. Duplicated rather than shared because they
# live in the TypeScript seed layer and this is Python; if they diverge,
# this diagnostic reports the wrong window, so it is printed explicitly
# below rather than assumed.
MATCHDAY_LOOKBACK_HOURS = 3
MATCHDAY_LOOKAHEAD_HOURS = 3

# How far back the retrospective capture-rate report looks.
CAPTURE_REPORT_DAYS = 30


def main() -> None:
    # `or None` matters: the workflow always passes an argument, and an
    # unfilled optional input arrives as the empty string. Without this,
    # the filter becomes ILIKE '%%' -- harmless, but the header would
    # claim to be "matching ''" when it is actually showing everything.
    team_filter = (sys.argv[1].strip() if len(sys.argv) > 1 else "") or None
    conn = get_connection()
    try:
        rows = _query_df(
            conn,
            """
            SELECT f.id AS fixture_id,
                   c.name AS competition_name,
                   ht.name AS home_team,
                   at.name AS away_team,
                   f.kickoff_at,
                   f.status,
                   f.external_api_football_id,
                   now() AS checked_at,
                   EXTRACT(EPOCH FROM (f.kickoff_at - now())) / 3600 AS hours_until_kickoff,
                   (SELECT count(*) FROM fixture_lineups fl WHERE fl.fixture_id = f.id) AS lineup_rows,
                   (SELECT count(*) FROM fixture_lineups fl
                     WHERE fl.fixture_id = f.id AND fl.is_starting) AS starters,
                   (SELECT max(mp.predicted_at) FROM model_predictions mp
                     WHERE mp.fixture_id = f.id) AS predicted_at,
                   (SELECT max(fl.pre_match_captured_at) FROM fixture_lineups fl
                     WHERE fl.fixture_id = f.id) AS lineup_captured_at,
                   (SELECT count(*) FROM player_goal_predictions pgp
                     WHERE pgp.fixture_id = f.id) AS scorer_picks
            FROM fixtures f
            JOIN teams ht ON ht.id = f.home_team_id
            JOIN teams at ON at.id = f.away_team_id
            JOIN competition_seasons cs ON cs.id = f.competition_season_id
            JOIN competitions c ON c.id = cs.competition_id
            WHERE f.status != 'finished'
              AND f.kickoff_at BETWEEN now() - interval '12 hours' AND now() + interval '48 hours'
              -- ::text casts are load-bearing, not decoration. With a NULL
              -- parameter and no cast Postgres cannot infer the type and
              -- fails with "could not determine data type of parameter" --
              -- which is exactly what an unfiltered run (the workflow's
              -- default, since an unfilled input becomes None) did until
              -- tests/test_queries_against_schema.py executed it.
              AND (%(team)s::text IS NULL OR ht.name ILIKE %(like)s::text OR at.name ILIKE %(like)s::text)
            ORDER BY f.kickoff_at
            """,
            {"team": team_filter, "like": f"%{team_filter}%" if team_filter else None},
        )

        scope = f" matching '{team_filter}'" if team_filter else ""
        print(
            f"Unfinished fixtures{scope} from 12h ago to 48h ahead: {len(rows)}\n"
            f"Matchday check window is now -{MATCHDAY_LOOKBACK_HOURS}h to "
            f"now +{MATCHDAY_LOOKAHEAD_HOURS}h.\n"
        )
        if rows.empty:
            print(
                "Nothing in range. If you expected a fixture here, it is either already\n"
                "marked 'finished', outside the 48h horizon, or the team name didn't match."
            )
            return

        for row in rows.itertuples():
            hours = float(row.hours_until_kickoff)
            in_window = -MATCHDAY_LOOKBACK_HOURS <= hours <= MATCHDAY_LOOKAHEAD_HOURS
            when = f"in {hours:.1f}h" if hours >= 0 else f"{abs(hours):.1f}h ago"

            print(f"{row.home_team} vs {row.away_team}  ({row.competition_name}, fixture {row.fixture_id})")
            print(f"  kickoff {row.kickoff_at} ({when}), status '{row.status}'")

            if row.external_api_football_id is None:
                print("  -> BLOCKED: no external_api_football_id, so the lineup check can never look it up.\n")
                continue

            if row.lineup_rows == 0:
                if not in_window:
                    print(
                        f"  -> STATE 1: outside the check window, so it was never looked up.\n"
                        f"     Running the workflow again now will not help. It becomes eligible "
                        f"{max(hours - MATCHDAY_LOOKAHEAD_HOURS, 0):.1f}h from now.\n"
                    )
                else:
                    print(
                        "  -> STATE 2: in the window, but API-Football has published nothing yet.\n"
                        "     Normal until roughly an hour before kickoff. Nothing is broken; run it again later.\n"
                    )
                continue

            print(f"  lineup: {row.lineup_rows} players ({row.starters} starting)")
            if row.predicted_at is None:
                print("  -> STATE 3: lineup captured, but this fixture has NO prediction at all. Run app.train.\n")
                continue

            print(f"  predicted_at {row.predicted_at}, {row.scorer_picks} scorer picks")

            # Compare TIMESTAMPS, not counts. The original version inferred
            # staleness from "more scorer picks than squad players", which
            # was wrong in both directions and said so confidently: on
            # 2026-08-22 it reported Hull vs Manchester United as STATE 3
            # when the prediction had in fact run 56 seconds AFTER the
            # lineup landed. The extra picks were orphaned rows from the
            # days-ahead run that nothing ever deleted -- a separate real
            # bug (see train.delete_stale_player_goal_predictions), which
            # the count heuristic could not distinguish from the thing it
            # claimed to detect.
            captured_at = row.lineup_captured_at
            if not pd.isna(captured_at) and row.predicted_at is not None:
                if row.predicted_at > captured_at:
                    print(
                        f"  -> STATE 4: lineup captured {captured_at}, predictions written after it.\n"
                        f"     These predictions ARE lineup-aware. If it still isn't on screen, the\n"
                        f"     problem is the API or the frontend, not the data.\n"
                    )
                else:
                    print(
                        f"  -> STATE 3: lineup captured {captured_at}, but the newest prediction\n"
                        f"     predates it. Re-run app.apply_lineups (or Daily data refresh) to apply it.\n"
                    )
                continue

            # No capture timestamp: either a pre-migration row or a
            # post-match backfill, so the comparison above is impossible.
            # Fall back to the count, explicitly labelled as a guess.
            if row.scorer_picks > row.lineup_rows:
                print(
                    "  -> STATE 3 (probable): no capture timestamp to compare against, and there are\n"
                    "     more scorer picks than squad players. That USUALLY means the prediction ran\n"
                    "     without the confirmed squad -- but orphaned picks from an earlier run look\n"
                    "     identical, so confirm before acting.\n"
                )
            else:
                print(
                    "  -> STATE 4 (probable): no capture timestamp, but the pick count is consistent\n"
                    "     with a lineup-aware run.\n"
                )
        report_capture_rate(conn)
    finally:
        conn.close()


def report_capture_rate(conn) -> None:
    """
    Is pre-match capture actually working? -- answered retrospectively
    rather than by watching one fixture and guessing.

    The 2026-08-22 goal-scorer backtest reported 40 pre-match rows out of
    57,316, and that 0% is genuinely ambiguous: fixture_lineups.
    pre_match_captured_at only exists since migration 1701000000027, so
    every row seeded before it is NULL BY CONSTRUCTION and not evidence of
    anything. Reading that 0% as "capture is broken" would be the same
    mistake as reading the matchday log's "0 had a confirmed lineup" as
    "nothing was found" -- a number that cannot distinguish failure from
    not-yet-measured.

    So this reports only on fixtures kicking off AFTER the first pre-match
    capture on record, which is the earliest point the column could have
    been populated, and states the sample size next to the rate. It also
    reports the LEAD TIME distribution, which is the number that decides
    whether the hourly cadence is fast enough: lineups are published around
    an hour before kickoff, so a median lead time near zero means we are
    catching them at the last possible moment and a faster check would help,
    while a healthy lead means the cadence is fine and any gap is elsewhere.
    """
    live_since = _query_df(
        conn, "SELECT min(pre_match_captured_at) AS first_capture FROM fixture_lineups"
    )["first_capture"].iloc[0]

    print("\n=== Pre-match capture rate ===")
    if live_since is None:
        print(
            "  No lineup has EVER been captured pre-match. Either the matchday check has not\n"
            "  run inside a fixture's window since migration 1701000000027 added the column,\n"
            "  or it runs and API-Football never has anything in time. Run the check during a\n"
            "  window (app.diagnose_lineups shows which fixtures qualify) before concluding."
        )
        return

    rows = _query_df(
        conn,
        """
        SELECT f.id AS fixture_id, ht.name AS home_team, at.name AS away_team,
               f.kickoff_at,
               max(fl.pre_match_captured_at) AS captured_at,
               EXTRACT(EPOCH FROM (f.kickoff_at - max(fl.pre_match_captured_at))) / 60 AS lead_minutes
        FROM fixtures f
        JOIN teams ht ON ht.id = f.home_team_id
        JOIN teams at ON at.id = f.away_team_id
        JOIN fixture_lineups fl ON fl.fixture_id = f.id
        WHERE f.kickoff_at >= %(live_since)s::timestamptz
          AND f.kickoff_at < now()
          AND f.kickoff_at > now() - (%(days)s || ' days')::interval
        GROUP BY f.id, ht.name, at.name, f.kickoff_at
        ORDER BY f.kickoff_at DESC
        """,
        {"live_since": live_since, "days": CAPTURE_REPORT_DAYS},
    )

    if rows.empty:
        print(
            f"  The column has been live since {live_since}, but no fixture with a lineup has\n"
            f"  kicked off since then. Nothing to measure yet -- not a failure."
        )
        return

    captured = rows[rows["captured_at"].notna()]  # notna handles NaT the same way
    print(
        f"  Column live since {live_since}. Of {len(rows)} fixture(s) with a lineup that have\n"
        f"  kicked off since: {len(captured)} were captured pre-match ({len(captured) / len(rows):.0%})."
    )
    if len(rows) < 5:
        print("  Sample far too small to read as a rate -- treat these as individual cases, not a percentage.")

    if not captured.empty:
        leads = captured["lead_minutes"].astype(float)
        print(
            f"  Lead time before kickoff: median {leads.median():.0f} min, "
            f"earliest {leads.max():.0f}, latest {leads.min():.0f}."
        )
        if leads.median() < 20:
            print(
                "  -> Median lead under 20 minutes: we are catching lineups at the last moment.\n"
                "     A faster check cadence would very likely raise the capture rate."
            )
    for row in rows.head(10).itertuples():
        # pd.isna, not `is None`: a missing capture arrives as NaT/NaN
        # from the LEFT-joined aggregate and printed "nan min before
        # kickoff" -- which reads like a captured fixture with a broken
        # number rather than one that was never captured at all.
        captured = not pd.isna(row.captured_at)
        when = f"{float(row.lead_minutes):.0f} min before kickoff" if captured else "NOT captured pre-match"
        print(f"    {row.home_team} vs {row.away_team}  ({row.kickoff_at})  {when}")


if __name__ == "__main__":
    sys.exit(main())
