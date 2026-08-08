"""
Batch job: fit Dixon-Coles per competition on finished matches, predict every
upcoming (unplayed) fixture in that competition, write results to
model_predictions. This is the scheduled batch-inference job described in
docs/architecture.md -- run on a schedule (a GitHub Actions workflow once
deployed, per Phase 10's plan), not called live from the backend API.

Usage: python -m app.train
"""

from __future__ import annotations

import sys

from app.data import load_finished_matches, load_upcoming_fixtures
from app.db import get_connection
from app.dixon_coles import DixonColesModel

MODEL_VERSION = "dixon-coles-v1"

# FA Cup deliberately excluded: it mixes Premier League and Championship
# teams (and lower-tier sides with no fitted parameters at all), which a
# single-competition Dixon-Coles fit can't handle -- see the note in
# docs/learning-log.md's Phase 5 entry. Predicting those crossover fixtures
# needs both leagues' team strengths on one comparable scale, a real problem
# deliberately deferred, not solved here.
COMPETITIONS = ["Premier League", "Championship"]

MIN_MATCHES_TO_FIT = 50  # below this, per-team parameters are too noisy to trust

# How many days back until a match's weight decays to half of a match
# today's. Shorter = recent form dominates more, at the cost of a noisier
# effective sample (a team plays ~4-5 matches/month, so going very short
# means fitting on a handful of results). 60 days means a 90-day-old match
# already carries ~35% weight and a year-old one ~1.5% -- tune this and
# rerun app.evaluate to compare against a different value directly, rather
# than guessing which is better.
HALF_LIFE_DAYS = 60


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


def run_for_competition(conn, competition_name: str) -> None:
    matches = load_finished_matches(conn, competition_name)
    if len(matches) < MIN_MATCHES_TO_FIT:
        print(f"{competition_name}: only {len(matches)} finished matches, skipping (need {MIN_MATCHES_TO_FIT}+).")
        return

    model = DixonColesModel()
    model.fit(matches, half_life_days=HALF_LIFE_DAYS)
    print(f"{competition_name}: fitted on {model.fitted_on} matches, home_advantage={model.home_advantage:.3f}, rho={model.rho:.4f}")

    upcoming = load_upcoming_fixtures(conn, competition_name)
    predicted = 0
    skipped = 0
    for _, fixture in upcoming.iterrows():
        try:
            prediction = model.predict(fixture["home_team"], fixture["away_team"])
        except ValueError:
            # A team with no finished matches yet (e.g. newly promoted, still
            # mid-transfer-window) has no fitted attack/defense -- skip rather
            # than guess with an arbitrary default.
            skipped += 1
            continue
        upsert_prediction(conn, fixture["fixture_id"], prediction)
        predicted += 1

    conn.commit()
    print(f"{competition_name}: wrote {predicted} predictions, skipped {skipped} (team not in training data).")


def main() -> None:
    conn = get_connection()
    try:
        for competition_name in COMPETITIONS:
            run_for_competition(conn, competition_name)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
