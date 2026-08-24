"""
Read-only diagnostic: which club does the model think this player is at,
and why?

Built 2026-08-23, after the third instance of the same question. Harry
Wilson was predicted for Fulham after joining Leeds (2026-08-16), Mohamed
Salah for Liverpool after leaving (2026-08-22), and Alexander Isak for
Newcastle after joining Liverpool. Each time the answer lay somewhere in a
chain nobody could see from the app -- FPL's live current_team_id, the
API-Football squads roster, the appearance-derived fallback, and the
entity resolution that decides whether two sightings are the same person.

Each of those was diagnosed by reading code and guessing which link had
failed. This prints the chain instead.

The links, in the order app.data.load_player_squad_appearances applies
them:

  1. players.current_team_id -- set by FPL's bootstrap-static and by the
     API-Football squads sync. Authoritative when present.
  2. teams.roster_synced_at on the club he last played for -- the thing
     that distinguishes "verified absent" from "never checked"
     (migration 1701000000029). Only consulted when 1 is NULL.
  3. the most recent appearance's team -- the fallback, used only when
     that club has never been verified.
  4. whether he has enough appearances to reach the shares pool at all
     (app.goal_scorer's MIN_PLAYER_MATCHES).

It also lists every player row with a similar name, because a transfer
between two tracked clubs can produce a DUPLICATE rather than a move: the
squads matcher's candidate pool (ROSTER_CANDIDATES_CTE in
backend/seed/lib/db.ts) only considers players already associated with the
team being synced, which is the one club a transferring player is not yet
associated with. Unless he was already linked by his namespaced
api_football_squads external id, the sync inserts a second row for him.
A split identity looks exactly like a stale one from the app and needs a
completely different fix, so it is worth being able to tell them apart
before touching anything.

Writes nothing; safe against production any time.

Usage: python -m app.diagnose_player "Isak"
"""

from __future__ import annotations

import sys

import pandas as pd

from app.data import _query_df
from app.db import get_connection
from app.goal_scorer import MIN_PLAYER_MATCHES
from app.train import JOINT_FIT_COMPETITIONS

# The appearance count has to be scoped exactly the way
# load_player_squad_appearances scopes it -- finished matches in the
# tracked competitions -- or the "below MIN_PLAYER_MATCHES" line reports a
# number the pool never sees and sends you looking for the wrong problem.
PLAYER_CHAIN_QUERY = """
    WITH appearances AS (
        SELECT fl.player_id, fl.team_id, f.kickoff_date
        FROM fixture_lineups fl
        JOIN fixtures f ON f.id = fl.fixture_id
        JOIN competition_seasons cs ON cs.id = f.competition_season_id
        JOIN competitions c ON c.id = cs.competition_id
        WHERE c.name = ANY(%(competition_names)s)
          AND f.status = 'finished'
    ),
    tallied AS (
        SELECT player_id, count(*) AS appearances
        FROM appearances GROUP BY player_id
    ),
    most_recent_club AS (
        SELECT DISTINCT ON (player_id) player_id, team_id, kickoff_date
        FROM appearances
        ORDER BY player_id, kickoff_date DESC
    )
    SELECT p.id AS player_id,
           p.full_name,
           p.current_team_id,
           ct.name AS current_team_name,
           mrc.team_id AS last_appearance_team_id,
           lt.name AS last_appearance_team_name,
           mrc.kickoff_date AS last_appearance_date,
           lt.roster_synced_at AS last_club_roster_synced_at,
           COALESCE(t.appearances, 0) AS appearances,
           (SELECT string_agg(pei.source || '=' || pei.external_id, ', ' ORDER BY pei.source)
              FROM player_external_ids pei WHERE pei.player_id = p.id) AS external_ids
    FROM players p
    LEFT JOIN teams ct ON ct.id = p.current_team_id
    LEFT JOIN tallied t ON t.player_id = p.id
    LEFT JOIN most_recent_club mrc ON mrc.player_id = p.id
    LEFT JOIN teams lt ON lt.id = mrc.team_id
    WHERE p.full_name ILIKE %(like)s::text
    ORDER BY COALESCE(t.appearances, 0) DESC, p.id
"""


def load_player_chain(conn, needle: str) -> pd.DataFrame:
    return _query_df(
        conn,
        PLAYER_CHAIN_QUERY,
        {"competition_names": JOINT_FIT_COMPETITIONS, "like": f"%{needle}%"},
    )


def resolve_club(row) -> tuple[str | None, str]:
    """
    Which club this player row resolves to, and the reason -- None meaning
    he is dropped from the pool entirely.

    Deliberately a re-implementation of load_player_squad_appearances'
    effective_club CASE rather than a call into it. The point of this
    diagnostic is to show what that query WILL decide; a version that
    shared the code under test could never disagree with it, and "these
    two disagree" is exactly the finding worth surfacing. The schema test
    pins the two to the same answer against a real database instead, which
    catches divergence without making disagreement impossible.
    """
    if pd.isna(row.last_appearance_team_id):
        return None, "no appearances on record, so he never reaches the pool"
    if not pd.isna(row.current_team_id):
        return row.current_team_name, "current_team_id is set, so it wins outright"
    if not pd.isna(row.last_club_roster_synced_at):
        return None, "no current club AND his last club's roster HAS been verified -> departed"
    return row.last_appearance_team_name, "no current club, and that roster was never verified -> appearance fallback"


def describe(row) -> None:
    """Print one player row's chain and the club it resolves to."""
    print(f"{row.full_name}  (player {row.player_id})")

    current = f"{row.current_team_name} ({int(row.current_team_id)})" if not pd.isna(row.current_team_id) else "NULL"
    print(f"  current_team_id            : {current}")

    if pd.isna(row.last_appearance_team_id):
        print("  last appearance            : none on record")
    else:
        print(f"  last appearance            : {row.last_appearance_team_name} on {row.last_appearance_date}")
    synced = "NEVER (roster_synced_at is NULL)" if pd.isna(row.last_club_roster_synced_at) else row.last_club_roster_synced_at
    print(f"  that club's roster verified: {synced}")
    print(f"  appearances                : {row.appearances} (pool needs {MIN_PLAYER_MATCHES})")
    print(f"  external ids               : {row.external_ids or 'none'}")

    club, why = resolve_club(row)
    print(f"  => predicted for           : {club or 'NOBODY (dropped)'}  ({why})")

    if club is not None and row.appearances < MIN_PLAYER_MATCHES:
        print(f"     ...though {row.appearances} appearances is below {MIN_PLAYER_MATCHES}, so he is filtered out regardless.")
    print()


DUPLICATE_WARNING = """
MORE THAN ONE ROW matched. If these are the same real person, entity resolution has
split him, and no amount of fixing club resolution will help -- each row resolves
correctly on its own. A transfer between two tracked clubs causes this: the squads
matcher's candidate pool is scoped to the team being synced, which is the one club a
transferring player is not yet associated with, so unless he was already linked by his
api_football_squads external id the sync inserts a second row rather than moving him.
Tell the two apart by the external ids above: one source per row usually means a real
namesake, the SAME source on both rows means a split. The fix is to merge the rows and
add the missing external id, not to touch load_player_squad_appearances.
""".strip()


def main() -> None:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print('Usage: python -m app.diagnose_player "surname"')
        return
    needle = sys.argv[1].strip()

    conn = get_connection()
    try:
        rows = load_player_chain(conn, needle)
        if rows.empty:
            print(f"No player matching '{needle}'.")
            return

        print(f"{len(rows)} player row(s) matching '{needle}':\n")
        for row in rows.itertuples():
            describe(row)

        if len(rows) > 1:
            print(DUPLICATE_WARNING)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
