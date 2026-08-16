import os

# app.evaluate imports app.db, which imports app.config -- and app.config
# reads DATABASE_URL at *module import time*, not lazily. None of the pure
# functions under test here (brier_score, time_weight, compute_player_shares,
# ...) touch the database, but importing the module they live in still
# requires that env var to exist. A dummy value is enough: nothing in this
# test suite ever calls get_connection().
os.environ.setdefault("DATABASE_URL", "postgres://test:test@localhost/test")
