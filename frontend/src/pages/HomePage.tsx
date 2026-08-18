import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { FixtureSummary, Standings, Team } from '../api/types';
import { Crest } from '../components/Crest';
import { EnglandWalesMap } from '../components/EnglandWalesMap';

const COMPETITIONS = ['Premier League', 'Championship'] as const;
type Competition = (typeof COMPETITIONS)[number];

const FIXTURE_WINDOW_DAYS = 10;
const FIXTURES_SHOWN = 5;

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function fixtureLine(fixture: FixtureSummary): string {
  const when = new Date(fixture.kickoffAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (fixture.status === 'finished') {
    return `${fixture.homeTeam.name} ${fixture.homeScore}-${fixture.awayScore} ${fixture.awayTeam.name} · ${when}`;
  }
  return `${fixture.homeTeam.name} vs ${fixture.awayTeam.name} · ${when}`;
}

export function HomePage() {
  const [competition, setCompetition] = useState<Competition>('Premier League');

  const { data: teams, error: teamsError } = useFetch<Team[]>(
    apiUrl(`/api/teams?competition=${encodeURIComponent(competition)}`),
  );
  const { data: standings, error: standingsError } = useFetch<Standings>(
    apiUrl(`/api/teams/standings?competition=${encodeURIComponent(competition)}`),
  );

  const today = new Date();
  const { data: fixturesWindow, error: fixturesError } = useFetch<FixtureSummary[]>(
    apiUrl(
      `/api/fixtures?competition=${encodeURIComponent(competition)}` +
        `&from=${addDays(today, -FIXTURE_WINDOW_DAYS)}&to=${addDays(today, FIXTURE_WINDOW_DAYS)}&limit=100`,
    ),
  );

  // The app deliberately has no live/in-play score tracking (see
  // docs/architecture.md) -- fixtures are only ever 'scheduled' or
  // 'finished', so this box is upcoming fixtures and recent results, not
  // a live scoreboard. Derived client-side from one shared window fetch
  // rather than two separate backend queries/filters.
  const recentResults = (fixturesWindow ?? [])
    .filter((f) => f.status === 'finished')
    .slice(-FIXTURES_SHOWN)
    .reverse();
  const upcoming = (fixturesWindow ?? [])
    .filter((f) => f.status !== 'finished' && new Date(f.kickoffAt) >= today)
    .slice(0, FIXTURES_SHOWN);

  return (
    <div className="page home-page">
      <h1>Mentat FC</h1>
      <p>Premier League and Championship sides, where they play, and how the table looks right now.</p>

      <label className="competition-filter">
        Competition
        <select value={competition} onChange={(e) => setCompetition(e.target.value as Competition)}>
          {COMPETITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      {teamsError && <p className="error">Couldn't load teams: {teamsError.message}</p>}

      <div className="home-layout">
        <section className="home-map-section">
          <h2>Where they play</h2>
          {teams ? <EnglandWalesMap teams={teams} /> : <p>Hang about, plotting the sides…</p>}
        </section>

        <div className="home-side-column">
          <section>
            <h2>
              {standings ? `${standings.competitionName} — ${standings.seasonLabel}` : 'Standings'}
            </h2>
            {standingsError && <p className="error">Couldn't load standings: {standingsError.message}</p>}
            {standings && (
              <table className="standings-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Team</th>
                    <th>P</th>
                    <th>GD</th>
                    <th>Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.rows.map((row) => (
                    <tr key={row.team.id}>
                      <td>{row.position}</td>
                      <td>
                        <Link to={`/teams/${row.team.id}`} className="standings-team">
                          <Crest src={row.team.logoUrl} alt="" size={18} />
                          {row.team.name}
                        </Link>
                      </td>
                      <td>{row.played}</td>
                      <td>{row.goalDifference >= 0 ? `+${row.goalDifference}` : row.goalDifference}</td>
                      <td>
                        <strong>{row.points}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h2>Upcoming fixtures</h2>
            {fixturesError && <p className="error">Couldn't load fixtures: {fixturesError.message}</p>}
            {upcoming.length === 0 && fixturesWindow && <p>Nothing on the calendar in the next {FIXTURE_WINDOW_DAYS} days.</p>}
            <ul className="home-fixture-list">
              {upcoming.map((f) => (
                <li key={f.id}>
                  <Link to={`/fixtures/${f.id}`}>{fixtureLine(f)}</Link>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>Recent results</h2>
            {recentResults.length === 0 && fixturesWindow && <p>Nothing finished in the last {FIXTURE_WINDOW_DAYS} days.</p>}
            <ul className="home-fixture-list">
              {recentResults.map((f) => (
                <li key={f.id}>
                  <Link to={`/fixtures/${f.id}`}>{fixtureLine(f)}</Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
