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
