"""
Dixon-Coles match outcome model (Dixon & Coles, 1997).

Each team gets an attack strength and a defense weakness; a match's expected
goals come from multiplying the home team's attack by the away team's
defense (and vice versa), plus a shared home-advantage term. Fit by maximum
likelihood on historical results, weighted so more recent matches count more
(team strength changes over time -- a result from a year ago is weaker
evidence about today than one from last month). A small correlation
correction (rho) is applied to low-scoring outcomes (0-0, 1-0, 0-1, 1-1),
which a plain independent-Poisson model systematically underestimates.

See docs/learning-log.md's Phase 5 entry for the full walkthrough of why
this shape, and why goals-as-Poisson-counts in the first place.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from math import exp, log

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import poisson

MAX_GOALS = 10  # more than enough range to cover realistic scorelines; the tail beyond this is negligible


def _tau(home_goals: int, away_goals: int, lambda_home: float, lambda_away: float, rho: float) -> float:
    """The Dixon-Coles low-score correlation adjustment. 1.0 (no change) outside the four cells it touches."""
    if home_goals == 0 and away_goals == 0:
        return 1 - lambda_home * lambda_away * rho
    if home_goals == 0 and away_goals == 1:
        return 1 + lambda_home * rho
    if home_goals == 1 and away_goals == 0:
        return 1 + lambda_away * rho
    if home_goals == 1 and away_goals == 1:
        return 1 - rho
    return 1.0


def time_weight(match_date: date, as_of: date, half_life_days: float) -> float:
    """Exponential decay: a match half_life_days ago counts for half as much as one today.
    Public (not a leading underscore) so app.goal_scorer can reuse the exact same decay
    formula for per-player goal/minutes shares instead of a second, subtly different one."""
    days_ago = (as_of - match_date).days
    xi = log(2) / half_life_days
    return exp(-xi * max(days_ago, 0))


@dataclass
class MatchPrediction:
    predicted_home_goals: float
    predicted_away_goals: float
    prob_home_win: float
    prob_draw: float
    prob_away_win: float


@dataclass
class DixonColesModel:
    teams: list[str] = field(default_factory=list)
    attack: dict[str, float] = field(default_factory=dict)  # exp() already applied -- 1.0 = league-average attack
    defense: dict[str, float] = field(default_factory=dict)  # 1.0 = league-average defense
    home_advantage: float = 1.0
    rho: float = 0.0
    fitted_on: int = 0  # match count, kept for reporting/sanity-checking, not used in the math

    def fit(self, matches: pd.DataFrame, half_life_days: float = 180) -> None:
        """
        matches needs columns: kickoff_date, home_team, away_team, home_score, away_score.
        Fits by maximizing the weighted Dixon-Coles log-likelihood via scipy.
        """
        self.teams = sorted(set(matches["home_team"]) | set(matches["away_team"]))
        n = len(self.teams)
        team_index = {team: i for i, team in enumerate(self.teams)}

        as_of = matches["kickoff_date"].max()
        weights = matches["kickoff_date"].apply(lambda d: time_weight(d, as_of, half_life_days)).to_numpy()

        home_idx = matches["home_team"].map(team_index).to_numpy()
        away_idx = matches["away_team"].map(team_index).to_numpy()
        home_goals = matches["home_score"].to_numpy()
        away_goals = matches["away_score"].to_numpy()

        # Parameter vector: n attack (log-space) + n defense (log-space) + home advantage (log-space) + rho.
        # Log-space keeps attack/defense positive automatically without extra constraints on the optimizer.
        def unpack(params: np.ndarray) -> tuple[np.ndarray, np.ndarray, float, float]:
            log_attack = params[:n]
            log_defense = params[n : 2 * n]
            log_home_adv = params[2 * n]
            rho = params[2 * n + 1]
            return log_attack, log_defense, log_home_adv, rho

        def negative_log_likelihood(params: np.ndarray) -> float:
            log_attack, log_defense, log_home_adv, rho = unpack(params)

            log_lambda_home = log_attack[home_idx] + log_defense[away_idx] + log_home_adv
            log_lambda_away = log_attack[away_idx] + log_defense[home_idx]
            lambda_home = np.exp(log_lambda_home)
            lambda_away = np.exp(log_lambda_away)

            # Poisson log-pmf without the log(k!) term -- constant w.r.t. parameters, doesn't affect the argmax.
            poisson_ll = (
                home_goals * log_lambda_home - lambda_home + away_goals * log_lambda_away - lambda_away
            )

            tau_values = np.array(
                [
                    _tau(int(hg), int(ag), lh, la, rho)
                    for hg, ag, lh, la in zip(home_goals, away_goals, lambda_home, lambda_away)
                ]
            )
            tau_values = np.clip(tau_values, 1e-10, None)  # guard against log(0) for pathological rho

            log_likelihood = poisson_ll + np.log(tau_values)
            return -np.sum(weights * log_likelihood)

        initial_guess = np.zeros(2 * n + 2)
        initial_guess[2 * n] = log(1.3)  # modest home-advantage starting point

        result = minimize(negative_log_likelihood, initial_guess, method="L-BFGS-B")
        log_attack, log_defense, log_home_adv, rho = unpack(result.x)

        # Identifiability: (attack_i + c, defense_i - c) for every team leaves every prediction
        # unchanged, so the raw fit lands at an arbitrary point on that ridge. Recentering so
        # mean(log_attack) == 0 makes "1.0" mean "exactly league-average" -- purely for
        # interpretability, doesn't change a single prediction.
        c = log_attack.mean()
        log_attack = log_attack - c
        log_defense = log_defense + c

        self.attack = {team: exp(log_attack[i]) for team, i in team_index.items()}
        self.defense = {team: exp(log_defense[i]) for team, i in team_index.items()}
        self.home_advantage = exp(log_home_adv)
        self.rho = rho
        self.fitted_on = len(matches)

    def _expected_goals(self, home_team: str, away_team: str) -> tuple[float, float]:
        if home_team not in self.attack or away_team not in self.attack:
            missing = home_team if home_team not in self.attack else away_team
            raise ValueError(f"'{missing}' has no fitted parameters -- not present in the training data")

        lambda_home = self.attack[home_team] * self.defense[away_team] * self.home_advantage
        lambda_away = self.attack[away_team] * self.defense[home_team]
        return lambda_home, lambda_away

    def _predict_from_expected_goals(self, lambda_home: float, lambda_away: float) -> MatchPrediction:
        home_range = np.arange(0, MAX_GOALS + 1)
        away_range = np.arange(0, MAX_GOALS + 1)
        home_probs = poisson.pmf(home_range, lambda_home)
        away_probs = poisson.pmf(away_range, lambda_away)
        grid = np.outer(home_probs, away_probs)

        for hg in range(2):
            for ag in range(2):
                grid[hg, ag] *= _tau(hg, ag, lambda_home, lambda_away, self.rho)
        grid = grid / grid.sum()  # tau perturbs the four cells, renormalize back to a valid distribution

        # grid[i, j]: i = home goals, j = away goals. Home win is row > column (tril);
        # away win is column > row (triu). Easy to get backwards -- verified with a quick
        # numpy check before trusting this, not just by eyeballing the triangle names.
        prob_home_win = float(np.sum(np.tril(grid, k=-1)))
        prob_away_win = float(np.sum(np.triu(grid, k=1)))
        prob_draw = float(np.trace(grid))

        return MatchPrediction(
            predicted_home_goals=lambda_home,
            predicted_away_goals=lambda_away,
            prob_home_win=prob_home_win,
            prob_draw=prob_draw,
            prob_away_win=prob_away_win,
        )

    def predict(self, home_team: str, away_team: str) -> MatchPrediction:
        lambda_home, lambda_away = self._expected_goals(home_team, away_team)
        return self._predict_from_expected_goals(lambda_home, lambda_away)

    def predict_with_availability(
        self, home_team: str, away_team: str, home_availability: float = 1.0, away_availability: float = 1.0
    ) -> MatchPrediction:
        """
        Same as predict(), except each side's expected goals is scaled by a
        confirmed-lineup availability factor first -- see
        app.goal_scorer.compute_team_availability for how that factor is
        derived (missing reliable-share players, partially offset by a
        rating-based compensation for their replacements). 1.0 (the
        default) is a complete no-op, identical to predict() -- callers
        without a confirmed lineup for a side should just leave its
        availability at 1.0 rather than guessing.
        """
        lambda_home, lambda_away = self._expected_goals(home_team, away_team)
        return self._predict_from_expected_goals(lambda_home * home_availability, lambda_away * away_availability)
