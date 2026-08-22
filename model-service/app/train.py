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

from app.data import (
    blend_fitting_signals,
    load_confirmed_lineups,
    load_finished_matches,
    load_player_squad_appearances,
    load_upcoming_fixtures,
)
from app.db import get_connection
from app.dixon_coles import DixonColesModel
from app.goal_scorer import MIN_PLAYER_MATCHES, allocate_team_goals, compute_player_shares, compute_team_availability

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

# How much of the fit's "goals" for a match is that side's own goals-
# scaled shots on target instead of the actual final score -- see
# app.data.blend_shots_on_target_into_scores. Per competition, not a
# single shared value: a real 2026-08-19 backtest (see
# app.evaluate.SHOTS_ON_TARGET_BLEND_WEIGHT's own comment and
# docs/learning-log.md's entry for the full table and reasoning) found
# Premier League, Championship, and FA Cup genuinely disagree on what
# helps, not just by a little -- a single compromise value would have
# left Premier League's real ~2.4% Brier improvement on the table.
# "FA Cup" here is the weight applied to the whole joint training set the
# joint fit below uses, not a per-row-competition split within it.
SHOTS_ON_TARGET_BLEND_WEIGHT: dict[str, float] = {
    "Premier League": 0.75,
    "Championship": 0.25,
    "FA Cup": 1.0,
}

# Same idea, but the proxy is built from shots INSIDE and OUTSIDE the box
# regressed separately, so the fit can learn that a shot from six yards is
# worth several from thirty. Where these columns exist this replaces the
# shots-on-target proxy for that match; where they don't, that match keeps
# the shots-on-target blend above (see app.data.blend_fitting_signals).
#
# ZERO EVERYWHERE as of 2026-08-22, including the Premier League, whose
# 0.75 was deployed for one day. The story is worth keeping in full,
# because the mistake is more useful than the setting.
#
# A single 80/20 split (2026-08-21) measured Premier League 0.75 as better
# than 0.0 by 0.00693 Brier, CI [-0.01384, +0.00001]. Not significant --
# the interval touched zero -- but promoted anyway on the argument that
# deployment is a symmetric-loss choice rather than a hypothesis test, and
# ~97.5% of the bootstrap mass sat below zero. The recorded caveat was
# that the dose-response curve was not clean: 0.25 came back slightly
# POSITIVE when a smooth real effect should have shown about a third of
# 0.75's gain.
#
# That caveat was the tell. Re-measured walk-forward (four consecutive
# held-out windows, ~2x the matches) the same comparison came back at
# +0.00129 in favour of 0.75, CI [-0.00359, +0.00606] -- the effect shrank
# 5.4x and now sits well inside noise. The interval tightened by 0.697,
# almost exactly the 1/sqrt(2) the extra data predicts, so the machinery
# was working; the effect simply was not there. Weight 0.5 came back
# indistinguishable from 0.75 (+0.00029), and 1.0 worse (+0.00316).
#
# So the choice is between options that cannot be told apart, and the
# argument that justified the promotion no longer holds -- what remains is
# a 0.00129 point estimate, an order of magnitude below anything else this
# model has adopted (the shots-on-target blend was worth 0.015). Among
# indistinguishable options, take the one with fewer moving parts: at 0.0
# the fit depends only on shots on target, with no operational dependency
# on shots_inside_box/shots_outside_box staying backfilled and current.
#
# Championship and FA Cup were never promoted and stay at 0. FA Cup is
# still measurably WORSE with location at 0.5 and 1.0 (CI excluding zero
# both times), which is a firmer reason for a 0 than an untested one.
#
# The columns stay populated and app.compare still sweeps them -- re-run
# "Paired model comparison" once the season adds matches. The lesson to
# carry: an effect that needs a symmetric-loss argument to justify shipping
# is an effect that has not been measured yet.
SHOT_LOCATION_BLEND_WEIGHT: dict[str, float] = {
    "Premier League": 0.0,
    "Championship": 0.0,
    "FA Cup": 0.0,
}

# L2 shrinkage on every team's fitted attack/defense toward league
# average -- see DixonColesModel.fit()'s own docstring for the mechanism.
# Real bug this fixes: West Ham, relegated into the Championship, had one
# single finished match in that competition's fit, and with zero
# regularization anywhere in the optimizer that one result alone pushed
# their fitted attack high enough to predict a 97.1% win probability and
# a 6.62-1.13 scoreline for their very next match.
#
# Validated 2026-08-21 (see app.evaluate.SHRINKAGE's own comment and
# docs/learning-log.md's entry for the full 11-value table): per
# competition, not a single shared value -- Premier League peaks at 1.0
# and gets worse past it, Championship peaks much further out at 5.0.
# FA Cup was still improving at the top of what got tested (10.0) with
# no peak found yet -- promoted as the best-tested-so-far value rather
# than a converged one, since FA Cup predictions aren't surfaced in the
# app yet (low stakes to be exactly right immediately) and the 3-season
# backtest sweep is cheap to rerun and refine later.
SHRINKAGE: dict[str, float] = {
    "Premier League": 1.0,
    "Championship": 5.0,
    "FA Cup": 10.0,
}

# Applied to a team's rating when it is IMPUTED into a competition's fit
# from the joint model (a promoted/relegated club with zero matches here
# yet -- see DixonColesModel.impute_team_from). 1.0 = the translated
# rating used as-is; below 1.0 = the imputed team scores less and concedes
# more than the translation says.
#
# MEASURED 2026-08-22 by app.estimate_promotion_penalty, which reconstructs
# what production WOULD have imputed on day one for every club that has
# changed divisions in our data, and compares it against the rating their
# actual season went on to earn.
#
# Premier League: 0.725, from 6 club-seasons, gap mean -0.643 (se 0.169,
# t -3.8), and every single one negative. Promoted clubs are
# systematically and substantially weaker than their translated
# Championship rating claims -- Southampton imputed at 1.145 and realized
# at 0.395, Leicester 1.103 -> 0.395, Ipswich 1.098 -> 0.450. This is the
# bias the Hull-over-Manchester-United fix left behind, now sized.
#
# Two honest caveats on that number. The cohorts disagree a lot: 2024/25's
# intake (Ipswich, Leicester, Southampton -- a historically bad trio) gives
# 0.608, while 2025/26's (Burnley, Leeds, Sunderland) gives 0.864. 0.725 is
# the pooled mean, which is the right point estimate under squared loss but
# is not a converged one, and it should be re-estimated every season. And
# the correction folds together two mechanisms it cannot separate: the
# joint fit's kappa=10 shrinkage compressing everyone toward its own mean,
# and genuine promoted-club underperformance. That is fine for correcting
# the prediction and would matter if either mechanism were changed.
#
# Championship: 1.0, and the reason is the more interesting half of the
# result. Pooled across its 12 club-seasons the estimator suggested 1.025 --
# apparently "no measurable bias". Split by where the club came FROM, that
# turns out to be two opposite effects cancelling:
#     relegated from the Premier League   1.146  (n=6, t +1.2)
#     arrived from League One             0.918  (n=6, t -2.2)
# Neither clears a convincing bar on its own and they point opposite ways,
# so a single per-competition number cannot express what is happening here
# and 1.0 stays. Acting on either would need PROMOTION_PENALTY keyed by
# (competition, origin) rather than competition alone -- worth building
# only once the per-origin estimates are strong enough to be worth
# applying, which they are not yet.
#
# The Premier League has exactly one intake route (from the Championship),
# which is precisely why its signal is clean and the Championship's is not.
PROMOTION_PENALTY: dict[str, float] = {
    "Premier League": 0.725,
    "Championship": 1.0,
    "FA Cup": 1.0,
}


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


def _predict_fixture(model: DixonColesModel, fixture, home_availability: float, away_availability: float):
    """
    Shared by the primary and fallback paths below so the two can't drift
    apart -- a fallback prediction that silently skipped the availability
    adjustment would be a subtle, hard-to-spot inconsistency.
    """
    if home_availability == 1.0 and away_availability == 1.0:
        # No confirmed squad yet (or a full-strength one) for either side --
        # identical to predict(), so call it directly for the common case.
        return model.predict(fixture["home_team"], fixture["away_team"])
    return model.predict_with_availability(
        fixture["home_team"], fixture["away_team"], home_availability, away_availability
    )


def predict_for_competition(
    conn,
    model: DixonColesModel,
    competition_name: str,
    player_shares,
    fallback_model: DixonColesModel | None = None,
    only_with_confirmed_lineups: bool = False,
    imputed_strength_penalty: float = 1.0,
) -> None:
    """
    only_with_confirmed_lineups restricts the rewrite to fixtures that
    actually have a confirmed matchday squad -- see app.apply_lineups for
    why that distinction is worth a parameter. Everything else is
    identical, deliberately: the two paths must produce the same
    prediction for the same fixture, so they share one loop rather than
    having a fast copy that can drift from the real one.
    """
    upcoming = load_upcoming_fixtures(conn, competition_name)
    # Bulk-loaded once per competition rather than per fixture -- most
    # upcoming fixtures have no confirmed squad yet (typically only
    # announced ~1 hour before kickoff, see matchday-lineups.yml), so this
    # is usually a near-empty frame and one query beats N.
    confirmed = load_confirmed_lineups(conn, upcoming["fixture_id"].tolist())
    predicted = 0
    skipped = 0
    goal_scorer_predictions = 0
    availability_adjusted = 0
    fell_back = 0
    for _, fixture in upcoming.iterrows():
        fixture_lineup = confirmed[confirmed["fixture_id"] == fixture["fixture_id"]]
        if only_with_confirmed_lineups and fixture_lineup.empty:
            continue
        home_confirmed = set(fixture_lineup[fixture_lineup["team_id"] == fixture["home_team_id"]]["player_id"])
        away_confirmed = set(fixture_lineup[fixture_lineup["team_id"] == fixture["away_team_id"]]["player_id"])
        home_availability = compute_team_availability(fixture["home_team_id"], home_confirmed, player_shares)
        away_availability = compute_team_availability(fixture["away_team_id"], away_confirmed, player_shares)

        try:
            prediction = _predict_fixture(model, fixture, home_availability, away_availability)
        except ValueError:
            # A team with no finished matches in THIS competition yet has no
            # fitted attack/defense here. Real production bug this fixes,
            # found 2026-08-21 via app.diagnose_coverage: that's the normal
            # state of a newly-promoted side for the whole first part of a
            # season -- Coventry and Hull City had zero finished Premier
            # League matches on the opening weekend -- and skipping outright
            # meant every one of their ~38 fixtures produced no prediction
            # AND no goal-scorer picks at all, including for a fully-fitted
            # opponent like Arsenal sitting on 42 reliable players. One
            # side's missing history was suppressing the other side's.
            #
            # The joint fit knows the missing team: it spans all three
            # competitions, so a promoted club with a full Championship
            # record is in it even when this competition's own fit has
            # never seen them.
            #
            # Revised 2026-08-22 after a second real production bug on this
            # exact path. The original fallback predicted the WHOLE fixture
            # with the joint model, and the joint model is tuned for the FA
            # Cup, not for this: its shrinkage (10.0) flattens every team
            # toward average -- which costs an established giant far more
            # than a promoted club, since the giant is the one far from
            # average -- and its home advantage (~1.5 vs the Premier
            # League's own ~1.18, inflated by cup ties) then decides the
            # fixture for whoever is at home. Net effect: Hull City, zero
            # Premier League matches, picked to BEAT Manchester United at
            # home. Every fallback fixture had the same home-side
            # inflation; that one was just visible.
            #
            # Now only the missing team's rating is borrowed, translated
            # onto this competition's own scale (see impute_team_from for
            # the re-centring), and the fixture is predicted by this
            # competition's own fit -- the opponent's real rating, home
            # advantage, and rho stay in charge. The translated rating
            # still inherits the joint fit's flattening (a known residual
            # optimism for promoted sides, testable via app.compare once
            # they accumulate real matches), but the fixture is no longer
            # decided by parameters tuned for a different competition.
            if fallback_model is None:
                skipped += 1
                continue
            try:
                for team in (fixture["home_team"], fixture["away_team"]):
                    model.impute_team_from(team, fallback_model, strength_penalty=imputed_strength_penalty)
                prediction = _predict_fixture(model, fixture, home_availability, away_availability)
                fell_back += 1
            except ValueError:
                # Not in the joint fit either -- genuinely no data anywhere
                # (a non-league FA Cup entrant with zero appearances). Skip
                # rather than guess with an arbitrary default.
                skipped += 1
                continue

        if home_availability != 1.0 or away_availability != 1.0:
            availability_adjusted += 1
        upsert_prediction(conn, fixture["fixture_id"], prediction)
        predicted += 1

        # Goal-scorer allocation reuses this same match-outcome prediction's
        # team-level expected goals -- see app.goal_scorer for why this is
        # allocation, not a separate model trained from scratch. Confirmed
        # squad/starting-XI membership (home_confirmed/away_confirmed,
        # already loaded above for the team-level availability adjustment)
        # is reused here too, for the separate per-player question of
        # whether a specific reliable player is even in the squad, and
        # whether he's starting or on the bench for this one fixture --
        # see allocate_team_goals for why that changes his own scorer odds.
        for team_id, team_expected_goals, team_confirmed in (
            (fixture["home_team_id"], prediction.predicted_home_goals, home_confirmed),
            (fixture["away_team_id"], prediction.predicted_away_goals, away_confirmed),
        ):
            team_starting = set(
                fixture_lineup[(fixture_lineup["team_id"] == team_id) & fixture_lineup["is_starting"]]["player_id"]
            )
            for player_prediction in allocate_team_goals(
                team_expected_goals, team_id, player_shares, confirmed_squad=team_confirmed, confirmed_starting=team_starting
            ):
                upsert_player_goal_prediction(conn, fixture["fixture_id"], team_id, player_prediction)
                goal_scorer_predictions += 1

    conn.commit()
    print(
        f"{competition_name}: wrote {predicted} predictions ({availability_adjusted} availability-adjusted, "
        f"{fell_back} with a rating imputed from the joint fit for a team new to this competition), "
        f"skipped {skipped} (team not in any training data), {goal_scorer_predictions} player goal-scorer predictions."
    )


def _blend(matches, competition_name: str):
    """This competition's two blend weights, applied. Mirrors app.evaluate._blend."""
    return blend_fitting_signals(
        matches, SHOT_LOCATION_BLEND_WEIGHT[competition_name], SHOTS_ON_TARGET_BLEND_WEIGHT[competition_name]
    )


def fit_and_report(matches, label: str, shrinkage: float) -> DixonColesModel | None:
    if len(matches) < MIN_MATCHES_TO_FIT:
        print(f"Only {len(matches)} finished matches for {label}, skipping (need {MIN_MATCHES_TO_FIT}+).")
        return None
    model = DixonColesModel()
    model.fit(matches, half_life_days=HALF_LIFE_DAYS, shrinkage=shrinkage)
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

        pl_model = fit_and_report(
            _blend(pl_matches, "Premier League"),
            "Premier League",
            shrinkage=SHRINKAGE["Premier League"],
        )
        championship_model = fit_and_report(
            _blend(championship_matches, "Championship"),
            "Championship",
            shrinkage=SHRINKAGE["Championship"],
        )
        # Joint fit reuses every competition's matches, including FA Cup's --
        # it's the only one of the three that needs the cross-league
        # connection, so it's the only one that gets predicted from this model.
        joint_model = fit_and_report(
            _blend(matches, "FA Cup"),
            "Joint (Premier League + Championship + FA Cup, for FA Cup predictions)",
            shrinkage=SHRINKAGE["FA Cup"],
        )

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
            # The joint fit backstops a team this competition's own fit has
            # never seen -- a newly-promoted/relegated side early in a
            # season (see predict_for_competition's ValueError branch).
            # Passed as None for FA Cup, which already IS the joint fit, so
            # there'd be nothing left to fall back to.
            fallback = None if model is joint_model else joint_model
            predict_for_competition(
                conn,
                model,
                competition_name,
                player_shares,
                fallback_model=fallback,
                imputed_strength_penalty=PROMOTION_PENALTY[competition_name],
            )
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
