import earcut from 'earcut';
import type { EdgeKind, EdgeSeed, FeatureMasks, GeneratedTileMesh, PuzzleConfig } from '../types';

export interface MeshTileRequest {
  tileId: string;
  label: string;
  centerMmX: number;
  centerMmY: number;
  edgeTypes: EdgeKind[];
  edgeSeeds: EdgeSeed[];
  config: PuzzleConfig;
  halfSpanMm: number;
  elevations: Float32Array;
  globalMinElevM: number;
  globalMaxElevM: number;
  masks: FeatureMasks;
}

interface Vec2 {
  x: number;
  y: number;
}

function getBaseCorners(shape: 'hex' | 'rect', sizeMm: number): Vec2[] {
  if (shape === 'hex') {
    const r = sizeMm / Math.sqrt(3);
    const pts: Vec2[] = [];
    for (let i = 0; i < 6; i++) {
      const a = ((30 + i * 60) * Math.PI) / 180;
      pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return pts; // CCW
  }
  const h = sizeMm / 2;
  // CCW starting from top-left? Wait: TL(-h,h) -> BL(-h,-h) -> BR(h,-h) -> TR(h,h) is CCW.
  // Let's keep edge order matching RECT_NEIGHBORS: 0:Top, 1:Right, 2:Bottom, 3:Left
  // If we list edges explicitly as [A, B] pairs, we can ensure CCW polygon order!
  // In CCW: Top is TR->TL, Left is TL->BL, Bottom is BL->BR, Right is BR->TR.
  return [
    { x: h, y: h }, // 0: TR
    { x: -h, y: h }, // 1: TL
    { x: -h, y: -h }, // 2: BL
    { x: h, y: -h }, // 3: BR
  ];
}

function getEdgePairIndices(shape: 'hex' | 'rect'): Array<[number, number, number]> {
  if (shape === 'hex') {
    // edge i goes from corner i to (i+1)%6, maps directly to edgeTypes[i]
    return [0, 1, 2, 3, 4, 5].map((i) => [i, (i + 1) % 6, i]);
  }
  // Corners: 0=TR, 1=TL, 2=BL, 3=BR (CCW)
  // 0->1 is Top (edgeTypes[0])
  // 1->2 is Left (edgeTypes[3])
  // 2->3 is Bottom (edgeTypes[2])
  // 3->0 is Right (edgeTypes[1])
  return [
    [0, 1, 0],
    [1, 2, 3],
    [2, 3, 2],
    [3, 0, 1],
  ];
}

/**
 * Generates a classic smooth jigsaw tab/blank curve in normalized edge coords (u in [0,1], v = outward).
 */
function sampleJigsawProfile(
  kind: EdgeKind,
  edgeLenMm: number,
  tabRatio: number,
  seed?: EdgeSeed
): Array<{ u: number; v: number }> {
  if (kind === 'flat') {
    return [{ u: 0, v: 0 }];
  }

  const sign = kind === 'tab' ? 1 : -1;
  const uShift = seed?.uShift ?? 0;
  const skew = seed?.skew ?? 0;
  const sizeScale = seed?.sizeScale ?? 1;

  const tabDepth = Math.max(1.8, edgeLenMm * tabRatio * sizeScale);
  const neckHalfU = 0.085 * sizeScale;
  const bulbHalfU = 0.145 * sizeScale;
  const c = 0.5 + uShift;

  // Normalized key points (u along edge, v outward in mm)
  const pts: Array<{ u: number; v: number }> = [
    { u: 0.0, v: 0 },
    { u: Math.min(0.22, c - bulbHalfU - 0.08), v: 0 },
    { u: c - neckHalfU * 1.4, v: sign * tabDepth * 0.04 },
    { u: c - neckHalfU + skew * 0.4, v: sign * tabDepth * 0.28 },
    { u: c - bulbHalfU * 0.85 + skew * 0.7, v: sign * tabDepth * 0.55 },
    { u: c - bulbHalfU + skew * 0.9, v: sign * tabDepth * 0.78 },
    { u: c - bulbHalfU * 0.65 + skew, v: sign * tabDepth * 0.96 },
    { u: c + skew, v: sign * tabDepth },
    { u: c + bulbHalfU * 0.65 + skew, v: sign * tabDepth * 0.96 },
    { u: c + bulbHalfU + skew * 0.9, v: sign * tabDepth * 0.78 },
    { u: c + bulbHalfU * 0.85 + skew * 0.7, v: sign * tabDepth * 0.55 },
    { u: c + neckHalfU + skew * 0.4, v: sign * tabDepth * 0.28 },
    { u: c + neckHalfU * 1.4, v: sign * tabDepth * 0.04 },
    { u: Math.max(0.78, c + bulbHalfU + 0.08), v: 0 },
  ];

  // Subdivide with Catmull-Rom / quadratic smoothing for silky curves
  const smooth: Array<{ u: number; v: number }> = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    smooth.push({
      u: 0.25 * p0.u + 0.75 * p1.u,
      v: 0.25 * p0.v + 0.75 * p1.v,
    });
    smooth.push({
      u: 0.75 * p1.u + 0.25 * p2.u,
      v: 0.75 * p1.v + 0.25 * p2.v,
    });
  }
  return smooth;
}

function buildOuterJigsawPolygon(
  shape: 'hex' | 'rect',
  tilePrintSizeMm: number,
  edgeTypes: EdgeKind[],
  edgeSeeds: EdgeSeed[],
  tabRatio: number,
  clearanceMm: number
): Vec2[] {
  const corners = getBaseCorners(shape, tilePrintSizeMm);
  const edges = getEdgePairIndices(shape);
  const poly: Vec2[] = [];

  for (const [iA, iB, edgeTypeIdx] of edges) {
    const a = corners[iA];
    const b = corners[iB];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const tx = dx / len;
    const ty = dy / len;
    // Outward normal for CCW polygon is (ty, -tx)
    let nx = ty;
    let ny = -tx;
    const midX = (a.x + b.x) * 0.5;
    const midY = (a.y + b.y) * 0.5;
    if (nx * midX + ny * midY < 0) {
      nx = -nx;
      ny = -ny;
    }

    const kind = edgeTypes[edgeTypeIdx] ?? 'flat';
    const seed = edgeSeeds[edgeTypeIdx];
    const profile = sampleJigsawProfile(kind, len, tabRatio, seed);
    for (const p of profile) {
      poly.push({
        x: a.x + dx * p.u + nx * p.v,
        y: a.y + dy * p.u + ny * p.v,
      });
    }
  }

  // Offset the entire CCW boundary inward by clearanceMm * 0.5 along its 2D normal
  // so straight edges, necks, bulbs, and tips all have uniform clearance without interference.
  const halfGap = Math.max(0, clearanceMm * 0.5);
  if (halfGap <= 0 || poly.length < 3) return poly;

  const n = poly.length;
  const insetPoly: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const curr = poly[i];
    const next = poly[(i + 1) % n];

    const e1x = curr.x - prev.x;
    const e1y = curr.y - prev.y;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const n1x = -e1y / l1;
    const n1y = e1x / l1;

    const e2x = next.x - curr.x;
    const e2y = next.y - curr.y;
    const l2 = Math.hypot(e2x, e2y) || 1;
    const n2x = -e2y / l2;
    const n2y = e2x / l2;

    const mx = n1x + n2x;
    const my = n1y + n2y;
    const mLen = Math.hypot(mx, my);
    if (mLen < 1e-6) {
      insetPoly[i] = { x: curr.x + n1x * halfGap, y: curr.y + n1y * halfGap };
    } else {
      const ux = mx / mLen;
      const uy = my / mLen;
      const dot = Math.max(0.5, ux * n1x + uy * n1y);
      const dist = halfGap / dot;
      insetPoly[i] = { x: curr.x + ux * dist, y: curr.y + uy * dist };
    }
  }

  return insetPoly;
}

/**
 * Subdivides any boundary edge longer than `maxSegLen` so flat outer edges
 * and straight jigsaw shoulders sample terrain valleys/peaks instead of bridging across them.
 */
function subdividePolyEdges(
  poly: Vec2[],
  maxSegLen: number
): { poly: Vec2[]; rawToSubIdx: number[] } {
  if (poly.length < 3 || maxSegLen <= 0) {
    return { poly, rawToSubIdx: poly.map((_, i) => i) };
  }
  const out: Vec2[] = [];
  const rawToSubIdx: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    rawToSubIdx.push(out.length);
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / maxSegLen));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
    }
  }
  return { poly: out, rawToSubIdx };
}

function pointInPolygon(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distanceToPolySq(x: number, y: number, poly: Vec2[]): number {
  let minD2 = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x;
    const ay = poly[j].y;
    const bx = poly[i].x;
    const by = poly[i].y;
    const vx = bx - ax;
    const vy = by - ay;
    const wx = x - ax;
    const wy = y - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
    const px = ax + t * vx - x;
    const py = ay + t * vy - y;
    const d2 = px * px + py * py;
    if (d2 < minD2) minD2 = d2;
  }
  return minD2;
}

function sampleFieldBilinear(
  field: Float32Array,
  size: number,
  xMm: number,
  yMm: number,
  halfSpanMm: number
): number {
  const u = Math.max(0, Math.min(size - 1, ((xMm + halfSpanMm) / (halfSpanMm * 2)) * (size - 1)));
  const v = Math.max(0, Math.min(size - 1, ((yMm + halfSpanMm) / (halfSpanMm * 2)) * (size - 1)));
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const tx = u - x0;
  const ty = v - y0;
  const f00 = field[y0 * size + x0];
  const f10 = field[y0 * size + x1];
  const f01 = field[y1 * size + x0];
  const f11 = field[y1 * size + x1];
  return (f00 * (1 - tx) + f10 * tx) * (1 - ty) + (f01 * (1 - tx) + f11 * tx) * ty;
}

function hash2D(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth bicubic-interpolated value noise in [0, 1] for printable micro-textures. */
function smoothNoise2D(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2D(ix, iy);
  const b = hash2D(ix + 1, iy);
  const c = hash2D(ix, iy + 1);
  const d = hash2D(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

function fbm2D(x: number, y: number): number {
  return smoothNoise2D(x, y) * 0.65 + smoothNoise2D(x * 2.13 + 7.3, y * 2.13 - 4.1) * 0.35;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Evaluates physical print height Z (mm) and zone/color at any (xMm, yMm).
 */
function evalSurface(
  xMm: number,
  yMm: number,
  req: MeshTileRequest
): { z: number; zone: number; rgb: [number, number, number] } {
  const {
    elevations,
    globalMinElevM,
    globalMaxElevM,
    halfSpanMm,
    masks,
    config,
  } = req;
  const size = masks.size;

  const elevM = sampleFieldBilinear(elevations, size, xMm, yMm, halfSpanMm);
  const water = sampleFieldBilinear(masks.water, size, xMm, yMm, halfSpanMm);
  const forest = sampleFieldBilinear(masks.forest, size, xMm, yMm, halfSpanMm);
  const road = sampleFieldBilinear(masks.road, size, xMm, yMm, halfSpanMm);
  const building = sampleFieldBilinear(masks.building, size, xMm, yMm, halfSpanMm);

  const rangeM = Math.max(10, globalMaxElevM - globalMinElevM);
  let normElev = Math.max(0, Math.min(1, (elevM - globalMinElevM) / rangeM));

  // Optional terraced contours
  if (config.contourSteps > 0) {
    const steps = config.contourSteps;
    normElev = Math.floor(normElev * steps) / steps;
  }

  let reliefMm = normElev * config.maxReliefMm * config.zExaggeration;
  reliefMm = Math.min(config.maxReliefMm * 1.8, reliefMm);

  let z = config.baseThicknessMm + reliefMm;
  let zone = 0; // 0 = terrain

  // World-locked print coordinates so textures flow seamlessly across adjacent tiles
  const wx = req.centerMmX + xMm;
  const wy = req.centerMmY + yMm;

  // Water treatment (kept flat so slicer top-ironing produces a mirror finish)
  if (water > 0.45 && config.waterMode !== 'none') {
    zone = 1;
    if (config.waterMode === 'recessed') {
      z = Math.max(config.baseThicknessMm * 0.72, z - 0.55);
    } else {
      z = Math.max(config.baseThicknessMm * 0.85, z);
    }
  } else {
    // Forest canopy micro-texture: rounded organic crown clusters feathered at edges
    if (forest > 0.35) {
      if (forest > 0.45) zone = 2;
      if (config.forestTexture) {
        const feather = smoothstep(0.32, 0.72, forest);
        const macroCanopy = smoothNoise2D(wx * 0.75, wy * 0.75);
        const crownClusters = smoothNoise2D(wx * 1.65 + 11.7, wy * 1.65 - 5.2);
        const canopyHeight = (macroCanopy * 0.55 + crownClusters * 0.45) * 0.42;
        z += feather * (0.08 + canopyHeight);
      }
    }

    // Urban buildings (urban scale only)
    if (building > 0.5) {
      z += 1.1;
    }

    // Scale-filtered roads (kept crisp & flat on top for concentric ironing)
    if (road > 0.45 && config.roadMode !== 'none') {
      zone = 3;
      z += config.roadMode === 'raised' ? 0.55 : -0.45;
    }

    // Alpine rock strata & snow-drift sastrugi (zone 4 -> fuzzy skin + archimedean top-fill)
    if (zone === 0 && normElev > 0.52 && config.elevationBands) {
      zone = 4;
      const alpineBlend = smoothstep(0.50, 0.60, normElev);
      if (normElev <= 0.78) {
        // Anisotropic rock striations + crag texture
        const rx = wx * 0.82 - wy * 0.57;
        const ry = wx * 0.57 + wy * 0.82;
        const strata = Math.sin(reliefMm * 4.2 + fbm2D(rx * 0.55, ry * 0.55) * 3.0);
        const crag = fbm2D(rx * 1.15, ry * 0.45) - 0.5;
        z += alpineBlend * (strata * 0.11 + crag * 0.24);
      } else {
        // Wind-swept snow / glacier sastrugi ripples
        const sx = wx * 0.91 + wy * 0.41;
        const sy = -wx * 0.41 + wy * 0.91;
        const drift = smoothNoise2D(sx * 0.45, sy * 1.35) - 0.45;
        z += alpineBlend * drift * 0.20;
      }
    } else if (zone === 0 && normElev > 0.72) {
      zone = 4;
    } else if (zone === 0 && config.contourSteps === 0) {
      // Delicate debossed contour micro-grooves in smooth valleys (0.10 mm)
      const contourPhase = Math.abs(((reliefMm / 1.6) % 1) - 0.5) * 2;
      const groove = 1.0 - smoothstep(0.0, 0.16, 1.0 - contourPhase);
      z -= groove * 0.10;
    }
  }

  // Vertex color for WebGL 2 multi-color preview (single-color & clay modes override dynamically in Three.js)
  let rgb: [number, number, number];
  if (zone === 1) {
    rgb = [0.09, 0.48, 0.82]; // Ocean/lake blue
  } else if (zone === 3) {
    rgb = [0.25, 0.27, 0.31]; // Asphalt road
  } else if (zone === 2) {
    rgb = [0.16, 0.48, 0.26]; // Forest green
  } else if (normElev > 0.78 && config.elevationBands) {
    rgb = [0.92, 0.94, 0.97]; // Snow peak
  } else if (normElev > 0.52 && config.elevationBands) {
    rgb = [0.54, 0.49, 0.45]; // Alpine rock
  } else {
    // Hypsometric warm-green to highland-tan
    rgb = [
      0.34 + normElev * 0.32,
      0.52 - normElev * 0.08,
      0.32 - normElev * 0.06,
    ];
  }

  return { z, zone, rgb };
}

/**
 * Traces the largest connected component of inside-grid-cells to produce a simple
 * closed inner boundary loop (in grid vertex coordinates) with zero T-junctions.
 */
function buildInnerGridRegion(
  poly: Vec2[],
  gridN: number,
  halfSpanMm: number
): {
  insideCells: Uint8Array;
  innerLoops: number[][];
} {
  const cellN = gridN - 1;
  const rawInside = new Uint8Array(cellN * cellN);
  const step = (halfSpanMm * 2) / cellN;
  // Cell half-diagonal is step * sqrt(2)/2 (~0.7071 * step). Requiring center
  // clearance > 0.85 * step guarantees the entire cell square lies strictly
  // inside `poly` with no outerPoly edge/vertex intruding into innerLoops.
  const minClearanceSq = (step * 0.85) ** 2;

  const gx = (c: number) => -halfSpanMm + c * step;
  const gy = (r: number) => -halfSpanMm + r * step;

  for (let r = 0; r < cellN; r++) {
    for (let c = 0; c < cellN; c++) {
      const x0 = gx(c);
      const y0 = gy(r);
      const x1 = gx(c + 1);
      const y1 = gy(r + 1);
      if (
        pointInPolygon(x0, y0, poly) &&
        pointInPolygon(x1, y0, poly) &&
        pointInPolygon(x1, y1, poly) &&
        pointInPolygon(x0, y1, poly) &&
        distanceToPolySq((x0 + x1) * 0.5, (y0 + y1) * 0.5, poly) > minClearanceSq
      ) {
        rawInside[r * cellN + c] = 1;
      }
    }
  }

  // Keep only the largest 4-connected component so there is 1 clean inner loop
  const visited = new Uint8Array(cellN * cellN);
  let bestComp: number[] = [];

  for (let i = 0; i < cellN * cellN; i++) {
    if (!rawInside[i] || visited[i]) continue;
    const queue = [i];
    visited[i] = 1;
    const comp: number[] = [];
    while (queue.length > 0) {
      const curr = queue.pop()!;
      comp.push(curr);
      const cr = Math.floor(curr / cellN);
      const cc = curr % cellN;
      const nbrs = [
        cr > 0 ? (cr - 1) * cellN + cc : -1,
        cr < cellN - 1 ? (cr + 1) * cellN + cc : -1,
        cc > 0 ? cr * cellN + (cc - 1) : -1,
        cc < cellN - 1 ? cr * cellN + (cc + 1) : -1,
      ];
      for (const n of nbrs) {
        if (n >= 0 && rawInside[n] && !visited[n]) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }
    if (comp.length > bestComp.length) {
      bestComp = comp;
    }
  }

  const insideCells = new Uint8Array(cellN * cellN);
  for (const idx of bestComp) insideCells[idx] = 1;

  // Clean any diagonal pinch vertices so innerLoops has no self-touching vertices
  let pinchChanged = true;
  while (pinchChanged) {
    pinchChanged = false;
    for (let r = 0; r < cellN - 1; r++) {
      for (let c = 0; c < cellN - 1; c++) {
        const a = insideCells[r * cellN + c];
        const b = insideCells[r * cellN + c + 1];
        const d = insideCells[(r + 1) * cellN + c];
        const e = insideCells[(r + 1) * cellN + c + 1];
        if (a && e && !b && !d) {
          insideCells[r * cellN + c] = 0;
          pinchChanged = true;
        } else if (!a && !e && b && d) {
          insideCells[r * cellN + c + 1] = 0;
          pinchChanged = true;
        }
      }
    }
  }

  // Collect directed boundary edges around insideCells (CCW around the filled region)
  const edgeMap = new Map<number, number[]>();
  const vid = (r: number, c: number) => r * gridN + c;
  const addEdge = (a: number, b: number) => {
    const list = edgeMap.get(a);
    if (list) list.push(b);
    else edgeMap.set(a, [b]);
  };

  for (let idx = 0; idx < cellN * cellN; idx++) {
    if (!insideCells[idx]) continue;
    const r = Math.floor(idx / cellN);
    const c = idx % cellN;
    // Bottom edge: (r, c) -> (r, c+1)
    if (r === 0 || !insideCells[(r - 1) * cellN + c]) addEdge(vid(r, c), vid(r, c + 1));
    // Right edge: (r, c+1) -> (r+1, c+1)
    if (c === cellN - 1 || !insideCells[r * cellN + (c + 1)]) addEdge(vid(r, c + 1), vid(r + 1, c + 1));
    // Top edge: (r+1, c+1) -> (r+1, c)
    if (r === cellN - 1 || !insideCells[(r + 1) * cellN + c]) addEdge(vid(r + 1, c + 1), vid(r + 1, c));
    // Left edge: (r+1, c) -> (r, c)
    if (c === 0 || !insideCells[r * cellN + (c - 1)]) addEdge(vid(r + 1, c), vid(r, c));
  }

  // Trace closed loops
  const innerLoops: number[][] = [];
  while (edgeMap.size > 0) {
    const start = edgeMap.keys().next().value!;
    const loop: number[] = [start];
    let curr = start;
    while (true) {
      const nexts = edgeMap.get(curr);
      if (!nexts || nexts.length === 0) break;
      const next = nexts.pop()!;
      if (nexts.length === 0) edgeMap.delete(curr);
      if (next === start) break;
      loop.push(next);
      curr = next;
    }
    if (loop.length >= 3) innerLoops.push(loop);
  }

  return { insideCells, innerLoops };
}

export type WorkerOutMessage =
  | { type: 'progress'; tileId: string; label: string; step: string; pct: number }
  | { type: 'done'; mesh: GeneratedTileMesh };

function postProgress(tileId: string, label: string, step: string, pct: number) {
  (self as unknown as Worker).postMessage({
    type: 'progress',
    tileId,
    label,
    step,
    pct,
  } satisfies WorkerOutMessage);
}

/**
 * Builds disjoint, non-overlapping CCW polygons (in top-down XY print coords)
 * for an old-school 8-point nautical compass rose + mirrored 'N' glyph
 * so it reads forwards when debossed into the bottom face of the center tile.
 */
function buildCompassRoseHoles(northAngleRad: number, radiusMm: number): Vec2[][] {
  const holes: Vec2[][] = [];
  const cosN = Math.cos(northAngleRad);
  const sinN = Math.sin(northAngleRad);

  // North = (sinN, cosN), East = (cosN, -sinN)
  const mapPt = (gx: number, gy: number): Vec2 => ({
    x: gx * cosN + gy * sinN,
    y: -gx * sinN + gy * cosN,
  });

  // 1. 8-point nautical compass star (16 vertices, CCW in top-down XY)
  const star: Vec2[] = [];
  const rNorth = radiusMm * 0.86;
  const rCard = radiusMm * 0.64;
  const rInter = radiusMm * 0.42;
  const rValley = radiusMm * 0.19;
  for (let i = 0; i < 16; i++) {
    const ang = (i * Math.PI) / 8;
    let r = rValley;
    if (i === 0) r = rNorth;
    else if (i % 4 === 0) r = rCard;
    else if (i % 2 === 0) r = rInter;
    star.push(mapPt(-r * Math.sin(ang), r * Math.cos(ang)));
  }
  holes.push(star);

  // 2. Bold 'N' glyph at North (mirrored in gx so it reads forwards from underneath)
  const nCenterY = radiusMm * 1.06;
  const w = radiusMm * 0.14;
  const h = radiusMm * 0.17;
  const t = Math.max(0.45, radiusMm * 0.065);
  const diagShift = t * 1.85;
  const nBottomPts: Array<[number, number]> = [
    [-w, -h],
    [-w, h],
    [-w + t, h],
    [w - t, -h + diagShift],
    [w - t, h],
    [w, h],
    [w, -h],
    [w - t, -h],
    [-w + t, h - diagShift],
    [-w + t, -h],
  ];
  holes.push(nBottomPts.map(([bx, by]) => mapPt(-bx, nCenterY + by)));

  // 3. Cardinal tick bars for E, S, W
  const tickInner = radiusMm * 0.74;
  const tickOuter = radiusMm * 0.92;
  const tickHalfW = Math.max(0.32, radiusMm * 0.045);
  const cardAngles = [Math.PI * 0.5, Math.PI, Math.PI * 1.5];
  for (const ang of cardAngles) {
    const ux = Math.sin(ang);
    const uy = Math.cos(ang);
    const px = Math.cos(ang);
    const py = -Math.sin(ang);
    holes.push([
      mapPt(ux * tickInner - px * tickHalfW, uy * tickInner - py * tickHalfW),
      mapPt(ux * tickInner + px * tickHalfW, uy * tickInner + py * tickHalfW),
      mapPt(ux * tickOuter + px * tickHalfW, uy * tickOuter + py * tickHalfW),
      mapPt(ux * tickOuter - px * tickHalfW, uy * tickOuter - py * tickHalfW),
    ]);
  }

  // 4. Four outer compass-ring arcs between the cardinal directions
  const ringIn = radiusMm * 0.76;
  const ringOut = radiusMm * 0.86;
  const arcGap = 0.24;
  const segsPerArc = 7;
  for (let q = 0; q < 4; q++) {
    const a0 = q * (Math.PI * 0.5) + arcGap;
    const a1 = (q + 1) * (Math.PI * 0.5) - arcGap;
    const arc: Vec2[] = [];
    for (let s = 0; s <= segsPerArc; s++) {
      const a = a0 + ((a1 - a0) * s) / segsPerArc;
      arc.push(mapPt(-ringOut * Math.sin(a), ringOut * Math.cos(a)));
    }
    for (let s = segsPerArc; s >= 0; s--) {
      const a = a0 + ((a1 - a0) * s) / segsPerArc;
      arc.push(mapPt(-ringIn * Math.sin(a), ringIn * Math.cos(a)));
    }
    holes.push(arc);
  }

  return holes;
}

function buildTileMesh(req: MeshTileRequest): GeneratedTileMesh {
  const t0 = performance.now();
  const { config, edgeTypes, edgeSeeds, halfSpanMm } = req;
  const gridN = Math.max(32, Math.min(144, config.resolution));
  const cellN = gridN - 1;
  const step = (halfSpanMm * 2) / cellN;

  postProgress(req.tileId, req.label, 'Building jigsaw boundary & inner grid', 0.15);

  const rawOuterPoly = buildOuterJigsawPolygon(
    config.shape,
    config.tilePrintSizeMm,
    edgeTypes,
    edgeSeeds,
    config.tabSizeRatio,
    config.jigsawClearanceMm
  );

  const { insideCells, innerLoops } = buildInnerGridRegion(rawOuterPoly, gridN, halfSpanMm);
  const { poly: outerPoly, rawToSubIdx } = subdividePolyEdges(rawOuterPoly, Math.max(0.35, step));
  postProgress(req.tileId, req.label, 'Sampling terrain relief & surface textures', 0.45);

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const triangleZones: number[] = [];

  // Map grid vertex id -> mesh vertex index
  const gridVertToMesh = new Int32Array(gridN * gridN).fill(-1);

  const getOrCreateGridVertex = (vid: number): number => {
    const existing = gridVertToMesh[vid];
    if (existing >= 0) return existing;
    const r = Math.floor(vid / gridN);
    const c = vid % gridN;
    const x = -halfSpanMm + c * step;
    const y = -halfSpanMm + r * step;
    const surf = evalSurface(x, y, req);
    const idx = positions.length / 3;
    positions.push(x, y, surf.z);
    colors.push(surf.rgb[0], surf.rgb[1], surf.rgb[2]);
    gridVertToMesh[vid] = idx;
    return idx;
  };

  // 1. Emit regular grid triangles for all inside cells
  for (let r = 0; r < cellN; r++) {
    for (let c = 0; c < cellN; c++) {
      if (!insideCells[r * cellN + c]) continue;
      const v00 = getOrCreateGridVertex(r * gridN + c);
      const v10 = getOrCreateGridVertex(r * gridN + (c + 1));
      const v11 = getOrCreateGridVertex((r + 1) * gridN + (c + 1));
      const v01 = getOrCreateGridVertex((r + 1) * gridN + c);

      const cx = -halfSpanMm + (c + 0.5) * step;
      const cy = -halfSpanMm + (r + 0.5) * step;
      const { zone } = evalSurface(cx, cy, req);

      indices.push(v00, v10, v11);
      triangleZones.push(zone);
      indices.push(v00, v11, v01);
      triangleZones.push(zone);
    }
  }

  // 2. Create top outer boundary vertices
  const outerTopVerts: number[] = [];
  for (const p of outerPoly) {
    const surf = evalSurface(p.x, p.y, req);
    const idx = positions.length / 3;
    positions.push(p.x, p.y, surf.z);
    colors.push(surf.rgb[0], surf.rgb[1], surf.rgb[2]);
    outerTopVerts.push(idx);
  }

  // 3. Earcut the ring between outerPoly and corner-simplified innerLoops,
  // then fan-split any simplified collinear chains -> 0 T-junctions & 0 open edges!
  const ringCoords: number[] = [];
  const ringVertMap: number[] = [];
  const holeIndices: number[] = [];
  const chainMap = new Map<string, number[]>();

  for (let i = 0; i < rawOuterPoly.length; i++) {
    ringCoords.push(rawOuterPoly[i].x, rawOuterPoly[i].y);
    ringVertMap.push(outerTopVerts[rawToSubIdx[i]]);

    const startSub = rawToSubIdx[i];
    const endSub = i + 1 < rawOuterPoly.length ? rawToSubIdx[i + 1] : outerPoly.length;
    if (endSub - startSub > 1) {
      const chain: number[] = [];
      for (let s = startSub; s <= endSub; s++) {
        chain.push(outerTopVerts[s % outerPoly.length]);
      }
      chainMap.set(`${chain[0]}:${chain[chain.length - 1]}`, chain);
    }
  }

  for (const loop of innerLoops) {
    // Reverse inner loop so hole winding is CW (opposite outer CCW)
    const rev = [...loop].reverse();
    const isCorner = (idx: number) => {
      const prev = rev[(idx - 1 + rev.length) % rev.length];
      const curr = rev[idx];
      const next = rev[(idx + 1) % rev.length];
      const dr1 = Math.floor(curr / gridN) - Math.floor(prev / gridN);
      const dc1 = (curr % gridN) - (prev % gridN);
      const dr2 = Math.floor(next / gridN) - Math.floor(curr / gridN);
      const dc2 = (next % gridN) - (curr % gridN);
      return dr1 !== dr2 || dc1 !== dc2;
    };

    const cornerIdxs: number[] = [];
    for (let i = 0; i < rev.length; i++) {
      if (isCorner(i)) cornerIdxs.push(i);
    }
    if (cornerIdxs.length < 3) continue;

    holeIndices.push(ringCoords.length / 2);
    for (let ci = 0; ci < cornerIdxs.length; ci++) {
      const startI = cornerIdxs[ci];
      const endI = cornerIdxs[(ci + 1) % cornerIdxs.length];
      const idA = rev[startI];
      const idB = rev[endI];
      const r = Math.floor(idA / gridN);
      const c = idA % gridN;
      ringCoords.push(-halfSpanMm + c * step, -halfSpanMm + r * step);
      ringVertMap.push(getOrCreateGridVertex(idA));

      const chain: number[] = [];
      let k = startI;
      while (k !== endI) {
        chain.push(getOrCreateGridVertex(rev[k]));
        k = (k + 1) % rev.length;
      }
      chain.push(getOrCreateGridVertex(idB));
      if (chain.length > 2) {
        chainMap.set(`${chain[0]}:${chain[chain.length - 1]}`, chain);
      }
    }
  }

  // Collect ring triangles first, then bisect any long interior diagonals (> 1.6 * step)
  // so flat-edge border strips follow terrain valleys instead of bridging between peaks.
  const rawRingTris: Array<[number, number, number]> = [];
  const pushRingTri = (a: number, b: number, c: number) => {
    rawRingTris.push([a, b, c]);
  };

  const ringTris = earcut(ringCoords, holeIndices.length > 0 ? holeIndices : undefined, 2);
  for (let i = 0; i < ringTris.length; i += 3) {
    const a = ringVertMap[ringTris[i]];
    const b = ringVertMap[ringTris[i + 1]];
    const c = ringVertMap[ringTris[i + 2]];

    const cAB = chainMap.get(`${a}:${b}`);
    const cBC = chainMap.get(`${b}:${c}`);
    const cCA = chainMap.get(`${c}:${a}`);

    // Rotate so any single chain is first, or handle 2 chains without zero-area triangles
    const splitEdge = (u: number, v: number, opp: number, cUV?: number[], cVO?: number[], cOU?: number[]) => {
      if (!cUV && !cVO && !cOU) {
        pushRingTri(u, v, opp);
        return;
      }
      if (cUV && !cVO && !cOU) {
        for (let k = 0; k < cUV.length - 1; k++) {
          pushRingTri(opp, cUV[k], cUV[k + 1]);
        }
        return;
      }
      // 2+ chains: peel off cUV using opp, leaving (cUV[last-1], v, opp) for cVO
      if (cUV && cVO && !cOU) {
        for (let k = 0; k < cUV.length - 2; k++) {
          pushRingTri(opp, cUV[k], cUV[k + 1]);
        }
        const pivot = cUV[cUV.length - 2];
        for (let k = 0; k < cVO.length - 1; k++) {
          pushRingTri(pivot, cVO[k], cVO[k + 1]);
        }
        return;
      }
      // Fallback for 3 chains (rare corner case): peel each chain to centroid-safe vertex
      const pts = cUV ? cUV.slice(0, -1) : [u];
      if (cVO) pts.push(...cVO.slice(0, -1));
      else pts.push(v);
      if (cOU) pts.push(...cOU.slice(0, -1));
      else pts.push(opp);
      for (let k = 1; k < pts.length - 1; k++) {
        pushRingTri(pts[0], pts[k], pts[k + 1]);
      }
    };

    if (cAB && !cBC && cCA) {
      splitEdge(c, a, b, cCA, cAB, undefined);
    } else if (!cAB && cBC && !cCA) {
      splitEdge(b, c, a, cBC, undefined, undefined);
    } else if (!cAB && !cBC && cCA) {
      splitEdge(c, a, b, cCA, undefined, undefined);
    } else if (!cAB && cBC && cCA) {
      splitEdge(b, c, a, cBC, cCA, undefined);
    } else {
      splitEdge(a, b, c, cAB, cBC, cCA);
    }
  }

  // Conformal longest-edge bisection of any long interior ring diagonals
  // (boundary edges are <= step, so only interior diagonals > maxEdgeLen are split)
  const maxRingEdgeSq = Math.max(0.65, step * 1.6) ** 2;
  const midpointCache = new Map<string, number>();
  const getEdgeMidpoint = (u: number, v: number): number => {
    const key = u < v ? `${u}:${v}` : `${v}:${u}`;
    const hit = midpointCache.get(key);
    if (hit !== undefined) return hit;
    const mx = (positions[u * 3] + positions[v * 3]) * 0.5;
    const my = (positions[u * 3 + 1] + positions[v * 3 + 1]) * 0.5;
    const surf = evalSurface(mx, my, req);
    const idx = positions.length / 3;
    positions.push(mx, my, surf.z);
    colors.push(surf.rgb[0], surf.rgb[1], surf.rgb[2]);
    midpointCache.set(key, idx);
    return idx;
  };
  const edgeLenSq = (u: number, v: number): number => {
    const dx = positions[u * 3] - positions[v * 3];
    const dy = positions[u * 3 + 1] - positions[v * 3 + 1];
    return dx * dx + dy * dy;
  };

  let curRingTris = rawRingTris;
  for (let pass = 0; pass < 64; pass++) {
    let anySplit = false;
    const nextTris: Array<[number, number, number]> = [];
    for (const [a, b, c] of curRingTris) {
      const dab = edgeLenSq(a, b);
      const dbc = edgeLenSq(b, c);
      const dca = edgeLenSq(c, a);
      const maxD = Math.max(dab, dbc, dca);
      if (maxD <= maxRingEdgeSq) {
        nextTris.push([a, b, c]);
        continue;
      }
      anySplit = true;
      if (dab >= dbc && dab >= dca) {
        const m = getEdgeMidpoint(a, b);
        nextTris.push([a, m, c], [m, b, c]);
      } else if (dbc >= dab && dbc >= dca) {
        const m = getEdgeMidpoint(b, c);
        nextTris.push([b, m, a], [m, c, a]);
      } else {
        const m = getEdgeMidpoint(c, a);
        nextTris.push([c, m, b], [m, a, b]);
      }
    }
    curRingTris = nextTris;
    if (!anySplit) break;
  }

  for (const [a, b, c] of curRingTris) {
    indices.push(a, b, c);
    const mx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
    const my = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
    triangleZones.push(evalSurface(mx, my, req).zone);
  }

  // 4. Create bottom outer vertices (z = 0) and extrude watertight side walls
  const outerBotVerts: number[] = [];
  for (const p of outerPoly) {
    const idx = positions.length / 3;
    positions.push(p.x, p.y, 0);
    colors.push(0.22, 0.24, 0.28);
    outerBotVerts.push(idx);
  }

  const nOuter = outerPoly.length;
  for (let i = 0; i < nOuter; i++) {
    const next = (i + 1) % nOuter;
    const t0v = outerTopVerts[i];
    const t1v = outerTopVerts[next];
    const b0v = outerBotVerts[i];
    const b1v = outerBotVerts[next];
    indices.push(t0v, b0v, b1v);
    triangleZones.push(0);
    indices.push(t0v, b1v, t1v);
    triangleZones.push(0);
  }

  // 5. Bottom cap (z = 0, reversed winding so normal points -Z)
  // On the center tile (E0N0) and middle calibration tile (T020_A), deboss an
  // old-school nautical compass rose upward into the base (zero-support print).
  const hasCompassRose = req.label === 'E0N0' || req.label === 'T020_A';
  const botCoords: number[] = [];
  const botVertMap: number[] = [];
  const botChainMap = new Map<string, number[]>();
  for (let i = 0; i < rawOuterPoly.length; i++) {
    botCoords.push(rawOuterPoly[i].x, rawOuterPoly[i].y);
    botVertMap.push(outerBotVerts[rawToSubIdx[i]]);

    const startSub = rawToSubIdx[i];
    const endSub = i + 1 < rawOuterPoly.length ? rawToSubIdx[i + 1] : outerPoly.length;
    if (endSub - startSub > 1) {
      const chain: number[] = [];
      for (let s = startSub; s <= endSub; s++) {
        chain.push(outerBotVerts[s % outerPoly.length]);
      }
      botChainMap.set(`${chain[0]}:${chain[chain.length - 1]}`, chain);
    }
  }

  const botHoleIndices: number[] = [];
  if (hasCompassRose) {
    const roseRadius = Math.min(8.2, config.tilePrintSizeMm * 0.25);
    const northRad = (config.gridRotationDeg * Math.PI) / 180;
    const debossDepth = Math.min(0.45, config.baseThicknessMm * 0.28);
    const rosePolys = buildCompassRoseHoles(northRad, roseRadius);

    for (const polyCCW of rosePolys) {
      // Bottom rim vertices at z = 0 (CW for earcut hole)
      const polyCW = [...polyCCW].reverse();
      const holeBotVerts: number[] = [];
      const holeTopVerts: number[] = [];
      botHoleIndices.push(botCoords.length / 2);

      for (const p of polyCW) {
        botCoords.push(p.x, p.y);
        const bIdx = positions.length / 3;
        positions.push(p.x, p.y, 0);
        colors.push(0.22, 0.24, 0.28);
        botVertMap.push(bIdx);
        holeBotVerts.push(bIdx);

        const tIdx = positions.length / 3;
        positions.push(p.x, p.y, debossDepth);
        colors.push(0.14, 0.16, 0.20);
        holeTopVerts.push(tIdx);
      }

      // Pocket ceiling at z = debossDepth (normal -Z)
      const ceilCoords: number[] = [];
      for (const p of polyCW) ceilCoords.push(p.x, p.y);
      const ceilTris = earcut(ceilCoords, undefined, 2);
      for (let i = 0; i < ceilTris.length; i += 3) {
        indices.push(
          holeTopVerts[ceilTris[i]],
          holeTopVerts[ceilTris[i + 2]],
          holeTopVerts[ceilTris[i + 1]]
        );
        triangleZones.push(0);
      }

      // Pocket side walls (connecting z = 0 holeBotVerts[i..next] to z = debossDepth holeTopVerts[i..next])
      // Since holeBotVerts is CW, reversing (next -> i) is CCW around pocket interior
      const m = polyCW.length;
      for (let i = 0; i < m; i++) {
        const next = (i + 1) % m;
        const b0 = holeBotVerts[next];
        const b1 = holeBotVerts[i];
        const t0v = holeTopVerts[next];
        const t1v = holeTopVerts[i];
        indices.push(b0, t1v, b1);
        triangleZones.push(0);
        indices.push(b0, t0v, t1v);
        triangleZones.push(0);
      }
    }
  }

  const botTris = earcut(botCoords, botHoleIndices.length > 0 ? botHoleIndices : undefined, 2);
  const pushBotTri = (a: number, b: number, c: number) => {
    indices.push(a, c, b);
    triangleZones.push(0);
  };
  for (let i = 0; i < botTris.length; i += 3) {
    const a = botVertMap[botTris[i]];
    const b = botVertMap[botTris[i + 1]];
    const c = botVertMap[botTris[i + 2]];
    const cAB = botChainMap.get(`${a}:${b}`);
    const cBC = botChainMap.get(`${b}:${c}`);
    const cCA = botChainMap.get(`${c}:${a}`);

    if (!cAB && !cBC && !cCA) {
      pushBotTri(a, b, c);
    } else if (cAB && !cBC && !cCA) {
      for (let k = 0; k < cAB.length - 1; k++) pushBotTri(c, cAB[k], cAB[k + 1]);
    } else if (!cAB && cBC && !cCA) {
      for (let k = 0; k < cBC.length - 1; k++) pushBotTri(a, cBC[k], cBC[k + 1]);
    } else if (!cAB && !cBC && cCA) {
      for (let k = 0; k < cCA.length - 1; k++) pushBotTri(b, cCA[k], cCA[k + 1]);
    } else {
      const pts = cAB ? cAB.slice(0, -1) : [a];
      if (cBC) pts.push(...cBC.slice(0, -1));
      else pts.push(b);
      if (cCA) pts.push(...cCA.slice(0, -1));
      else pts.push(c);
      for (let k = 1; k < pts.length - 1; k++) {
        pushBotTri(pts[0], pts[k], pts[k + 1]);
      }
    }
  }

  // 6. Compute smooth vertex normals
  const posArr = new Float32Array(positions);
  const colArr = new Float32Array(colors);
  const idxArr = new Uint32Array(indices);
  const normArr = new Float32Array(posArr.length);

  for (let i = 0; i < idxArr.length; i += 3) {
    const ia = idxArr[i] * 3;
    const ib = idxArr[i + 1] * 3;
    const ic = idxArr[i + 2] * 3;
    const abx = posArr[ib] - posArr[ia];
    const aby = posArr[ib + 1] - posArr[ia + 1];
    const abz = posArr[ib + 2] - posArr[ia + 2];
    const acx = posArr[ic] - posArr[ia];
    const acy = posArr[ic + 1] - posArr[ia + 1];
    const acz = posArr[ic + 2] - posArr[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    normArr[ia] += nx;
    normArr[ia + 1] += ny;
    normArr[ia + 2] += nz;
    normArr[ib] += nx;
    normArr[ib + 1] += ny;
    normArr[ib + 2] += nz;
    normArr[ic] += nx;
    normArr[ic + 1] += ny;
    normArr[ic + 2] += nz;
  }

  for (let i = 0; i < normArr.length; i += 3) {
    const len = Math.hypot(normArr[i], normArr[i + 1], normArr[i + 2]) || 1;
    normArr[i] /= len;
    normArr[i + 1] /= len;
    normArr[i + 2] /= len;
  }

  // 7. Build optional Water / Road / Forest / Alpine modifier sub-meshes for 3MF multi-color & tactile slicer textures
  const waterModPos: number[] = [];
  const waterModIdx: number[] = [];
  const roadModPos: number[] = [];
  const roadModIdx: number[] = [];
  const forestModPos: number[] = [];
  const forestModIdx: number[] = [];
  const alpineModPos: number[] = [];
  const alpineModIdx: number[] = [];

  if (config.exportFormat !== 'stl') {
    postProgress(req.tileId, req.label, 'Building 3MF ironing & texture modifiers', 0.8);
    const buildClosedModifierSlab = (
      targetZone: number,
      outPos: number[],
      outIdx: number[]
    ) => {
      const zoneTris: Array<[number, number, number]> = [];
      for (let t = 0; t < triangleZones.length; t++) {
        if (triangleZones[t] === targetZone) {
          zoneTris.push([idxArr[t * 3], idxArr[t * 3 + 1], idxArr[t * 3 + 2]]);
        }
      }
      if (zoneTris.length === 0) return;

      // Split any non-manifold pinch vertices (where 2+ disconnected fans touch at 1 vertex)
      const vertToTris = new Map<number, number[]>();
      for (let ti = 0; ti < zoneTris.length; ti++) {
        const [a, b, c] = zoneTris[ti];
        for (const v of [a, b, c]) {
          let list = vertToTris.get(v);
          if (!list) {
            list = [];
            vertToTris.set(v, list);
          }
          list.push(ti);
        }
      }

      const virtualCoords = new Map<number, [number, number, number]>();
      let nextVirtualId = posArr.length / 3;

      for (const [s, incTris] of vertToTris) {
        if (incTris.length <= 1) continue;
        // Partition incTris into edge-connected fans around vertex s
        const visited = new Uint8Array(incTris.length);
        const fans: number[][] = [];
        for (let i = 0; i < incTris.length; i++) {
          if (visited[i]) continue;
          visited[i] = 1;
          const fan = [incTris[i]];
          const queue = [i];
          while (queue.length > 0) {
            const curIdx = queue.pop()!;
            const curTri = zoneTris[incTris[curIdx]];
            const curOthers = curTri.filter((v) => v !== s);
            for (let j = 0; j < incTris.length; j++) {
              if (visited[j]) continue;
              const candTri = zoneTris[incTris[j]];
              if (candTri.includes(curOthers[0]) || candTri.includes(curOthers[1])) {
                visited[j] = 1;
                fan.push(incTris[j]);
                queue.push(j);
              }
            }
          }
          fans.push(fan);
        }

        if (fans.length > 1) {
          const sx = posArr[s * 3];
          const sy = posArr[s * 3 + 1];
          const sz = posArr[s * 3 + 2];
          for (const fan of fans) {
            let cx = 0;
            let cy = 0;
            let cnt = 0;
            for (const ti of fan) {
              for (const v of zoneTris[ti]) {
                if (v !== s) {
                  const coords = virtualCoords.get(v);
                  cx += coords ? coords[0] : posArr[v * 3];
                  cy += coords ? coords[1] : posArr[v * 3 + 1];
                  cnt++;
                }
              }
            }
            const dx = cnt > 0 ? cx / cnt - sx : 0;
            const dy = cnt > 0 ? cy / cnt - sy : 0;
            const dlen = Math.hypot(dx, dy) || 1;
            const vid = nextVirtualId++;
            virtualCoords.set(vid, [sx + (dx / dlen) * 0.002, sy + (dy / dlen) * 0.002, sz]);
            for (const ti of fan) {
              const tri = zoneTris[ti];
              if (tri[0] === s) tri[0] = vid;
              if (tri[1] === s) tri[1] = vid;
              if (tri[2] === s) tri[2] = vid;
            }
          }
        }
      }

      const getXYZ = (s: number): [number, number, number] => {
        const vc = virtualCoords.get(s);
        if (vc) return vc;
        return [posArr[s * 3], posArr[s * 3 + 1], posArr[s * 3 + 2]];
      };

      const topMap = new Map<number, number>();
      const botMap = new Map<number, number>();
      const edgeCounts = new Map<string, [number, number]>();

      const getTop = (s: number) => {
        const hit = topMap.get(s);
        if (hit !== undefined) return hit;
        const n = outPos.length / 3;
        const [x, y, z] = getXYZ(s);
        outPos.push(x, y, z + 0.45);
        topMap.set(s, n);
        return n;
      };
      const getBot = (s: number) => {
        const hit = botMap.get(s);
        if (hit !== undefined) return hit;
        const n = outPos.length / 3;
        const [x, y, z] = getXYZ(s);
        outPos.push(x, y, Math.max(0, z - 0.75));
        botMap.set(s, n);
        return n;
      };
      const countEdge = (u: number, v: number) => {
        const revKey = `${v}:${u}`;
        if (edgeCounts.has(revKey)) {
          edgeCounts.delete(revKey);
        } else {
          edgeCounts.set(`${u}:${v}`, [u, v]);
        }
      };

      for (const [a, b, c] of zoneTris) {
        // Top cap (CCW)
        outIdx.push(getTop(a), getTop(b), getTop(c));
        // Bottom cap (CW)
        outIdx.push(getBot(a), getBot(c), getBot(b));
        countEdge(a, b);
        countEdge(b, c);
        countEdge(c, a);
      }

      // Extrude outer boundary walls
      for (const [u, v] of edgeCounts.values()) {
        const tu = getTop(u);
        const tv = getTop(v);
        const bu = getBot(u);
        const bv = getBot(v);
        outIdx.push(tu, bu, bv, tu, bv, tv);
      }
    };

    buildClosedModifierSlab(1, waterModPos, waterModIdx);
    buildClosedModifierSlab(3, roadModPos, roadModIdx);
    buildClosedModifierSlab(2, forestModPos, forestModIdx);
    buildClosedModifierSlab(4, alpineModPos, alpineModIdx);
  }

  let minElevM = Infinity;
  let maxElevM = -Infinity;
  for (let i = 0; i < req.elevations.length; i++) {
    const e = req.elevations[i];
    if (e < minElevM) minElevM = e;
    if (e > maxElevM) maxElevM = e;
  }

  return {
    tileId: req.tileId,
    label: req.label,
    centerMmX: req.centerMmX,
    centerMmY: req.centerMmY,
    positions: posArr,
    normals: normArr,
    colors: colArr,
    triangleZones: new Uint8Array(triangleZones),
    indices: idxArr,
    waterModifierPositions: waterModPos.length > 0 ? new Float32Array(waterModPos) : undefined,
    waterModifierIndices: waterModIdx.length > 0 ? new Uint32Array(waterModIdx) : undefined,
    roadModifierPositions: roadModPos.length > 0 ? new Float32Array(roadModPos) : undefined,
    roadModifierIndices: roadModIdx.length > 0 ? new Uint32Array(roadModIdx) : undefined,
    forestModifierPositions: forestModPos.length > 0 ? new Float32Array(forestModPos) : undefined,
    forestModifierIndices: forestModIdx.length > 0 ? new Uint32Array(forestModIdx) : undefined,
    alpineModifierPositions: alpineModPos.length > 0 ? new Float32Array(alpineModPos) : undefined,
    alpineModifierIndices: alpineModIdx.length > 0 ? new Uint32Array(alpineModIdx) : undefined,
    minElevM,
    maxElevM,
    triangleCount: idxArr.length / 3,
    buildTimeMs: Math.round(performance.now() - t0),
  };
}

self.onmessage = (ev: MessageEvent<MeshTileRequest>) => {
  const mesh = buildTileMesh(ev.data);
  const transfers: Transferable[] = [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.colors.buffer,
    mesh.triangleZones.buffer,
    mesh.indices.buffer,
  ];
  if (mesh.waterModifierPositions) transfers.push(mesh.waterModifierPositions.buffer);
  if (mesh.waterModifierIndices) transfers.push(mesh.waterModifierIndices.buffer);
  if (mesh.roadModifierPositions) transfers.push(mesh.roadModifierPositions.buffer);
  if (mesh.roadModifierIndices) transfers.push(mesh.roadModifierIndices.buffer);
  if (mesh.forestModifierPositions) transfers.push(mesh.forestModifierPositions.buffer);
  if (mesh.forestModifierIndices) transfers.push(mesh.forestModifierIndices.buffer);
  if (mesh.alpineModifierPositions) transfers.push(mesh.alpineModifierPositions.buffer);
  if (mesh.alpineModifierIndices) transfers.push(mesh.alpineModifierIndices.buffer);

  const out: WorkerOutMessage = { type: 'done', mesh };
  (self as unknown as Worker).postMessage(out, transfers);
};
