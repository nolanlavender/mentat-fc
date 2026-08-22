"""
Sanity-check the model's upcoming predictions against the betting market.

Why this exists. Every embarrassing prediction this project has produced
-- West Ham at 97.1%, a 6.62-goal scoreline, Hull City picked to beat
Manchester United -- was caught the same way: a person happened to look at
a screen. Each had been sitting in model_predictions for hours or days,
and each would have been flagged instantly by comparing it to a bookmaker,
because every one of those bugs produced a probability wildly out of line
with the market. The market is not the ground truth (if we believed that,
there'd be no point having a model), but it is an extremely well-funded
opinion, and disagreeing with it by 20+ points is far more often a bug in
our pipeline than an edge.

So: for every upcoming fixture that has both a model prediction and fresh
pre-match odds (seeded by backend's db:seed:upcoming-odds), strip the
bookmaker margin from the odds and compare the two probability vectors.
Anything past DIVERGENCE_THRESHOLD gets printed -- and the process EXITS
NONZERO, which is the entire alerting mechanism: the workflow run fails,
and GitHub emails about failed runs. No new infrastructure, no webhook, no
notification service; a red X and an email.

De-vigging: a bookmaker's three prices imply probabilities summing to
more than 1 (the overround -- their margin). Dividing each implied
probability by the sum is the standard proportional de-vig. Multiple
bookmakers are averaged after de-vigging, so one outlier book doesn't
move the consensus much.

A fixture with odds but no prediction, or a prediction but no odds, is
reported as a coverage note rather than silently skipped -- a divergence
check that quietly checks nothing is worse than none, because it reads as
a green light.

Reads only. Usage: python -m app.check_market_divergence
Exit codes: 0 = nothing to flag, 1 = at least one divergent fixture.
"""

from __future__ import annotations

import sys

import pandas as pd

from app.data import _query_df
from app.db import get_connection

# Flag when model and de-vigged market disagree by more than this on any
# of the three outcomes. 0.15 is deliberately loose: this is a tripwire
# for pipeline bugs, not a value-betting signal. Every historical bug it
# is designed to catch (97.1% West Ham, Hull over Man U) diverged by 25+
# points; a genuinely sharp model edge is a few points at most. If this
# ever fires constantly on small margins, the threshold is wrong -- raise
# it rather than learning to ignore the alert, an ignored alarm is worse
# than no alarm.
DIVERGENCE_THRESHOLD = 0.15

# Only compare against prices recorded recently -- a stale price from days
# ago (team news since, lineup out) is not the market's current opinion,
# and diverging from it proves nothing.
MAX_ODDS_AGE_HOURS = 36


def devig(home_price: float, draw_price: float, away_price: float) -> tuple[float, float, float]:
    """
    Proportional de-vig: implied probabilities (1/price) renormalised to
    sum to 1, removing the bookmaker's overround.
    """
    implied = (1 / home_price, 1 / draw_price, 1 / away_price)
    total = sum(implied)
    return implied[0] / total, implied[1] / total, implied[2] / total


def market_consensus(odds: pd.DataFrame) -> tuple[float, float, float] | None:
    """
    Average de-vigged probabilities across bookmakers that quote all three
    outcomes. A bookmaker missing an outcome is dropped entirely rather
    than partially counted -- de-vigging needs the full triple, since the
    margin is only removable when you can see all of it.
    """
    triples = []
    for _, book in odds.groupby("bookmaker"):
        prices = {row.outcome: float(row.price) for row in book.itertuples()}
        if {"home", "draw", "away"} <= prices.keys():
            triples.append(devig(prices["home"], prices["draw"], prices["away"]))
    if not triples:
        return None
    n = len(triples)
    return (
        sum(t[0] for t in triples) / n,
        sum(t[1] for t in triples) / n,
        sum(t[2] for t in triples) / n,
    )


def flag(model: tuple[float, float, float], market: tuple[float, float, float]) -> float:
    """Largest absolute disagreement across the three outcomes."""
    return max(abs(m - k) for m, k in zip(model, market))


def main() -> int:
    conn = get_connection()
    try:
        rows = _query_df(
            conn,
            """
            SELECT f.id AS fixture_id, ht.name AS home_team, at.name AS away_team,
                   f.kickoff_at, c.name AS competition_name,
                   mp.prob_home_win, mp.prob_draw, mp.prob_away_win,
                   fo.bookmaker, fo.outcome, fo.price
            FROM fixtures f
            JOIN teams ht ON ht.id = f.home_team_id
            JOIN teams at ON at.id = f.away_team_id
            JOIN competition_seasons cs ON cs.id = f.competition_season_id
            JOIN competitions c ON c.id = cs.competition_id
            LEFT JOIN LATERAL (
                SELECT prob_home_win, prob_draw, prob_away_win
                FROM model_predictions mp2 WHERE mp2.fixture_id = f.id
                ORDER BY predicted_at DESC LIMIT 1
            ) mp ON true
            LEFT JOIN fixture_odds fo ON fo.fixture_id = f.id
                AND fo.market = 'match_winner' AND fo.snapshot_type = 'live'
                AND fo.recorded_at > now() - (%(max_age)s || ' hours')::interval
            WHERE f.status != 'finished'
              AND f.kickoff_at BETWEEN now() AND now() + interval '4 days'
            ORDER BY f.kickoff_at
            """,
            {"max_age": MAX_ODDS_AGE_HOURS},
        )

        if rows.empty:
            print("No upcoming fixtures in the next 4 days -- nothing to check.")
            return 0

        divergent = []
        no_prediction = 0
        no_odds = 0
        compared = 0

        for fixture_id, fixture_rows in rows.groupby("fixture_id", sort=False):
            first = fixture_rows.iloc[0]
            if pd.isna(first["prob_home_win"]):
                no_prediction += 1
                continue
            odds = fixture_rows[fixture_rows["bookmaker"].notna()]
            market = market_consensus(odds) if not odds.empty else None
            if market is None:
                no_odds += 1
                continue

            compared += 1
            model = (float(first["prob_home_win"]), float(first["prob_draw"]), float(first["prob_away_win"]))
            gap = flag(model, market)
            if gap > DIVERGENCE_THRESHOLD:
                divergent.append((first, model, market, gap))

        print(
            f"Checked {compared} fixture(s) with both a prediction and fresh odds "
            f"({no_prediction} had no prediction, {no_odds} no usable odds)."
        )
        if no_prediction + no_odds > compared:
            print(
                "NOTE: more fixtures were skipped than compared -- this check is mostly "
                "blind right now, which is not the same thing as everything being fine."
            )

        if not divergent:
            print(f"No fixture diverges from the market by more than {DIVERGENCE_THRESHOLD:.0%}.")
            return 0

        print(f"\n{len(divergent)} fixture(s) diverge from the market by more than {DIVERGENCE_THRESHOLD:.0%}:\n")
        for first, model, market, gap in sorted(divergent, key=lambda d: -d[3]):
            print(f"  {first['home_team']} vs {first['away_team']}  ({first['competition_name']}, kickoff {first['kickoff_at']})")
            print(f"    model:  home {model[0]:.1%} / draw {model[1]:.1%} / away {model[2]:.1%}")
            print(f"    market: home {market[0]:.1%} / draw {market[1]:.1%} / away {market[2]:.1%}")
            print(f"    largest gap {gap:.1%}")
            print()
        print(
            "A gap this size is far more often a pipeline bug than an edge -- every\n"
            "historical bug this check exists for (West Ham 97.1%, Hull over Man U)\n"
            "would have tripped it. Investigate before trusting the number, starting\n"
            "with app.diagnose_coverage for the flagged fixture."
        )
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
