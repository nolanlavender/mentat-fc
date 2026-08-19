// Kickoff dates throughout this app are anchored to Europe/London calendar
// days (fixtures.kickoff_date, migration 1701000000006) -- a day browser's
// "today" should mean the same calendar day the schedule itself uses, not
// the viewer's local one. A Saturday 3pm London kickoff shouldn't look
// like it happened "tomorrow" or "yesterday" depending on where in the US
// someone's browsing from. en-CA formats as YYYY-MM-DD directly, matching
// both <input type="date">'s value format and the backend's kickoff_date
// column -- no manual parsing needed.
export function londonToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

// Pure calendar-day arithmetic on the YYYY-MM-DD label itself (via UTC, to
// dodge any local-timezone DST edge case), not a real timestamp shift --
// this only ever needs to answer "what's the next/previous date label",
// never "what time is it".
export function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
