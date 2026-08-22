"""
Measure what a division-changing club's imputed rating SHOULD be
multiplied by, from the clubs that already did it.

The question. When a promoted club has no matches in its new competition,
its rating is imputed from the joint fit (DixonColesModel.impute_team_from).
That translated rating carries two biases in the same direction: the joint
fit's shrinkage compresses everyone toward its own average, and clubs
changing divisions systematically deviate from their old-division form.
app.train.PROMOTION_PENALTY is the knob that corrects for both at once --
this module measures what it should be.

The method. For every season boundary in the data, find the clubs that
appear in a competition's fixtures that season but not the season before
(promoted into the Premier League; relegated into the Championship). For
each such club:

  1. Fit the joint model and the competition model on ONLY the matches
     before that season started -- exactly what production knew on day one.
  2. Impute the club into the competition fit (penalty 1.0): this is the
     rating production WOULD have used.
  3. Fit the competition model again on data through the season's end:
     the club's REALIZED rating, estimated from its actual matches.
  4. The gap, in log-strength space, is the bias the penalty exists to
     remove. strength = attack/defense; the penalty multiplies attack by s
     and divides defense by s, so log(strength) moves by 2*log(s), and
     s_hat = exp(mean_gap / 2).

Both fits centre "1.0 = my own league's average", so each rating is
relative-to-league -- which is the comparable quantity across seasons even
though the league's membership rotates.

Honest limitations, printed with the result rather than hidden: ~3 clubs
change divisions per competition per season and the data holds ~2 usable
boundaries, so n is small (~6 per direction) and the pooled estimate is a
mean of noisy numbers. That is still far better than the current
guess-of-1.0, which is not an estimate at all but a default. The
per-direction split (promoted vs relegated) exists because there is no
reason the biases should be symmetric.

Reads only. Usage: python -m app.estimate_promotion_penalty
"""

from __future__ import annotations

import sys
from math import exp, log

import numpy as np
import pandas as pd

from app.data import _query_df, load_finished_matches
from app.db import get_connection
from app.dixon_coles import DixonColesModel
from app.evaluate import HALF_LIFE_DAYS, SHRINKAGE, _blend

# A realized rating estimated from fewer matches than this is noise, and a
# noisy target makes the measured "bias" mostly a measurement of nothing.
MIN_REALIZED_MATCHES = 10

# Day-one imputation in production runs against seasons of history; an
# estimate built from less would be measuring a situation production is
# never in.
MIN_PRIOR_HISTORY = 200

FIT_COMPETITIONS = ["Premier League", "Championship", "FA Cup"]
DIRECTIONS = ["Premier League", "Championship"]

# Which competitions count as "where a club was last season". FA Cup is
# excluded deliberately: every club plays it, so it says nothing about
# which division they came from.
LEAGUE_COMPETITIONS = ["Premier League", "Championship"]

OUTSIDE = "outside the tracked leagues"


def load_matches_with_season(conn) -> pd.DataFrame:
    """
    load_finished_matches plus each fixture's season label, which is what
    makes "which clubs are new to this competition this season?" answerable.

    Deliberately REUSES load_finished_matches rather than reimplementing
    its SELECT with one extra column. The first version did reimplement it,
    copied the shot-stat columns without the two LEFT JOINs that define
    home_stats/away_stats, and shipped -- because the end-to-end test
    monkeypatches this whole function, so its SQL was never executed
    anywhere except production. Same shape as the app.compare NameError:
    a query that only runs in production is untested by default. Fetching
    the labels separately and merging keeps the risky query in the one
    place that is already exercised everywhere else.
    """
    matches = load_finished_matches(conn, FIT_COMPETITIONS)
    seasons = _query_df(
        conn,
        """
        SELECT f.id AS fixture_id, s.label AS season_label
        FROM fixtures f
        JOIN competition_seasons cs ON cs.id = f.competition_season_id
        JOIN seasons s ON s.id = cs.season_id
        """,
    )
    return matches.merge(seasons, on="fixture_id", how="left")


def teams_in(matches: pd.DataFrame) -> set[str]:
    return set(matches["home_team"]) | set(matches["away_team"])


def newcomers_by_season(matches: pd.DataFrame, competition: str) -> list[tuple[str, str, set[str]]]:
    """
    (season_label, previous_season_label, teams new to this competition
    that season), season pairs in chronological order. The first season in
    the data has no "before" to compare against and is skipped -- every
    team would count as new.
    """
    competition_matches = matches[matches["competition_name"] == competition]
    seasons = (
        competition_matches.groupby("season_label")["kickoff_date"].min().sort_values().index.tolist()
    )
    result = []
    for previous, current in zip(seasons, seasons[1:]):
        before = teams_in(competition_matches[competition_matches["season_label"] == previous])
        now = teams_in(competition_matches[competition_matches["season_label"] == current])
        result.append((current, previous, now - before))
    return result


def classify_origin(matches: pd.DataFrame, team: str, previous_season: str, target: str) -> str:
    """
    Where a newcomer came FROM, which turns out to matter more than where
    they arrived.

    Found 2026-08-22, running this for real. Grouping only by destination
    made the Championship look unbiased (penalty 1.025 from 12
    club-seasons) -- but that set mixes two opposite populations. A club
    entering the Championship either dropped from the Premier League
    (rich history, 38 top-flight matches, and they tend to be STRONGER
    than the translation says: +1.146) or came up from League One (which
    this database does not track at all, so their imputed rating rests on
    a handful of FA Cup ties, and they come out WEAKER: 0.918). Averaged
    together those cancel to nothing, and "no measurable bias" was an
    artifact of the grouping rather than a fact about the world.

    The Premier League direction has no such problem and that is why its
    signal is clean: there is exactly one way in, from the Championship.

    Returns the league the club played in last season, or OUTSIDE when
    they played in neither tracked league -- which is itself the
    interesting category, since it means the imputation had almost nothing
    to work from.
    """
    played = matches[
        (matches["season_label"] == previous_season)
        & (matches["competition_name"].isin(LEAGUE_COMPETITIONS))
        & ((matches["home_team"] == team) | (matches["away_team"] == team))
    ]
    leagues = set(played["competition_name"]) - {target}
    if not leagues:
        return OUTSIDE
    return sorted(leagues)[0]  # a club plays one league in a season


def log_strength(model: DixonColesModel, team: str) -> float:
    return log(model.attack[team]) - log(model.defense[team])


def penalty_from_gaps(gaps: list[float]) -> float:
    """
    The penalty multiplies attack by s and divides defense by s, moving
    log-strength by 2*log(s) -- so the s that removes the mean bias is
    exp(mean_gap / 2). gap = realized - imputed, negative when the club
    was worse than its translated rating said.
    """
    return exp(float(np.mean(gaps)) / 2)


def main() -> None:
    conn = get_connection()
    try:
        matches = load_matches_with_season(conn)
        if matches.empty:
            print("No finished matches -- nothing to estimate from.")
            return

        all_gaps: dict[tuple[str, str], list[float]] = {}
        for competition in DIRECTIONS:
            print(f"=== {competition} ===")
            for season, previous, newcomers in newcomers_by_season(matches, competition):
                if not newcomers:
                    continue
                competition_matches = matches[matches["competition_name"] == competition]
                season_matches = competition_matches[competition_matches["season_label"] == season]
                season_start = season_matches["kickoff_date"].min()
                season_end = season_matches["kickoff_date"].max()

                history = matches[matches["kickoff_date"] < season_start]
                if len(history) < MIN_PRIOR_HISTORY:
                    print(f"  {season}: only {len(history)} matches of prior history, skipped "
                          f"(day-one imputation would never have run on this little).")
                    continue

                joint = DixonColesModel()
                joint.fit(_blend(history, "FA Cup"), half_life_days=HALF_LIFE_DAYS, shrinkage=SHRINKAGE["FA Cup"])

                day_one = DixonColesModel()
                day_one.fit(
                    _blend(history[history["competition_name"] == competition], competition),
                    half_life_days=HALF_LIFE_DAYS,
                    shrinkage=SHRINKAGE[competition],
                )

                realized_fit = DixonColesModel()
                realized_fit.fit(
                    _blend(
                        competition_matches[competition_matches["kickoff_date"] <= season_end], competition
                    ),
                    half_life_days=HALF_LIFE_DAYS,
                    shrinkage=SHRINKAGE[competition],
                )

                for team in sorted(newcomers):
                    played = season_matches[
                        (season_matches["home_team"] == team) | (season_matches["away_team"] == team)
                    ]
                    if len(played) < MIN_REALIZED_MATCHES:
                        print(f"  {season} {team}: only {len(played)} matches, skipped (realized rating too noisy).")
                        continue
                    try:
                        day_one.impute_team_from(team, joint)
                    except ValueError as error:
                        print(f"  {season} {team}: cannot impute ({error}), skipped.")
                        continue
                    if team not in realized_fit.attack:
                        continue
                    imputed = log_strength(day_one, team)
                    realized = log_strength(realized_fit, team)
                    gap = realized - imputed
                    origin = classify_origin(matches, team, previous, competition)
                    all_gaps.setdefault((competition, origin), []).append(gap)
                    print(
                        f"  {season} {team} (from {origin}): imputed strength {exp(imputed):.3f}, "
                        f"realized {exp(realized):.3f}, gap {gap:+.3f} "
                        f"({'worse' if gap < 0 else 'better'} than the translation said)"
                    )
            print()

        print("=== Suggested PROMOTION_PENALTY ===")
        for competition in DIRECTIONS:
            groups = {origin: gaps for (comp, origin), gaps in all_gaps.items() if comp == competition}
            pooled = [gap for gaps in groups.values() for gap in gaps]
            if not pooled:
                print(f"  {competition}: no usable club-seasons.")
                continue

            print(f"  {competition}: pooled {penalty_from_gaps(pooled):.3f} from {len(pooled)} club-seasons "
                  f"(gap mean {np.mean(pooled):+.3f}).")
            for origin, gaps in sorted(groups.items()):
                if len(gaps) < 3:
                    print(f"    from {origin}: only {len(gaps)} club-season(s) -- too few to read.")
                    continue
                # Standard error, not just spread: with n this small the
                # question is whether the mean is distinguishable from
                # zero at all, and sd alone does not answer that.
                standard_error = float(np.std(gaps, ddof=1)) / len(gaps) ** 0.5
                same_sign = sum(1 for gap in gaps if (gap < 0) == (np.mean(gaps) < 0))
                print(
                    f"    from {origin}: {penalty_from_gaps(gaps):.3f} from {len(gaps)} club-seasons "
                    f"(mean {np.mean(gaps):+.3f}, se {standard_error:.3f}, "
                    f"t {np.mean(gaps) / standard_error:+.2f}, {same_sign}/{len(gaps)} same sign)."
                )
            if len(groups) > 1:
                print(
                    "    NOTE: this competition has more than one intake route, and they can "
                    "point OPPOSITE ways.\n"
                    "    Read the per-origin rows, not the pooled one -- a pooled value near 1.0 "
                    "may be two real\n    effects cancelling rather than an absence of bias."
                )
        print(
            "\nPromote by editing app.train.PROMOTION_PENALTY. Treat a value within a few percent\n"
            "of 1.0 as 'no measurable bias' rather than signal, and prefer a group where the sign\n"
            "is consistent across club-seasons over one with a large mean and a mixed sign."
        )
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
