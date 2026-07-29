import { Link } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { Team } from '../api/types';

export function TeamListPage() {
  const { data: teams, loading, error } = useFetch<Team[]>(apiUrl('/api/teams'));

  return (
    <div className="page">
      <h1>Mentat FC</h1>
      <p>Premier League and Championship team dashboards.</p>

      {loading && <p>Loading teams…</p>}
      {error && <p className="error">Couldn't load teams: {error.message}</p>}

      {teams && (
        <ul className="team-list">
          {teams.map((team) => (
            <li key={team.id}>
              <Link to={`/teams/${team.id}`}>{team.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
