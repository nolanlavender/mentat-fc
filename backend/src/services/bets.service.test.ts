import { describe, expect, it } from 'vitest';
import { assertValidCreateInput, createBet, legModelProbability, rowsToBet, type BetLegRow } from './bets.service.js';
import { AppError } from '../lib/errors.js';

// Only the pure aggregation/validation logic in bets.service.ts is under
// test here -- everything else in that file is a direct SQL query, not
// business logic to verify in isolation. rowsToBet in particular is the
// real "how does a parlay's overall result/odds/edge/payout get derived
// from its legs" logic, and it's worth pinning down exactly since it has
// several easy-to-get-backwards rules (void legs drop out of the price but
// still count as legs; "lost" beats "pending" beats "won" when deciding
// the overall result).

function row(overrides: Partial<BetLegRow> = {}): BetLegRow {
  return {
    bet_id: 1,
    stake: '10',
    placed_at: '2026-08-01T12:00:00.000Z',
    leg_id: 1,
    fixture_id: 100,
    market: 'match_winner',
    selection: 'home',
    odds_decimal: '2.00',
    leg_result: 'pending',
    leg_settled_at: null,
    kickoff_at: '2026-08-02T15:00:00.000Z',
    status: 'finished',
    home_score: 2,
    away_score: 1,
    competition_name: 'Premier League',
    season_label: '2026/27',
    home_team_id: 10,
    home_team_name: 'Home FC',
    away_team_id: 20,
    away_team_name: 'Away FC',
    prob_home_win: '0.5',
    prob_draw: '0.25',
    prob_away_win: '0.25',
    ...overrides,
  };
}

describe('legModelProbability', () => {
  it('picks the probability matching the leg selection for match_winner', () => {
    expect(legModelProbability(row({ selection: 'home', prob_home_win: '0.5' }))).toBe(0.5);
    expect(legModelProbability(row({ selection: 'draw', prob_draw: '0.25' }))).toBe(0.25);
    expect(legModelProbability(row({ selection: 'away', prob_away_win: '0.25' }))).toBe(0.25);
  });

  it('is null for a non-match_winner market, even with a prediction present', () => {
    expect(legModelProbability(row({ market: 'over_under', prob_home_win: '0.5' }))).toBeNull();
  });

  it('is null when there is no prediction for the fixture at all', () => {
    expect(legModelProbability(row({ prob_home_win: null, prob_draw: null, prob_away_win: null }))).toBeNull();
  });
});

describe('rowsToBet -- single-leg bets', () => {
  it('a won leg pays stake * odds', () => {
    const bet = rowsToBet([row({ leg_result: 'won', leg_settled_at: '2026-08-02T17:00:00.000Z', stake: '10', odds_decimal: '2.5' })]);
    expect(bet.result).toBe('won');
    expect(bet.combinedOdds).toBe(2.5);
    expect(bet.payout).toBe(25);
    expect(bet.isParlay).toBe(false);
  });

  it('a lost leg pays 0', () => {
    const bet = rowsToBet([row({ leg_result: 'lost', leg_settled_at: '2026-08-02T17:00:00.000Z', stake: '10' })]);
    expect(bet.result).toBe('lost');
    expect(bet.payout).toBe(0);
  });

  it('a pending leg has no payout or settled time yet', () => {
    const bet = rowsToBet([row({ leg_result: 'pending' })]);
    expect(bet.result).toBe('pending');
    expect(bet.payout).toBeNull();
    expect(bet.settledAt).toBeNull();
  });

  it('a void leg refunds the stake, not stake * odds', () => {
    const bet = rowsToBet([row({ leg_result: 'void', leg_settled_at: '2026-08-02T17:00:00.000Z', stake: '10', odds_decimal: '3.0' })]);
    expect(bet.result).toBe('void');
    expect(bet.payout).toBe(10);
  });

  it('computes edge as modelProbability minus the bettor\'s own implied probability', () => {
    const bet = rowsToBet([row({ odds_decimal: '2.0', selection: 'home', prob_home_win: '0.6' })]);
    expect(bet.yourImpliedProbability).toBeCloseTo(0.5, 10);
    expect(bet.modelProbability).toBe(0.6);
    expect(bet.edge).toBeCloseTo(0.1, 10);
  });

  it('edge is null when there is no model prediction to compare against', () => {
    const bet = rowsToBet([row({ prob_home_win: null, prob_draw: null, prob_away_win: null })]);
    expect(bet.modelProbability).toBeNull();
    expect(bet.edge).toBeNull();
  });
});

describe('rowsToBet -- parlays', () => {
  it('is a parlay once there is more than one leg', () => {
    const bet = rowsToBet([row({ leg_id: 1 }), row({ leg_id: 2, fixture_id: 101 })]);
    expect(bet.isParlay).toBe(true);
  });

  it('one lost leg loses the whole parlay, even if others are pending or won', () => {
    const bet = rowsToBet([
      row({ leg_id: 1, leg_result: 'lost' }),
      row({ leg_id: 2, fixture_id: 101, leg_result: 'pending' }),
      row({ leg_id: 3, fixture_id: 102, leg_result: 'won' }),
    ]);
    expect(bet.result).toBe('lost');
    expect(bet.payout).toBe(0);
  });

  it('is pending while any non-lost leg is still undecided', () => {
    const bet = rowsToBet([
      row({ leg_id: 1, leg_result: 'won' }),
      row({ leg_id: 2, fixture_id: 101, leg_result: 'pending' }),
    ]);
    expect(bet.result).toBe('pending');
  });

  it('is void only when every leg is void', () => {
    const bet = rowsToBet([
      row({ leg_id: 1, leg_result: 'void', leg_settled_at: '2026-08-02T17:00:00.000Z' }),
      row({ leg_id: 2, fixture_id: 101, leg_result: 'void', leg_settled_at: '2026-08-02T17:00:00.000Z' }),
    ]);
    expect(bet.result).toBe('void');
    expect(bet.payout).toBe(Number(bet.stake));
  });

  it('drops a void leg from the combined price but still requires the rest to win', () => {
    const bet = rowsToBet([
      row({ leg_id: 1, leg_result: 'won', odds_decimal: '2.0', leg_settled_at: '2026-08-02T17:00:00.000Z' }),
      row({ leg_id: 2, fixture_id: 101, leg_result: 'void', odds_decimal: '3.0', leg_settled_at: '2026-08-02T17:00:00.000Z' }),
      row({ leg_id: 3, fixture_id: 102, leg_result: 'won', odds_decimal: '1.5', leg_settled_at: '2026-08-02T17:00:00.000Z' }),
    ]);
    expect(bet.result).toBe('won');
    // Only the two 'won' legs' odds multiply in -- the void leg's 3.0 is excluded entirely.
    expect(bet.combinedOdds).toBeCloseTo(3.0, 10);
    expect(bet.payout).toBeCloseTo(Number(bet.stake) * 3.0, 10);
  });

  it('multiplies each non-void leg\'s model probability, independence-assumption product', () => {
    const bet = rowsToBet([
      row({ leg_id: 1, selection: 'home', prob_home_win: '0.5' }),
      row({ leg_id: 2, fixture_id: 101, selection: 'away', prob_away_win: '0.4' }),
    ]);
    expect(bet.modelProbability).toBeCloseTo(0.2, 10);
  });

  it('modelProbability is null overall if even one non-void leg lacks a prediction', () => {
    const bet = rowsToBet([
      row({ leg_id: 1, selection: 'home', prob_home_win: '0.5' }),
      row({ leg_id: 2, fixture_id: 101, prob_home_win: null, prob_draw: null, prob_away_win: null }),
    ]);
    expect(bet.modelProbability).toBeNull();
  });

  it('a void leg\'s missing prediction does not block modelProbability for the rest', () => {
    const bet = rowsToBet([
      row({ leg_id: 1, selection: 'home', prob_home_win: '0.5' }),
      row({ leg_id: 2, fixture_id: 101, leg_result: 'void', prob_home_win: null, prob_draw: null, prob_away_win: null }),
    ]);
    expect(bet.modelProbability).toBe(0.5);
  });

  it('settledAt is the latest settlement time among the legs once decided', () => {
    const bet = rowsToBet([
      row({ leg_id: 1, leg_result: 'won', leg_settled_at: '2026-08-02T10:00:00.000Z' }),
      row({ leg_id: 2, fixture_id: 101, leg_result: 'won', leg_settled_at: '2026-08-03T09:00:00.000Z' }),
    ]);
    expect(bet.settledAt).toBe('2026-08-03T09:00:00.000Z');
  });
});

describe('assertValidCreateInput (via createBet)', () => {
  // createBet validates synchronously before it ever touches the DB, so
  // these reject without needing a real database connection.
  it('rejects a non-positive stake', async () => {
    await expect(createBet(1, { stake: 0, legs: [{ fixtureId: 1, market: 'match_winner', selection: 'home', oddsDecimal: 2 }] })).rejects.toThrow(
      AppError,
    );
  });

  it('rejects an empty legs array', async () => {
    await expect(createBet(1, { stake: 10, legs: [] })).rejects.toThrow(AppError);
  });

  it('rejects odds that are not greater than 1', async () => {
    await expect(
      createBet(1, { stake: 10, legs: [{ fixtureId: 1, market: 'match_winner', selection: 'home', oddsDecimal: 1 }] }),
    ).rejects.toThrow(AppError);
  });

  it('accepts a well-formed single-leg bet without throwing synchronously', () => {
    expect(() =>
      assertValidCreateInput({ stake: 10, legs: [{ fixtureId: 1, market: 'match_winner', selection: 'home', oddsDecimal: 2 }] }),
    ).not.toThrow();
  });
});
