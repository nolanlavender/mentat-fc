// football-data.co.uk uses its own short team names, which don't always match
// API-Football's (or FPL's) canonical names. Extend this as mismatches turn
// up when the API-Football importer runs -- a hardcoded map is enough since
// we're only doing this a handful of times, not continuously; escalate to a
// team_aliases table only if this genuinely becomes painful to maintain.
export const TEAM_NAME_ALIASES: Record<string, string> = {
  'Man United': 'Manchester United',
  'Man City': 'Manchester City',
  Spurs: 'Tottenham Hotspur',
  "Nott'm Forest": 'Nottingham Forest',
  Newcastle: 'Newcastle United',
  Wolves: 'Wolverhampton Wanderers',
  Leicester: 'Leicester City',
  'West Brom': 'West Bromwich Albion',
  Leeds: 'Leeds United',
  Norwich: 'Norwich City',
  Cardiff: 'Cardiff City',
  Hull: 'Hull City',
  Stoke: 'Stoke City',
  Swansea: 'Swansea City',
  QPR: 'Queens Park Rangers',

  // Discovered for real 2026-08-15: these 3 Championship clubs were missing
  // from this map, so football-data.co.uk's name and API-Football's name for
  // the same real club each created their own teams row -- every match that
  // club played got inserted twice (once under each team_id), inflating
  // Championship's fixture counts by ~130+ fixtures/season and corrupting the
  // Dixon-Coles training data (each "half" of a club's real results got
  // treated as a separate, weaker team). Confirmed by a verification query:
  // both team_ids under each pair had matching or near-matching fixture
  // counts, meaning the same real matches existed under both.
  //
  // Unlike the entries above, these deliberately map to the SHORTER name,
  // not the fuller/more official one -- football-data.co.uk's spelling is
  // kept as canonical here because that's the row that already carries the
  // real odds/team-stats data (football-data.co.uk is the only source for
  // historical odds; there's nowhere else to re-fetch it from), while the
  // API-Football-named duplicate only ever had lineup data, which is cheaply
  // re-fetchable once this alias makes both sources agree.
  'Oxford United': 'Oxford',
  'Sheffield Wednesday': 'Sheffield Weds',
  'Sheffield Utd': 'Sheffield United',
};

export function canonicalTeamName(rawName: string): string {
  return TEAM_NAME_ALIASES[rawName] ?? rawName;
}
