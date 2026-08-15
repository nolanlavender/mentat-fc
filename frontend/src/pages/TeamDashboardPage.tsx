import { useParams } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { TeamDashboard } from '../api/types';
import { TeamSwitcher } from '../components/TeamSwitcher';

export function TeamDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useFetch<TeamDashboard>(id ? apiUrl(`/api/teams/${id}/dashboard`) : null);

  return (
    <div className="page">
      <TeamSwitcher currentTeamId={id ? Number(id) : undefined} />

      {loading && <p>Hang about…</p>}
      {error && <p className="error">Couldn't load this team: {error.message}</p>}

      {data && (
        <>
          <h1>{data.team.name}</h1>

          {data.tablePosition && (
            <section>
              <h2>
                {data.tablePosition.competitionName} — {data.tablePosition.seasonLabel}
              </h2>
              <p>
                Position {data.tablePosition.position} · {data.tablePosition.points} pts ·{' '}
                {data.tablePosition.played} played · {data.tablePosition.goalsFor}-{data.tablePosition.goalsAgainst}{' '}
                goal difference
              </p>
            </section>
          )}

          <section>
            <h2>Next match</h2>
            {data.nextMatch ? (
              <>
                <p>
                  {data.nextMatch.homeTeam.name} vs {data.nextMatch.awayTeam.name} —{' '}
                  {new Date(data.nextMatch.kickoffAt).toLocaleString()} ({data.nextMatch.competitionName})
                </p>
                {data.nextMatch.prediction ? (
                  <p>
                    Model prediction: {data.nextMatch.prediction.predictedHomeGoals ?? '?'} -{' '}
                    {data.nextMatch.prediction.predictedAwayGoals ?? '?'} (home win{' '}
                    {Math.round(data.nextMatch.prediction.probHomeWin * 100)}%)
                  </p>
                ) : (
                  <p>No prediction available for this fixture yet.</p>
                )}
              </>
            ) : (
              <p>Nothing on the fixture list just yet.</p>
            )}
          </section>

          <section>
            <h2>Squad</h2>
            {data.squad.length === 0 ? (
              <p>No squad news in for this lot yet.</p>
            ) : (
              <ul className="squad-list">
                {data.squad.map((player) => (
                  <li key={player.id}>
                    {player.fullName}
                    {player.position ? ` (${player.position})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
