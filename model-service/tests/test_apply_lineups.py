import os
from datetime import date

import pandas as pd
import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused/for-import-only")

import app.train as train_module  # noqa: E402
from app.dixon_coles import DixonColesModel  # noqa: E402


class _FakeCursor:
    def __init__(self, sink):
        self.sink = sink

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, query, params):
        self.sink.append((query, params))


class _FakeConnection:
    def __init__(self):
        self.statements = []

    def cursor(self):
        return _FakeCursor(self.statements)

    def commit(self):
        pass

    def close(self):
        pass


def _model():
    rng = __import__("numpy").random.default_rng(3)
    rows = []
    teams = ["Arsenal", "Coventry City", "Chelsea", "Fulham"]
    for round_ in range(6):
        for home in teams:
            for away in teams:
                if home != away:
                    rows.append({
                        "kickoff_date": date(2026, 1, 1 + round_),
                        "home_team": home, "away_team": away,
                        "home_score": int(rng.poisson(1.4)), "away_score": int(rng.poisson(1.1)),
                    })
    model = DixonColesModel()
    model.fit(pd.DataFrame(rows), half_life_days=180, shrinkage=1.0)
    return model


def _shares():
    return pd.DataFrame([
        {"team_id": t, "player_id": t * 100 + i, "matches": 10, "minutes_share": 0.8,
         "goal_share": 0.25, "avg_rating": 7.0, "avg_minutes_when_starting": 0.9,
         "avg_minutes_when_benched": 0.2, "non_penalty_goal_share": 0.25,
         "penalty_attempts": 0, "penalty_goal_fraction": 0.0}
        for t in (1, 2) for i in range(4)
    ])


def _wire(monkeypatch, confirmed_fixture_ids):
    upcoming = pd.DataFrame([
        {"fixture_id": 10, "home_team": "Arsenal", "away_team": "Coventry City", "home_team_id": 1, "away_team_id": 2},
        {"fixture_id": 11, "home_team": "Chelsea", "away_team": "Fulham", "home_team_id": 1, "away_team_id": 2},
        {"fixture_id": 12, "home_team": "Arsenal", "away_team": "Fulham", "home_team_id": 1, "away_team_id": 2},
    ])
    lineup_rows = []
    for fixture_id in confirmed_fixture_ids:
        for team_id in (1, 2):
            for i in range(4):
                lineup_rows.append({
                    "fixture_id": fixture_id, "team_id": team_id,
                    "player_id": team_id * 100 + i, "is_starting": i < 2,
                })
    confirmed = pd.DataFrame(
        lineup_rows, columns=["fixture_id", "team_id", "player_id", "is_starting"]
    )
    monkeypatch.setattr(train_module, "load_upcoming_fixtures", lambda conn, competition: upcoming)
    monkeypatch.setattr(train_module, "load_confirmed_lineups", lambda conn, ids: confirmed)


def _predicted_fixture_ids(connection):
    return {
        params["fixture_id"]
        for query, params in connection.statements
        if "INSERT INTO model_predictions" in query
    }


class TestOnlyWithConfirmedLineups:
    """
    The filter app.apply_lineups depends on. If it silently stopped
    filtering, the hourly job would quietly become the full rewrite that
    exhausted the account's Actions minutes -- and it would still look
    correct, just slow, which is how that incident happened the first time.
    """

    def test_restricts_the_rewrite_to_fixtures_that_have_a_lineup(self, monkeypatch):
        _wire(monkeypatch, confirmed_fixture_ids=[11])
        connection = _FakeConnection()
        train_module.predict_for_competition(
            connection, _model(), "Premier League", _shares(), only_with_confirmed_lineups=True
        )
        assert _predicted_fixture_ids(connection) == {11}

    def test_default_still_predicts_every_upcoming_fixture(self, monkeypatch):
        # The daily job must be unaffected -- this parameter is opt-in.
        _wire(monkeypatch, confirmed_fixture_ids=[11])
        connection = _FakeConnection()
        train_module.predict_for_competition(connection, _model(), "Premier League", _shares())
        assert _predicted_fixture_ids(connection) == {10, 11, 12}

    def test_no_confirmed_lineups_writes_nothing(self, monkeypatch):
        # The common case: most hours have nothing new. It must be a no-op,
        # not a full rewrite.
        _wire(monkeypatch, confirmed_fixture_ids=[])
        connection = _FakeConnection()
        train_module.predict_for_competition(
            connection, _model(), "Premier League", _shares(), only_with_confirmed_lineups=True
        )
        assert _predicted_fixture_ids(connection) == set()

    def test_the_filtered_run_still_applies_the_lineup(self, monkeypatch):
        # Filtering to lineup-bearing fixtures is only useful if those
        # fixtures actually get lineup-aware predictions -- otherwise the
        # job is cheap and pointless.
        _wire(monkeypatch, confirmed_fixture_ids=[11])
        connection = _FakeConnection()
        train_module.predict_for_competition(
            connection, _model(), "Premier League", _shares(), only_with_confirmed_lineups=True
        )
        scorer_players = {
            params["player_id"]
            for query, params in connection.statements
            if "INSERT INTO player_goal_predictions" in query
        }
        assert scorer_players, "a confirmed fixture should still get scorer picks"
        # Only players named in the squad -- all 8 are, here.
        assert scorer_players <= {t * 100 + i for t in (1, 2) for i in range(4)}
