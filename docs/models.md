# The models

What the prediction models actually do, and the maths behind them. Written
to be read start to finish once, then dipped into. Every section says what
the maths is, why we chose it, where it lives in the code, and what to read
if you want to go deeper.

`docs/learning-log.md` is the running history of *what we tried and what
happened*. This file is the *what we currently believe and why*. When they
disagree, this one is wrong and should be updated.

---

## 0. What we are actually predicting

Not "who wins." The object the model produces is a **probability
distribution over every possible scoreline**:

| | 0 away | 1 away | 2 away | … |
|---|---|---|---|---|
| **0 home** | 8.1% | 6.4% | 2.6% | |
| **1 home** | 11.9% | 9.5% | 3.8% | |
| **2 home** | 8.8% | 7.0% | 2.8% | |
| … | | | | |

Everything the app shows is a *sum over cells of that table*:

- **P(home win)** = sum of everything below the diagonal
- **P(draw)** = sum of the diagonal
- **P(away win)** = sum of everything above it
- **P(over 2.5 goals)** = sum of every cell where home + away ≥ 3

That's why the model is built around scorelines rather than trained
directly on win/draw/loss: one distribution answers every market at once,
and a 3-1 and a 1-3 carry more information than "home win" and "away win"
do. In code this is the `grid` in `DixonColesModel._predict_from_expected_goals`
(`model-service/app/dixon_coles.py`), and the three sums are literally
`np.tril`, `np.trace`, `np.triu`.

---

## 1. Layer one: goals are (nearly) Poisson

A [Poisson distribution](https://en.wikipedia.org/wiki/Poisson_distribution)
describes *how many independent rare events happen in a fixed window*.
It has exactly one parameter, $\lambda$ — the average rate:

$$P(k \text{ goals}) = \frac{\lambda^k e^{-\lambda}}{k!}$$

If a team's $\lambda$ is 1.4, that formula says they score 0 about 25% of
the time, 1 about 35%, 2 about 24%, 3 about 11%, and so on. Football goals
fit this shape well — not perfectly, but well enough that the whole field
starts here.

**The key consequence, and the reason the rest of this document exists:**
predicting a football match reduces to predicting *two numbers* — the home
team's $\lambda$ and the away team's $\lambda$. Everything else is
arithmetic. All the modelling effort goes into those two numbers.

Assuming the two sides' goal counts are independent, the probability of an
exact scoreline is just the product:

$$P(x\text{–}y) = \frac{\lambda_H^x e^{-\lambda_H}}{x!} \cdot \frac{\lambda_A^y e^{-\lambda_A}}{y!}$$

which is the `np.outer(home_probs, away_probs)` line in the code — an outer
product is precisely "multiply every row probability by every column
probability."

> **Read:** [Poisson distribution](https://en.wikipedia.org/wiki/Poisson_distribution) ·
> [Poisson regression](https://en.wikipedia.org/wiki/Poisson_regression)

---

## 2. Layer two: where λ comes from (Dixon-Coles)

Each team gets **two numbers**, and the league gets one shared number:

| Parameter | Meaning | 1.0 means |
|---|---|---|
| $\alpha_i$ — attack | how much this team inflates its own scoring | league average |
| $\beta_i$ — defense | how much this team inflates its *opponent's* scoring | league average |
| $\gamma$ — home advantage | shared multiplier for whoever is at home | no advantage |

Then:

$$\lambda_H = \alpha_{home} \cdot \beta_{away} \cdot \gamma \qquad \lambda_A = \alpha_{away} \cdot \beta_{home}$$

In words: **how many you score = how good you are at scoring × how bad
they are at defending × home bump.** Note $\beta$ is a *badness* number —
a team with $\beta = 0.7$ concedes 30% fewer than average, so lower is
better. (Naming it "defense" where lower is better is a genuine footgun in
our code; it's the convention from the literature.)

Multiplying rather than adding matters: it means a great attack facing a
great defense produces a sensible middling $\lambda$, and the effects
compose the same way at every scoring level. It also means the whole thing
is *linear in log space*, which is why the code fits `log_attack` and
`log_defense` and calls `np.exp` at the end — the optimiser gets a much
better-behaved problem, and $\lambda$ can never go negative.

### The Dixon-Coles correction (the τ bit)

Plain independent Poisson has one well-known flaw: **it gets low-scoring
games wrong.** Real football produces more 0-0s and 1-1s than independence
predicts, because a 0-0 in the 80th minute changes how both teams play.
Goals are not quite independent events.

[Dixon and Coles (1997)](https://doi.org/10.1111/1467-9876.00065) fixed
this in the least elegant, most practical way available: multiply the four
low-score cells by a correction factor $\tau$, and leave the other ~117
cells alone.

$$\tau(0,0) = 1 - \lambda_H\lambda_A\rho \quad \tau(0,1) = 1 + \lambda_H\rho \quad \tau(1,0) = 1 + \lambda_A\rho \quad \tau(1,1) = 1 - \rho$$

with $\tau = 1$ (i.e. no change) everywhere else. $\rho$ is a single number
fitted from the data alongside everything else; it typically comes out
slightly negative, which nudges 0-0 and 1-1 *up*. After the nudge the grid
no longer sums to 1, so we renormalise (`grid / grid.sum()`).

This is a **patch, not a theory** — Dixon and Coles say as much. There are
principled alternatives (see the bivariate-Poisson reading below); the
patch wins on being one extra parameter instead of a different model.

> **Read:** [Dixon & Coles 1997](https://doi.org/10.1111/1467-9876.00065),
> the founding paper, and readable — sections 1–3 are the whole idea (the PDF
> is widely mirrored if the DOI is paywalled) ·
> [Maher 1982](https://doi.org/10.1111/j.1467-9574.1982.tb00782.x), the
> attack/defense Poisson idea Dixon-Coles builds on ·
> [Karlis & Ntzoufras 2003](https://doi.org/10.1111/1467-9884.00366) on
> bivariate Poisson, the more principled way to correlate the two scores

---

## 3. How the parameters get fitted

We have ~2,000 historical matches and ~25 teams, so ~52 unknowns
(25 attacks + 25 defenses + $\gamma$ + $\rho$). We find them by
[maximum likelihood](https://en.wikipedia.org/wiki/Maximum_likelihood_estimation):

> **Pick the parameter values that make the results that actually happened
> as unsurprising as possible.**

Concretely: for one candidate set of parameters, compute the probability
the model assigns to every real historical scoreline, multiply them all
together, and that's the *likelihood*. Search for the parameters that
maximise it. In practice we work with the **log** of it (products of
thousands of small numbers underflow to zero; sums of logs don't) and
**minimise the negative** (optimisers are written to go downhill):

$$\text{NLL} = -\sum_{\text{matches}} w_m \Big[ x_m \log\lambda_H - \lambda_H + y_m \log\lambda_A - \lambda_A + \log \tau_m \Big]$$

That expression is `negative_log_likelihood` in `dixon_coles.py`, more or
less verbatim. The `k!` term from the Poisson formula is missing on purpose
— it doesn't depend on the parameters, so it can't affect *which*
parameters win.

The search itself is [L-BFGS-B](https://docs.scipy.org/doc/scipy/reference/optimize.minimize-lbfgsb.html)
via `scipy.optimize.minimize` — a quasi-Newton method that follows the
gradient downhill while building an approximation of the curvature. We
don't implement any of it; we hand it a function and a starting point.

### Time decay (the $w_m$ weight)

A result from 2023 says less about a team today than one from last month.
Each match is weighted by an exponential decay:

$$w_m = e^{-\xi \cdot \text{days ago}}, \qquad \xi = \frac{\ln 2}{\text{half-life}}$$

The half-life is the intuitive handle: at `HALF_LIFE_DAYS = 180`, a match
six months old counts half as much as one today, twelve months old a
quarter, and so on. This is the same mathematics as radioactive decay or
[EWMA](https://en.wikipedia.org/wiki/Exponential_smoothing) smoothing.

We tested 60 and 120 against 180 on real data and **both were worse, in
both leagues, monotonically.** Shortening the half-life sharpens
"recent form" but shrinks the effective sample size, and Dixon-Coles is
estimating something that genuinely changes slowly. Noise cost more than
freshness gained.

### The identifiability trap

Here's a subtlety that will bite anyone reading the fitted numbers:

$$\lambda_H = \alpha_{home} \cdot \beta_{away} \cdot \gamma$$

If you multiply **every** attack by 2 and divide **every** defense by 2,
every $\lambda$ in the entire dataset is unchanged. The likelihood is
*exactly* identical. There isn't one best answer — there's an infinite ridge
of equally-good answers, and the optimiser stops at an arbitrary point
along it. This is called an
[identifiability](https://en.wikipedia.org/wiki/Identifiability) problem.

Predictions don't care. But *comparing two teams' attack ratings*, or
*shrinking a rating toward a target*, absolutely does — the numbers are
meaningless until you pin the ridge down. We pin it by recentring after the
fit so the mean of `log_attack` is exactly 0:

```python
c = log_attack.mean()
log_attack = log_attack - c
log_defense = log_defense + c   # slide along the ridge, predictions unchanged
```

After that, attack 1.0 means "league average" and the numbers are
comparable. **Any time you see `- offset` on an attack and `+ offset` on a
defense in this codebase, that's a deliberate move along this ridge**, not
a sign error. It's the fiddly part of section 5.

---

## 4. Regularisation: why we shrink ratings toward average

### The bug that forced this

West Ham were relegated into the Championship and had played **one** match
in that competition. Unregularised maximum likelihood looked at that single
result and concluded they were the best attacking side the division had
ever seen — predicting a **97.1% win probability** and a **6.62–1.13
scoreline** for their next fixture.

Nothing was broken. MLE did exactly what it's told to do: with one data
point and no other constraint, the parameters that make that one result
least surprising are extreme ones. `MIN_MATCHES_TO_FIT` guards the
*competition's* total match count and never any individual team's, so
nothing in the pipeline caught it.

### The fix: an L2 penalty

Add a cost for being far from average, and minimise likelihood-plus-cost:

$$\text{NLL}_{\text{penalised}} = \text{NLL} + \kappa \sum_i \big( \log\alpha_i^2 + \log\beta_i^2 \big)$$

This is [ridge regression](https://en.wikipedia.org/wiki/Ridge_regression)
/ Tikhonov regularisation, and it's `shrinkage` in `fit()`.

**Why this needs no per-team logic, which is the elegant part.** The
penalty is the same fixed size for every team. But the *likelihood's* pull
on a team's rating scales with how many matches that team has. An
established team with 60 matches has 60 matches' worth of evidence pushing
back against the penalty and barely moves. West Ham have one, so the
penalty dominates and drags them most of the way back to average. **Teams
are shrunk in proportion to how little we know about them, automatically.**

This is one of the genuinely beautiful ideas in statistics, and it shows up
under many names — [James-Stein estimation](https://en.wikipedia.org/wiki/James%E2%80%93Stein_estimator),
shrinkage estimators, [regularisation](https://en.wikipedia.org/wiki/Regularization_(mathematics)),
partial pooling, and (below) empirical Bayes.

### The Bayesian reading of the same equation

That penalty is not an arbitrary hack. Minimising

$$\text{NLL} + \kappa \sum \log\alpha_i^2$$

is *algebraically identical* to finding the most probable parameters under
a Gaussian prior centred on average, with $\kappa$ inversely related to the
prior's variance. "Add a squared penalty" and "start from a belief that
teams are probably about average, and let data move you off it" are the
same sentence written two ways. This equivalence
([MAP estimation](https://en.wikipedia.org/wiki/Maximum_a_posteriori_estimation))
is worth genuinely internalising — it recurs everywhere in ML.

### Our tuned values

Fitted per competition, from an 11-value backtest sweep:

| Competition | κ | Notes |
|---|---|---|
| Premier League | 1.0 | clear peak; worse above and below |
| Championship | 5.0 | peaks much further out |
| FA Cup (joint fit) | 10.0 | **still improving at the top of what was tested** — best-known, not converged |

Championship needing 5× the Premier League's shrinkage makes sense: more
teams, more promotion/relegation churn, thinner per-team data.

---

## 5. Hierarchical priors: shrink toward *what*, exactly

Section 4's shrinkage pulls every team toward **league average**. For West
Ham that fixes an overrating by creating an underrating — they have three
seasons of top-flight results saying they are well *above* Championship
average, and pulling them to 1.0 throws all of that away.

The better idea: pull each team toward **a prior specific to that team**.
We fit a joint model across all three competitions — the FA Cup ties
connecting divisions are what put them on a common scale — and use each
team's joint rating as their personal shrinkage target:

$$\text{NLL} + \kappa \sum_i \big( (\log\alpha_i - \log\alpha_i^{prior})^2 + \dots \big)$$

This is [hierarchical modelling / partial pooling](https://en.wikipedia.org/wiki/Multilevel_model):
teams are neither fully independent nor forced to be identical; they're
drawn from a shared distribution, and how far an individual is allowed to
stray from it depends on their evidence.

The fiddly part is section 3's ridge. The joint fit centres its attack mean
across ~800 teams, most of them non-league FA Cup entrants, so its raw
numbers are on a completely different scale and mean nothing in a Premier
League fit until re-centred onto that competition's own scale — hence the
`- offset` / `+ offset` in `fit()`.

**Status: built, tested, currently switched off** (`SHRINK_TOWARD_JOINT = False`
in `app/evaluate.py`). A paired comparison couldn't distinguish it from
noise in either direction. The most likely reason is that the held-out
window contains very few promoted/relegated clubs — precisely the case it
helps. Left in place to re-test after a season with more division changes.

> **Read:** Gelman & Hill, *Data Analysis Using Regression and
> Multilevel/Hierarchical Models* — the standard reference ·
> McElreath, *Statistical Rethinking* — chapter 13 on multilevel models is
> the best intuitive explanation of partial pooling in print, and the
> lecture series is free on YouTube

---

## 6. Fitting on more than the final score

A 1-0 win where you were battered and a 1-0 win where you had 25 shots are
the same data point to a model that only sees goals. Goals are a
*low-frequency, high-variance* signal — a season is only ~38 matches, and
the shot counts underneath are far more stable.

The ideal input is **expected goals (xG)**. We confirmed against a real
API-Football response that our data source doesn't provide it — no xG field
at all. So we build proxies from what we do have.

### How a proxy becomes goals

Shots aren't goals, so they have to be rescaled. Two methods, both in
`app/data.py`, and the difference between them mattered more than expected:

1. **Pooled mean ratio** — compute total goals ÷ total shots on target
   across the dataset, multiply. One number, robust.
2. **Least squares** — regress goals on the shot counts with no intercept,
   learning a separate goals-per-shot coefficient for each signal. Required
   once we had *two* signals (inside/outside the box) that convert at very
   different rates.

Then blend, per competition:

$$\text{fitted score} = (1-w)\cdot\text{actual goals} + w \cdot \text{proxy}$$

$w = 0$ is pure real scores; $w = 1$ is pure proxy. **The blend is applied
only to what the model trains on — never to the held-out matches it's
scored against**, or the backtest would be grading the model against a
distorted version of reality.

### Current values

| Competition | shots on target | shot location (in/out of box) |
|---|---|---|
| Premier League | 0.75 | **0.75** |
| Championship | 0.25 | 0 |
| FA Cup (joint) | 1.00 | 0 |

Shot location was measured as *significantly worse* in the Championship at
all four weights tested, which is why those zeros are firm rather than
merely untried. The Premier League's 0.75 was promoted on expected loss
rather than strict significance — the caveats are in the constant's comment
in `app/train.py` and in the learning log.

**One trap worth knowing:** `inside_box + outside_box` equals *total* shots,
not shots on target. Using location alone silently discards the accuracy
filter — a blocked shot from six yards counts the same as one that beat the
keeper — and every goal is by definition an on-target shot. That's why the
location signal blends alongside shots on target rather than replacing it.

---

## 7. Lineup adjustment

Once a real lineup is confirmed (usually ~1 hour before kickoff), we scale
that team's $\lambda$ by an availability factor:

$$\text{availability} = 1 - \underbrace{\Big(\textstyle\sum_{\text{missing}} \text{goal\_share}\Big)}_{\text{how much scoring is absent}} \times \underbrace{\Big(1 - \tfrac{\text{rating}_{\text{confirmed}}}{\text{rating}_{\text{normal}}}\Big)}_{\text{how much worse the replacements are}}$$

The second factor is the important half. "Missing 30% of your goal share"
means very different things depending on who replaced them — a team
fielding its usual-quality deputies barely weakens, a team fielding
genuinely worse fill-ins loses close to the full share. Without it, squad
rotation would look like catastrophe.

Returns exactly `1.0` — a complete no-op — when there's no confirmed lineup
yet. "No confident answer" and "full strength" are different states and we
never conflate them.

---

## 8. The goal-scorer model

This is **allocation, not a second model.** We take the team $\lambda$ the
Dixon-Coles model already produced and split it among players:

$$\lambda_{\text{player}} = \lambda_{\text{team}} \times \text{goal\_share} \times \text{minutes\_share}$$

- **goal_share** — this player's share of the team's goals, computed on a
  **per-90 rate** basis so a productive substitute isn't punished for
  playing less
- **minutes_share** — what fraction of a full match he typically plays.
  When a lineup is confirmed we swap in his starting-specific or
  bench-specific average instead, because "60% of minutes" blends two very
  different worlds

Then, because "does he score at least once" is the market:

$$P(\text{scores}) = 1 - P(\text{zero goals}) = 1 - e^{-\lambda_{\text{player}}}$$

Straight from the Poisson formula with $k = 0$.

**Penalties are carved out first.** A penalty isn't a share of open play —
it's one specific player's job, at a ~76% conversion rate that has nothing
to do with his open-play rate. So the team's expected goals are split into
a penalty portion (handed entirely to the identified primary taker) and an
open-play portion (allocated by *non-penalty* goal share, so the taker's
penalty history doesn't get counted twice).

> **This section is the least trustworthy part of the system.** It has
> never been backtested — see section 10.

---

## 9. How we know whether any of it works

### Scoring a probabilistic prediction

You cannot grade a probability against one outcome. Saying "70% home win"
and seeing an away win doesn't make you wrong. You need a
[proper scoring rule](https://en.wikipedia.org/wiki/Scoring_rule) — a
metric whose expected value is optimised by *reporting your true beliefs*,
so there's no way to score better by shading your numbers.

**[Brier score](https://en.wikipedia.org/wiki/Brier_score)** — mean squared
error against the one-hot actual outcome. Lower is better:

$$\text{Brier} = \frac{1}{N}\sum \big[ (p_H - o_H)^2 + (p_D - o_D)^2 + (p_A - o_A)^2 \big]$$

**Log loss** — average negative log probability of what actually happened.
Punishes confident-and-wrong far more harshly (a 1% assigned to the real
outcome costs enormously). We report both.

There is no universal "good" Brier score. Only comparisons on the same
matches mean anything — model vs. market, or config A vs. config B.

### Telling a real improvement from luck

The mistake that nearly shipped a change fitted to sampling error: running
the backtest twice and comparing the two summary numbers. That's fine when
the gap is large. It's actively misleading when it's small, and **almost
every remaining improvement is small.**

`app/compare.py` does it properly:

1. **Pairing.** Score both configs on *the same* held-out fixtures and
   difference them match by match. Most of the variance in a Brier score is
   "some matches are just harder," and that variance is identical for both
   configs — so pairing cancels it entirely.
2. **[Bootstrap](https://en.wikipedia.org/wiki/Bootstrapping_(statistics)).**
   Resample those per-match differences with replacement 5,000 times and
   take the 2.5th/97.5th percentiles. This answers the real question —
   *would this hold up on a different sample of matches?* — rather than
   "is number A smaller than number B."
3. **A null self-check.** Run it on data where the change *cannot* do
   anything, and confirm it reports exactly zero. This caught a confound
   that would have corrupted every verdict: the baseline and the candidate
   were using two different goals-per-shot calibrations, so every result
   was a mixture of two questions. **A test that can't detect its own null
   case can't be trusted on a real one.**

### The noise floor

With ~350–500 held-out matches, effects smaller than roughly **0.003 Brier**
are unresolvable. That's a property of the test set, not of any change —
and several things we'd like to know sit right underneath it.

> **Read:** [Proper scoring rules](https://en.wikipedia.org/wiki/Scoring_rule) ·
> [Brier score](https://en.wikipedia.org/wiki/Brier_score) ·
> [Bootstrapping](https://en.wikipedia.org/wiki/Bootstrapping_(statistics)) ·
> Hyndman & Athanasopoulos, [*Forecasting: Principles and Practice*, §5.10
> on time-series cross-validation](https://otexts.com/fpp3/tscv.html) —
> free online, and directly relevant to fixing the noise floor

---

## 10. Known gaps, honestly stated

**The goal-scorer model has never been backtested.** Every team-level
change went through paired comparison; this one shipped on plausibility.
It's the largest untested surface in the project.

**The allocation leaks ~24% of every team's expected goals**, and it's a
normalisation bug, not rounding. Summed over a team's players, the
allocated goals should come back to $\lambda_{team}$. They come to about
0.76 of it. Two separate causes, both confirmed by working the arithmetic
through:

1. **The share is normalised before the reliability filter is applied.**
   `goal_share` is divided by the team's total per-90 rate including
   fringe players, and *then* players below `MIN_PLAYER_MATCHES` are
   dropped. So the shares that survive sum to less than 1 by construction.
2. **A rate share is multiplied by a minutes share.** `goal_share` is a
   share of the team's per-90 *rate*; multiplying it by `minutes_share`
   (always < 1) discounts a second time. The allocated total is
   $\sum_i \text{goal\_share}_i \cdot \text{minutes\_share}_i$, which is a
   weighted average of numbers below 1 and therefore always below 1.

The fix for (2) is to normalise by the minutes-weighted total,
$\sum_j (\text{goals per 90})_j \cdot \text{minutes\_share}_j$, rather
than the raw per-90 total — which by construction makes the allocation sum
to exactly 1. (1) is fixed by filtering before normalising.

**Fix and measure together, not separately:** correcting this raises every
scorer probability by roughly 1/0.76 ≈ 1.3×, and we have no backtest to
say whether our current numbers are too low or too high. Shipping a 30%
uplift to a model nobody has ever scored would be moving fast in an
unknown direction.

**Player position is loaded from the database and used nowhere.** A
defender and a striker with identically thin histories get identical
priors. Position is the obvious per-player shrinkage target — the same
mechanism that fixed West Ham, applied one level down.

**Single train/test split.** One 20% cutoff is what sets the noise floor.
Walk-forward (rolling-origin) evaluation would give several times more
held-out matches and could resolve effects we currently have to decide by
judgement. It would also retroactively confirm or kill the shots-on-target
weights, which were picked from point estimates with no confidence
intervals at all.

**No opponent-adjustment on the shot proxies.** Shots against a bad defense
are worth less than shots against a good one, and we treat them alike.

**Every goal is worth the same.** No timing, no game state, no red cards.
A 4-0 and a 1-0 move the ratings by different amounts, but a 90th-minute
consolation counts the same as an opening goal.

---

## 11. Reading list, ordered

**Start here**
1. [Poisson distribution](https://en.wikipedia.org/wiki/Poisson_distribution) — the one distribution this all rests on
2. [Dixon & Coles 1997](https://doi.org/10.1111/1467-9876.00065) — the founding paper; sections 1–3 are the entire idea and it is unusually readable
3. [Brier score](https://en.wikipedia.org/wiki/Brier_score) + [proper scoring rules](https://en.wikipedia.org/wiki/Scoring_rule) — how to grade a probability

**The statistics underneath**
4. [Maximum likelihood estimation](https://en.wikipedia.org/wiki/Maximum_likelihood_estimation)
5. [Ridge regression](https://en.wikipedia.org/wiki/Ridge_regression) and [MAP estimation](https://en.wikipedia.org/wiki/Maximum_a_posteriori_estimation) — read together; they're the same equation
6. [James-Stein estimator](https://en.wikipedia.org/wiki/James%E2%80%93Stein_estimator) — the counterintuitive result that shrinkage is *provably* better
7. [Multilevel models](https://en.wikipedia.org/wiki/Multilevel_model)
8. [Bootstrapping](https://en.wikipedia.org/wiki/Bootstrapping_(statistics))

**Going further**
9. [Maher 1982](https://doi.org/10.1111/j.1467-9574.1982.tb00782.x) — the attack/defense idea Dixon-Coles builds on
10. [Karlis & Ntzoufras 2003](https://doi.org/10.1111/1467-9884.00366) — bivariate Poisson, the principled alternative to the τ patch
11. Hyndman & Athanasopoulos, [*Forecasting: Principles and Practice*](https://otexts.com/fpp3/) — free online; [§5.10](https://otexts.com/fpp3/tscv.html) is the fix for our noise floor
12. McElreath, *Statistical Rethinking* — ch. 13 on partial pooling; free lecture series on YouTube
13. Gelman & Hill, *Data Analysis Using Regression and Multilevel/Hierarchical Models*
14. [Kelly criterion](https://en.wikipedia.org/wiki/Kelly_criterion) — turning a probability edge into a stake size; relevant when the betting side matures

*(DOI links may be paywalled; the Dixon-Coles PDF in particular is widely
mirrored and easy to find by title.)*

---

## Where things live

| File | Role |
|---|---|
| `model-service/app/dixon_coles.py` | the model — fit, τ, shrinkage, predict |
| `model-service/app/goal_scorer.py` | player shares, availability, goal allocation |
| `model-service/app/data.py` | loaders, shot proxies, blending |
| `model-service/app/train.py` | **deployed** config + the batch prediction job |
| `model-service/app/evaluate.py` | backtest **sandbox** — try a value here first |
| `model-service/app/compare.py` | paired A/B — is a difference real? |
| `docs/learning-log.md` | the running history of what we tried |

The `train.py` / `evaluate.py` split is deliberate and the constants are
duplicated by hand: **try a value in the sandbox, back it with a real
comparison, only then promote it into the deployed file.** A test asserts
the two stay in sync.
