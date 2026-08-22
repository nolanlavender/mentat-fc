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
        # delete_stale_player_goal_predictions reads rowcount to report how
        # many orphans it removed.
        self.rowcount = 0

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


class TestFallbackImputation:
    """
    The production path for a promoted team (Hull-vs-Man-U regression,
    2026-08-22): predict_for_competition must impute the missing team into
    the competition's own model rather than handing the whole fixture to
    the joint fit.
    """

    @staticmethod
    def _joint_with_hull():
        rng = __import__("numpy").random.default_rng(9)
        teams = ["Arsenal", "Coventry City", "Chelsea", "Fulham", "Hull", "Leeds"]
        rows = []
        for round_ in range(6):
            for home in teams:
                for away in teams:
                    if home != away:
                        rows.append({
                            "kickoff_date": date(2026, 1, 1 + round_),
                            "home_team": home, "away_team": away,
                            "home_score": int(rng.poisson(1.4)), "away_score": int(rng.poisson(1.1)),
                        })
        joint = DixonColesModel()
        joint.fit(pd.DataFrame(rows), half_life_days=180, shrinkage=10.0)
        return joint

    def test_missing_team_is_imputed_not_delegated(self, monkeypatch):
        upcoming = pd.DataFrame([
            {"fixture_id": 20, "home_team": "Hull", "away_team": "Arsenal", "home_team_id": 3, "away_team_id": 1},
        ])
        monkeypatch.setattr(train_module, "load_upcoming_fixtures", lambda conn, competition: upcoming)
        monkeypatch.setattr(
            train_module,
            "load_confirmed_lineups",
            lambda conn, ids: pd.DataFrame(columns=["fixture_id", "team_id", "player_id", "is_starting"]),
        )
        model = _model()  # fitted without Hull
        assert "Hull" not in model.attack
        connection = _FakeConnection()
        train_module.predict_for_competition(
            connection, model, "Premier League", _shares(), fallback_model=self._joint_with_hull()
        )
        assert _predicted_fixture_ids(connection) == {20}
        assert "Hull" in model.attack, (
            "the missing team must be imputed into the competition's own model -- "
            "if this fails, the fixture was predicted by the joint fit instead"
        )


class TestCoverageReachesPredictions:
    """
    The deployed constant has to actually arrive at allocate_team_goals.
    A coverage factor wired up but never passed would look completely
    correct and silently change nothing -- the same shape as the `xg`
    column that was plumbed in and touched no data.
    """

    def test_scorer_picks_shrink_by_the_coverage_factor(self, monkeypatch):
        import app.train as train

        upcoming = pd.DataFrame([
            {"fixture_id": 30, "home_team": "Arsenal", "away_team": "Coventry City",
             "home_team_id": 1, "away_team_id": 2},
        ])
        monkeypatch.setattr(train, "load_upcoming_fixtures", lambda conn, competition: upcoming)
        monkeypatch.setattr(
            train, "load_confirmed_lineups",
            lambda conn, ids: pd.DataFrame(columns=["fixture_id", "team_id", "player_id", "is_starting"]),
        )

        def _total(coverage):
            connection = _FakeConnection()
            train.predict_for_competition(
                connection, _model(), "Premier League", _shares(), coverage=coverage
            )
            return sum(
                float(params["expected_goals"])
                for query, params in connection.statements
                if "INSERT INTO player_goal_predictions" in query
            )

        full = _total({"no_lineup": 1.0, "confirmed": 1.0})
        reduced = _total({"no_lineup": 0.8, "confirmed": 1.0})
        assert full > 0
        assert reduced == pytest.approx(0.8 * full), "the no_lineup coverage must reach the allocation"

    def test_the_deployed_constant_is_used_by_default(self, monkeypatch):
        # Guards the wiring in main(): every predicted competition must
        # have an entry, so a new competition cannot silently default to 1.0.
        import app.train as train

        assert set(train.ALLOCATION_COVERAGE) == set(train.PREDICT_COMPETITIONS)
        for competition, values in train.ALLOCATION_COVERAGE.items():
            assert set(values) == {"no_lineup", "confirmed"}, competition
            assert 0 < values["no_lineup"] <= 1 and 0 < values["confirmed"] <= 1, competition
            assert values["confirmed"] >= values["no_lineup"], (
                f"{competition}: knowing the squad should never cover LESS of the team's goals"
            )


class TestStalePickCleanup:
    """
    Real production bug, 2026-08-22: Hull City vs Manchester United had a
    confirmed 40-player squad, was re-predicted 56 seconds AFTER that squad
    landed, and still carried 105 scorer picks.
    upsert_player_goal_prediction only INSERTs or UPDATEs, so the ~65
    players predicted days ahead and then left out of the matchday squad
    kept their rows forever -- and the app reads whatever the table holds,
    so it showed scorer odds for players who were not even named.
    """

    @staticmethod
    def _wire(monkeypatch, confirmed_player_ids):
        upcoming = pd.DataFrame([
            {"fixture_id": 40, "home_team": "Arsenal", "away_team": "Coventry City",
             "home_team_id": 1, "away_team_id": 2},
        ])
        rows = [
            {"fixture_id": 40, "team_id": t, "player_id": p, "is_starting": True}
            for t in (1, 2) for p in confirmed_player_ids(t)
        ]
        monkeypatch.setattr(train_module, "load_upcoming_fixtures", lambda conn, competition: upcoming)
        monkeypatch.setattr(
            train_module, "load_confirmed_lineups",
            lambda conn, ids: pd.DataFrame(rows, columns=["fixture_id", "team_id", "player_id", "is_starting"]),
        )

    def test_a_delete_is_issued_keeping_exactly_the_predicted_players(self, monkeypatch):
        # Squad of two per team out of four reliable -- so two players per
        # team must be cleaned up rather than left behind.
        self._wire(monkeypatch, lambda t: [t * 100 + i for i in range(2)])
        connection = _FakeConnection()
        train_module.predict_for_competition(connection, _model(), "Premier League", _shares())

        deletes = [
            params for query, params in connection.statements
            if "DELETE FROM player_goal_predictions" in query
        ]
        assert deletes, "a fixture predicted with a confirmed squad must clean up orphans"
        kept = set(deletes[0]["keep"])
        written = {
            params["player_id"] for query, params in connection.statements
            if "INSERT INTO player_goal_predictions" in query
        }
        assert kept == written, "the delete must keep exactly the players just written, no more and no less"
        assert deletes[0]["fixture_id"] == 40

    def test_the_delete_is_scoped_to_this_model_version(self, monkeypatch):
        # A future second scorer model must not have its rows wiped by this
        # one's cleanup.
        self._wire(monkeypatch, lambda t: [t * 100 + i for i in range(2)])
        connection = _FakeConnection()
        train_module.predict_for_competition(connection, _model(), "Premier League", _shares())
        query, params = next(
            (q, p) for q, p in connection.statements if "DELETE FROM player_goal_predictions" in q
        )
        assert "model_version" in query
        assert params["model_version"] == train_module.GOAL_SCORER_MODEL_VERSION

    def test_an_empty_prediction_set_does_not_delete_everything_by_accident(self, monkeypatch):
        # keep=[] would make `NOT (player_id = ANY('{}'))` true for every
        # row. The sentinel keeps the statement well-formed; this pins that
        # the parameter is never an empty list.
        self._wire(monkeypatch, lambda t: [])
        connection = _FakeConnection()
        train_module.predict_for_competition(connection, _model(), "Premier League", _shares())
        for query, params in connection.statements:
            if "DELETE FROM player_goal_predictions" in query:
                assert params["keep"], "keep must never be an empty list"
