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
};

export function canonicalTeamName(rawName: string): string {
  return TEAM_NAME_ALIASES[rawName] ?? rawName;
}
