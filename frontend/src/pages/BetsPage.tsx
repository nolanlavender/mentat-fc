import { useEffect, useState, type FormEvent } from 'react';
import { apiUrl, apiRequest } from '../api/client';
import type { Bet, BetResult, BetsRoiSummary } from '../api/types';

interface UpcomingFixture {
  id: number;
  kickoffAt: string;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
}

const MATCH_WINNER = 'match_winner';

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function formatProb(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

// useFetch (GET-only, no refetch) doesn't fit this page: every mutation
// here (log a bet, settle one, delete one) needs to invalidate the same
// list + summary. Simpler to own the fetch/refetch cycle directly than to
// force a read-only hook to do something it wasn't built for.
export function BetsPage() {
  const [bets, setBets] = useState<Bet[] | null>(null);
  const [summary, setSummary] = useState<BetsRoiSummary | null>(null);
  const [fixtures, setFixtures] = useState<UpcomingFixture[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fixtureId, setFixtureId] = useState('');
  const [selection, setSelection] = useState<'home' | 'draw' | 'away'>('home');
  const [oddsDecimal, setOddsDecimal] = useState('');
  const [stake, setStake] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const [betsRes, summaryRes] = await Promise.all([
        fetch(apiUrl('/api/bets')).then((r) => r.json() as Promise<Bet[]>),
        fetch(apiUrl('/api/bets/summary')).then((r) => r.json() as Promise<BetsRoiSummary>),
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
    const today = new Date().toISOString().slice(0, 10);
    fetch(apiUrl(`/api/fixtures?competition=Premier%20League&from=${today}&limit=50`))
      .then((r) => r.json() as Promise<UpcomingFixture[]>)
      .then(setFixtures)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await apiRequest('/api/bets', {
        method: 'POST',
        body: {
          fixtureId: Number(fixtureId),
          market: MATCH_WINNER,
          selection,
          oddsDecimal: Number(oddsDecimal),
          stake: Number(stake),
        },
      });
      setFixtureId('');
      setOddsDecimal('');
      setStake('');
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSettle(id: number, result: BetResult): Promise<void> {
    await apiRequest(`/api/bets/${id}`, { method: 'PATCH', body: { result } });
    await refresh();
  }

  async function handleDelete(id: number): Promise<void> {
    await apiRequest(`/api/bets/${id}`, { method: 'DELETE' });
    await refresh();
  }

  return (
    <div className="page">
      <h1>Bets</h1>

      {loadError && <p className="error">Couldn't load bets: {loadError}</p>}

      {summary && (
        <section>
          <h2>Record</h2>
          <p>
            {summary.won}-{summary.lost}
            {summary.void > 0 ? `-${summary.void}` : ''} · {summary.pending} pending · win rate{' '}
            {summary.winRatePercent === null ? '—' : `${summary.winRatePercent.toFixed(1)}%`}
          </p>
          <p>
            £{summary.totalStakedSettled.toFixed(2)} staked · £{summary.totalReturnedSettled.toFixed(2)} returned · net{' '}
            £{summary.netProfitSettled.toFixed(2)} · ROI {formatPercent(summary.roiPercent)}
          </p>
        </section>
      )}

      <section>
        <h2>Log a bet</h2>
        <form onSubmit={handleSubmit} className="bet-form">
          <label>
            Fixture
            <select value={fixtureId} onChange={(e) => setFixtureId(e.target.value)} required>
              <option value="" disabled>
                Select an upcoming fixture…
              </option>
              {fixtures?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.homeTeam.name} vs {f.awayTeam.name} — {new Date(f.kickoffAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pick
            <select value={selection} onChange={(e) => setSelection(e.target.value as 'home' | 'draw' | 'away')}>
              <option value="home">Home win</option>
              <option value="draw">Draw</option>
              <option value="away">Away win</option>
            </select>
          </label>
          <label>
            Odds (decimal)
            <input
              type="number"
              step="0.01"
              min="1.01"
              value={oddsDecimal}
              onChange={(e) => setOddsDecimal(e.target.value)}
              required
            />
          </label>
          <label>
            Stake (£)
            <input type="number" step="0.01" min="0.01" value={stake} onChange={(e) => setStake(e.target.value)} required />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Logging…' : 'Log bet'}
          </button>
          {formError && <p className="error">{formError}</p>}
        </form>
      </section>

      <section>
        <h2>All bets</h2>
        <table className="bets-table">
          <thead>
            <tr>
              <th>Fixture</th>
              <th>Pick</th>
              <th>Odds</th>
              <th>Stake</th>
              <th>Your %</th>
              <th>Model %</th>
              <th>Edge</th>
              <th>Result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {bets?.map((bet) => (
              <tr key={bet.id}>
                <td>
                  {bet.fixture.homeTeam} vs {bet.fixture.awayTeam}
                </td>
                <td>{bet.selection}</td>
                <td>{bet.oddsDecimal.toFixed(2)}</td>
                <td>£{bet.stake.toFixed(2)}</td>
                <td>{formatProb(bet.yourImpliedProbability)}</td>
                <td>{formatProb(bet.modelProbability)}</td>
                <td>{bet.edge === null ? '—' : formatPercent(bet.edge * 100)}</td>
                <td>{bet.result}</td>
                <td>
                  {bet.result === 'pending' ? (
                    <>
                      <button onClick={() => handleSettle(bet.id, 'won')}>Won</button>
                      <button onClick={() => handleSettle(bet.id, 'lost')}>Lost</button>
                      <button onClick={() => handleSettle(bet.id, 'void')}>Void</button>
                    </>
                  ) : (
                    <button onClick={() => handleDelete(bet.id)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {bets?.length === 0 && <p>No bets logged yet.</p>}
      </section>
    </div>
  );
}
