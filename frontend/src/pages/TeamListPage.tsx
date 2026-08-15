import { Link } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { Team } from '../api/types';
import { Crest } from '../components/Crest';

export function TeamListPage() {
  const { data: teams, loading, error } = useFetch<Team[]>(apiUrl('/api/teams'));

  return (
    <div className="page">
      <h1>Mentat FC</h1>
      <p>Premier League and Championship sides, all in one place. Have a look about.</p>

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
