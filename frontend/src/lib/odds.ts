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

// --- Displaying a model probability as odds -------------------------------
//
// The above converts odds a bookmaker quoted into the decimal the API
// stores. Everything below goes the other way, for *display* only: the
// model gives us a probability, and these render it in whichever notation
// the reader thinks in. Nothing here ever reaches the API.
//
// Worth being precise about what these are, since the app shows them right
// next to real bookmaker lines: converting a probability straight to odds
// gives FAIR odds -- what the price would be with no bookmaker margin at
// all. A real sportsbook's line on the same outcome is always somewhat
// worse than its own implied probability suggests (that gap is the vig,
// which load_closing_match_winner_probabilities strips out on the market
// side before comparison). So model odds looking "better" than a book's
// on the same outcome is partly this, not pure edge.

export type OddsFormat = 'percent' | 'decimal' | 'american';

export const ODDS_FORMAT_LABELS: Record<OddsFormat, string> = {
  percent: 'Percent',
  decimal: 'Decimal',
  american: 'American',
};

export function probabilityToDecimal(probability: number): number {
  return 1 / probability;
}

export function decimalToAmerican(decimal: number): number {
  // Even money (decimal 2.00) is the pivot between the two halves of the
  // American convention: at better than even the number is the profit on a
  // 100 stake (+150), at worse than even it's the stake needed to profit
  // 100 (-150). Both round to a whole number, and |value| is always >= 100.
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
}

export function probabilityToAmerican(probability: number): number {
  return decimalToAmerican(probabilityToDecimal(probability));
}

/**
 * Renders a model probability (0..1) in the reader's chosen notation.
 *
 * Returns an em dash for anything that can't be expressed as odds at all --
 * a probability of exactly 0 or 1 has no finite price, and a non-finite
 * input means something upstream went wrong. Deliberately not clamped to a
 * huge-but-finite number: a fake "+99900" would read as a real prediction,
 * where a dash reads as "no answer", which is the truth.
 */
export function formatOdds(probability: number, format: OddsFormat): string {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return '—';

  if (format === 'percent') return `${(probability * 100).toFixed(2)}%`;
  if (format === 'decimal') return probabilityToDecimal(probability).toFixed(2);

  const american = probabilityToAmerican(probability);
  return american > 0 ? `+${american}` : `${american}`;
}

/**
 * Renders an already-decimal price (a real bookmaker's, as stored on a bet)
 * in the reader's chosen notation.
 *
 * Separate from formatOdds because the input is a price, not a probability
 * -- 'percent' here means "the probability this price implies", which for a
 * real bookmaker's line includes their margin and so slightly overstates
 * the true chance. Anything at or below decimal 1.00 is not a valid price
 * (it would mean risking money to win nothing), so it gets the same em
 * dash treatment as an impossible probability.
 */
export function formatPrice(decimal: number, format: OddsFormat): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return '—';

  if (format === 'decimal') return decimal.toFixed(2);
  if (format === 'percent') return `${(100 / decimal).toFixed(2)}%`;

  const american = decimalToAmerican(decimal);
  return american > 0 ? `+${american}` : `${american}`;
}
