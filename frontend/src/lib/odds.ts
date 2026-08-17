// Decimal odds (e.g. 2.50) stay the backend's source of truth -- see
// docs/erd.md's bets design notes. American odds (e.g. +150, -110) are
// purely an input convenience converted client-side before a leg or the
// parlay override ever reaches the API.
export function americanToDecimal(american: number): number {
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function isValidAmericanOdds(american: number): boolean {
  return Number.isFinite(american) && Math.abs(american) >= 100;
}
