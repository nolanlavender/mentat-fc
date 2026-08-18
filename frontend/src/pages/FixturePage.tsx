import { Link, useParams } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { FixtureDetail, FixtureLineupPlayer } from '../api/types';
import { Crest, PlayerPhoto } from '../components/Crest';
import { shortCode } from '../lib/teamDisplay';

function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// A stat comparison row only worth rendering once at least one side has a
// number -- fixture_team_stats can be entirely absent (not yet backfilled,
// or a competition this app doesn't pull stats for).
function StatRow({ label, home, away }: { label: string; home: number | null; away: number | null }) {
  if (home === null && away === null) return null;
  return (
    <tr>
      <td className="fixture-stat-value">{home ?? '—'}</td>
      <td className="fixture-stat-label">{label}</td>
      <td className="fixture-stat-value">{away ?? '—'}</td>
    </tr>
  );
}

function lineupGroups(lineup: FixtureLineupPlayer[], teamId: number): { starters: FixtureLineupPlayer[]; subs: FixtureLineupPlayer[] } {
  const teamLineup = lineup.filter((p) => p.teamId === teamId);
  return {
    starters: teamLineup.filter((p) => p.isStarting),
    subs: teamLineup.filter((p) => !p.isStarting),
  };
}

function PlayerRow({ player }: { player: FixtureLineupPlayer }) {
  const played = player.minutesPlayed !== null;
  return (
    <li className="fixture-lineup-row">
      <Link to={`/players/${player.playerId}`} className="fixture-lineup-link">
        <span className="fixture-lineup-number">{player.shirtNumber ?? ''}</span>
        <PlayerPhoto src={player.playerPhotoUrl} alt="" size={22} />
        {player.playerName}
      </Link>
      {played && (
        <span className="fixture-lineup-stats">
          {player.goals ? `⚽${player.goals > 1 ? `×${player.goals}` : ''} ` : ''}
          {player.assists ? `🅰️${player.assists > 1 ? `×${player.assists}` : ''} ` : ''}
          {player.yellowCards ? '🟨 ' : ''}
          {player.redCards ? '🟥 ' : ''}
          {player.minutesPlayed}&apos; {player.rating !== null ? `· ${player.rating.toFixed(1)}` : ''}
        </span>
      )}
    </li>
  );
}

function TeamLineup({ title, lineup, teamId }: { title: string; lineup: FixtureLineupPlayer[]; teamId: number }) {
  const { starters, subs } = lineupGroups(lineup, teamId);
  if (starters.length === 0 && subs.length === 0) return null;
  return (
    <div className="fixture-lineup-team">
      <h3>{title}</h3>
      {starters.length > 0 && (
        <>
          <p className="fixture-lineup-heading">Starting XI</p>
          <ul className="fixture-lineup-list">
            {starters.map((p) => (
              <PlayerRow key={p.playerId} player={p} />
            ))}
          </ul>
        </>
      )}
      {subs.length > 0 && (
        <>
          <p className="fixture-lineup-heading">Substitutes</p>
          <ul className="fixture-lineup-list">
            {subs.map((p) => (
              <PlayerRow key={p.playerId} player={p} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function FixturePage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useFetch<FixtureDetail>(id ? apiUrl(`/api/fixtures/${id}`) : null);

  if (loading) return <p className="page">Hang about…</p>;
  if (error) return <p className="page error">Couldn't load this match: {error.message}</p>;
  if (!data) return null;

  const finished = data.status === 'finished';
  const homeStats = data.teamStats.find((s) => s.teamId === data.homeTeam.id) ?? null;
  const awayStats = data.teamStats.find((s) => s.teamId === data.awayTeam.id) ?? null;
  const marketOdds = data.odds.filter((o) => o.bookmaker === 'market_avg' && o.market === 'match_winner' && o.snapshotType === 'closing');

  return (
    <div className="page fixture-page">
      <p className="fixture-meta">
        {data.competitionName} — {data.seasonLabel}
        {data.round ? ` · ${data.round}` : ''}
      </p>

      <div className="fixture-scoreline">
        <Link to={`/teams/${data.homeTeam.id}`} className="fixture-team">
          <Crest src={data.homeTeam.logoUrl} alt="" size={40} />
          {data.homeTeam.name}
        </Link>
        {finished ? (
          <span className="fixture-score">
            {data.homeScore} – {data.awayScore}
          </span>
        ) : (
          <span className="fixture-kickoff">{formatKickoff(data.kickoffAt)}</span>
        )}
        <Link to={`/teams/${data.awayTeam.id}`} className="fixture-team">
          <Crest src={data.awayTeam.logoUrl} alt="" size={40} />
          {data.awayTeam.name}
        </Link>
      </div>

      {(data.venue || data.referee) && (
        <p className="fixture-meta">
          {data.venue}
          {data.venue && data.referee ? ' · ' : ''}
          {data.referee ? `Referee: ${data.referee}` : ''}
        </p>
      )}

      {data.prediction && (
        <section>
          <h2>Model vs. market</h2>
          <p>
            Model: {shortCode(data.homeTeam)} {formatPercent(data.prediction.probHomeWin)} · Draw{' '}
            {formatPercent(data.prediction.probDraw)} · {shortCode(data.awayTeam)} {formatPercent(data.prediction.probAwayWin)}
            {data.prediction.predictedHomeGoals !== null && data.prediction.predictedAwayGoals !== null && (
              <>
                {' '}
                (predicted {data.prediction.predictedHomeGoals.toFixed(2)} – {data.prediction.predictedAwayGoals.toFixed(2)})
              </>
            )}
          </p>
          {marketOdds.length > 0 && (
            <p>
              Market (closing):{' '}
              {marketOdds
                .map((o) => `${o.outcome === 'home' ? shortCode(data.homeTeam) : o.outcome === 'away' ? shortCode(data.awayTeam) : 'Draw'} ${o.price.toFixed(2)}`)
                .join(' · ')}
            </p>
          )}
        </section>
      )}

      {(homeStats || awayStats) && (
        <section>
          <h2>Match stats</h2>
          <table className="fixture-stats-table">
            <tbody>
              <StatRow label="Shots" home={homeStats?.shots ?? null} away={awayStats?.shots ?? null} />
              <StatRow label="Shots on target" home={homeStats?.shotsOnTarget ?? null} away={awayStats?.shotsOnTarget ?? null} />
              <StatRow label="Corners" home={homeStats?.corners ?? null} away={awayStats?.corners ?? null} />
              <StatRow label="Fouls" home={homeStats?.fouls ?? null} away={awayStats?.fouls ?? null} />
              <StatRow label="Yellow cards" home={homeStats?.yellowCards ?? null} away={awayStats?.yellowCards ?? null} />
              <StatRow label="Red cards" home={homeStats?.redCards ?? null} away={awayStats?.redCards ?? null} />
              <StatRow label="xG" home={homeStats?.xg ?? null} away={awayStats?.xg ?? null} />
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>Lineups</h2>
        {data.lineup.length === 0 ? (
          <p>No lineup yet — usually confirmed within an hour of kickoff.</p>
        ) : (
          <div className="fixture-lineups">
            <TeamLineup title={data.homeTeam.name} lineup={data.lineup} teamId={data.homeTeam.id} />
            <TeamLineup title={data.awayTeam.name} lineup={data.lineup} teamId={data.awayTeam.id} />
          </div>
        )}
      </section>
    </div>
  );
}
