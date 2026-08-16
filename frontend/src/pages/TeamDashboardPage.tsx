import { Link, useParams } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { apiUrl } from '../api/client';
import type { SquadPlayer, TeamDashboard } from '../api/types';
import { TeamSwitcher } from '../components/TeamSwitcher';
import { Crest, PlayerPhoto } from '../components/Crest';
import { shortCode } from '../lib/teamDisplay';

function resultClass(result: 'W' | 'D' | 'L'): string {
  return `form-badge form-badge-${result.toLowerCase()}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

// Position values in the DB aren't consistently one format -- FPL stores
// its own short codes ("GKP"/"DEF"/"MID"/"FWD"), API-Football's lineup
// data uses single letters ("G"/"D"/"M"/"F"), and its player-stats/squads
// endpoints use full words ("Goalkeeper"/"Defender"/"Midfielder"/
// "Attacker") -- whichever source's sighting reached upsertPlayerGoldenRecord
// first is whatever's stored (position is COALESCE'd, never overwritten).
// Bucketing by first letter (with "A" folded into Forward for API-
// Football's "Attacker") groups correctly regardless of which format a
// given player happens to have, without needing to normalize the stored
// data itself.
const POSITION_GROUPS = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'] as const;
type PositionGroup = (typeof POSITION_GROUPS)[number] | 'Other';

function positionGroup(position: string | null): PositionGroup {
  const first = position?.trim().charAt(0).toUpperCase();
  switch (first) {
    case 'G':
      return 'Goalkeeper';
    case 'D':
      return 'Defender';
    case 'M':
      return 'Midfielder';
    case 'F':
    case 'A': // API-Football's "Attacker"
      return 'Forward';
    default:
      return 'Other';
  }
}

function groupSquadByPosition(squad: SquadPlayer[]): Array<[PositionGroup, SquadPlayer[]]> {
  const groups = new Map<PositionGroup, SquadPlayer[]>();
  for (const player of squad) {
    const group = positionGroup(player.position);
    const existing = groups.get(group);
    if (existing) existing.push(player);
    else groups.set(group, [player]);
  }
  for (const players of groups.values()) players.sort((a, b) => a.fullName.localeCompare(b.fullName));
  const order: PositionGroup[] = [...POSITION_GROUPS, 'Other'];
  return order.filter((g) => groups.has(g)).map((g) => [g, groups.get(g)!]);
}

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
          <h1 className="team-dashboard-heading">
            <Crest src={data.team.logoUrl} alt="" size={36} />
            {data.team.name}
          </h1>

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
            <h2>Form</h2>
            {data.form.matches.length === 0 ? (
              <p>Nothing in the results book yet.</p>
            ) : (
              <>
                <p>
                  {data.form.wins}W {data.form.draws}D {data.form.losses}L (last {data.form.matches.length}) ·{' '}
                  {data.form.goalsFor}-{data.form.goalsAgainst} goals
                </p>
                <ul className="form-list">
                  {data.form.matches.map((m) => (
                    <li key={m.fixtureId} className="fixture-teams">
                      <span className={resultClass(m.result)}>{m.result}</span>
                      {m.isHome ? 'vs' : '@'} <Crest src={m.opponent.logoUrl} alt="" />
                      {m.opponent.name} {m.goalsFor}-{m.goalsAgainst}
                      <span className="prediction-meta">
                        {new Date(m.kickoffDate).toLocaleDateString()} · {m.competitionName}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section>
            <h2>Next match</h2>
            {data.nextMatch ? (
              <>
                <p className="fixture-teams">
                  <Crest src={data.nextMatch.homeTeam.logoUrl} alt="" />
                  {data.nextMatch.homeTeam.name} vs{' '}
                  <Crest src={data.nextMatch.awayTeam.logoUrl} alt="" />
                  {data.nextMatch.awayTeam.name}
                  {' — '}
                  {new Date(data.nextMatch.kickoffAt).toLocaleString()} ({data.nextMatch.competitionName})
                </p>
                {data.nextMatch.prediction ? (
                  <p>
                    Model prediction:{' '}
                    {data.nextMatch.prediction.predictedHomeGoals !== null && data.nextMatch.prediction.predictedAwayGoals !== null
                      ? `${shortCode(data.nextMatch.homeTeam)} ${data.nextMatch.prediction.predictedHomeGoals.toFixed(2)} - ${shortCode(data.nextMatch.awayTeam)} ${data.nextMatch.prediction.predictedAwayGoals.toFixed(2)}`
                      : '?'}{' '}
                    (home win {formatPercent(data.nextMatch.prediction.probHomeWin)})
                  </p>
                ) : (
                  <p>No prediction available for this fixture yet.</p>
                )}
              </>
            ) : (
              <p>Nothing on the fixture list just yet.</p>
            )}
          </section>

          {data.topStats && (data.topStats.topScorers.length > 0 || data.topStats.topAssisters.length > 0) && (
            <section>
              <h2>Top performers — {data.topStats.seasonLabel}</h2>
              <div className="top-performers">
                {data.topStats.topScorers.length > 0 && (
                  <div>
                    <h3>Goals</h3>
                    <ul className="form-list">
                      {data.topStats.topScorers.map((p) => (
                        <li key={p.playerId}>
                          <Link to={`/players/${p.playerId}`} className="squad-link">
                            <PlayerPhoto src={p.photoUrl} alt="" />
                            {p.fullName}
                            <span className="top-pick-call">{p.value}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {data.topStats.topAssisters.length > 0 && (
                  <div>
                    <h3>Assists</h3>
                    <ul className="form-list">
                      {data.topStats.topAssisters.map((p) => (
                        <li key={p.playerId}>
                          <Link to={`/players/${p.playerId}`} className="squad-link">
                            <PlayerPhoto src={p.photoUrl} alt="" />
                            {p.fullName}
                            <span className="top-pick-call">{p.value}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}

          <section>
            <h2>Squad</h2>
            {data.squad.length === 0 ? (
              <p>No squad news in for this lot yet.</p>
            ) : (
              groupSquadByPosition(data.squad).map(([group, players]) => (
                <div key={group} className="squad-group">
                  <h3>{group === 'Goalkeeper' ? 'Goalkeepers' : `${group}s`}</h3>
                  <ul className="squad-list">
                    {players.map((player) => (
                      <li key={player.id}>
                        <Link to={`/players/${player.id}`} className="squad-link">
                          <PlayerPhoto src={player.photoUrl} alt="" />
                          {player.fullName}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
