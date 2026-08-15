"""
Batch job: fit a single joint Dixon-Coles model across every competition's
finished matches, predict every upcoming (unplayed) fixture in each
competition, write results to model_predictions. This is the scheduled
batch-inference job described in docs/architecture.md -- run on a schedule
(a GitHub Actions workflow once deployed, per Phase 10's plan), not called
live from the backend API.

Usage: python -m app.train
"""

from __future__ import annotations

import sys

from app.data import load_finished_matches, load_upcoming_fixtures
from app.db import get_connection
from app.dixon_coles import DixonColesModel

MODEL_VERSION = "dixon-coles-v1"

# All three fit together, not three separate per-competition fits. A
# Premier League team's attack/defense numbers and a Championship team's
# aren't comparable on their own -- each competition-only fit lands on an
# arbitrary, independent scale (see the identifiability note in
# dixon_coles.py). FA Cup fixtures are what make a *joint* fit meaningful:
# they're the only matches where a Premier League side and a Championship
# (or lower-tier) side play each other, so they're the actual data that
# ties the two leagues' scales together. Without them, fitting everything
# in one call would still be two disconnected, independently-arbitrary
# scales wearing one shared home_advantage/rho -- the FA Cup matches are
# the load-bearing part of this, not an incidental inclusion.
JOINT_FIT_COMPETITIONS = ["Premier League", "Championship", "FA Cup"]

# Predictions get written for all three now that the joint fit makes FA Cup
# comparisons meaningful -- fulfills the original Phase 5 intent (predict
# FA Cup fixtures where both teams are PL/Championship sides) that a
# single-competition fit couldn't support. The app's frontend still only
# ever displays Premier League and Championship (see docs/CLAUDE.md's data
# scope note); writing FA Cup predictions here doesn't change that, it just
# makes them exist for whenever that's picked up.
PREDICT_COMPETITIONS = ["Premier League", "Championship", "FA Cup"]

MIN_MATCHES_TO_FIT = 50  # below this, per-team parameters are too noisy to trust

# How many days back until a match's weight decays to half of a match
# today's. Shorter = recent form dominates more, at the cost of a noisier
# effective sample (a team plays ~4-5 matches/month, so going very short
# means fitting on a handful of results) -- tune this and rerun app.evaluate
# to compare against a different value directly, rather than guessing which
# is better.
#
# Tested against real 3-season data (see docs/learning-log.md's Phase 5
# entry): 180 beat both 120 and 60 in both leagues, monotonically --
# shortening the half-life consistently hurt. Dixon-Coles is estimating
# underlying team strength, which changes slowly, so discounting older
# results costs more in sample size/noise than it gains from "freshness."
HALF_LIFE_DAYS = 180


def upsert_prediction(conn, fixture_id: int, prediction) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO model_predictions (
                fixture_id, model_version, prob_home_win, prob_draw, prob_away_win,
                predicted_home_goals, predicted_away_goals
            ) VALUES (%(fixture_id)s, %(model_version)s, %(prob_home_win)s, %(prob_draw)s, %(prob_away_win)s,
                      %(predicted_home_goals)s, %(predicted_away_goals)s)
            ON CONFLICT (fixture_id, model_version) DO UPDATE SET
                predicted_at = now(),
                prob_home_win = EXCLUDED.prob_home_win,
                prob_draw = EXCLUDED.prob_draw,
                prob_away_win = EXCLUDED.prob_away_win,
                predicted_home_goals = EXCLUDED.predicted_home_goals,
                predicted_away_goals = EXCLUDED.predicted_away_goals
            """,
            {
                "fixture_id": fixture_id,
                "model_version": MODEL_VERSION,
                "prob_home_win": prediction.prob_home_win,
                "prob_draw": prediction.prob_draw,
                "prob_away_win": prediction.prob_away_win,
                "predicted_home_goals": prediction.predicted_home_goals,
                "predicted_away_goals": prediction.predicted_away_goals,
            },
        )


def predict_for_competition(conn, model: DixonColesModel, competition_name: str) -> None:
    upcoming = load_upcoming_fixtures(conn, competition_name)
    predicted = 0
    skipped = 0
    for _, fixture in upcoming.iterrows():
        try:
            prediction = model.predict(fixture["home_team"], fixture["away_team"])
        except ValueError:
            # A team with no finished matches yet in the joint fit (e.g. a
            # non-league FA Cup minnow with zero appearances) has no fitted
            # attack/defense -- skip rather than guess with an arbitrary
            # default.
            skipped += 1
            continue
        upsert_prediction(conn, fixture["fixture_id"], prediction)
        predicted += 1

    conn.commit()
    print(f"{competition_name}: wrote {predicted} predictions, skipped {skipped} (team not in training data).")


def main() -> None:
    conn = get_connection()
    try:
        matches = load_finished_matches(conn, JOINT_FIT_COMPETITIONS)
        if len(matches) < MIN_MATCHES_TO_FIT:
            print(f"Only {len(matches)} finished matches across {JOINT_FIT_COMPETITIONS}, skipping (need {MIN_MATCHES_TO_FIT}+).")
            return

        model = DixonColesModel()
        model.fit(matches, half_life_days=HALF_LIFE_DAYS)
        print(
            f"Joint fit on {model.fitted_on} matches across {', '.join(JOINT_FIT_COMPETITIONS)}, "
            f"{len(model.teams)} teams, home_advantage={model.home_advantage:.3f}, rho={model.rho:.4f}"
        )

        for competition_name in PREDICT_COMPETITIONS:
            predict_for_competition(conn, model, competition_name)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
