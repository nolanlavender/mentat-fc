import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiUrl } from '../api/client';
import type { FixtureSummary, ScorerPrediction } from '../api/types';
import { Crest, PlayerPhoto } from '../components/Crest';
import { shortCode } from '../lib/teamDisplay';
import { useOddsFormat } from '../odds/OddsFormatContext';

const COMPETITIONS = ['Premier League', 'Championship'] as const;
type CompetitionFilter = (typeof COMPETITIONS)[number] | 'all';

// Capped by date, not by literal round-number matching -- API-Football's
// round strings ("Regular Season - 3") aren't guaranteed to be uniformly
// comparable across competitions, but "the next 14 days" is a robust
// stand-in for "next 2 matchweeks" for leagues that play weekly, without
// needing to parse that string at all. The matchweek dropdown below is a
// client-side narrowing of whatever calendar weeks land inside this
// window, not the primary windowing mechanism.
const DAYS_AHEAD = 14;

// Top 3 only, even though the API can return up to 5 -- this is a compact
// list view, not a fixture detail page; showing all 5 tips over into
// clutter for a "likely scorers" glance rather than a full breakdown.
const SCORERS_SHOWN = 3;
const TOP_PICKS_SHOWN = 5;
const TOP_SCORER_PICKS_SHOWN = 10;

interface TopPick {
  fixture: FixtureSummary;
  label: string; // a team's short code, or "Draw"
  probability: number;
}

function topOutcome(fixture: FixtureSummary): TopPick | null {
  const p = fixture.prediction;
  if (!p) return null;
  const options: Array<{ label: string; probability: number }> = [
    { label: shortCode(fixture.homeTeam), probability: p.probHomeWin },
    { label: 'Draw', probability: p.probDraw },
    { label: shortCode(fixture.awayTeam), probability: p.probAwayWin },
  ];
  return { fixture, ...options.reduce((a, b) => (b.probability > a.probability ? b : a)) };
}

interface TopScorerPick extends ScorerPrediction {
  fixture: FixtureSummary;
}

// Monday of the week containing `date` -- getDay() is 0 (Sun) .. 6 (Sat),
// so Sunday needs -6 to reach that same week's Monday while every other
// day just walks back to day 1.
function mondayOf(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatWeekLabel(monday: Date): string {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(monday)} - ${fmt(sunday)}`;
}

function inWeek(kickoffAt: string, monday: Date): boolean {
  const sundayEnd = new Date(monday);
  sundayEnd.setDate(sundayEnd.getDate() + 7); // exclusive upper bound
  const t = new Date(kickoffAt);
  return t >= monday && t < sundayEnd;
}

function PredictionRow({ fixture }: { fixture: FixtureSummary }) {
  const { formatProbability } = useOddsFormat();
  const { prediction, topScorers } = fixture;
  const homeCode = shortCode(fixture.homeTeam);
  const awayCode = shortCode(fixture.awayTeam);
  return (
    <li className="prediction-row">
      <div className="prediction-fixture">
        <Link to={`/fixtures/${fixture.id}`} className="fixture-teams">
          <Crest src={fixture.homeTeam.logoUrl} alt="" />
          {fixture.homeTeam.name} vs {fixture.awayTeam.name}
          <Crest src={fixture.awayTeam.logoUrl} alt="" />
        </Link>
        <span className="prediction-meta">
          {fixture.competitionName} · {new Date(fixture.kickoffAt).toLocaleString()}
        </span>
      </div>
      {prediction ? (
        <div className="prediction-probs">
          <span>
            {homeCode} {formatProbability(prediction.probHomeWin)}
          </span>
          <span>Draw {formatProbability(prediction.probDraw)}</span>
          <span>
            {awayCode} {formatProbability(prediction.probAwayWin)}
          </span>
          {prediction.predictedHomeGoals !== null && prediction.predictedAwayGoals !== null && (
            <span className="prediction-expected-goals">
              {homeCode} {prediction.predictedHomeGoals.toFixed(2)} - {awayCode} {prediction.predictedAwayGoals.toFixed(2)}
            </span>
          )}
          {topScorers.length > 0 && (
            <span className="prediction-scorers">
              Likely scorers:{' '}
              {topScorers.slice(0, SCORERS_SHOWN).map((s, i) => (
                <span key={s.playerId} className="scorer-chip">
                  <PlayerPhoto src={s.playerPhotoUrl} alt="" size={18} />
                  {s.playerName} ({formatProbability(s.probScores)})
                  {i < Math.min(topScorers.length, SCORERS_SHOWN) - 1 ? ', ' : ''}
                </span>
              ))}
            </span>
          )}
        </div>
      ) : (
        <span className="prediction-none">No prediction yet</span>
      )}
    </li>
  );
}

// Not built on useFetch: needs two competitions merged into one sorted
// list, which is simpler as an owned fetch than forcing a single-URL hook
// to combine two responses.
export function PredictionsPage() {
  const { formatProbability } = useOddsFormat();
  const [fixtures, setFixtures] = useState<FixtureSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [competition, setCompetition] = useState<CompetitionFilter>('all');
  const [matchweek, setMatchweek] = useState<'all' | 'week1' | 'week2'>('all');

  useEffect(() => {
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const wanted = competition === 'all' ? COMPETITIONS : [competition];

    Promise.all(
      wanted.map((c) =>
        fetch(apiUrl(`/api/fixtures?competition=${encodeURIComponent(c)}&from=${from}&to=${to}&limit=100`)).then(
          (res) => res.json() as Promise<FixtureSummary[]>,
        ),
      ),
    )
      .then((results) => {
        const merged = results.flat().sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
        setFixtures(merged);
        setMatchweek('all');
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [competition]);

  // "Next 2 matchweeks" as real calendar weeks (Monday-Sunday), not
  // API-Football's round strings -- rounds aren't guaranteed comparable
  // across competitions, but a calendar week means the same thing for
  // both. Week 1 starts on the Monday of the week containing TOMORROW
  // (not today), so a fixture still to be played later today isn't
  // stranded outside both weeks, and a week that's already mostly elapsed
  // doesn't get relabeled as "upcoming".
  const { week1Start, week2Start } = useMemo(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const w1 = mondayOf(tomorrow);
    const w2 = new Date(w1);
    w2.setDate(w2.getDate() + 7);
    return { week1Start: w1, week2Start: w2 };
  }, []);

  const filteredFixtures = useMemo(() => {
    if (!fixtures) return [];
    if (matchweek === 'week1') return fixtures.filter((f) => inWeek(f.kickoffAt, week1Start));
    if (matchweek === 'week2') return fixtures.filter((f) => inWeek(f.kickoffAt, week2Start));
    return fixtures;
  }, [fixtures, matchweek, week1Start, week2Start]);

  const topPicks = useMemo(
    () =>
      filteredFixtures
        .map(topOutcome)
        .filter((p): p is TopPick => p !== null)
        .sort((a, b) => b.probability - a.probability)
        .slice(0, TOP_PICKS_SHOWN),
    [filteredFixtures],
  );

  const topScorerPicks = useMemo(() => {
    const flattened: TopScorerPick[] = filteredFixtures.flatMap((fixture) =>
      fixture.topScorers.map((s) => ({ ...s, fixture })),
    );
    return flattened.sort((a, b) => b.probScores - a.probScores).slice(0, TOP_SCORER_PICKS_SHOWN);
  }, [filteredFixtures]);

  return (
    <div className="page">
      <h1>Predictions</h1>

      <div className="prediction-filters">
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
        <label className="competition-filter">
          Matchweek
          <select value={matchweek} onChange={(e) => setMatchweek(e.target.value as 'all' | 'week1' | 'week2')}>
            <option value="all">Next {DAYS_AHEAD} days</option>
            <option value="week1">{formatWeekLabel(week1Start)}</option>
            <option value="week2">{formatWeekLabel(week2Start)}</option>
          </select>
        </label>
      </div>

      {error && <p className="error">Couldn't load predictions: {error}</p>}
      {fixtures?.length === 0 && <p>Nothing on the card just now.</p>}

      {topPicks.length > 0 && (
        <section>
          <h2>Top picks</h2>
          <ul className="top-picks-list">
            {topPicks.map((pick) => (
              <li key={pick.fixture.id}>
                <Link to={`/fixtures/${pick.fixture.id}`} className="fixture-teams">
                  <Crest src={pick.fixture.homeTeam.logoUrl} alt="" />
                  <span className="top-pick-fixture">
                    {pick.fixture.homeTeam.name} vs {pick.fixture.awayTeam.name}
                    <span className="prediction-meta">{new Date(pick.fixture.kickoffAt).toLocaleString()}</span>
                  </span>
                  <Crest src={pick.fixture.awayTeam.logoUrl} alt="" />
                  <span className="top-pick-call">
                    {pick.label} {formatProbability(pick.probability)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {topScorerPicks.length > 0 && (
        <section>
          <h2>Top goalscorer picks</h2>
          <ol className="top-picks-list">
            {topScorerPicks.map((pick, i) => (
              <li key={`${pick.fixture.id}-${pick.playerId}`} className="fixture-teams">
                <span className="top-pick-rank">{i + 1}</span>
                <Link to={`/players/${pick.playerId}`} className="top-pick-player-link">
                  <PlayerPhoto src={pick.playerPhotoUrl} alt="" />
                  {pick.playerName}
                </Link>
                <Link to={`/fixtures/${pick.fixture.id}`} className="prediction-meta">
                  {pick.fixture.homeTeam.name} vs {pick.fixture.awayTeam.name} ·{' '}
                  {new Date(pick.fixture.kickoffAt).toLocaleString()}
                </Link>
                <span className="top-pick-call">{formatProbability(pick.probScores)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section>
        <h2>All fixtures</h2>
        <ul className="prediction-list">{filteredFixtures.map((f) => <PredictionRow key={f.id} fixture={f} />)}</ul>
      </section>
    </div>
  );
}
