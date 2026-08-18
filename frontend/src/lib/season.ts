// Every season in this app is seeded starting August 1st (see
// backend/seed/index.ts's getOrCreateSeason calls, always `${year}-08-01`
// to `${year + 1}-06-30`), so "the current season" is derivable from
// today's date with the same August cutover, without a round-trip to the
// backend just to ask it.
export function currentSeasonLabel(now: Date = new Date()): string {
  const AUGUST = 7; // Date.getMonth() is 0-indexed
  const year = now.getMonth() >= AUGUST ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}/${String(year + 1).slice(2)}`;
}
