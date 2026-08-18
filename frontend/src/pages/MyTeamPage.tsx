import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { authedGet, apiRequest } from '../api/client';
import type { MyTeamPlayer, MyTeamResponse } from '../api/types';
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

// Owns its own fetch/refresh cycle (not useFetch, GET-only) -- linking a
// team is a mutation that needs to invalidate the same GET this page reads.
export function MyTeamPage() {
  const [data, setData] = useState<MyTeamResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [entryIdInput, setEntryIdInput] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const result = await authedGet<MyTeamResponse>('/api/fpl/my-team');
      setData(result);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleLink(e: FormEvent): Promise<void> {
    e.preventDefault();
    setLinkError(null);
    const fplEntryId = Number(entryIdInput);
    if (!Number.isInteger(fplEntryId) || fplEntryId <= 0) {
      setLinkError('Enter the numeric ID from your team\'s URL on fantasy.premierleague.com');
      return;
    }
    setLinking(true);
    try {
      await apiRequest('/api/fpl/link', { method: 'POST', body: { fplEntryId } });
      setEntryIdInput('');
      setShowLinkForm(false);
      await refresh();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinking(false);
    }
  }

  function linkForm(cancelable: boolean): ReactElement {
    return (
      <form onSubmit={handleLink} className="bet-form">
        <label>
          Your FPL team ID
          <input
            type="number"
            placeholder="e.g. 1234567"
            value={entryIdInput}
            onChange={(e) => setEntryIdInput(e.target.value)}
          />
        </label>
        <button type="submit" disabled={linking}>
          {linking ? 'Linking…' : 'Link team'}
        </button>
        {cancelable && (
          <button type="button" onClick={() => setShowLinkForm(false)}>
            Cancel
          </button>
        )}
        {linkError && <p className="error">{linkError}</p>}
      </form>
    );
  }

  return (
    <div className="page">
      <h1>My Team</h1>

      {loading && <p>Hang about…</p>}
      {loadError && <p className="error">Couldn't load your team: {loadError}</p>}

      {data && !data.linked && (
        <>
          <p>
            Link your Fantasy Premier League team to see it here. Find your team ID in the URL when you view your team
            on fantasy.premierleague.com — e.g. <code>fantasy.premierleague.com/entry/1234567/...</code>, the ID is the
            number after <code>/entry/</code>.
          </p>
          {linkForm(false)}
        </>
      )}

      {data && data.linked && (
        <>
          <p>
            {data.entryName} — {data.managerName}{' '}
            <button type="button" className="link-button" onClick={() => setShowLinkForm((s) => !s)}>
              {showLinkForm ? 'Cancel' : 'Not your team? Link a different one'}
            </button>
          </p>
          {showLinkForm && linkForm(true)}
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
