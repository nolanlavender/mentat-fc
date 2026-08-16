// A team's stored short_name is backfilled by the backend's getOrCreateTeam
// (see backend/seed/lib/team-short-codes.ts), but existing production teams
// won't have it until the next reseed -- this fallback mirrors that same
// derivation client-side so scoreboard-style labels never show a blank/null
// while that catches up.
export function shortCode(team: { name: string; shortName: string | null }): string {
  if (team.shortName) return team.shortName;
  const letters = team.name.replace(/[^A-Za-z]/g, '').toUpperCase();
  return letters.slice(0, 3) || '???';
}

// A DIFFERENT shortening from shortCode above -- that one is a 3-letter
// scoreboard code ("WOL"), this is the colloquial name fans/pundits
// actually use ("Wolves"), for tight-space UI like the nav dropdown where
// wrapping to a second line breaks the layout. Only the handful of clubs
// whose full name (teams.name -- already the shortest canonical spelling
// team-aliases.ts resolves to) is long enough to wrap need an entry here;
// everything else just uses its stored name as-is.
const NAV_DISPLAY_NAMES: Record<string, string> = {
  'Queens Park Rangers': 'QPR',
  'West Bromwich Albion': 'West Brom',
  'Wolverhampton Wanderers': 'Wolves',
};

export function navDisplayName(team: { name: string }): string {
  return NAV_DISPLAY_NAMES[team.name] ?? team.name;
}
