import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiUrl } from '../api/client';
import type { FixtureSummary } from '../api/types';
import { Crest } from '../components/Crest';
import { londonToday, shiftDate } from '../lib/date';

const COMPETITIONS = ['Premier League', 'Championship'] as const;

function formatHeading(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function statusLabel(fixture: FixtureSummary): string {
  if (fixture.status === 'finished') return `${fixture.homeScore} - ${fixture.awayScore}`;
  return new Date(fixture.kickoffAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function FixtureRow({ fixture }: { fixture: FixtureSummary }) {
  return (
    <li className="fixture-list-row">
      <Link to={`/fixtures/${fixture.id}`} className="fixture-teams">
        <Crest src={fixture.homeTeam.logoUrl} alt="" />
        {fixture.homeTeam.name} vs {fixture.awayTeam.name}
        <Crest src={fixture.awayTeam.logoUrl} alt="" />
      </Link>
      <span className="prediction-meta">{fixture.competitionName}</span>
      <span className="fixture-list-status">{statusLabel(fixture)}</span>
    </li>
  );
}

// Owns its own fetch, not useFetch -- same reason as PredictionsPage:
// merges two competitions' worth of fixtures into one sorted list.
export function FixturesPage() {
  const [date, setDate] = useState(londonToday);
  const [fixtures, setFixtures] = useState<FixtureSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFixtures(null);
    Promise.all(
      COMPETITIONS.map((c) =>
        fetch(apiUrl(`/api/fixtures?competition=${encodeURIComponent(c)}&date=${date}&limit=100`)).then(
          (res) => res.json() as Promise<FixtureSummary[]>,
        ),
      ),
    )
      .then((results) => {
        setFixtures(results.flat().sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt)));
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [date]);

  return (
    <div className="page">
      <h1>Fixtures</h1>

      <div className="date-nav">
        <button type="button" onClick={() => setDate((d) => shiftDate(d, -1))} aria-label="Previous day">
          ‹ Prev
        </button>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Select date" />
        <button type="button" onClick={() => setDate((d) => shiftDate(d, 1))} aria-label="Next day">
          Next ›
        </button>
        {date !== londonToday() && (
          <button type="button" onClick={() => setDate(londonToday())} className="link-button">
            Today
          </button>
        )}
      </div>

      <h2>{formatHeading(date)}</h2>

      {error && <p className="error">Couldn't load fixtures: {error}</p>}
      {fixtures && fixtures.length === 0 && <p>No Premier League or Championship fixtures on this date.</p>}

      <ul className="fixture-list">{fixtures?.map((f) => <FixtureRow key={f.id} fixture={f} />)}</ul>
    </div>
  );
}
