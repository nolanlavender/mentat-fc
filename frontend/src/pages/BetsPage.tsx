import { useEffect, useState, type FormEvent } from 'react';
import { authedGet, apiRequest } from '../api/client';
import type { Bet, BetLeg, BetResult, BetsRoiSummary, SquadPlayer, Team } from '../api/types';
import { positionGroup } from '../lib/positions';
import { americanToDecimal, isValidAmericanOdds } from '../lib/odds';

interface UpcomingFixture {
  id: number;
  kickoffAt: string;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
}

const MATCH_WINNER = 'match_winner';
const ANYTIME_SCORER = 'anytime_scorer';
type Market = typeof MATCH_WINNER | typeof ANYTIME_SCORER;
type OddsFormat = 'decimal' | 'american';

interface DraftLeg {
  key: string;
  fixtureId: number;
  fixtureLabel: string;
  market: Market;
  selection: string;
  selectionLabel: string;
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

function legKey(fixtureId: number, market: string, selection: string): string {
  return `${fixtureId}-${market}-${selection}`;
}

// Decimal odds are the backend's source of truth (see docs/erd.md's bets
// design notes); American odds are purely an input convenience converted
// here before anything reaches the API.
function parseOdds(raw: string, format: OddsFormat): number | null {
  const value = Number(raw);
  if (format === 'decimal') return value > 1 ? value : null;
  if (!isValidAmericanOdds(value)) return null;
  return americanToDecimal(value);
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
  const [squadsByTeam, setSquadsByTeam] = useState<Record<number, SquadPlayer[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const [seasonFilter, setSeasonFilter] = useState('');
  const [teamFilter, setTeamFilter] = useState('');

  const [draftLegs, setDraftLegs] = useState<DraftLeg[]>([]);
  const [legMarket, setLegMarket] = useState<Market>(MATCH_WINNER);
  const [legFixtureId, setLegFixtureId] = useState('');
  const [legSelection, setLegSelection] = useState<'home' | 'draw' | 'away'>('home');
  const [legTeamId, setLegTeamId] = useState('');
  const [legPlayerId, setLegPlayerId] = useState('');
  const [legOddsFormat, setLegOddsFormat] = useState<OddsFormat>('decimal');
  const [legOdds, setLegOdds] = useState('');
  const [stake, setStake] = useState('');
  const [overrideOddsFormat, setOverrideOddsFormat] = useState<OddsFormat>('decimal');
  const [overrideOdds, setOverrideOdds] = useState('');
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

  // Lazily fetch + cache a team's squad the first time it's picked for an
  // anytime-scorer leg -- most bet sessions only ever touch one or two
  // teams, so there's no reason to fetch every team's squad up front.
  useEffect(() => {
    if (legMarket !== ANYTIME_SCORER || !legTeamId) return;
    const teamId = Number(legTeamId);
    if (squadsByTeam[teamId]) return;
    authedGet<{ squad: SquadPlayer[] }>(`/api/teams/${teamId}/dashboard`)
      .then((dashboard) => setSquadsByTeam((prev) => ({ ...prev, [teamId]: dashboard.squad })))
      .catch((err) => setFormError(err instanceof Error ? err.message : String(err)));
  }, [legMarket, legTeamId, squadsByTeam]);

  const teamFixtures = legTeamId
    ? (fixtures ?? []).filter((f) => f.homeTeam.id === Number(legTeamId) || f.awayTeam.id === Number(legTeamId))
    : [];
  // Goalkeepers excluded -- vanishingly rare for one to score, and it just
  // clutters a picker meant for realistic anytime-scorer bets.
  const teamSquad = legTeamId
    ? (squadsByTeam[Number(legTeamId)] ?? []).filter((p) => positionGroup(p.position) !== 'Goalkeeper')
    : [];

  function handleMarketChange(market: Market): void {
    setLegMarket(market);
    setLegFixtureId('');
    setLegTeamId('');
    setLegPlayerId('');
  }

  function handleAddLeg(): void {
    setFormError(null);
    const odds = parseOdds(legOdds, legOddsFormat);
    if (odds === null) {
      setFormError(
        legOddsFormat === 'decimal' ? 'Odds must be greater than 1' : 'American odds must be +100 or higher, or -100 or lower',
      );
      return;
    }

    if (legMarket === MATCH_WINNER) {
      const fixture = fixtures?.find((f) => f.id === Number(legFixtureId));
      if (!fixture) {
        setFormError('Pick a fixture first');
        return;
      }
      const key = legKey(fixture.id, MATCH_WINNER, legSelection);
      if (draftLegs.some((l) => l.key === key)) {
        setFormError('That pick is already in this bet');
        return;
      }
      setDraftLegs([
        ...draftLegs,
        {
          key,
          fixtureId: fixture.id,
          fixtureLabel: `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`,
          market: MATCH_WINNER,
          selection: legSelection,
          selectionLabel: legSelection === 'home' ? 'Home win' : legSelection === 'away' ? 'Away win' : 'Draw',
          oddsDecimal: odds,
        },
      ]);
    } else {
      const fixture = fixtures?.find((f) => f.id === Number(legFixtureId));
      if (!fixture) {
        setFormError('Pick a fixture first');
        return;
      }
      const player = teamSquad.find((p) => p.id === Number(legPlayerId));
      if (!player) {
        setFormError('Pick a player first');
        return;
      }
      const key = legKey(fixture.id, ANYTIME_SCORER, String(player.id));
      if (draftLegs.some((l) => l.key === key)) {
        setFormError('That pick is already in this bet');
        return;
      }
      setDraftLegs([
        ...draftLegs,
        {
          key,
          fixtureId: fixture.id,
          fixtureLabel: `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`,
          market: ANYTIME_SCORER,
          selection: String(player.id),
          selectionLabel: `${player.fullName} anytime scorer`,
          oddsDecimal: odds,
        },
      ]);
    }
    setLegFixtureId('');
    setLegPlayerId('');
    setLegOdds('');
  }

  function handleRemoveLeg(key: string): void {
    setDraftLegs(draftLegs.filter((l) => l.key !== key));
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    if (draftLegs.length === 0) {
      setFormError('Add at least one leg');
      return;
    }

    let oddsOverrideDecimal: number | undefined;
    if (draftLegs.length > 1 && overrideOdds.trim() !== '') {
      const parsed = parseOdds(overrideOdds, overrideOddsFormat);
      if (parsed === null) {
        setFormError(
          overrideOddsFormat === 'decimal'
            ? 'Combined odds must be greater than 1'
            : 'Combined American odds must be +100 or higher, or -100 or lower',
        );
        return;
      }
      oddsOverrideDecimal = parsed;
    }

    setSubmitting(true);
    try {
      await apiRequest('/api/bets', {
        method: 'POST',
        body: {
          stake: Number(stake),
          legs: draftLegs.map((l) => ({
            fixtureId: l.fixtureId,
            market: l.market,
            selection: l.selection,
            oddsDecimal: l.oddsDecimal,
          })),
          ...(oddsOverrideDecimal !== undefined ? { oddsOverrideDecimal } : {}),
        },
      });
      setDraftLegs([]);
      setStake('');
      setOverrideOdds('');
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

  function draftLegLine(leg: DraftLeg): string {
    return leg.market === ANYTIME_SCORER
      ? `${leg.selectionLabel} — ${leg.fixtureLabel} @ ${leg.oddsDecimal.toFixed(2)}`
      : `${leg.fixtureLabel} — ${leg.selectionLabel} @ ${leg.oddsDecimal.toFixed(2)}`;
  }

  function legLine(leg: BetLeg): string {
    if (leg.market === ANYTIME_SCORER && leg.player) {
      return `${leg.player.name} anytime scorer — ${leg.fixture.homeTeam.name} vs ${leg.fixture.awayTeam.name} @ ${leg.oddsDecimal.toFixed(2)}`;
    }
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
              ${summary.totalStakedSettled.toFixed(2)} staked · ${summary.totalReturnedSettled.toFixed(2)} returned · net{' '}
              ${summary.netProfitSettled.toFixed(2)} · ROI {formatPercent(summary.roiPercent)}
            </p>
          </>
        )}
      </section>

      <section>
        <h2>Log a bet</h2>
        <div className="bet-form">
          <label>
            Market
            <select value={legMarket} onChange={(e) => handleMarketChange(e.target.value as Market)}>
              <option value={MATCH_WINNER}>Match winner</option>
              <option value={ANYTIME_SCORER}>Anytime goalscorer</option>
            </select>
          </label>

          {legMarket === MATCH_WINNER ? (
            <>
              <label>
                Fixture
                <select value={legFixtureId} onChange={(e) => setLegFixtureId(e.target.value)}>
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
                <select value={legSelection} onChange={(e) => setLegSelection(e.target.value as 'home' | 'draw' | 'away')}>
                  <option value="home">Home win</option>
                  <option value="draw">Draw</option>
                  <option value="away">Away win</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                Team
                <select
                  value={legTeamId}
                  onChange={(e) => {
                    setLegTeamId(e.target.value);
                    setLegFixtureId('');
                    setLegPlayerId('');
                  }}
                >
                  <option value="" disabled>
                    Select a team…
                  </option>
                  {teams?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Fixture
                <select value={legFixtureId} onChange={(e) => setLegFixtureId(e.target.value)} disabled={!legTeamId}>
                  <option value="" disabled>
                    {legTeamId ? 'Select an upcoming fixture…' : 'Pick a team first'}
                  </option>
                  {teamFixtures.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.homeTeam.name} vs {f.awayTeam.name} — {new Date(f.kickoffAt).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Player
                <select value={legPlayerId} onChange={(e) => setLegPlayerId(e.target.value)} disabled={!legTeamId}>
                  <option value="" disabled>
                    {legTeamId ? 'Select a player…' : 'Pick a team first'}
                  </option>
                  {teamSquad.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          <label>
            Odds format
            <select value={legOddsFormat} onChange={(e) => setLegOddsFormat(e.target.value as OddsFormat)}>
              <option value="decimal">Decimal</option>
              <option value="american">American</option>
            </select>
          </label>
          <label>
            {legOddsFormat === 'decimal' ? 'Leg odds (decimal)' : 'Leg odds (American)'}
            <input
              type="number"
              step={legOddsFormat === 'decimal' ? '0.01' : '1'}
              placeholder={legOddsFormat === 'decimal' ? 'e.g. 2.50' : 'e.g. -110 or +150'}
              value={legOdds}
              onChange={(e) => setLegOdds(e.target.value)}
            />
          </label>
          <button type="button" onClick={handleAddLeg}>
            Add leg
          </button>
        </div>

        {draftLegs.length > 0 && (
          <ul className="draft-legs">
            {draftLegs.map((l) => (
              <li key={l.key}>
                {draftLegLine(l)}{' '}
                <button type="button" onClick={() => handleRemoveLeg(l.key)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleSubmit} className="bet-form">
          <label>
            Stake ($)
            <input type="number" step="0.01" min="0.01" value={stake} onChange={(e) => setStake(e.target.value)} required />
          </label>
          {draftLegs.length > 1 && (
            <>
              <label>
                Combined odds format
                <select value={overrideOddsFormat} onChange={(e) => setOverrideOddsFormat(e.target.value as OddsFormat)}>
                  <option value="decimal">Decimal</option>
                  <option value="american">American</option>
                </select>
              </label>
              <label>
                Combined odds (from the book, optional)
                <input
                  type="number"
                  step={overrideOddsFormat === 'decimal' ? '0.01' : '1'}
                  placeholder={overrideOddsFormat === 'decimal' ? 'e.g. 6.25' : 'e.g. +525'}
                  value={overrideOdds}
                  onChange={(e) => setOverrideOdds(e.target.value)}
                />
              </label>
            </>
          )}
          <button type="submit" disabled={submitting || draftLegs.length === 0}>
            {submitting ? 'Logging…' : draftLegs.length > 1 ? `Log parlay (${draftLegs.length} legs)` : 'Log bet'}
          </button>
          {formError && <p className="error">{formError}</p>}
        </form>
        {draftLegs.length > 1 && (
          <p className="bet-form-hint">
            Leave combined odds blank to use the pure product of each leg's own odds — enter it only if the book quoted you a
            different total.
          </p>
        )}
      </section>

      <section>
        <h2>All bets</h2>
        <p className="bet-form-hint">
          Match-winner and anytime-scorer legs grade themselves automatically once the match finishes, using the real result
          — use Won/Lost/Void only to correct or settle something the app can't grade on its own.
        </p>
        {bets?.length === 0 && <p>Nothing on the books yet — fancy a flutter?</p>}
        {bets?.map((bet) => (
          <div className="bet-card" key={bet.id}>
            <div className="bet-card-header">
              <strong>{bet.isParlay ? `Parlay (${bet.legs.length} legs)` : 'Single bet'}</strong>
              <span>
                ${bet.stake.toFixed(2)} @ {bet.combinedOdds.toFixed(2)}
                {bet.oddsOverrideDecimal !== null ? ' (book price)' : ''} · your {formatProb(bet.yourImpliedProbability)} ·
                model {formatProb(bet.modelProbability)} · edge {bet.edge === null ? '—' : formatPercent(bet.edge * 100)}
              </span>
              <span className={`bet-result bet-result-${bet.result}`}>{bet.result}</span>
              {bet.payout !== null && <span>payout ${bet.payout.toFixed(2)}</span>}
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
