import { useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { Team } from '../api/types';

export function TeamSwitcher({ currentTeamId }: { currentTeamId?: number }) {
  const { data: teams } = useFetch<Team[]>(apiUrl('/api/teams'));
  const navigate = useNavigate();

  return (
    <nav className="team-switcher">
      <select
        value={currentTeamId ?? ''}
        onChange={(e) => navigate(`/teams/${e.target.value}`)}
        aria-label="Switch team"
      >
        <option value="" disabled>
          Switch team…
        </option>
        {teams?.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
    </nav>
  );
}
