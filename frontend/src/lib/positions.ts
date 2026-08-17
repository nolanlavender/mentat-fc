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
export const POSITION_GROUPS = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'] as const;
export type PositionGroup = (typeof POSITION_GROUPS)[number] | 'Other';

export function positionGroup(position: string | null): PositionGroup {
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
