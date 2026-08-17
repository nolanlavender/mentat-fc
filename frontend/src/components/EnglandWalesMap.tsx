import { Link } from 'react-router-dom';
import type { Team } from '../api/types';
import { Crest } from './Crest';
import {
  ENGLAND_WALES_OUTLINE,
  MAJOR_CITY_LABELS,
  MAP_VIEW_HEIGHT,
  MAP_VIEW_WIDTH,
  TEAM_CITY_COORDINATES,
  layoutMarkers,
  project,
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
  const { markers, clusterAnchors } = layoutMarkers(markerInputs);

  const teamNames = new Set(teams.map((t) => t.name));
  const relevantCityLabels = MAJOR_CITY_LABELS.filter((city) => city.triggerTeams.some((name) => teamNames.has(name)));

  return (
    <div className="england-wales-map">
      <svg viewBox={`0 0 ${MAP_VIEW_WIDTH.toFixed(1)} ${MAP_VIEW_HEIGHT.toFixed(1)}`} className="map-outline" aria-hidden="true">
        <path d={OUTLINE_D} />
        {/* Each fanned-out marker gets a short leader line back to its
            cluster's real (pre-fan-out) location, plus one small dot
            marking that real location -- without these, a ring of crests
            around, say, London reads as "approximately this area" with no
            visual cue for where the actual point is or which crest is
            closest to it. */}
        {markers
          .filter((m): m is typeof m & { clusterCenter: NonNullable<typeof m.clusterCenter> } => m.clusterCenter !== null)
          .map((m) => (
            <line
              key={`line-${m.id.id}`}
              className="map-leader-line"
              x1={m.clusterCenter.x}
              y1={m.clusterCenter.y}
              x2={m.x}
              y2={m.y}
            />
          ))}
        {clusterAnchors.map((anchor, i) => (
          <circle key={`anchor-${i}`} className="map-cluster-anchor" cx={anchor.x} cy={anchor.y} r={2.5} />
        ))}
      </svg>
      {relevantCityLabels.map((city) => {
        const { x, y } = project(city.point);
        return (
          <span
            key={city.name}
            className="map-city-label"
            aria-hidden="true"
            style={{ left: `${(x / MAP_VIEW_WIDTH) * 100}%`, top: `${(y / MAP_VIEW_HEIGHT) * 100}%` }}
          >
            {city.name}
          </span>
        );
      })}
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
