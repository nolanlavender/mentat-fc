import os

import numpy as np
import pandas as pd
import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused/for-import-only")

from app.evaluate_scorers import _attach_outcomes, _auc, _score  # noqa: E402


class TestAuc:
    """
    Discrimination, deliberately measured separately from calibration --
    a model can rank players perfectly while being systematically wrong
    about the overall level (which is exactly the failure we suspect).
    """

    def test_perfect_ranking(self):
        assert _auc(np.array([0.9, 0.8, 0.2, 0.1]), np.array([1.0, 1.0, 0.0, 0.0])) == 1.0

    def test_inverted_ranking(self):
        assert _auc(np.array([0.1, 0.2, 0.8, 0.9]), np.array([1.0, 1.0, 0.0, 0.0])) == 0.0

    def test_a_constant_prediction_is_exactly_a_coin_flip(self):
        # The property the whole baseline comparison rests on. Without
        # average ranks for ties this drifts off 0.5 depending on the
        # order rows happen to arrive in, and the baseline stops being a
        # baseline.
        outcomes = np.array([1.0, 0.0, 1.0, 0.0, 0.0])
        assert _auc(np.full(5, 0.3), outcomes) == 0.5

    def test_undefined_without_both_classes(self):
        # Every player scored, or none did -- ranking is meaningless, and
        # returning a number here would invent one.
        assert _auc(np.array([0.5, 0.6]), np.array([1.0, 1.0])) is None
        assert _auc(np.array([0.5, 0.6]), np.array([0.0, 0.0])) is None

    def test_indifferent_to_monotone_rescaling(self):
        # The reason AUC is the right discrimination metric here: halving
        # every probability (the shape of the suspected allocation leak)
        # must not change the ranking verdict at all.
        probabilities = np.array([0.4, 0.3, 0.2, 0.1])
        outcomes = np.array([1.0, 0.0, 1.0, 0.0])
        assert _auc(probabilities, outcomes) == _auc(probabilities * 0.5, outcomes)


class TestScore:
    def test_calibration_detects_systematic_under_calling(self):
        # 10 players at 0.2 with 4 actual scorers: we predicted 2.0
        # scorers where 4 happened, so calibration is 0.5. This is the
        # exact number the allocation-leak investigation turns on.
        outcomes = np.array([1.0] * 4 + [0.0] * 6)
        result = _score("m", np.full(10, 0.2), outcomes)
        assert result["predicted_scorers"] == pytest.approx(2.0)
        assert result["actual_scorers"] == pytest.approx(4.0)
        assert result["calibration"] == pytest.approx(0.5)

    def test_calibration_one_when_the_level_is_right(self):
        outcomes = np.array([1.0] * 4 + [0.0] * 6)
        assert _score("m", np.full(10, 0.4), outcomes)["calibration"] == pytest.approx(1.0)

    def test_log_loss_survives_a_zero_probability(self):
        # A player with zero goal share legitimately gets prob 0. Without
        # the epsilon guard this is -inf and poisons the whole run's mean.
        result = _score("m", np.array([0.0, 0.5]), np.array([1.0, 0.0]))
        assert np.isfinite(result["log_loss"])

    def test_brier_matches_the_hand_computation(self):
        result = _score("m", np.array([0.25, 0.75]), np.array([0.0, 1.0]))
        assert result["brier"] == pytest.approx((0.0625 + 0.0625) / 2)


class TestAttachOutcomes:
    """
    The join that decides what "wrong" means. Pinned because the tempting
    version of it -- an inner join -- silently deletes exactly the
    predictions that embarrass the model.
    """

    @staticmethod
    def _predictions():
        return pd.DataFrame(
            {
                "fixture_id": [1, 1, 1],
                "competition_name": ["Premier League"] * 3,
                "player_id": [10, 11, 12],
                "prob_scores": [0.4, 0.3, 0.9],
            }
        )

    def test_a_player_who_did_not_appear_counts_as_not_scoring(self):
        # Player 12 was predicted at 0.9 and was not in the squad. That is
        # a bad prediction and must be scored as one. An inner join would
        # drop the row and flatter the model.
        truth = pd.DataFrame({"fixture_id": [1, 1], "player_id": [10, 11], "goals": [1, 0]})
        scored = _attach_outcomes(self._predictions(), truth)
        assert len(scored) == 3
        assert scored.loc[scored["player_id"] == 12, "scored"].item() == 0.0

    def test_multiple_goals_still_count_as_scored_once(self):
        # The market is "does he score at least once", so a hat-trick is
        # one success, not three.
        truth = pd.DataFrame({"fixture_id": [1], "player_id": [10], "goals": [3]})
        scored = _attach_outcomes(self._predictions(), truth)
        assert scored.loc[scored["player_id"] == 10, "scored"].item() == 1.0

    def test_no_prediction_is_ever_added_by_the_join(self):
        # A player who scored but was never predicted must not appear --
        # the denominator is what we predicted, not what happened.
        truth = pd.DataFrame({"fixture_id": [1, 1], "player_id": [10, 99], "goals": [1, 2]})
        scored = _attach_outcomes(self._predictions(), truth)
        assert 99 not in set(scored["player_id"])
        assert len(scored) == 3


class TestMainEndToEnd:
    """
    Runs main() top to bottom against synthetic loaders.

    This exists because of a specific, expensive failure: a NameError
    reached a real production run of app.compare because the only way to
    execute that module was against the production database, and the
    pre-ship check had been an `import`, which passes. Every module here
    that can only be exercised with a live connection is one bug away from
    repeating it. Faking the four loaders costs a page of setup and makes
    the whole pipeline runnable on a laptop with no database at all.
    """

    @staticmethod
    def _synthetic(monkeypatch):
        from datetime import date, timedelta

        import app.evaluate_scorers as module

        rng = np.random.default_rng(7)
        competitions = {"Premier League": list(range(1, 9)), "Championship": list(range(9, 17))}
        team_names = {tid: f"Team{tid}" for tid in range(1, 17)}

        # Build the fixture list first, then shuffle before assigning dates.
        # Dating them in generation order would put every Premier League
        # match before every Championship one, so the held-out tail would
        # contain a single competition and the per-competition reporting
        # would never be exercised at all.
        fixtures = []
        for _ in range(2):
            for competition, teams in competitions.items():
                for home in teams:
                    for away in teams:
                        if home != away:
                            fixtures.append((competition, home, away))
        rng.shuffle(fixtures)

        matches, appearances, truth, lineups = [], [], [], []
        day = date(2025, 8, 1)
        for fixture_id, (competition, home, away) in enumerate(fixtures, start=1):
            day = day + timedelta(days=1)
            home_score, away_score = int(rng.poisson(1.5)), int(rng.poisson(1.1))
            matches.append({
                "fixture_id": fixture_id, "kickoff_date": day, "competition_name": competition,
                "home_team_id": home, "home_team": team_names[home],
                "away_team_id": away, "away_team": team_names[away],
                "home_score": home_score, "away_score": away_score,
                "home_shots_on_target": float(rng.integers(2, 9)),
                "away_shots_on_target": float(rng.integers(2, 9)),
                "home_shots_inside_box": float(rng.integers(3, 12)),
                "away_shots_inside_box": float(rng.integers(3, 12)),
                "home_shots_outside_box": float(rng.integers(2, 9)),
                "away_shots_outside_box": float(rng.integers(2, 9)),
            })
            for team, goals in ((home, home_score), (away, away_score)):
                squad = [team * 100 + i for i in range(14)]
                scorers = list(rng.choice(squad[:8], size=min(goals, 3), replace=False)) if goals else []
                for position, player in enumerate(squad):
                    player_goals = int(sum(1 for s in scorers if s == player))
                    # Rotate the XI, so a player's blended minutes share
                    # genuinely differs from his starting-specific one.
                    # With a fixed XI the two prediction modes produce
                    # byte-identical output and the test silently stops
                    # distinguishing them.
                    starting = ((position + fixture_id) % 14) < 11
                    appearances.append({
                        "team_id": team, "player_id": player, "kickoff_date": day,
                        "minutes_played": 90 if starting else int(rng.integers(0, 30)),
                        "goals": player_goals, "penalties_scored": 0, "penalties_missed": 0,
                        "rating": 6.5 + rng.normal(0, 0.4), "is_starting": starting,
                    })
                    truth.append({
                        "fixture_id": fixture_id, "team_id": team, "player_id": player,
                        "kickoff_date": day, "goals": player_goals,
                    })
                    lineups.append({
                        "fixture_id": fixture_id, "team_id": team,
                        "player_id": player, "is_starting": starting,
                    })

        frames = {
            "matches": pd.DataFrame(matches).sort_values("kickoff_date").reset_index(drop=True),
            "appearances": pd.DataFrame(appearances),
            "truth": pd.DataFrame(truth),
            "lineups": pd.DataFrame(lineups),
        }

        class _FakeConnection:
            def close(self):
                pass

        monkeypatch.setattr(module, "get_connection", lambda: _FakeConnection())
        monkeypatch.setattr(module, "load_finished_matches", lambda conn, comps: frames["matches"])
        monkeypatch.setattr(module, "load_fixture_player_goals", lambda conn, comps: frames["truth"])
        monkeypatch.setattr(
            module,
            "load_player_squad_appearances",
            lambda conn, comps, as_of=None: frames["appearances"][frames["appearances"]["kickoff_date"] < as_of]
            if as_of is not None
            else frames["appearances"],
        )
        monkeypatch.setattr(module, "load_confirmed_lineups", lambda conn, ids: frames["lineups"])
        return frames

    def test_main_runs_and_reports_both_modes(self, monkeypatch, capsys):
        import app.evaluate_scorers as module

        self._synthetic(monkeypatch)
        module.main()
        output = capsys.readouterr().out

        assert "no lineup (days ahead)" in output
        assert "confirmed lineup (matchday)" in output
        assert "base rate (constant)" in output
        assert "Premier League" in output
        # A run that silently produced nothing would still print headings.
        assert "no predictions produced" not in output

    def test_the_two_modes_actually_differ(self, monkeypatch, capsys):
        # Guards the mode split being a silent no-op: if confirmed-lineup
        # information changed nothing, reporting it as a separate mode
        # would be inventing a distinction the model doesn't make.
        import app.evaluate_scorers as module

        self._synthetic(monkeypatch)
        module.main()
        blocks = capsys.readouterr().out.split("---")
        days_ahead = next(b for b in blocks if "no lineup" in b)
        matchday = next(b for b in blocks if "confirmed lineup" in b)
        assert days_ahead != matchday

    def test_appearances_are_cut_off_at_the_split(self, monkeypatch):
        """
        The one assumption the whole backtest rests on: shares must be
        built only from matches before the cutoff. If this regresses the
        run still completes and just reports flattering nonsense, which is
        the worst kind of failure.
        """
        import app.evaluate_scorers as module

        frames = self._synthetic(monkeypatch)
        seen = {}
        original = module.load_player_squad_appearances
        monkeypatch.setattr(
            module,
            "load_player_squad_appearances",
            lambda conn, comps, as_of=None: seen.setdefault("as_of", as_of) and None or original(conn, comps, as_of=as_of),
        )
        module.main()

        matches = frames["matches"]
        expected_cutoff = matches.iloc[int(len(matches) * (1 - module.TEST_FRACTION))]["kickoff_date"]
        assert seen["as_of"] == expected_cutoff, "player shares must be built as of the train/test split"
