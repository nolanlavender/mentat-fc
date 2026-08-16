import { Link } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { MyTeam, MyTeamPlayer } from '../api/types';
import { Crest, PlayerPhoto } from '../components/Crest';

function PlayerRow({ player }: { player: MyTeamPlayer }) {
  const nameContent = (
    <>
      <PlayerPhoto src={player.photoUrl} alt="" />
      {player.fullName}
    </>
  );
  return (
    <li>
      {player.playerId > 0 ? (
        <Link to={`/players/${player.playerId}`} className="squad-link">
          {nameContent}
        </Link>
      ) : (
        nameContent
      )}
      {player.team ? (
        <>
          {' — '}
          <Crest src={player.team.logoUrl} alt="" size={18} />
          {player.team.name}
        </>
      ) : (
        ''
      )}
      {player.position ? ` (${player.position})` : ''}
      {player.isCaptain && ' (C)'}
      {player.isViceCaptain && ' (VC)'}
    </li>
  );
}

export function MyTeamPage() {
  const { data, loading, error } = useFetch<MyTeam>(apiUrl('/api/fpl/my-team'));

  return (
    <div className="page">
      <h1>My Team</h1>

      {loading && <p>Hang about…</p>}
      {error && <p className="error">Couldn't load your team: {error.message}</p>}

      {data && (
        <>
          <p>
            {data.entryName} — {data.managerName}
          </p>
          {data.isPreview && (
            <p className="preview-banner">
              Preseason preview — gameweek {data.gameweek} hasn't started yet, so there's no live scoring. This is just
              your saved squad.
            </p>
          )}
          <section>
            <h2>Gameweek {data.gameweek}</h2>
            {!data.isPreview && (
              <p>
                {data.gameweekPoints} points this gameweek · {data.totalPoints} total · £{data.squadValue.toFixed(1)}m
                squad value · £{data.bank.toFixed(1)}m in the bank
                {data.activeChip ? ` · ${data.activeChip} active` : ''}
              </p>
            )}
          </section>

          <section>
            <h2>Starting XI</h2>
            <ul className="squad-list">
              {data.players
                .filter((p) => p.isStarting)
                .map((p) => (
                  <PlayerRow key={p.fplPlayerId} player={p} />
                ))}
            </ul>
          </section>

          <section>
            <h2>Bench</h2>
            <ul className="squad-list">
              {data.players
                .filter((p) => !p.isStarting)
                .map((p) => (
                  <PlayerRow key={p.fplPlayerId} player={p} />
                ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
