// football-data.co.uk uses its own short team names, which don't always match
// API-Football's (or FPL's) canonical names. Extend this as mismatches turn
// up when the API-Football importer runs -- a hardcoded map is enough since
// we're only doing this a handful of times, not continuously; escalate to a
// team_aliases table only if this genuinely becomes painful to maintain.
export const TEAM_NAME_ALIASES: Record<string, string> = {
  'Man United': 'Manchester United',
  'Man Utd': 'Manchester United',
  'Man City': 'Manchester City',
  // Confirmed for real 2026-08-16: this used to map to 'Tottenham Hotspur',
  // which was itself never verified -- the real canonical row (seeded from
  // football-data.co.uk, the source of truth for team spelling) is just
  // "Tottenham". The old wrong target meant seed/sources/fpl.ts (once it
  // started calling canonicalTeamName at all, see that file's history)
  // would still have created a second "Tottenham Hotspur" row instead of
  // matching the real one. Both keys covered defensively since FPL's exact
  // real bootstrap-static value for this team wasn't confirmed.
  Spurs: 'Tottenham',
  'Tottenham Hotspur': 'Tottenham',
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

  // Confirmed for real 2026-08-16, from the same production diagnostic
  // that caught Spurs/Man Utd above: FPL's real bootstrap-static names for
  // these two ("Ipswich Town", "Coventry City") don't match the real
  // canonical rows (confirmed from production data as "Ipswich" and
  // "Coventry" respectively) and had no alias entry at all -- every
  // Ipswich/Coventry FPL player's current_team_id pointed at a phantom row.
  'Ipswich Town': 'Ipswich',
  'Coventry City': 'Coventry',

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
