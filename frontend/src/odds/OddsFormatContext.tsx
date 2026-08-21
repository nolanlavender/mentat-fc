import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { formatOdds, formatPrice, type OddsFormat } from '../lib/odds';

// One app-wide choice of how every model probability is displayed --
// percent (the long-standing default), decimal, or American. Deliberately
// global rather than per-page: the same fixture's numbers show up on the
// Predictions list, the fixture detail page and a team dashboard, and
// having them disagree between those would be worse than useless for
// anyone comparing the model against a real sportsbook line.
//
// Display only. The bets API still stores decimal odds regardless of what
// this is set to (see lib/odds.ts's note) -- changing this never changes
// what gets saved.

interface OddsFormatContextValue {
  format: OddsFormat;
  setFormat: (format: OddsFormat) => void;
  /** Renders a model probability (0..1) in the currently-selected notation. */
  formatProbability: (probability: number) => string;
  /** Renders an already-decimal price (a real bookmaker's) in the same notation. */
  formatPrice: (decimal: number) => string;
}

const OddsFormatContext = createContext<OddsFormatContextValue | null>(null);

const ODDS_FORMAT_KEY = 'mentat_fc_odds_format';

function isOddsFormat(value: string | null): value is OddsFormat {
  return value === 'percent' || value === 'decimal' || value === 'american';
}

function readStoredFormat(): OddsFormat {
  // try/catch, not just a null check: localStorage access itself throws in
  // a browser set to block site data, which would take the whole app down
  // on load rather than just losing a preference.
  try {
    const stored = localStorage.getItem(ODDS_FORMAT_KEY);
    return isOddsFormat(stored) ? stored : 'percent';
  } catch {
    return 'percent';
  }
}

export function OddsFormatProvider({ children }: { children: ReactNode }) {
  const [format, setFormatState] = useState<OddsFormat>(readStoredFormat);

  const setFormat = useCallback((next: OddsFormat): void => {
    setFormatState(next);
    try {
      localStorage.setItem(ODDS_FORMAT_KEY, next);
    } catch {
      // Preference just won't survive a reload -- not worth surfacing.
    }
  }, []);

  const formatProbability = useCallback((probability: number) => formatOdds(probability, format), [format]);
  const formatBookPrice = useCallback((decimal: number) => formatPrice(decimal, format), [format]);

  return (
    <OddsFormatContext.Provider value={{ format, setFormat, formatProbability, formatPrice: formatBookPrice }}>
      {children}
    </OddsFormatContext.Provider>
  );
}

export function useOddsFormat(): OddsFormatContextValue {
  const value = useContext(OddsFormatContext);
  if (!value) throw new Error('useOddsFormat must be used inside an OddsFormatProvider');
  return value;
}
