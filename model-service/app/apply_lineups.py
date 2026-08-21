"""
Apply newly-confirmed matchday squads to the fixtures that have them --
the cheap counterpart to a full app.train run.

Why this exists. A confirmed lineup changes three things about a fixture's
predictions: the team-level availability adjustment scales its expected
goals, players not named are dropped from the scorer picks entirely, and
those who are named get their starting- or bench-specific minutes instead
of a season-blended average. None of that reaches the app until app.train
runs again.

The obvious fix -- rerun app.train after every hourly lineup check --
was tried on 2026-08-19 and caused a real production incident (see
.github/workflows/matchday-lineups.yml's own comment, and
docs/learning-log.md). The reasoning at the time was "app.train makes no
external API calls, so it's free", which was true and beside the point:
it refits three models AND rewrites a player_goal_predictions row for
every reliable player on every upcoming fixture across all three
competitions, one round trip each. That is ~77,000 upserts and about
twenty minutes. Fine once a day. Multiplied by 24, it exhausted the
account's Actions minutes within a day.

What makes this version cheap is the observation that almost none of that
work is what a lineup check actually needs. On any given hour at most a
handful of fixtures have a newly-confirmed squad, and the other ~900
upcoming fixtures' predictions are completely unaffected. So this reuses
app.train's own prediction loop with only_with_confirmed_lineups=True and
rewrites only those. The model fits still happen -- they have to, the
prediction needs fitted parameters -- but the upsert volume drops by
roughly three orders of magnitude.

Deliberately shares train.predict_for_competition rather than
reimplementing a fast path. A separate copy would be free to drift, and
then this job and the daily one would quietly disagree about the same
fixture, which is a far worse failure than being slow.

Usage: python -m app.apply_lineups
"""

from __future__ import annotations

import sys

from app.data import load_finished_matches, load_player_squad_appearances
from app.db import get_connection
from app.goal_scorer import MIN_PLAYER_MATCHES, compute_player_shares
from app.train import (
    HALF_LIFE_DAYS,
    JOINT_FIT_COMPETITIONS,
    MIN_MATCHES_TO_FIT,
    PREDICT_COMPETITIONS,
    SHRINKAGE,
    _blend,
    fit_and_report,
    predict_for_competition,
)


def main() -> None:
    conn = get_connection()
    try:
        matches = load_finished_matches(conn, JOINT_FIT_COMPETITIONS)
        if len(matches) < MIN_MATCHES_TO_FIT:
            print(f"Only {len(matches)} finished matches, skipping (need {MIN_MATCHES_TO_FIT}+).")
            return

        pl_model = fit_and_report(
            _blend(matches[matches["competition_name"] == "Premier League"], "Premier League"),
            "Premier League",
            shrinkage=SHRINKAGE["Premier League"],
        )
        championship_model = fit_and_report(
            _blend(matches[matches["competition_name"] == "Championship"], "Championship"),
            "Championship",
            shrinkage=SHRINKAGE["Championship"],
        )
        joint_model = fit_and_report(
            _blend(matches, "FA Cup"),
            "Joint (for FA Cup, and as the fallback for teams new to a competition)",
            shrinkage=SHRINKAGE["FA Cup"],
        )

        appearances = load_player_squad_appearances(conn, JOINT_FIT_COMPETITIONS)
        player_shares = compute_player_shares(appearances, matches["kickoff_date"].max(), half_life_days=HALF_LIFE_DAYS)
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
            predict_for_competition(
                conn,
                model,
                competition_name,
                player_shares,
                fallback_model=None if model is joint_model else joint_model,
                only_with_confirmed_lineups=True,
            )
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
