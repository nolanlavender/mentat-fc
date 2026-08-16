// Well-known 3-letter club codes (the same style used across the football
// broadcast/data industry -- BBC, Sky, the Premier League's own graphics),
// keyed by this codebase's canonical team name (see team-aliases.ts's
// canonicalTeamName -- these are the exact post-alias spellings already
// stored in `teams.name`, not raw source names). A hardcoded map, same
// reasoning as team-aliases.ts: there are only a few dozen Premier
// League/Championship clubs, seeding runs a handful of times, so this is
// cheap to maintain by hand -- escalate only if it becomes genuinely
// painful. Anything not listed here falls back to a derived code (see
// teamShortCode below) rather than crashing or leaving it blank.
const TEAM_SHORT_CODES: Record<string, string> = {
  // Premier League
  Arsenal: 'ARS',
  'Aston Villa': 'AVL',
  Bournemouth: 'BOU',
  Brentford: 'BRE',
  Brighton: 'BHA',
  Burnley: 'BUR',
  Chelsea: 'CHE',
  'Crystal Palace': 'CRY',
  Everton: 'EVE',
  Fulham: 'FUL',
  'Leeds United': 'LEE',
  Liverpool: 'LIV',
  'Manchester City': 'MCI',
  'Manchester United': 'MUN',
  'Newcastle United': 'NEW',
  'Nottingham Forest': 'NFO',
  Sunderland: 'SUN',
  Tottenham: 'TOT',
  'West Ham': 'WHU',
  'Wolverhampton Wanderers': 'WOL',

  // Championship (canonical spellings per team-aliases.ts, current +
  // recent seasons -- broader than strictly necessary since teams move
  // between divisions and the DB keeps 3 seasons of history)
  'Birmingham City': 'BIR',
  Blackburn: 'BLB',
  'Bristol City': 'BRC',
  'Cardiff City': 'CAR',
  'Charlton Athletic': 'CHA',
  Coventry: 'COV',
  'Derby County': 'DER',
  'Huddersfield Town': 'HUD',
  'Hull City': 'HUL',
  Ipswich: 'IPS',
  'Leicester City': 'LEI',
  'Luton Town': 'LUT',
  Middlesbrough: 'MID',
  Millwall: 'MIL',
  'Norwich City': 'NOR',
  Oxford: 'OXU',
  'Plymouth Argyle': 'PLY',
  Portsmouth: 'POR',
  Preston: 'PNE',
  'Preston North End': 'PNE',
  'Queens Park Rangers': 'QPR',
  Reading: 'REA',
  'Rotherham United': 'ROT',
  'Sheffield United': 'SHU',
  'Sheffield Weds': 'SHW',
  Southampton: 'SOU',
  'Stoke City': 'STK',
  'Swansea City': 'SWA',
  Watford: 'WAT',
  'West Bromwich Albion': 'WBA',
  Wrexham: 'WRE',
};

/** Falls back to a derived 3-letter code (never blank/undefined) so an
 * unmapped or lower-tier team (FA Cup non-league entrants, mainly) still
 * gets something displayable instead of breaking a scoreboard-style UI. */
export function teamShortCode(canonicalName: string): string {
  const known = TEAM_SHORT_CODES[canonicalName];
  if (known) return known;
  const letters = canonicalName.replace(/[^A-Za-z]/g, '').toUpperCase();
  return letters.slice(0, 3) || '???';
}
