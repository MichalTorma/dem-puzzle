import type { EdgeKind, EdgeSeed, GridShape, TileSpec } from '../types';

const METERS_PER_DEG_LAT = 111320;

export function metersPerDegLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.max(0.15, Math.cos((lat * Math.PI) / 180));
}

export function localMetersToLngLat(
  dxMeters: number,
  dyMeters: number,
  anchorLng: number,
  anchorLat: number,
  rotationDeg: number
): [number, number] {
  const rad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const rx = dxMeters * cosR - dyMeters * sinR;
  const ry = dxMeters * sinR + dyMeters * cosR;
  const lat = anchorLat + ry / METERS_PER_DEG_LAT;
  const lng = anchorLng + rx / metersPerDegLng(anchorLat);
  return [lng, lat];
}

// Pointy-top hex axial directions (counter-clockwise starting from East-Northeast edge 0)
// Edge i connects vertex i to vertex (i+1)%6.
// With pointy-top vertices at angles: 30, 90, 150, 210, 270, 330 deg:
// Edge 0 (30->90): NE neighbor (+1, -1)? Wait: let's use standard pointy-top axial:
// +q = East, +r = Southeast (or Northeast with +y up).
// With +y up: q-axis = (1, 0), r-axis = (1/2, sqrt(3)/2).
// Edge 0 (30->90, normal 60 deg): neighbor (+0, +1) -> normal (1/2, sqrt(3)/2)
// Edge 1 (90->150, normal 120 deg): neighbor (-1, +1) -> normal (-1/2, sqrt(3)/2)
// Edge 2 (150->210, normal 180 deg): neighbor (-1, 0) -> normal (-1, 0)
// Edge 3 (210->270, normal 240 deg): neighbor (0, -1) -> normal (-1/2, -sqrt(3)/2)
// Edge 4 (270->330, normal 300 deg): neighbor (+1, -1) -> normal (1/2, -sqrt(3)/2)
// Edge 5 (330->30, normal 0 deg): neighbor (+1, 0) -> normal (1, 0)
const HEX_NEIGHBORS: [number, number][] = [
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
  [1, 0],
];

// Rect edges: 0: Top (+y), 1: Right (+x), 2: Bottom (-y), 3: Left (-x)
const RECT_NEIGHBORS: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

export function tileIdFromQR(q: number, r: number): string {
  return `${q},${r}`;
}

function hashFloat(seed: number): number {
  let x = seed | 0;
  x = ((x >>> 16) ^ x) * 0x45d9f3b;
  x = ((x >>> 16) ^ x) * 0x45d9f3b;
  x = (x >>> 16) ^ x;
  return (x >>> 0) / 0xffffffff;
}

function computeCanonicalEdgeSeed(q: number, r: number, dq: number, dr: number): EdgeSeed {
  const nq = q + dq;
  const nr = r + dr;
  const isCanonical = q < nq || (q === nq && r < nr);
  const aQ = isCanonical ? q : nq;
  const aR = isCanonical ? r : nr;
  const bQ = isCanonical ? nq : q;
  const bR = isCanonical ? nr : r;

  const baseHash = (aQ * 73856093) ^ (aR * 19349663) ^ (bQ * 83492791) ^ (bR * 297121507);
  const h1 = hashFloat(baseHash + 11);
  const h2 = hashFloat(baseHash + 37);
  const h3 = hashFloat(baseHash + 73);

  const dirSign = isCanonical ? 1 : -1;
  return {
    uShift: dirSign * (h1 - 0.5) * 0.14,
    skew: dirSign * (h3 - 0.5) * 0.03,
    sizeScale: 0.86 + h2 * 0.28,
  };
}

function formatGridLabel(q: number, r: number): string {
  // Compass-grounded unique assembly label invariant to grid radius (e.g. E2N1, W1S3)
  const qPart = q >= 0 ? `E${q}` : `W${-q}`;
  const rPart = r >= 0 ? `N${r}` : `S${-r}`;
  return `${qPart}${rPart}`;
}

export function generateGridTiles(params: {
  shape: GridShape;
  anchorLng: number;
  anchorLat: number;
  tileRealSizeKm: number;
  tilePrintSizeMm: number;
  gridRotationDeg: number;
  radius: number;
  selectedIds: Set<string>;
  perimeterFlatEdges: boolean;
}): TileSpec[] {
  const {
    shape,
    anchorLng,
    anchorLat,
    tileRealSizeKm,
    tilePrintSizeMm,
    gridRotationDeg,
    radius,
    selectedIds,
    perimeterFlatEdges,
  } = params;

  const realSizeM = tileRealSizeKm * 1000;
  const tiles: TileSpec[] = [];

  if (shape === 'hex') {
    // tileRealSizeKm = flat-to-flat width (inradius * 2)
    const circumRadiusM = realSizeM / Math.sqrt(3);
    const circumRadiusMm = tilePrintSizeMm / Math.sqrt(3);

    for (let r = -radius; r <= radius; r++) {
      const qMin = Math.max(-radius, -r - radius);
      const qMax = Math.min(radius, -r + radius);
      for (let q = qMin; q <= qMax; q++) {
        const cxM = realSizeM * (q + r * 0.5);
        const cyM = circumRadiusM * 1.5 * r;
        const cxMm = tilePrintSizeMm * (q + r * 0.5);
        const cyMm = circumRadiusMm * 1.5 * r;

        const [centerLng, centerLat] = localMetersToLngLat(
          cxM,
          cyM,
          anchorLng,
          anchorLat,
          gridRotationDeg
        );

        const polygonLngLat: [number, number][] = [];
        for (let i = 0; i < 6; i++) {
          const angle = ((30 + i * 60) * Math.PI) / 180;
          const vxM = cxM + circumRadiusM * Math.cos(angle);
          const vyM = cyM + circumRadiusM * Math.sin(angle);
          polygonLngLat.push(
            localMetersToLngLat(vxM, vyM, anchorLng, anchorLat, gridRotationDeg)
          );
        }

        const edgeTypes: EdgeKind[] = HEX_NEIGHBORS.map(([dq, dr], edgeIdx) => {
          if (perimeterFlatEdges && !selectedIds.has(tileIdFromQR(q + dq, r + dr))) {
            return 'flat';
          }
          // Even edges = tab, odd edges = blank -> opposite edge (edgeIdx+3)%6 is guaranteed opposite!
          return edgeIdx % 2 === 0 ? 'tab' : 'blank';
        });
        const edgeSeeds: EdgeSeed[] = HEX_NEIGHBORS.map(([dq, dr]) =>
          computeCanonicalEdgeSeed(q, r, dq, dr)
        );

        tiles.push({
          id: tileIdFromQR(q, r),
          label: formatGridLabel(q, r),
          q,
          r,
          centerLng,
          centerLat,
          centerMmX: cxMm,
          centerMmY: cyMm,
          polygonLngLat,
          edgeTypes,
          edgeSeeds,
        });
      }
    }
  } else {
    const halfM = realSizeM / 2;
    for (let r = -radius; r <= radius; r++) {
      for (let q = -radius; q <= radius; q++) {
        const cxM = q * realSizeM;
        const cyM = r * realSizeM;
        const cxMm = q * tilePrintSizeMm;
        const cyMm = r * tilePrintSizeMm;

        const [centerLng, centerLat] = localMetersToLngLat(
          cxM,
          cyM,
          anchorLng,
          anchorLat,
          gridRotationDeg
        );

        // Vertices: TL, TR, BR, BL -> Wait: let's match edge indices:
        // Edge 0 (Top): TL -> TR
        // Edge 1 (Right): TR -> BR
        // Edge 2 (Bottom): BR -> BL
        // Edge 3 (Left): BL -> TL
        const corners: [number, number][] = [
          [-halfM, halfM],
          [halfM, halfM],
          [halfM, -halfM],
          [-halfM, -halfM],
        ];
        const polygonLngLat = corners.map(([dx, dy]) =>
          localMetersToLngLat(cxM + dx, cyM + dy, anchorLng, anchorLat, gridRotationDeg)
        );

        const isEven = (((q + r) % 2) + 2) % 2 === 0;
        const edgeTypes: EdgeKind[] = RECT_NEIGHBORS.map(([dq, dr], edgeIdx) => {
          if (perimeterFlatEdges && !selectedIds.has(tileIdFromQR(q + dq, r + dr))) {
            return 'flat';
          }
          // Even: 0(T)=tab, 1(R)=blank, 2(B)=tab, 3(L)=blank
          // Odd:  0(T)=blank, 1(R)=tab, 2(B)=blank, 3(L)=tab
          const baseTab = edgeIdx % 2 === 0;
          return (isEven ? baseTab : !baseTab) ? 'tab' : 'blank';
        });
        const edgeSeeds: EdgeSeed[] = RECT_NEIGHBORS.map(([dq, dr]) =>
          computeCanonicalEdgeSeed(q, r, dq, dr)
        );

        tiles.push({
          id: tileIdFromQR(q, r),
          label: formatGridLabel(q, r),
          q,
          r,
          centerLng,
          centerLat,
          centerMmX: cxMm,
          centerMmY: cyMm,
          polygonLngLat,
          edgeTypes,
          edgeSeeds,
        });
      }
    }
  }

  return tiles;
}

export type FootprintShape = 'hex-ring' | 'circle' | 'rect-frame';

export interface FootprintParams {
  footprint: FootprintShape;
  radius: number;
  rectWidth: number;
  rectHeight: number;
  tilePrintSizeMm: number;
  shape: GridShape;
}

/**
 * Selects tile IDs inside the chosen outer footprint centered on the planted pin.
 */
export function selectTilesByFootprint(tiles: TileSpec[], params: FootprintParams): Set<string> {
  const next = new Set<string>();
  const { footprint, radius, rectWidth, rectHeight, tilePrintSizeMm, shape } = params;

  if (footprint === 'hex-ring') {
    for (const t of tiles) {
      const dist =
        shape === 'hex'
          ? Math.max(Math.abs(t.q), Math.abs(t.r), Math.abs(t.q + t.r))
          : Math.max(Math.abs(t.q), Math.abs(t.r));
      if (dist <= radius) next.add(t.id);
    }
    return next;
  }

  if (footprint === 'circle') {
    const maxMm = (radius + 0.35) * tilePrintSizeMm;
    for (const t of tiles) {
      if (Math.hypot(t.centerMmX, t.centerMmY) <= maxMm) {
        next.add(t.id);
      }
    }
    return next;
  }

  // 'rect-frame'
  const halfW = rectWidth * 0.5 * tilePrintSizeMm + tilePrintSizeMm * 0.12;
  const halfH = rectHeight * 0.5 * tilePrintSizeMm + tilePrintSizeMm * 0.12;
  for (const t of tiles) {
    if (Math.abs(t.centerMmX) <= halfW && Math.abs(t.centerMmY) <= halfH) {
      next.add(t.id);
    }
  }
  return next;
}

/**
 * Fast point-in-polygon hit test for map hover & click without GeoJSON fill layers.
 */
export function findTileAtLngLat(tiles: TileSpec[], lng: number, lat: number): TileSpec | null {
  for (const t of tiles) {
    const poly = t.polygonLngLat;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0];
      const yi = poly[i][1];
      const xj = poly[j][0];
      const yj = poly[j][1];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi) {
        inside = !inside;
      }
    }
    if (inside) return t;
  }
  return null;
}
