import os
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd
import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused/for-import-only")

import app.estimate_promotion_penalty as module  # noqa: E402
from app.estimate_promotion_penalty import newcomers_by_season, penalty_from_gaps  # noqa: E402


class TestNewcomersBySeason:
    @staticmethod
    def _matches(rows):
        return pd.DataFrame(rows, columns=["competition_name", "season_label", "kickoff_date", "home_team", "away_team"])

    def test_identifies_the_promoted_clubs(self):
        rows = [
            ("Premier League", "2024/25", date(2024, 8, 10), "Arsenal", "Burnley"),
            ("Premier League", "2025/26", date(2025, 8, 10), "Arsenal", "Hull"),
        ]
        result = newcomers_by_season(self._matches(rows), "Premier League")
        assert result == [("2025/26", "2024/25", {"Hull"})]

    def test_the_first_season_is_never_reported(self):
        # No "before" exists for it, so every club would count as new --
        # which would poison the estimate with ~20 fake newcomers.
        rows = [("Premier League", "2024/25", date(2024, 8, 10), "Arsenal", "Burnley")]
        assert newcomers_by_season(self._matches(rows), "Premier League") == []

    def test_seasons_are_ordered_by_date_not_label(self):
        # Labels happen to sort lexically today; dates are the contract.
        rows = [
            ("Premier League", "B-season", date(2024, 8, 10), "Arsenal", "Burnley"),
            ("Premier League", "A-season", date(2025, 8, 10), "Arsenal", "Hull"),
        ]
        result = newcomers_by_season(self._matches(rows), "Premier League")
        assert result[0][0] == "A-season"

    def test_other_competitions_do_not_leak_in(self):
        rows = [
            ("Premier League", "2024/25", date(2024, 8, 10), "Arsenal", "Burnley"),
            ("Championship", "2024/25", date(2024, 8, 10), "Hull", "Leeds"),
            ("Premier League", "2025/26", date(2025, 8, 10), "Arsenal", "Hull"),
        ]
        result = newcomers_by_season(self._matches(rows), "Premier League")
        assert result == [("2025/26", "2024/25", {"Hull"})]


class TestPenaltyFromGaps:
    def test_no_bias_means_no_penalty(self):
        assert penalty_from_gaps([0.0, 0.0]) == pytest.approx(1.0)

    def test_clubs_underperforming_their_translation_give_a_penalty_below_one(self):
        assert penalty_from_gaps([-0.2, -0.3]) < 1.0

    def test_halved_because_the_penalty_moves_strength_twice(self):
        # attack * s and defense / s together move log-strength by 2 log s,
        # so recovering a mean gap g needs s = exp(g / 2), not exp(g).
        assert penalty_from_gaps([-0.4]) == pytest.approx(np.exp(-0.2))


class TestMainEndToEnd:
    """
    Runs main() against a synthetic two-season history with a known
    planted bias, no database involved -- the same discipline as every
    other only-runnable-in-production module here, learned the hard way.
    """

    def _synthetic(self, monkeypatch):
        rng = np.random.default_rng(11)
        pl = ["Arsenal", "Chelsea", "Fulham", "Everton", "Villa", "Spurs"]
        ch = ["Leeds", "Hull", "Stoke", "Derby", "Luton", "Wigan"]
        rows = []

        def season(label, start, pl_teams, ch_teams, weak=()):
            day = start
            for _ in range(3):
                for competition, teams in (("Premier League", pl_teams), ("Championship", ch_teams)):
                    for h in teams:
                        for a in teams:
                            if h == a:
                                continue
                            day += timedelta(hours=8)
                            hs = int(rng.poisson(0.6 if h in weak else 1.5))
                            aws = int(rng.poisson(0.4 if a in weak else 1.1))
                            rows.append({
                                "fixture_id": len(rows), "kickoff_date": day.date(),
                                "competition_name": competition, "season_label": label,
                                "home_team": h, "away_team": a, "home_score": hs, "away_score": aws,
                                "home_shots_on_target": float(rng.integers(2, 9)),
                                "away_shots_on_target": float(rng.integers(2, 9)),
                                "home_shots_inside_box": None, "away_shots_inside_box": None,
                                "home_shots_outside_box": None, "away_shots_outside_box": None,
                            })
            # Cup ties keep the joint fit connected across divisions.
            for h, a in zip(pl_teams, ch_teams):
                day += timedelta(hours=8)
                rows.append({
                    "fixture_id": len(rows), "kickoff_date": day.date(),
                    "competition_name": "FA Cup", "season_label": label,
                    "home_team": h, "away_team": a, "home_score": 3, "away_score": 1,
                    "home_shots_on_target": float(rng.integers(2, 9)),
                    "away_shots_on_target": float(rng.integers(2, 9)),
                    "home_shots_inside_box": None, "away_shots_inside_box": None,
                    "home_shots_outside_box": None, "away_shots_outside_box": None,
                })

        season("2024/25", datetime(2024, 8, 1), pl, ch)
        # Leeds promoted, Spurs relegated -- and Leeds UNDERPERFORM in the
        # top flight (weak=...), the planted bias the estimator must find.
        season("2025/26", datetime(2025, 8, 1), pl[:-1] + ["Leeds"], ch[1:] + ["Spurs"], weak=("Leeds",))

        frame = pd.DataFrame(rows)

        class _FakeConnection:
            def close(self):
                pass

        monkeypatch.setattr(module, "get_connection", lambda: _FakeConnection())
        monkeypatch.setattr(module, "load_matches_with_season", lambda conn: frame)
        monkeypatch.setattr(module, "MIN_REALIZED_MATCHES", 8)
        monkeypatch.setattr(module, "MIN_PRIOR_HISTORY", 50)

    def test_runs_and_reports_the_promoted_club(self, monkeypatch, capsys):
        self._synthetic(monkeypatch)
        module.main()
        out = capsys.readouterr().out
        assert "Leeds" in out
        assert "Suggested PROMOTION_PENALTY" in out

    def test_a_planted_underperformance_reads_as_worse(self, monkeypatch, capsys):
        self._synthetic(monkeypatch)
        module.main()
        out = capsys.readouterr().out
        leeds_lines = [line for line in out.splitlines() if "Leeds" in line and "gap" in line]
        assert leeds_lines, "the promoted club must produce a measured gap"
        assert "worse" in leeds_lines[0], (
            "Leeds were planted as underperformers; the estimator must measure the gap as negative"
        )
