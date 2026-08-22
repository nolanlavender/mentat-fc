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

    def fit(
        self,
        matches: pd.DataFrame,
        half_life_days: float = 180,
        shrinkage: float = 0.0,
        prior_model: "DixonColesModel | None" = None,
    ) -> None:
        """
        matches needs columns: kickoff_date, home_team, away_team, home_score, away_score.
        Fits by maximizing the weighted Dixon-Coles log-likelihood via scipy.

        shrinkage (0.0 by default -- a complete no-op, identical to every
        fit before this parameter existed) adds an L2 penalty pulling every
        team's log_attack/log_defense back toward 0 (i.e. attack/defense
        toward 1.0, exactly league-average). This is real, deliberate bias
        toward the mean -- the point is that a team with almost no real
        evidence behind it shouldn't get a confident-looking, wildly
        off-average rating just because nothing currently stops the
        optimizer from chasing a perfect fit to one or two results.

        Why a single fixed-size penalty naturally shrinks a sparse-data
        team more than an established one, with no extra per-team logic
        needed: a team backed by a full (recency-weighted) season of
        results has a likelihood gradient that dominates this fixed
        penalty at the optimum, so its fitted value barely moves. A team
        with only one or two matches on record -- the real situation for
        a newly-promoted or newly-relegated side, see docs/learning-log.md's
        2026-08-20 entry on West Ham's Championship attack rating for the
        production case that surfaced this -- has a comparatively weak,
        underdetermined likelihood contribution, so the penalty
        proportionally dominates and holds their rating close to average
        until real results justify moving it. Standard ridge-regression/
        MAP-with-a-Gaussian-prior behavior, just applied to this fit's own
        log-space parameters instead of a linear model's coefficients.

        prior_model changes WHAT that penalty pulls toward. Left as None,
        every team is pulled toward league average, which is the right
        default when nothing better is known -- but it is a genuinely poor
        prior for the exact case shrinkage was added to fix. A club
        relegated into this competition has three seasons of top-flight
        results saying they are well ABOVE this division's average, and
        shrinking them to 1.0 throws all of that away: it trades an
        overrating for an underrating rather than fixing the estimate.

        Passing the joint fit (which spans every competition and is
        calibrated across divisions by the cup ties that connect them)
        instead pulls each team toward what all of their data implies,
        expressed on this competition's own scale. A team with plenty of
        matches here is barely moved either way; a team with almost none
        lands near their cross-competition strength rather than near the
        league mean. Standard hierarchical / partial-pooling behaviour --
        the shrinkage target becomes team-specific instead of global.

        Not yet the deployed default -- see SHRINKAGE's own comment in
        app.evaluate for why this needs a real backtest before promoting
        a candidate value to app.train, the same process
        SHOTS_ON_TARGET_BLEND_WEIGHT went through.
        """
        self.teams = sorted(set(matches["home_team"]) | set(matches["away_team"]))
        n = len(self.teams)
        team_index = {team: i for i, team in enumerate(self.teams)}

        # Shrinkage targets, in the same log space the optimizer works in.
        # All zeros (league average) unless a prior model is supplied.
        prior_log_attack = np.zeros(n)
        prior_log_defense = np.zeros(n)
        if prior_model is not None:
            known = [t for t in self.teams if t in prior_model.attack]
            if known:
                # Re-centre onto THIS competition's scale before using it as
                # a target. The prior model centred its own attack mean to 0
                # across its whole (much larger) team set, so its raw values
                # are not comparable here -- a Championship side's joint-fit
                # attack is below the joint mean, but that says nothing about
                # where they sit among Championship teams. Shifting by the
                # mean over just this competition's teams answers the
                # question that actually matters: how strong is this team
                # RELATIVE TO the others in this fit.
                offset = float(np.mean([log(prior_model.attack[t]) for t in known]))
                for team in known:
                    i = team_index[team]
                    # attack -= offset and defense += offset together, which
                    # is a move along the (attack + c, defense - c) ridge the
                    # model is invariant to -- so this re-centres the prior
                    # without distorting what it actually claims about any
                    # team's strength.
                    prior_log_attack[i] = log(prior_model.attack[team]) - offset
                    prior_log_defense[i] = log(prior_model.defense[team]) + offset

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
            nll = -np.sum(weights * log_likelihood)

            if shrinkage > 0:
                nll += shrinkage * (
                    np.sum((log_attack - prior_log_attack) ** 2) + np.sum((log_defense - prior_log_defense) ** 2)
                )
            return nll

        initial_guess = np.zeros(2 * n + 2)
        # Start from the prior rather than flat zeros when there is one --
        # it is already a better guess than "everyone is average", so the
        # optimizer starts closer to the answer.
        initial_guess[:n] = prior_log_attack
        initial_guess[n : 2 * n] = prior_log_defense
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

    def impute_team_from(self, team: str, prior_model: "DixonColesModel", strength_penalty: float = 1.0) -> None:
        """
        Adds a team this fit has never seen, carrying its attack/defense
        over from prior_model re-centred onto THIS fit's own scale. A
        no-op for a team already fitted here -- a real rating estimated
        from this competition's matches always beats a translated one.

        Why translation is required rather than just copying the numbers:
        each fit centres its attack mean over its OWN teams (see the
        identifiability note above), so "1.0" means "average of this
        training set". In the joint fit that training set is ~800 mostly
        non-league clubs, so a mid-table Premier League side sits well
        above 1.0 there while sitting below 1.0 in the Premier League's
        own fit. Copying a rating across uncorrected would smuggle in the
        wrong baseline. The correction is the same ridge move fit() uses
        for prior re-centring: shift every log-attack down by the mean the
        prior assigns to THIS fit's teams, shift log-defense up by the
        same amount -- a transformation the prior's own predictions are
        exactly invariant to, so it changes what the numbers are relative
        to without changing what the prior claims.

        Exists for the promoted-club case (found 2026-08-22, Hull City
        picked to beat Manchester United): a team with zero matches in
        this competition used to send the WHOLE fixture to the joint
        fallback model, whose FA-Cup-tuned shrinkage flattens the
        established opponent toward average and whose inflated cross-
        competition home advantage then decides the fixture for whoever
        is at home. Borrowing only the missing team's rating keeps the
        opponent's real rating and this competition's own home_advantage
        and rho in charge.
        """
        if team in self.attack:
            return
        if team not in prior_model.attack:
            raise ValueError(f"'{team}' has no fitted parameters in the prior model either")
        if strength_penalty <= 0:
            raise ValueError("strength_penalty must be positive -- it multiplies a rating, not a probability")
        shared = [t for t in self.teams if t in prior_model.attack]
        if not shared:
            raise ValueError("no teams in common with the prior model, so no shared scale to translate onto")
        offset = float(np.mean([log(prior_model.attack[t]) for t in shared]))
        # strength_penalty is a genuine weakening (or, above 1, a
        # strengthening), NOT a ridge move: attack and defense shift in
        # OPPOSITE directions from the (attack+c, defense-c) invariant, so
        # a penalised team both scores less and concedes more. It exists
        # because a translated rating carries two known biases the
        # translation itself cannot remove: the prior's shrinkage
        # compresses everyone toward its own mean (flattering whichever
        # direction the team is extreme in), and clubs changing divisions
        # systematically deviate from their old-division form. Both are
        # measurable as one net factor -- see app.estimate_promotion_penalty.
        self.attack[team] = exp(log(prior_model.attack[team]) - offset) * strength_penalty
        self.defense[team] = exp(log(prior_model.defense[team]) + offset) / strength_penalty
        self.teams = sorted(self.teams + [team])

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
                # max(..., 0) mirrors the identical guard fit()'s likelihood
                # already applies (np.clip(tau_values, 1e-10, None)) --
                # predict() was missing it, which was a real latent bug, not
                # a theoretical one. tau goes negative for a large enough
                # rho (it is 1 - rho at 1-1, and 1 - lambda_home*lambda_away*rho
                # at 0-0), which made one of the four low-score cells
                # negative. Normalizing kept it negative, so the triangle
                # sums below could return a "probability" outside [0, 1] --
                # observed as a draw probability of -0.048 on a small,
                # noisy fit where rho was poorly constrained. Real
                # production fits land near rho ~= 0.07 and never hit this,
                # but the joint fit now backstops other competitions too
                # (see app.train), so the guard is worth having rather than
                # relying on the data always being well-behaved.
                grid[hg, ag] *= max(_tau(hg, ag, lambda_home, lambda_away, self.rho), 0.0)
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
