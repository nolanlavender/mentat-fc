import { Link } from 'react-router-dom';
import type { Team } from '../api/types';
import { Crest } from './Crest';
import {
  ENGLAND_WALES_OUTLINE,
  MAP_VIEW_HEIGHT,
  MAP_VIEW_WIDTH,
  TEAM_CITY_COORDINATES,
  layoutMarkers,
  projectedPathD,
} from '../lib/teamGeo';

const OUTLINE_D = projectedPathD(ENGLAND_WALES_OUTLINE);
const MARKER_SIZE = 20;

// SVG's own <a> element and React Router's <Link> don't mix cleanly (Link
// renders a plain HTML anchor, and namespace handling for one nested
// inside inline SVG is inconsistent across browsers) -- simplest reliable
// fix is the well-established "SVG background, HTML pins overlaid on top"
// pattern: the outline is the only thing actually inside the <svg>, and
// each team marker is a normal, fully-accessible HTML <Link> positioned
// with percentage-based CSS over it, computed from the same projection.
export function EnglandWalesMap({ teams }: { teams: Team[] }) {
  const markerInputs = teams.flatMap((team) => {
    const point = TEAM_CITY_COORDINATES[team.name];
    return point ? [{ id: team, point }] : [];
  });
  const markers = layoutMarkers(markerInputs);

  return (
    <div className="england-wales-map">
      <svg viewBox={`0 0 ${MAP_VIEW_WIDTH.toFixed(1)} ${MAP_VIEW_HEIGHT.toFixed(1)}`} className="map-outline" aria-hidden="true">
        <path d={OUTLINE_D} />
      </svg>
      {markers.map((marker) => (
        <Link
          key={marker.id.id}
          to={`/teams/${marker.id.id}`}
          className="map-marker"
          title={marker.id.name}
          style={{
            left: `${(marker.x / MAP_VIEW_WIDTH) * 100}%`,
            top: `${(marker.y / MAP_VIEW_HEIGHT) * 100}%`,
          }}
        >
          <Crest src={marker.id.logoUrl} alt={marker.id.name} size={MARKER_SIZE} />
        </Link>
      ))}
    </div>
  );
}
