"""
Read-only diagnostic: why does an upcoming fixture have no predictions --
or no goal-scorer picks -- when other fixtures do?

Built 2026-08-21 after a real report ("I just didn't see any [predicted
scorers] for upcoming games like tomorrow's Arsenal Coventry game") where
some upcoming fixtures had scorer picks and others didn't. The backend's
own query (fixtures.service.ts) just reads whatever player_goal_predictions
holds, so a fixture with no picks means app.train never wrote any for it --
and there are several genuinely different reasons that can happen, which
this pulls apart instead of guessing between:

  - the fixture's competition isn't predicted at all
  - the fixture IS predicted, but a team has no fitted attack/defense
    (never appeared in that competition's finished matches -- app.train
    skips these, see its ValueError branch)
  - the fixture is predicted, but one/both teams have no players clearing
    goal_scorer.MIN_PLAYER_MATCHES, so allocate_team_goals returns nothing
  - a confirmed matchday squad exists and excludes every reliable player
    (a real risk since 2026-08-20's confirmed-role work -- an entity-
    resolution mismatch between fixture_lineups.player_id and the ids in
    player_shares would look exactly like this)

Writes nothing, so it's safe to run against production any time.

Usage: python -m app.diagnose_coverage [team name substring]
"""

from __future__ import annotations

import sys

import pandas as pd

from app.data import load_confirmed_lineups, load_finished_matches, load_player_squad_appearances, load_upcoming_fixtures
from app.db import get_connection
from app.goal_scorer import MIN_PLAYER_MATCHES, compute_player_shares
from app.train import HALF_LIFE_DAYS, JOINT_FIT_COMPETITIONS, PREDICT_COMPETITIONS


def _counts_by_fixture(conn, table: str, fixture_ids: list[int]) -> dict[int, int]:
    if not fixture_ids:
        return {}
    with conn.cursor() as cur:
        cur.execute(f"SELECT fixture_id, count(*) FROM {table} WHERE fixture_id = ANY(%s) GROUP BY fixture_id", (fixture_ids,))
        return {int(fixture_id): int(count) for fixture_id, count in cur.fetchall()}


def main() -> None:
    team_filter = sys.argv[1].lower() if len(sys.argv) > 1 else None
    conn = get_connection()
    try:
        matches = load_finished_matches(conn, JOINT_FIT_COMPETITIONS)
        as_of = matches["kickoff_date"].max()
        appearances = load_player_squad_appearances(conn, JOINT_FIT_COMPETITIONS)
        player_shares = compute_player_shares(appearances, as_of, half_life_days=HALF_LIFE_DAYS)

        # Raw (unfiltered by MIN_PLAYER_MATCHES) appearance counts, so a team
        # with zero reliable players can be told apart from a team whose
        # players are simply one or two appearances short of the threshold.
        raw_counts = appearances.groupby(["team_id", "player_id"]).size().reset_index(name="appearances")

        print(f"as_of={as_of}  MIN_PLAYER_MATCHES={MIN_PLAYER_MATCHES}  HALF_LIFE_DAYS={HALF_LIFE_DAYS}")
        print(f"player_shares: {len(player_shares)} reliable (team, player) rows across {player_shares['team_id'].nunique()} teams\n")

        # Teams that appear in fitted match data at all -- a team missing here
        # has no attack/defense, which is app.train's skip-with-ValueError case.
        for competition_name in PREDICT_COMPETITIONS:
            upcoming = load_upcoming_fixtures(conn, competition_name)
            if team_filter:
                upcoming = upcoming[
                    upcoming["home_team"].str.lower().str.contains(team_filter)
                    | upcoming["away_team"].str.lower().str.contains(team_filter)
                ]
            if upcoming.empty:
                continue

            fixture_ids = upcoming["fixture_id"].tolist()
            prediction_counts = _counts_by_fixture(conn, "model_predictions", fixture_ids)
            scorer_counts = _counts_by_fixture(conn, "player_goal_predictions", fixture_ids)
            confirmed = load_confirmed_lineups(conn, fixture_ids)

            fitted_teams = set(matches[matches["competition_name"] == competition_name]["home_team"]) | set(
                matches[matches["competition_name"] == competition_name]["away_team"]
            )

            print(f"=== {competition_name}: {len(upcoming)} upcoming fixtures ===")
            for f in upcoming.itertuples():
                scorers = scorer_counts.get(f.fixture_id, 0)
                predictions = prediction_counts.get(f.fixture_id, 0)
                flag = "" if scorers > 0 else "   <-- NO SCORER PICKS"
                print(f"  [{f.fixture_id}] {f.kickoff_date}  {f.home_team} vs {f.away_team}: "
                      f"{predictions} prediction(s), {scorers} scorer pick(s){flag}")
                if scorers > 0:
                    continue

                for side, team_name, team_id in (
                    ("home", f.home_team, f.home_team_id),
                    ("away", f.away_team, f.away_team_id),
                ):
                    reliable = player_shares[player_shares["team_id"] == team_id]
                    team_raw = raw_counts[raw_counts["team_id"] == team_id]
                    squad = set(confirmed[(confirmed["fixture_id"] == f.fixture_id) & (confirmed["team_id"] == team_id)]["player_id"])
                    in_fit = "yes" if team_name in fitted_teams else "NO (no fitted attack/defense -- app.train skips this fixture)"

                    print(f"      {side} {team_name} (id={team_id}): in {competition_name} fit: {in_fit}")
                    print(f"        reliable players (>= {MIN_PLAYER_MATCHES} apps): {len(reliable)}"
                          f"   |  players with any appearances: {len(team_raw)}"
                          f"   |  max appearances by one player: {int(team_raw['appearances'].max()) if len(team_raw) else 0}")
                    if squad:
                        overlap = len(squad & set(reliable["player_id"]))
                        excludes_everyone = not reliable.empty and overlap == 0
                        print(f"        confirmed squad: {len(squad)} players, {overlap} of them reliable"
                              f"{'   <-- confirmed squad excludes every reliable player' if excludes_everyone else ''}")
            print()
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
