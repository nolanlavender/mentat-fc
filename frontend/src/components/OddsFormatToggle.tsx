import { ODDS_FORMAT_LABELS, type OddsFormat } from '../lib/odds';
import { useOddsFormat } from '../odds/OddsFormatContext';

const FORMATS: OddsFormat[] = ['percent', 'decimal', 'american'];

// A native <select> rather than a segmented button row: the nav already
// overflows horizontally on a phone (three buttons would make that worse),
// and a select collapses to just the current value while still giving the
// OS's own picker on mobile.
export function OddsFormatToggle() {
  const { format, setFormat } = useOddsFormat();

  return (
    <label className="odds-format-toggle">
      <span className="sr-only">Odds format</span>
      <select value={format} onChange={(e) => setFormat(e.target.value as OddsFormat)} aria-label="Odds format">
        {FORMATS.map((f) => (
          <option key={f} value={f}>
            {ODDS_FORMAT_LABELS[f]}
          </option>
        ))}
      </select>
    </label>
  );
}
