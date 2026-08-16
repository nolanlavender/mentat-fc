import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { Team } from '../api/types';
import { Crest } from '../components/Crest';

const COMPETITIONS = ['Premier League', 'Championship'] as const;
type CompetitionFilter = (typeof COMPETITIONS)[number] | 'all';

export function TeamListPage() {
  const [competition, setCompetition] = useState<CompetitionFilter>('all');
  const url = competition === 'all' ? '/api/teams' : `/api/teams?competition=${encodeURIComponent(competition)}`;
  const { data: teams, loading, error } = useFetch<Team[]>(apiUrl(url));

  return (
    <div className="page">
      <h1>Mentat FC</h1>
      <p>Premier League and Championship sides, all in one place. Have a look about.</p>

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

      {loading && <p>Hang about, fetching the sides…</p>}
      {error && <p className="error">Couldn't load teams: {error.message}</p>}

      {teams && (
        <ul className="team-list">
          {teams.map((team) => (
            <li key={team.id}>
              <Link to={`/teams/${team.id}`}>
                <Crest src={team.logoUrl} alt="" />
                {team.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
