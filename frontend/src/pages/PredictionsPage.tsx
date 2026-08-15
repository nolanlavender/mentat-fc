import { useEffect, useState } from 'react';
import { apiUrl } from '../api/client';
import type { FixtureSummary } from '../api/types';
import { Crest, PlayerPhoto } from '../components/Crest';

const COMPETITIONS = ['Premier League', 'Championship'] as const;
type CompetitionFilter = (typeof COMPETITIONS)[number] | 'all';

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// Top 3 only, even though the API can return up to 5 -- this is a compact
// list view, not a fixture detail page; showing all 5 tips over into
// clutter for a "likely scorers" glance rather than a full breakdown.
const SCORERS_SHOWN = 3;

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
              expected {prediction.predictedHomeGoals.toFixed(1)} - {prediction.predictedAwayGoals.toFixed(1)}
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

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const wanted = competition === 'all' ? COMPETITIONS : [competition];

    Promise.all(
      wanted.map((c) =>
        fetch(apiUrl(`/api/fixtures?competition=${encodeURIComponent(c)}&from=${today}&limit=50`)).then(
          (res) => res.json() as Promise<FixtureSummary[]>,
        ),
      ),
    )
      .then((results) => {
        const merged = results.flat().sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
        setFixtures(merged);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [competition]);

  return (
    <div className="page">
      <h1>Predictions</h1>

      <label className="prediction-filter">
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

      {error && <p className="error">Couldn't load predictions: {error}</p>}
      {fixtures?.length === 0 && <p>Nothing on the card just now.</p>}

      <ul className="prediction-list">{fixtures?.map((f) => <PredictionRow key={f.id} fixture={f} />)}</ul>
    </div>
  );
}
