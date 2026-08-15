import { useEffect, useState, type FormEvent } from 'react';
import { authedGet, apiRequest } from '../api/client';
import type { Bet, BetLeg, BetResult, BetsRoiSummary, Team } from '../api/types';

interface UpcomingFixture {
  id: number;
  kickoffAt: string;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
}

const MATCH_WINNER = 'match_winner';

interface DraftLeg {
  fixtureId: number;
  fixtureLabel: string;
  selection: 'home' | 'draw' | 'away';
  oddsDecimal: number;
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function formatProb(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

// useFetch (GET-only, no refetch) doesn't fit this page: every mutation
// here (log a bet, settle a leg, delete a bet) needs to invalidate the same
// list + summary. Simpler to own the fetch/refetch cycle directly than to
// force a read-only hook to do something it wasn't built for.
export function BetsPage() {
  const [bets, setBets] = useState<Bet[] | null>(null);
  const [summary, setSummary] = useState<BetsRoiSummary | null>(null);
  const [fixtures, setFixtures] = useState<UpcomingFixture[] | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [seasonFilter, setSeasonFilter] = useState('');
  const [teamFilter, setTeamFilter] = useState('');

  const [draftLegs, setDraftLegs] = useState<DraftLeg[]>([]);
  const [legFixtureId, setLegFixtureId] = useState('');
  const [legSelection, setLegSelection] = useState<'home' | 'draw' | 'away'>('home');
  const [legOdds, setLegOdds] = useState('');
  const [stake, setStake] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (seasonFilter) params.set('season', seasonFilter);
      if (teamFilter) params.set('teamId', teamFilter);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const [betsRes, summaryRes] = await Promise.all([
        authedGet<Bet[]>(`/api/bets${qs}`),
        authedGet<BetsRoiSummary>(`/api/bets/summary${qs}`),
      ]);
      setBets(betsRes);
      setSummary(summaryRes);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, [seasonFilter, teamFilter]);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    authedGet<UpcomingFixture[]>(`/api/fixtures?competition=Premier%20League&from=${today}&limit=50`)
      .then(setFixtures)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    authedGet<Team[]>('/api/teams')
      .then(setTeams)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  function handleAddLeg(): void {
    setFormError(null);
    const fixture = fixtures?.find((f) => f.id === Number(legFixtureId));
    if (!fixture) {
      setFormError('Pick a fixture first');
      return;
    }
    const odds = Number(legOdds);
    if (!(odds > 1)) {
      setFormError('Odds must be greater than 1');
      return;
    }
    if (draftLegs.some((l) => l.fixtureId === fixture.id)) {
      setFormError('That fixture is already in this bet');
      return;
    }
    setDraftLegs([
      ...draftLegs,
      {
        fixtureId: fixture.id,
        fixtureLabel: `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`,
        selection: legSelection,
        oddsDecimal: odds,
      },
    ]);
    setLegFixtureId('');
    setLegOdds('');
  }

  function handleRemoveLeg(fixtureId: number): void {
    setDraftLegs(draftLegs.filter((l) => l.fixtureId !== fixtureId));
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    if (draftLegs.length === 0) {
      setFormError('Add at least one leg');
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest('/api/bets', {
        method: 'POST',
        body: {
          stake: Number(stake),
          legs: draftLegs.map((l) => ({
            fixtureId: l.fixtureId,
            market: MATCH_WINNER,
            selection: l.selection,
            oddsDecimal: l.oddsDecimal,
          })),
        },
      });
      setDraftLegs([]);
      setStake('');
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSettleLeg(betId: number, legId: number, result: BetResult): Promise<void> {
    await apiRequest(`/api/bets/${betId}/legs/${legId}`, { method: 'PATCH', body: { result } });
    await refresh();
  }

  async function handleDelete(id: number): Promise<void> {
    await apiRequest(`/api/bets/${id}`, { method: 'DELETE' });
    await refresh();
  }

  function legLine(leg: BetLeg): string {
    return `${leg.fixture.homeTeam.name} vs ${leg.fixture.awayTeam.name} — ${leg.selection} @ ${leg.oddsDecimal.toFixed(2)}`;
  }

  return (
    <div className="page">
      <h1>Bets</h1>

      {loadError && <p className="error">Couldn't load bets: {loadError}</p>}

      <section>
        <h2>Record</h2>
        <div className="bet-form">
          <label>
            Season
            <input placeholder="e.g. 2024/25" value={seasonFilter} onChange={(e) => setSeasonFilter(e.target.value)} />
          </label>
          <label>
            Team
            <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
              <option value="">All teams</option>
              {teams?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {summary && (
          <>
            <p>
              {summary.won}-{summary.lost}
              {summary.void > 0 ? `-${summary.void}` : ''} · {summary.pending} pending · win rate{' '}
              {summary.winRatePercent === null ? '—' : `${summary.winRatePercent.toFixed(1)}%`}
            </p>
            <p>
              £{summary.totalStakedSettled.toFixed(2)} staked · £{summary.totalReturnedSettled.toFixed(2)} returned · net{' '}
              £{summary.netProfitSettled.toFixed(2)} · ROI {formatPercent(summary.roiPercent)}
            </p>
          </>
        )}
      </section>

      <section>
        <h2>Log a bet</h2>
        <div className="bet-form">
          <label>
            Fixture
            <select value={legFixtureId} onChange={(e) => setLegFixtureId(e.target.value)}>
              <option value="" disabled>
                Select an upcoming fixture…
              </option>
              {fixtures
                ?.filter((f) => !draftLegs.some((l) => l.fixtureId === f.id))
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.homeTeam.name} vs {f.awayTeam.name} — {new Date(f.kickoffAt).toLocaleDateString()}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Pick
            <select value={legSelection} onChange={(e) => setLegSelection(e.target.value as 'home' | 'draw' | 'away')}>
              <option value="home">Home win</option>
              <option value="draw">Draw</option>
              <option value="away">Away win</option>
            </select>
          </label>
          <label>
            Leg odds (decimal)
            <input type="number" step="0.01" min="1.01" value={legOdds} onChange={(e) => setLegOdds(e.target.value)} />
          </label>
          <button type="button" onClick={handleAddLeg}>
            Add leg
          </button>
        </div>

        {draftLegs.length > 0 && (
          <ul className="draft-legs">
            {draftLegs.map((l) => (
              <li key={l.fixtureId}>
                {l.fixtureLabel} — {l.selection} @ {l.oddsDecimal.toFixed(2)}{' '}
                <button type="button" onClick={() => handleRemoveLeg(l.fixtureId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleSubmit} className="bet-form">
          <label>
            Stake (£)
            <input type="number" step="0.01" min="0.01" value={stake} onChange={(e) => setStake(e.target.value)} required />
          </label>
          <button type="submit" disabled={submitting || draftLegs.length === 0}>
            {submitting ? 'Logging…' : draftLegs.length > 1 ? `Log parlay (${draftLegs.length} legs)` : 'Log bet'}
          </button>
          {formError && <p className="error">{formError}</p>}
        </form>
      </section>

      <section>
        <h2>All bets</h2>
        {bets?.length === 0 && <p>No bets logged yet.</p>}
        {bets?.map((bet) => (
          <div className="bet-card" key={bet.id}>
            <div className="bet-card-header">
              <strong>{bet.isParlay ? `Parlay (${bet.legs.length} legs)` : 'Single bet'}</strong>
              <span>
                £{bet.stake.toFixed(2)} @ {bet.combinedOdds.toFixed(2)} · your {formatProb(bet.yourImpliedProbability)} · model{' '}
                {formatProb(bet.modelProbability)} · edge {bet.edge === null ? '—' : formatPercent(bet.edge * 100)}
              </span>
              <span className={`bet-result bet-result-${bet.result}`}>{bet.result}</span>
              {bet.payout !== null && <span>payout £{bet.payout.toFixed(2)}</span>}
              {bet.result !== 'pending' && (
                <button type="button" onClick={() => handleDelete(bet.id)}>
                  Delete
                </button>
              )}
            </div>
            <ul className="bet-legs">
              {bet.legs.map((leg) => (
                <li key={leg.id}>
                  {legLine(leg)} — <span className={`bet-result bet-result-${leg.result}`}>{leg.result}</span>
                  {leg.result === 'pending' && (
                    <>
                      {' '}
                      <button type="button" onClick={() => handleSettleLeg(bet.id, leg.id, 'won')}>
                        Won
                      </button>
                      <button type="button" onClick={() => handleSettleLeg(bet.id, leg.id, 'lost')}>
                        Lost
                      </button>
                      <button type="button" onClick={() => handleSettleLeg(bet.id, leg.id, 'void')}>
                        Void
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
