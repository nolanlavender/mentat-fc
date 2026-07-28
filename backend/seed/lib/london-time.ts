// football-data.co.uk gives kickoff date/time as UK local wall-clock time
// (no timezone attached), which shifts between GMT and BST across a season.
// Converting it correctly to a UTC instant means asking the IANA tz database
// what the UK offset actually was at that moment, not assuming a fixed one.
function londonOffsetMinutes(instant: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/London',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const asLondonWallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asLondonWallClock - instant.getTime()) / 60_000;
}

export function londonWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMinutes = londonOffsetMinutes(guess);
  return new Date(guess.getTime() - offsetMinutes * 60_000);
}

// The inverse: given a UTC instant (e.g. API-Football's ISO timestamp),
// what calendar date was it in the UK? Both importers must compute
// kickoff_date this way (not a raw UTC date slice) so they agree on the
// same fixture's natural key regardless of which source it came from.
export function utcInstantToLondonDate(instant: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
