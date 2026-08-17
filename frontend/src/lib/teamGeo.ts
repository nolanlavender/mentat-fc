// Approximate stylized geography for the Home page's team map -- NOT
// survey-grade coastline data. Both the England+Wales outline and the
// per-team city coordinates below are hand-estimated from general
// knowledge of UK geography, good enough for "which corner of the country
// is this club roughly in" at map-icon scale, not for anything requiring
// real accuracy. Keeping this self-contained (no external GeoJSON/basemap
// dependency, no attribution/license to carry) was a deliberate call over
// sourcing real boundary data -- see docs/learning-log.md's Home-page
// entry for the tradeoff.

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

// A crude equirectangular projection, scaled so 1 unit of longitude and 1
// unit of latitude cover the same real-world distance at England/Wales's
// latitude (otherwise the shape looks visibly squashed east-west, since a
// degree of longitude is shorter than a degree of latitude this far from
// the equator).
const LAT_MIN = 49.85;
const LAT_MAX = 55.9;
const LON_MIN = -5.85;
const LON_MAX = 1.85;
const MEAN_LAT_RADIANS = (53 * Math.PI) / 180;
const LON_SCALE = Math.cos(MEAN_LAT_RADIANS); // ~0.60 -- shrinks longitude to match latitude's real-world scale
const PX_PER_DEGREE_LAT = 90;

export const MAP_VIEW_WIDTH = (LON_MAX - LON_MIN) * LON_SCALE * PX_PER_DEGREE_LAT;
export const MAP_VIEW_HEIGHT = (LAT_MAX - LAT_MIN) * PX_PER_DEGREE_LAT;

export function project({ lat, lon }: GeoPoint): ProjectedPoint {
  return {
    x: (lon - LON_MIN) * LON_SCALE * PX_PER_DEGREE_LAT,
    y: (LAT_MAX - lat) * PX_PER_DEGREE_LAT, // inverted -- SVG y grows downward, latitude grows upward (north)
  };
}

export function projectedPathD(points: GeoPoint[]): string {
  return (
    points
      .map(project)
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ') + ' Z'
  );
}

// A simplified England+Wales coastline, walked clockwise from the
// England/Scotland border at Berwick-upon-Tweed: down the North Sea coast,
// around East Anglia, along the Channel coast, around the Cornish
// peninsula, up the Bristol Channel into Wales, around the Welsh coast,
// back down into Merseyside/Cumbria, and along the land border with
// Scotland back to the start.
export const ENGLAND_WALES_OUTLINE: GeoPoint[] = [
  { lat: 55.77, lon: -2.0 }, // Berwick-upon-Tweed
  { lat: 55.02, lon: -1.42 }, // Tyne mouth
  { lat: 54.91, lon: -1.38 }, // Sunderland
  { lat: 54.69, lon: -1.21 }, // Hartlepool
  { lat: 54.49, lon: -0.61 }, // Whitby
  { lat: 54.28, lon: -0.4 }, // Scarborough
  { lat: 54.12, lon: -0.08 }, // Flamborough Head
  { lat: 53.58, lon: 0.13 }, // Spurn Point / Humber mouth
  { lat: 52.93, lon: 0.1 }, // King's Lynn / the Wash
  { lat: 52.98, lon: 1.02 }, // Cromer
  { lat: 52.61, lon: 1.73 }, // Great Yarmouth
  { lat: 52.48, lon: 1.76 }, // Lowestoft
  { lat: 51.95, lon: 1.35 }, // Felixstowe
  { lat: 51.79, lon: 1.15 }, // Clacton
  { lat: 51.53, lon: 0.71 }, // Thames mouth
  { lat: 51.39, lon: 1.38 }, // Margate
  { lat: 51.13, lon: 1.31 }, // Dover
  { lat: 50.91, lon: 0.97 }, // Dungeness
  { lat: 50.85, lon: 0.57 }, // Hastings
  { lat: 50.74, lon: 0.27 }, // Eastbourne
  { lat: 50.82, lon: -0.14 }, // Brighton
  { lat: 50.73, lon: -0.79 }, // Selsey Bill
  { lat: 50.8, lon: -1.09 }, // Portsmouth
  { lat: 50.87, lon: -1.4 }, // Southampton Water
  { lat: 50.72, lon: -1.88 }, // Poole/Bournemouth
  { lat: 50.51, lon: -2.46 }, // Portland Bill
  { lat: 50.72, lon: -2.94 }, // Lyme Regis
  { lat: 50.6, lon: -3.4 }, // Exmouth
  { lat: 50.46, lon: -3.53 }, // Torquay
  { lat: 50.22, lon: -3.64 }, // Start Point
  { lat: 50.37, lon: -4.14 }, // Plymouth
  { lat: 50.32, lon: -4.22 }, // Rame Head
  { lat: 50.35, lon: -4.63 }, // Fowey
  { lat: 50.15, lon: -5.06 }, // Falmouth
  { lat: 49.96, lon: -5.2 }, // Lizard Point
  { lat: 50.12, lon: -5.53 }, // Penzance
  { lat: 50.07, lon: -5.71 }, // Land's End
  { lat: 50.21, lon: -5.48 }, // St Ives
  { lat: 50.42, lon: -5.09 }, // Newquay
  { lat: 50.83, lon: -4.55 }, // Bude
  { lat: 51.02, lon: -4.53 }, // Hartland Point
  { lat: 51.08, lon: -4.2 }, // Barnstaple Bay
  { lat: 51.23, lon: -3.83 }, // Lynton/Exmoor coast
  { lat: 51.21, lon: -3.48 }, // Minehead
  { lat: 51.35, lon: -2.98 }, // Weston-super-Mare
  { lat: 51.5, lon: -2.7 }, // Severn Estuary
  { lat: 51.48, lon: -3.18 }, // Cardiff
  { lat: 51.4, lon: -3.28 }, // Barry
  { lat: 51.48, lon: -3.7 }, // Porthcawl
  { lat: 51.58, lon: -3.95 }, // Swansea Bay
  { lat: 51.57, lon: -4.32 }, // Worm's Head / the Gower
  { lat: 51.72, lon: -4.3 }, // Carmarthen Bay
  { lat: 51.67, lon: -4.7 }, // Tenby
  { lat: 51.6, lon: -4.93 }, // St Govan's Head
  { lat: 51.88, lon: -5.3 }, // St David's Head
  { lat: 52.01, lon: -4.98 }, // Fishguard
  { lat: 52.08, lon: -4.66 }, // Cardigan
  { lat: 52.41, lon: -4.09 }, // Aberystwyth
  { lat: 52.72, lon: -4.15 }, // Barmouth
  { lat: 52.8, lon: -4.75 }, // Bardsey / Lleyn tip
  { lat: 52.94, lon: -4.53 }, // Nefyn
  { lat: 53.14, lon: -4.32 }, // Caernarfon Bay
  { lat: 53.31, lon: -4.63 }, // Holyhead / Anglesey
  { lat: 53.32, lon: -3.83 }, // Conwy
  { lat: 53.32, lon: -3.49 }, // Rhyl
  { lat: 53.25, lon: -3.13 }, // Dee Estuary -- Wales/England border
  { lat: 53.39, lon: -3.18 }, // Hoylake / Wirral
  { lat: 53.41, lon: -2.98 }, // Liverpool
  { lat: 53.65, lon: -3.01 }, // Southport
  { lat: 53.82, lon: -3.05 }, // Blackpool
  { lat: 54.07, lon: -2.87 }, // Morecambe Bay
  { lat: 54.11, lon: -3.23 }, // Barrow-in-Furness
  { lat: 54.55, lon: -3.58 }, // Whitehaven
  { lat: 54.98, lon: -3.05 }, // Solway Firth / Gretna
  { lat: 55.35, lon: -2.55 }, // Cheviot Hills (England/Scotland land border)
  { lat: 55.6, lon: -2.2 }, // Cheviot Hills
];

// City coordinates for every club in team-short-codes.ts's TEAM_SHORT_CODES
// map, keyed by the exact same canonical name -- see that file's own
// comment for why a hardcoded map is the right call here (a few dozen
// clubs, changes rarely). A team not listed here just doesn't get a map
// marker (still shows up in the standings table/nav) rather than guessing
// or erroring -- the same "no confident answer, don't fake one" pattern
// used throughout this codebase for entity resolution.
export const TEAM_CITY_COORDINATES: Record<string, GeoPoint> = {
  // Premier League
  Arsenal: { lat: 51.555, lon: -0.109 },
  'Aston Villa': { lat: 52.509, lon: -1.885 },
  Bournemouth: { lat: 50.735, lon: -1.838 },
  Brentford: { lat: 51.49, lon: -0.289 },
  Brighton: { lat: 50.862, lon: -0.084 },
  Burnley: { lat: 53.789, lon: -2.23 },
  Chelsea: { lat: 51.481, lon: -0.191 },
  'Crystal Palace': { lat: 51.398, lon: -0.086 },
  Everton: { lat: 53.439, lon: -2.966 },
  Fulham: { lat: 51.475, lon: -0.222 },
  'Leeds United': { lat: 53.778, lon: -1.572 },
  Liverpool: { lat: 53.431, lon: -2.961 },
  'Manchester City': { lat: 53.483, lon: -2.2 },
  'Manchester United': { lat: 53.463, lon: -2.291 },
  'Newcastle United': { lat: 54.976, lon: -1.622 },
  'Nottingham Forest': { lat: 52.94, lon: -1.133 },
  Sunderland: { lat: 54.914, lon: -1.388 },
  Tottenham: { lat: 51.604, lon: -0.066 },
  'West Ham': { lat: 51.539, lon: -0.017 },
  'Wolverhampton Wanderers': { lat: 52.59, lon: -2.13 },

  // Championship
  'Birmingham City': { lat: 52.475, lon: -1.868 },
  Blackburn: { lat: 53.729, lon: -2.489 },
  'Bristol City': { lat: 51.44, lon: -2.62 },
  'Cardiff City': { lat: 51.473, lon: -3.203 },
  'Charlton Athletic': { lat: 51.486, lon: 0.037 },
  Coventry: { lat: 52.448, lon: -1.495 },
  'Derby County': { lat: 52.915, lon: -1.447 },
  'Huddersfield Town': { lat: 53.654, lon: -1.768 },
  'Hull City': { lat: 53.746, lon: -0.367 },
  Ipswich: { lat: 52.055, lon: 1.145 },
  'Leicester City': { lat: 52.62, lon: -1.142 },
  'Luton Town': { lat: 51.884, lon: -0.432 },
  Middlesbrough: { lat: 54.578, lon: -1.217 },
  Millwall: { lat: 51.486, lon: -0.05 },
  'Norwich City': { lat: 52.622, lon: 1.309 },
  Oxford: { lat: 51.716, lon: -1.208 },
  'Plymouth Argyle': { lat: 50.388, lon: -4.15 },
  Portsmouth: { lat: 50.796, lon: -1.064 },
  Preston: { lat: 53.773, lon: -2.688 },
  'Preston North End': { lat: 53.773, lon: -2.688 },
  'Queens Park Rangers': { lat: 51.509, lon: -0.232 },
  Reading: { lat: 51.422, lon: -0.982 },
  'Rotherham United': { lat: 53.428, lon: -1.321 },
  'Sheffield United': { lat: 53.37, lon: -1.47 },
  'Sheffield Weds': { lat: 53.411, lon: -1.5 },
  Southampton: { lat: 50.906, lon: -1.391 },
  'Stoke City': { lat: 52.988, lon: -2.175 },
  'Swansea City': { lat: 51.643, lon: -3.935 },
  Watford: { lat: 51.65, lon: -0.401 },
  'West Bromwich Albion': { lat: 52.509, lon: -1.964 },
  Wrexham: { lat: 53.065, lon: -3.0 },
};

export interface MarkerInput<T> {
  id: T;
  point: GeoPoint;
}

export interface LayoutMarker<T> {
  id: T;
  x: number;
  y: number;
}

// Several English city clusters (London most of all -- 10 clubs within a
// few miles of each other) plot to the same handful of pixels at map
// scale, which would leave crests completely overlapping. Union-find
// groups any markers within CLUSTER_RADIUS_PX of each other (chained
// transitively, so a loose city-region cluster like "West Midlands" or
// "Lancashire" forms naturally without hardcoding which clubs belong to
// it), then fans each cluster's members out evenly around a small ring
// centered on the group's average position. A lone marker is left exactly
// where it projects. Generic by design -- works correctly for whatever
// teams are actually in a given season/competition, no hardcoded
// per-team offset table to keep in sync with promotion/relegation.
const CLUSTER_RADIUS_PX = 14;
// A fixed fan-out radius works for a 2-3 club cluster but crushes London's
// 10 clubs into an unreadable knot -- the ring's radius instead grows with
// cluster size, targeting a roughly constant ~16px of arc length between
// neighboring members regardless of how many are in the group (circle
// circumference = count * arc budget => radius = count * budget / 2*pi),
// floored at MIN_FAN_RADIUS_PX so a 2-member cluster still fans out
// visibly instead of nearly overlapping.
const MIN_FAN_RADIUS_PX = 12;
const ARC_BUDGET_PX = 16;
function fanRadiusFor(clusterSize: number): number {
  return Math.max(MIN_FAN_RADIUS_PX, (clusterSize * ARC_BUDGET_PX) / (2 * Math.PI));
}

export function layoutMarkers<T>(inputs: MarkerInput<T>[]): LayoutMarker<T>[] {
  const projected = inputs.map((input) => project(input.point));
  const n = inputs.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = projected[i].x - projected[j].x;
      const dy = projected[i].y - projected[j].y;
      if (Math.hypot(dx, dy) < CLUSTER_RADIUS_PX) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  const result: LayoutMarker<T>[] = [];
  for (const indices of groups.values()) {
    const cx = indices.reduce((sum, i) => sum + projected[i].x, 0) / indices.length;
    const cy = indices.reduce((sum, i) => sum + projected[i].y, 0) / indices.length;
    if (indices.length === 1) {
      result.push({ id: inputs[indices[0]].id, x: cx, y: cy });
      continue;
    }
    // Fan each member out starting from its OWN true bearing from the
    // cluster's centroid, not an arbitrary rotation -- keeps a member
    // roughly in the real compass direction it actually sits in relative
    // to the group, which reads more intuitively and avoids a member
    // swinging around to coincidentally overlap an unrelated singleton
    // marker sitting just outside the cluster on the ring's far side.
    const sorted = [...indices].sort(
      (a, b) => Math.atan2(projected[a].y - cy, projected[a].x - cx) - Math.atan2(projected[b].y - cy, projected[b].x - cx),
    );
    const radius = fanRadiusFor(sorted.length);
    sorted.forEach((i, k) => {
      const angle = (2 * Math.PI * k) / sorted.length - Math.PI / 2; // start at 12 o'clock, go clockwise
      result.push({
        id: inputs[i].id,
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    });
  }
  return result;
}
