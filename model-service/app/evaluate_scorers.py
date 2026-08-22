"""
Backtest for the goal-scorer model -- the first one it has ever had.

Why this exists. Every team-level change in this project went through a
real held-out comparison before shipping. The goal-scorer model shipped on
plausibility alone: the maths is reasonable, the outputs looked sane, and
nobody ever scored it against what actually happened. That is the largest
untested surface in the codebase, and it is the one the app displays most
prominently.

What it measures, in priority order:

1. CALIBRATION -- do the probabilities mean what they say? If we assign
   0.20 to a hundred player-fixtures, about twenty of those players should
   score. This is the headline number, because a scorer probability is
   read directly as a price. Reported as predicted-scorers / actual-
   scorers: 1.0 is perfect, below 1.0 means we systematically under-call.
2. DISCRIMINATION -- given that the overall level is right, do we rank the
   right players higher? Measured by AUC, which is invariant to any
   monotone rescaling and therefore says nothing about calibration. The
   two failures are independent and need separate numbers.
3. Brier and log loss, which mix the two, for comparability with
   app.evaluate.

Every one of those is reported against a BASE-RATE baseline: the same
probability for everyone, equal to the historical rate of a squad player
scoring. That baseline is perfectly calibrated by construction and has
zero discrimination (AUC 0.5), which makes it exactly the right thing to
beat -- if our model can't beat it, the per-player machinery is adding
nothing over "someone scores sometimes."

Two prediction modes, because production runs in both:
  - "no lineup": how a fixture looks days ahead, on the Predictions page.
    Every reliable player is predicted using his season-blended minutes.
  - "confirmed lineup": how it looks an hour before kickoff, once
    fixture_lineups is populated. Players not named are dropped; starters
    and bench get their role-specific minutes.

WALK-FORWARD (2026-08-22), and here it fixes a bias rather than just
tightening an interval. The first version froze player_shares at a single
cutoff and scored every match after it -- more than a full season. But a
player only enters the shares pool once he has MIN_PLAYER_MATCHES
appearances, so with a frozen cutoff every summer signing, every academy
debut and every January arrival in the test window is invisible to the
model and their goals count against it. Production retrains daily and has
no such blind spot.

That inflated exactly the quantity the allocation decision turns on. The
2026-08-22 run measured reliable players covering ~72% of goals; the
"expected" mode, which withholds the share of players below the
reliability threshold, only found 5% to withhold. The missing ~23% was not
fringe players at all -- it was players who did not exist in the training
data yet, an artifact of the frozen cutoff.

Now each fold recomputes the shares as of its own boundary, so staleness
is bounded by the fold width instead of by the whole test window, which is
much closer to what production actually does.

Reads only. Usage: python -m app.evaluate_scorers
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from app.data import (
    load_confirmed_lineups,
    load_finished_matches,
    load_fixture_player_goals,
    load_player_squad_appearances,
)
from app.db import get_connection
from app.dixon_coles import DixonColesModel
from app.evaluate import (
    FIT_COMPETITIONS,
    FOLD_FRACTION,
    FOLDS,
    HALF_LIFE_DAYS,
    MIN_MATCHES_FOR_BACKTEST,
    SHRINKAGE,
    _blend,
    _fold_frames,
    walk_forward_folds,
)
from app.goal_scorer import ALLOCATION_MODES, allocate_team_goals, compute_player_shares

MIN_PREDICTIONS_TO_REPORT = 200
EPSILON = 1e-9  # log-loss guard; probabilities can legitimately reach 0 for a zero-share player


def _auc(probabilities: np.ndarray, outcomes: np.ndarray) -> float | None:
    """
    Probability that a randomly chosen scorer was ranked above a randomly
    chosen non-scorer. 0.5 is coin-flip ranking, 1.0 is perfect.

    Computed by the rank-sum identity rather than by sweeping thresholds --
    same number, no ROC curve to build. Ties get average ranks, which is
    what makes a model that outputs one constant score exactly 0.5 instead
    of accidentally winning or losing on tie-break order.
    """
    positives = outcomes == 1
    n_pos = int(positives.sum())
    n_neg = int(len(outcomes) - n_pos)
    if n_pos == 0 or n_neg == 0:
        return None
    ranks = pd.Series(probabilities).rank(method="average").to_numpy()
    return float((ranks[positives].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def _score(label: str, probabilities: np.ndarray, outcomes: np.ndarray) -> dict:
    clipped = np.clip(probabilities, EPSILON, 1 - EPSILON)
    predicted_scorers = float(probabilities.sum())
    actual_scorers = float(outcomes.sum())
    return {
        "label": label,
        "n": len(outcomes),
        "predicted_scorers": predicted_scorers,
        "actual_scorers": actual_scorers,
        "calibration": predicted_scorers / actual_scorers if actual_scorers > 0 else float("nan"),
        "brier": float(np.mean((probabilities - outcomes) ** 2)),
        "log_loss": float(-np.mean(outcomes * np.log(clipped) + (1 - outcomes) * np.log(1 - clipped))),
        "auc": _auc(probabilities, outcomes),
    }


def _print_scores(rows: list[dict]) -> None:
    print(f"  {'':<26} {'n':>7} {'pred':>8} {'actual':>8} {'calib':>7} {'Brier':>8} {'logloss':>8} {'AUC':>6}")
    for row in rows:
        auc = f"{row['auc']:.3f}" if row["auc"] is not None else "   -- "
        print(
            f"  {row['label']:<26} {row['n']:>7} {row['predicted_scorers']:>8.1f} {row['actual_scorers']:>8.0f} "
            f"{row['calibration']:>7.3f} {row['brier']:>8.5f} {row['log_loss']:>8.5f} {auc:>6}"
        )


def _predict_fixtures(
    test_matches: pd.DataFrame,
    models: dict[str, DixonColesModel],
    joint_model: DixonColesModel,
    player_shares: pd.DataFrame,
    lineups: pd.DataFrame,
    use_confirmed_lineup: bool,
    normalization: str,
) -> pd.DataFrame:
    """One row per (fixture, player) predicted, with the probability we'd have shown."""
    predictions = []
    for match in test_matches.itertuples():
        model = models.get(match.competition_name, joint_model)
        try:
            prediction = model.predict(match.home_team, match.away_team)
        except ValueError:
            # Mirrors production's fallback exactly (see app.train's
            # 2026-08-22 note): borrow the missing team's rating from the
            # joint fit, translated onto this competition's scale, rather
            # than predicting the whole fixture with a model tuned for the
            # FA Cup. A backtest that fell back differently from
            # production would be measuring a pipeline nobody runs.
            try:
                for team in (match.home_team, match.away_team):
                    model.impute_team_from(team, joint_model)
                prediction = model.predict(match.home_team, match.away_team)
            except ValueError:
                continue  # no fitted parameters anywhere -- same skip production makes

        fixture_lineup = lineups[lineups["fixture_id"] == match.fixture_id]
        for team_id, team_expected_goals in (
            (match.home_team_id, prediction.predicted_home_goals),
            (match.away_team_id, prediction.predicted_away_goals),
        ):
            confirmed_squad: set[int] = set()
            confirmed_starting: set[int] = set()
            if use_confirmed_lineup:
                team_rows = fixture_lineup[fixture_lineup["team_id"] == team_id]
                confirmed_squad = set(team_rows["player_id"])
                confirmed_starting = set(team_rows[team_rows["is_starting"]]["player_id"])
                if not confirmed_squad:
                    continue  # no recorded lineup for this side -- nothing to score
            for player_prediction in allocate_team_goals(
                team_expected_goals,
                team_id,
                player_shares,
                confirmed_squad=confirmed_squad,
                confirmed_starting=confirmed_starting,
                normalization=normalization,
            ):
                predictions.append(
                    {
                        "fixture_id": int(match.fixture_id),
                        "competition_name": match.competition_name,
                        "player_id": player_prediction.player_id,
                        "prob_scores": player_prediction.prob_scores,
                    }
                )
    return pd.DataFrame(predictions)


def _attach_outcomes(predictions: pd.DataFrame, actual_goals: pd.DataFrame) -> pd.DataFrame:
    """
    Joins on what actually happened. A predicted player with no ground-truth
    row did not appear in that match's squad at all and therefore scored
    zero -- filled in rather than dropped, because dropping him would only
    ever remove a confident prediction that turned out wrong, which is the
    single most flattering thing a backtest can do to itself.
    """
    truth = actual_goals[["fixture_id", "player_id", "goals"]]
    merged = predictions.merge(truth, on=["fixture_id", "player_id"], how="left")
    merged["goals"] = merged["goals"].fillna(0)
    merged["scored"] = (merged["goals"] > 0).astype(float)
    return merged


def _fit_fold(train_matches: pd.DataFrame) -> tuple[dict[str, DixonColesModel], DixonColesModel]:
    """The three fits app.train builds, from one fold's training window."""
    joint = DixonColesModel()
    joint.fit(_blend(train_matches, "FA Cup"), half_life_days=HALF_LIFE_DAYS, shrinkage=SHRINKAGE["FA Cup"])
    models: dict[str, DixonColesModel] = {"FA Cup": joint}
    for competition in ("Premier League", "Championship"):
        competition_matches = train_matches[train_matches["competition_name"] == competition]
        if len(competition_matches) < MIN_MATCHES_FOR_BACKTEST:
            continue
        model = DixonColesModel()
        model.fit(
            _blend(competition_matches, competition),
            half_life_days=HALF_LIFE_DAYS,
            shrinkage=SHRINKAGE[competition],
        )
        models[competition] = model
    return models, joint


def main() -> None:
    conn = get_connection()
    try:
        matches = load_finished_matches(conn, FIT_COMPETITIONS)
        if len(matches) < MIN_MATCHES_FOR_BACKTEST:
            print(f"Only {len(matches)} matches, not enough for a meaningful backtest.")
            return

        folds = walk_forward_folds(matches)
        if not folds:
            print("Not enough date spread to build walk-forward folds.")
            return
        first_cutoff = folds[0][0]
        print(
            f"Goal-scorer backtest, {len(folds)} walk-forward windows from {first_cutoff}\n"
            f"  each scored by models AND player shares built only from matches before it"
        )

        actual_goals = load_fixture_player_goals(conn, FIT_COMPETITIONS)
        actual_goals = actual_goals[actual_goals["kickoff_date"] >= first_cutoff]

        # Same loader production uses on matchday, so "starting" here means
        # exactly what it means live. Note these lineups are the one thing
        # in this backtest that genuinely IS from the future -- which is
        # correct, because by the time production allocates with them they
        # are the present. That's what separates the two modes below.
        held_out = matches[matches["kickoff_date"] >= first_cutoff]
        lineups = load_confirmed_lineups(conn, held_out["fixture_id"].tolist())
        print(f"Confirmed lineup rows for held-out fixtures: {len(lineups)}")

        # The optimism the matchday mode carries, made visible rather than
        # assumed away. Held-out fixtures are FINISHED, so their lineup
        # rows were almost all written by the post-match backfill -- the
        # same announced XI, but retrieved after the fact. Scoring that
        # mode on them silently assumes we would have had every one of
        # those lineups before kickoff, which is exactly the assumption
        # that fails where pre-match capture doesn't work. Nothing to
        # correct with until pre-match captures accumulate (see migration
        # 1701000000027) -- but a run reporting 0% here is reporting a
        # ceiling on the matchday mode, not its real performance.
        if "pre_match_captured_at" in lineups.columns and len(lineups) > 0:
            pre_match = int(lineups["pre_match_captured_at"].notna().sum())
            print(
                f"  of which captured PRE-match: {pre_match}/{len(lineups)} "
                f"({pre_match / len(lineups):.0%}) -- the rest were backfilled after the final whistle,\n"
                f"  so the matchday mode below is an upper bound on what was actually knowable in time."
            )

        # One pass over the folds, accumulating predictions per (mode,
        # normalization). Each fold refits the models AND recomputes the
        # player shares as of its own boundary, so a player who becomes
        # reliable mid-window is invisible to the folds before him and
        # visible to the ones after -- which is what production does, and
        # what a single frozen cutoff got wrong.
        collected: dict[tuple[bool, str], list[pd.DataFrame]] = {}
        for fold_number, (start, end) in enumerate(folds, start=1):
            train, test = _fold_frames(matches, start, end)
            models, joint_model = _fit_fold(train)
            appearances = load_player_squad_appearances(conn, FIT_COMPETITIONS, as_of=start)
            player_shares = compute_player_shares(appearances, start, half_life_days=HALF_LIFE_DAYS)
            print(
                f"  fold {fold_number}: train < {start}, {len(test)} held-out fixtures, "
                f"{player_shares['player_id'].nunique()} reliable players from "
                f"{len(appearances)} appearances"
            )
            for use_confirmed_lineup in (False, True):
                for normalization in ALLOCATION_MODES:
                    predictions = _predict_fixtures(
                        test, models, joint_model, player_shares, lineups, use_confirmed_lineup, normalization
                    )
                    if not predictions.empty:
                        collected.setdefault((use_confirmed_lineup, normalization), []).append(predictions)
        print()

        for use_confirmed_lineup, mode in ((False, "no lineup (days ahead)"), (True, "confirmed lineup (matchday)")):
            # Every allocation mode scored on the SAME held-out
            # player-fixtures, so they are read off one run rather than
            # three. See app.goal_scorer.ALLOCATION_MODE for what differs;
            # calibration is the column that separates them, since all
            # three are monotone rescales and therefore share an AUC.
            variants = {}
            for normalization in ALLOCATION_MODES:
                frames = collected.get((use_confirmed_lineup, normalization), [])
                if frames:
                    variants[f"model ({normalization})"] = _attach_outcomes(pd.concat(frames), actual_goals)
            if not variants:
                print(f"--- {mode} --- no predictions produced.\n")
                continue

            reference = next(iter(variants.values()))
            print(f"--- {mode} --- {len(reference)} player-fixtures")
            for competition in FIT_COMPETITIONS + ["ALL"]:
                mask = reference["competition_name"] == competition
                if competition != "ALL" and int(mask.sum()) < MIN_PREDICTIONS_TO_REPORT:
                    continue
                rows = []
                for name, scored in variants.items():
                    subset = scored if competition == "ALL" else scored[scored["competition_name"] == competition]
                    rows.append(
                        _score(name, subset["prob_scores"].to_numpy(dtype=float), subset["scored"].to_numpy(dtype=float))
                    )
                # The baseline every number here has to beat: one constant
                # probability for everybody, set to the observed rate. It is
                # perfectly calibrated by construction and ranks nobody.
                outcomes = (reference if competition == "ALL" else reference[mask])["scored"].to_numpy(dtype=float)
                rows.append(_score("base rate (constant)", np.full(len(outcomes), float(outcomes.mean())), outcomes))
                print(f"\n {competition}")
                _print_scores(rows)
            print()
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
