"""
Batch job: fit three Dixon-Coles models (Premier League, Championship, and
one joint fit for FA Cup), predict every upcoming (unplayed) fixture in
each competition, write results to model_predictions. This is the
scheduled batch-inference job described in docs/architecture.md -- run on
a schedule (a GitHub Actions workflow once deployed, per Phase 10's plan),
not called live from the backend API.

Usage: python -m app.train
"""

from __future__ import annotations

import sys

from app.data import load_finished_matches, load_player_squad_appearances, load_upcoming_fixtures
from app.db import get_connection
from app.dixon_coles import DixonColesModel
from app.goal_scorer import MIN_PLAYER_MATCHES, allocate_team_goals, compute_player_shares

MODEL_VERSION = "dixon-coles-v1"
GOAL_SCORER_MODEL_VERSION = "goal-scorer-poisson-v1"

# Revised 2026-08-15: originally one joint fit across all three
# competitions, used for every prediction. Real data exposed the cost of
# that: the joint fit's team count came back at 821 -- Premier League and
# Championship are ~20-25 clubs each, so the overwhelming majority were
# one-off FA Cup entrants from the Extra Preliminary Round upward, most of
# them non-league clubs a Premier League team never plays and that have
# almost no data of their own. Those ~800 near-unconstrained parameters
# still pull on the fit's shared home_advantage/rho and the recentering
# constant every team's attack/defense gets shifted by (see dixon_coles.py's
# identifiability note) -- contaminating Premier League and Championship's
# OWN predictions for no benefit, since cross-league comparability is only
# ever needed for a cross-league prediction.
#
# The original reasoning for a joint fit was correct, just applied too
# broadly: FA Cup fixtures really are the only matches where a Premier
# League side and a Championship (or lower-tier) side play each other, so
# they're genuinely necessary for predicting an FA Cup tie between two
# sides from different divisions. A pure Premier-League-vs-Premier-League
# or Championship-vs-Championship prediction never needs that connection at
# all. So: two single-competition fits for Premier League and Championship
# predictions, and the joint (all three) fit kept, but used only for FA Cup.
JOINT_FIT_COMPETITIONS = ["Premier League", "Championship", "FA Cup"]
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


def upsert_player_goal_prediction(conn, fixture_id: int, team_id: int, prediction) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO player_goal_predictions (
                fixture_id, player_id, team_id, model_version, expected_goals, prob_scores
            ) VALUES (%(fixture_id)s, %(player_id)s, %(team_id)s, %(model_version)s, %(expected_goals)s, %(prob_scores)s)
            ON CONFLICT (fixture_id, player_id, model_version) DO UPDATE SET
                predicted_at = now(),
                expected_goals = EXCLUDED.expected_goals,
                prob_scores = EXCLUDED.prob_scores
            """,
            {
                "fixture_id": fixture_id,
                "player_id": prediction.player_id,
                "team_id": team_id,
                "model_version": GOAL_SCORER_MODEL_VERSION,
                "expected_goals": prediction.expected_goals,
                "prob_scores": prediction.prob_scores,
            },
        )


def predict_for_competition(conn, model: DixonColesModel, competition_name: str, player_shares) -> None:
    upcoming = load_upcoming_fixtures(conn, competition_name)
    predicted = 0
    skipped = 0
    goal_scorer_predictions = 0
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

        # Goal-scorer allocation reuses this same match-outcome prediction's
        # team-level expected goals -- see app.goal_scorer for why this is
        # allocation, not a separate model trained from scratch.
        for team_id, team_expected_goals in (
            (fixture["home_team_id"], prediction.predicted_home_goals),
            (fixture["away_team_id"], prediction.predicted_away_goals),
        ):
            for player_prediction in allocate_team_goals(team_expected_goals, team_id, player_shares):
                upsert_player_goal_prediction(conn, fixture["fixture_id"], team_id, player_prediction)
                goal_scorer_predictions += 1

    conn.commit()
    print(
        f"{competition_name}: wrote {predicted} predictions, skipped {skipped} (team not in training data), "
        f"{goal_scorer_predictions} player goal-scorer predictions."
    )


def fit_and_report(matches, label: str) -> DixonColesModel | None:
    if len(matches) < MIN_MATCHES_TO_FIT:
        print(f"Only {len(matches)} finished matches for {label}, skipping (need {MIN_MATCHES_TO_FIT}+).")
        return None
    model = DixonColesModel()
    model.fit(matches, half_life_days=HALF_LIFE_DAYS)
    print(
        f"{label} fit on {model.fitted_on} matches, {len(model.teams)} teams, "
        f"home_advantage={model.home_advantage:.3f}, rho={model.rho:.4f}"
    )
    return model


def main() -> None:
    conn = get_connection()
    try:
        matches = load_finished_matches(conn, JOINT_FIT_COMPETITIONS)
        if len(matches) < MIN_MATCHES_TO_FIT:
            print(f"Only {len(matches)} finished matches across {JOINT_FIT_COMPETITIONS}, skipping (need {MIN_MATCHES_TO_FIT}+).")
            return

        pl_matches = matches[matches["competition_name"] == "Premier League"]
        championship_matches = matches[matches["competition_name"] == "Championship"]

        pl_model = fit_and_report(pl_matches, "Premier League")
        championship_model = fit_and_report(championship_matches, "Championship")
        # Joint fit reuses every competition's matches, including FA Cup's --
        # it's the only one of the three that needs the cross-league
        # connection, so it's the only one that gets predicted from this model.
        joint_model = fit_and_report(matches, "Joint (Premier League + Championship + FA Cup, for FA Cup predictions)")

        # Player shares use the full cross-competition appearance history
        # regardless of which team-strength model ends up allocating for a
        # given fixture -- a player's rotation pattern and scoring rate for
        # their team is the same real thing whether it happened in a league
        # game or an FA Cup tie (see load_player_squad_appearances).
        appearances = load_player_squad_appearances(conn, JOINT_FIT_COMPETITIONS)
        as_of = matches["kickoff_date"].max()
        player_shares = compute_player_shares(appearances, as_of, half_life_days=HALF_LIFE_DAYS)
        print(
            f"Player shares: {player_shares['player_id'].nunique()} players across "
            f"{player_shares['team_id'].nunique()} teams have >= {MIN_PLAYER_MATCHES} squad appearances."
        )

        models_by_competition = {
            "Premier League": pl_model,
            "Championship": championship_model,
            "FA Cup": joint_model,
        }
        for competition_name in PREDICT_COMPETITIONS:
            model = models_by_competition[competition_name]
            if model is None:
                print(f"{competition_name}: skipped (not enough matches to fit).")
                continue
            predict_for_competition(conn, model, competition_name, player_shares)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
