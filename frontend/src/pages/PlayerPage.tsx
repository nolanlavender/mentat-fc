import { Link, useParams } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { PlayerDetail, PlayerFormSummary } from '../api/types';
import { Crest, PlayerPhoto } from '../components/Crest';

function formatRating(rating: number | null): string {
  return rating === null ? '—' : rating.toFixed(2);
}

function FormLine({ label, form }: { label: string; form: PlayerFormSummary | null }) {
  if (!form) return <p>{label}: nothing in this window yet.</p>;
  return (
    <p>
      {label}: {form.matches} apps · {form.goals} goals · {form.assists} assists · {form.minutesPlayed} mins · avg
      rating {formatRating(form.avgRating)}
    </p>
  );
}

export function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const { data: player, loading, error } = useFetch<PlayerDetail>(id ? apiUrl(`/api/players/${id}`) : null);

  return (
    <div className="page">
      {loading && <p>Hang about…</p>}
      {error && <p className="error">Couldn't load this player: {error.message}</p>}

      {player && (
        <>
          <h1 className="team-dashboard-heading">
            <PlayerPhoto src={player.photoUrl} alt="" size={48} />
            {player.fullName}
          </h1>

          <section>
            <h2>Basics</h2>
            <p>
              {player.position ?? 'Position unknown'}
              {player.nationality ? ` · ${player.nationality}` : ''}
              {player.dateOfBirth ? ` · born ${new Date(player.dateOfBirth).toLocaleDateString()}` : ''}
            </p>
            {player.currentTeam && (
              <p className="fixture-teams">
                <Crest src={player.currentTeam.logoUrl} alt="" />
                <Link to={`/teams/${player.currentTeam.id}`}>{player.currentTeam.name}</Link>
              </p>
            )}
          </section>

          <section>
            <h2>Season stats</h2>
            {player.seasonStats ? (
              <p>
                {player.seasonStats.seasonLabel}: {player.seasonStats.matches} apps ·{' '}
                {player.seasonStats.goals} goals · {player.seasonStats.assists} assists ·{' '}
                {player.seasonStats.minutesPlayed} mins · avg rating {formatRating(player.seasonStats.avgRating)} ·{' '}
                {player.seasonStats.yellowCards} yellow · {player.seasonStats.redCards} red
              </p>
            ) : (
              <p>No stats in for this one yet.</p>
            )}
          </section>

          <section>
            <h2>Form</h2>
            <FormLine label="Last 5 matches" form={player.last5Form} />
            <FormLine label="Last 30 days" form={player.last30DaysForm} />
          </section>

          <section>
            <h2>Game log</h2>
            {player.gameLog.length === 0 ? (
              <p>Nothing on the log yet.</p>
            ) : (
              <ul className="game-log">
                {player.gameLog.map((g) => (
                  <li key={g.fixtureId} className="game-log-row">
                    <div className="prediction-fixture">
                      <strong className="fixture-teams">
                        {g.isHome ? 'vs' : '@'} <Crest src={g.opponent.logoUrl} alt="" />
                        {g.opponent.name}
                      </strong>
                      <span className="prediction-meta">
                        {g.competitionName} · {new Date(g.kickoffAt).toLocaleDateString()} ·{' '}
                        {g.homeScore !== null && g.awayScore !== null ? `${g.homeScore}-${g.awayScore}` : 'result n/a'}
                      </span>
                    </div>
                    <span className="game-log-stats">
                      {g.minutesPlayed ?? 0}' · {g.goals ?? 0}g {g.assists ?? 0}a · rating {formatRating(g.rating)}
                      {g.yellowCards ? ` · ${g.yellowCards} yellow` : ''}
                      {g.redCards ? ` · ${g.redCards} red` : ''}
                    </span>
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
