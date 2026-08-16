import { useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../api/client';
import type { FixtureSummary, ScorerPrediction } from '../api/types';
import { Crest, PlayerPhoto } from '../components/Crest';

const COMPETITIONS = ['Premier League', 'Championship'] as const;
type CompetitionFilter = (typeof COMPETITIONS)[number] | 'all';

// Capped by date, not by literal round-number matching -- API-Football's
// round strings ("Regular Season - 3") aren't guaranteed to be uniformly
// comparable across competitions, but "the next 14 days" is a robust
// stand-in for "next 2 matchweeks" for leagues that play weekly, without
// needing to parse that string at all. The matchweek dropdown below is a
// client-side narrowing of whatever rounds land inside this window, not
// the primary windowing mechanism.
const DAYS_AHEAD = 14;

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

// Top 3 only, even though the API can return up to 5 -- this is a compact
// list view, not a fixture detail page; showing all 5 tips over into
// clutter for a "likely scorers" glance rather than a full breakdown.
const SCORERS_SHOWN = 3;
const TOP_PICKS_SHOWN = 5;
const TOP_SCORER_PICKS_SHOWN = 8;

interface TopPick {
  fixture: FixtureSummary;
  outcome: 'Home' | 'Draw' | 'Away';
  probability: number;
}

function topOutcome(fixture: FixtureSummary): TopPick | null {
  const p = fixture.prediction;
  if (!p) return null;
  const options: Array<{ outcome: TopPick['outcome']; probability: number }> = [
    { outcome: 'Home', probability: p.probHomeWin },
    { outcome: 'Draw', probability: p.probDraw },
    { outcome: 'Away', probability: p.probAwayWin },
  ];
  return { fixture, ...options.reduce((a, b) => (b.probability > a.probability ? b : a)) };
}

interface TopScorerPick extends ScorerPrediction {
  fixture: FixtureSummary;
}

function PredictionRow({ fixture }: { fixture: FixtureSummary }) {
  const { prediction, topScorers } = fixture;
  return (
    <li className="prediction-row">
      <div className="prediction-fixture">
        <strong className="fixture-teams">
          <Crest src={fixture.homeTeam.logoUrl} alt="" />
          {fixture.homeTeam.name} vs {fixture.awayTeam.name}
          <Crest src={fixture.awayTeam.logoUrl} alt="" />
        </strong>
        <span className="prediction-meta">
          {fixture.competitionName} · {new Date(fixture.kickoffAt).toLocaleString()}
        </span>
      </div>
      {prediction ? (
        <div className="prediction-probs">
          <span>Home {formatPercent(prediction.probHomeWin)}</span>
          <span>Draw {formatPercent(prediction.probDraw)}</span>
          <span>Away {formatPercent(prediction.probAwayWin)}</span>
          {prediction.predictedHomeGoals !== null && prediction.predictedAwayGoals !== null && (
            <span className="prediction-expected-goals">
              expected {prediction.predictedHomeGoals.toFixed(2)} - {prediction.predictedAwayGoals.toFixed(2)}
            </span>
          )}
          {topScorers.length > 0 && (
            <span className="prediction-scorers">
              Likely scorers:{' '}
              {topScorers.slice(0, SCORERS_SHOWN).map((s, i) => (
                <span key={s.playerId} className="scorer-chip">
                  <PlayerPhoto src={s.playerPhotoUrl} alt="" size={18} />
                  {s.playerName} ({formatPercent(s.probScores)})
                  {i < Math.min(topScorers.length, SCORERS_SHOWN) - 1 ? ', ' : ''}
                </span>
              ))}
            </span>
          )}
        </div>
      ) : (
        <span className="prediction-none">No prediction yet</span>
      )}
    </li>
  );
}

// Not built on useFetch: needs two competitions merged into one sorted
// list, which is simpler as an owned fetch than forcing a single-URL hook
// to combine two responses.
export function PredictionsPage() {
  const [fixtures, setFixtures] = useState<FixtureSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [competition, setCompetition] = useState<CompetitionFilter>('all');
  const [matchweek, setMatchweek] = useState<string>('all');

  useEffect(() => {
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const wanted = competition === 'all' ? COMPETITIONS : [competition];

    Promise.all(
      wanted.map((c) =>
        fetch(apiUrl(`/api/fixtures?competition=${encodeURIComponent(c)}&from=${from}&to=${to}&limit=100`)).then(
          (res) => res.json() as Promise<FixtureSummary[]>,
        ),
      ),
    )
      .then((results) => {
        const merged = results.flat().sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
        setFixtures(merged);
        setMatchweek('all');
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [competition]);

  // Distinct rounds present in the fetched window, ordered by their
  // earliest kickoff -- not alphabetically, since "Regular Season - 10"
  // would otherwise sort before "Regular Season - 2" as plain strings.
  const matchweeks = useMemo(() => {
    if (!fixtures) return [];
    const earliestKickoffByRound = new Map<string, string>();
    for (const f of fixtures) {
      if (!f.round) continue;
      const existing = earliestKickoffByRound.get(f.round);
      if (!existing || f.kickoffAt < existing) earliestKickoffByRound.set(f.round, f.kickoffAt);
    }
    return [...earliestKickoffByRound.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([round]) => round);
  }, [fixtures]);

  const filteredFixtures = useMemo(() => {
    if (!fixtures) return [];
    return matchweek === 'all' ? fixtures : fixtures.filter((f) => f.round === matchweek);
  }, [fixtures, matchweek]);

  const topPicks = useMemo(
    () =>
      filteredFixtures
        .map(topOutcome)
        .filter((p): p is TopPick => p !== null)
        .sort((a, b) => b.probability - a.probability)
        .slice(0, TOP_PICKS_SHOWN),
    [filteredFixtures],
  );

  const topScorerPicks = useMemo(() => {
    const flattened: TopScorerPick[] = filteredFixtures.flatMap((fixture) =>
      fixture.topScorers.map((s) => ({ ...s, fixture })),
    );
    return flattened.sort((a, b) => b.probScores - a.probScores).slice(0, TOP_SCORER_PICKS_SHOWN);
  }, [filteredFixtures]);

  return (
    <div className="page">
      <h1>Predictions</h1>

      <div className="prediction-filters">
        <label className="competition-filter">
          Competition
          <select value={competition} onChange={(e) => setCompetition(e.target.value as CompetitionFilter)}>
            <option value="all">All</option>
            {COMPETITIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="competition-filter">
          Matchweek
          <select value={matchweek} onChange={(e) => setMatchweek(e.target.value)}>
            <option value="all">Next {DAYS_AHEAD} days</option>
            {matchweeks.map((round) => (
              <option key={round} value={round}>
                {round}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="error">Couldn't load predictions: {error}</p>}
      {fixtures?.length === 0 && <p>Nothing on the card just now.</p>}

      {topPicks.length > 0 && (
        <section>
          <h2>Top picks</h2>
          <ul className="top-picks-list">
            {topPicks.map((pick) => (
              <li key={pick.fixture.id} className="fixture-teams">
                <Crest src={pick.fixture.homeTeam.logoUrl} alt="" />
                <span className="top-pick-fixture">
                  {pick.fixture.homeTeam.name} vs {pick.fixture.awayTeam.name}
                  <span className="prediction-meta">{new Date(pick.fixture.kickoffAt).toLocaleString()}</span>
                </span>
                <Crest src={pick.fixture.awayTeam.logoUrl} alt="" />
                <span className="top-pick-call">
                  {pick.outcome} {formatPercent(pick.probability)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {topScorerPicks.length > 0 && (
        <section>
          <h2>Top goalscorer picks</h2>
          <ul className="top-picks-list">
            {topScorerPicks.map((pick) => (
              <li key={`${pick.fixture.id}-${pick.playerId}`} className="fixture-teams">
                <PlayerPhoto src={pick.playerPhotoUrl} alt="" />
                {pick.playerName}
                <span className="prediction-meta">
                  {pick.fixture.homeTeam.name} vs {pick.fixture.awayTeam.name} ·{' '}
                  {new Date(pick.fixture.kickoffAt).toLocaleString()}
                </span>
                <span className="top-pick-call">{formatPercent(pick.probScores)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>All fixtures</h2>
        <ul className="prediction-list">{filteredFixtures.map((f) => <PredictionRow key={f.id} fixture={f} />)}</ul>
      </section>
    </div>
  );
}
