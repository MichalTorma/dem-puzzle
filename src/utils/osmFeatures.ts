import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { FeatureMasks, ScaleProfile } from '../types';
import { lngLatToTileXY } from './dem';
import { localMetersToLngLat } from './grid';

export interface OsmElement {
  kind: 'water' | 'waterway' | 'forest' | 'road' | 'building';
  roadClass?: string;
  rings: Array<Array<{ lat: number; lon: number }>>;
}

let tileUrlTemplatePromise: Promise<string> | null = null;
const mvtTileCache = new Map<string, Promise<OsmElement[]>>();

async function getOpenFreeMapTileTemplate(): Promise<string> {
  if (!tileUrlTemplatePromise) {
    tileUrlTemplatePromise = (async () => {
      const resp = await fetch('https://tiles.openfreemap.org/planet');
      if (!resp.ok) throw new Error(`TileJSON HTTP ${resp.status}`);
      const json = (await resp.json()) as { tiles?: string[] };
      if (!json.tiles?.[0]) throw new Error('Missing tiles array in OpenFreeMap TileJSON');
      return json.tiles[0];
    })();
  }
  return tileUrlTemplatePromise;
}

function mvtPointToLngLat(
  z: number,
  tx: number,
  ty: number,
  px: number,
  py: number,
  extent: number
): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = ((tx + px / extent) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lon, lat };
}

function decodeMvtLayer(
  tile: VectorTile,
  layerName: string,
  z: number,
  tx: number,
  ty: number,
  out: OsmElement[],
  mapper: (props: Record<string, unknown>) => {
    kind: OsmElement['kind'];
    roadClass?: string;
  } | null
) {
  const layer = tile.layers[layerName];
  if (!layer) return;

  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i);
    const mapped = mapper(feat.properties as Record<string, unknown>);
    if (!mapped) continue;

    const geom = feat.loadGeometry();
    const rings = geom
      .filter((ring) => ring.length >= 2)
      .map((ring) =>
        ring.map((pt) => mvtPointToLngLat(z, tx, ty, pt.x, pt.y, layer.extent))
      );
    if (rings.length > 0) {
      out.push({
        kind: mapped.kind,
        roadClass: mapped.roadClass,
        rings,
      });
    }
  }
}

async function fetchMvtTileElements(
  template: string,
  z: number,
  x: number,
  y: number,
  onTileDone?: (key: string, fromCache: boolean, bytes: number) => void
): Promise<OsmElement[]> {
  const n = 2 ** z;
  const wx = ((x % n) + n) % n;
  const cy = Math.max(0, Math.min(n - 1, y));
  const key = `${z}/${wx}/${cy}`;

  const existing = mvtTileCache.get(key);
  if (existing) {
    const els = await existing;
    onTileDone?.(key, true, 0);
    return els;
  }

  const promise = (async () => {
    const url = template
      .replace('{z}', String(z))
      .replace('{x}', String(wx))
      .replace('{y}', String(cy));
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const buf = await resp.arrayBuffer();
    const vt = new VectorTile(
      new PbfReader(buf) as unknown as ConstructorParameters<typeof VectorTile>[0]
    );
    const els: OsmElement[] = [];

    decodeMvtLayer(vt, 'water', z, wx, cy, els, () => ({ kind: 'water' }));
    decodeMvtLayer(vt, 'waterway', z, wx, cy, els, (p) => {
      const cls = String(p.class ?? '');
      if (cls === 'river' || cls === 'canal' || cls === 'stream') {
        return { kind: 'waterway' };
      }
      return null;
    });
    decodeMvtLayer(vt, 'landcover', z, wx, cy, els, (p) =>
      p.class === 'wood' ? { kind: 'forest' } : null
    );
    decodeMvtLayer(vt, 'landuse', z, wx, cy, els, (p) =>
      p.class === 'forest' || p.class === 'park' ? { kind: 'forest' } : null
    );
    decodeMvtLayer(vt, 'park', z, wx, cy, els, () => ({ kind: 'forest' }));
    decodeMvtLayer(vt, 'transportation', z, wx, cy, els, (p) => {
      const cls = String(p.class ?? '');
      if (!cls || cls === 'path' || cls === 'track' || cls === 'ferry') return null;
      return { kind: 'road', roadClass: cls };
    });
    decodeMvtLayer(vt, 'building', z, wx, cy, els, () => ({ kind: 'building' }));

    onTileDone?.(key, false, buf.byteLength);
    return els;
  })();

  mvtTileCache.set(key, promise);
  return promise;
}

/**
 * Fetches scale-appropriate OSM vector features from OpenFreeMap's Cloudflare CDN MVT tiles
 * (zero rate-limits, zero 502s, cached in browser & PWA).
 */
export async function prefetchOsmRegion(
  south: number,
  west: number,
  north: number,
  east: number,
  profile: ScaleProfile,
  onStatus?: (detail: string) => void
): Promise<OsmElement[]> {
  const vZoom =
    profile.tier === 'urban'
      ? 14
      : profile.tier === 'town'
        ? 12
        : profile.tier === 'regional'
          ? 10
          : 8;

  const nw = lngLatToTileXY(west, north, vZoom);
  const se = lngLatToTileXY(east, south, vZoom);
  const xMin = Math.floor(nw.x);
  const xMax = Math.floor(se.x);
  const yMin = Math.floor(nw.y);
  const yMax = Math.floor(se.y);

  const coords: Array<{ x: number; y: number }> = [];
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      coords.push({ x, y });
    }
  }

  onStatus?.(`Resolving OpenFreeMap CDN vector tiles (z${vZoom}, ${coords.length} tiles)...`);
  let template: string;
  try {
    template = await getOpenFreeMapTileTemplate();
  } catch {
    onStatus?.('OpenFreeMap TileJSON unreachable — continuing with elevation-only relief');
    return [];
  }

  let done = 0;
  let totalBytes = 0;
  const perTile = await Promise.all(
    coords.map(({ x, y }) =>
      fetchMvtTileElements(template, vZoom, x, y, (key, fromCache, bytes) => {
        done++;
        totalBytes += bytes;
        const kb = Math.round(totalBytes / 1024);
        onStatus?.(
          `${fromCache ? 'Cached' : 'Loaded'} vector tile ${key} (${done}/${coords.length}${kb > 0 ? `, ${kb} KB` : ''})`
        );
      })
    )
  );

  const merged = perTile.flat();
  onStatus?.(
    `Decoded ${merged.length.toLocaleString()} OpenFreeMap features across ${coords.length} vector tiles`
  );
  return merged;
}

/**
 * Rasterizes scale-appropriate OpenFreeMap features into local tile masks.
 * All features are clamped to nozzle-safe widths (>= 0.85 mm on the physical print).
 */
export function rasterizeTileFeatureMasks(params: {
  elements: OsmElement[];
  anchorLng: number;
  anchorLat: number;
  gridRotationDeg: number;
  tileCenterMmX: number;
  tileCenterMmY: number;
  tilePrintSizeMm: number;
  tileRealSizeKm: number;
  halfSpanMm: number;
  gridSize: number;
  profile: ScaleProfile;
}): FeatureMasks {
  const {
    elements,
    anchorLng,
    anchorLat,
    gridRotationDeg,
    tileCenterMmX,
    tileCenterMmY,
    tilePrintSizeMm,
    tileRealSizeKm,
    halfSpanMm,
    gridSize,
    profile,
  } = params;

  const metersPerMm = (tileRealSizeKm * 1000) / tilePrintSizeMm;

  const waterCanvas = new OffscreenCanvas(gridSize, gridSize);
  const forestCanvas = new OffscreenCanvas(gridSize, gridSize);
  const roadCanvas = new OffscreenCanvas(gridSize, gridSize);
  const buildingCanvas = new OffscreenCanvas(gridSize, gridSize);

  const wCtx = waterCanvas.getContext('2d')!;
  const fCtx = forestCanvas.getContext('2d')!;
  const rCtx = roadCanvas.getContext('2d')!;
  const bCtx = buildingCanvas.getContext('2d')!;

  const rad = (-gridRotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const mPerDegLng = 111320 * Math.max(0.15, Math.cos((anchorLat * Math.PI) / 180));

  const projectToGrid = (lng: number, lat: number): [number, number] => {
    const rx = (lng - anchorLng) * mPerDegLng;
    const ry = (lat - anchorLat) * 111320;
    const dxM = rx * cosR - ry * sinR;
    const dyM = rx * sinR + ry * cosR;
    const localXmm = dxM / metersPerMm - tileCenterMmX;
    const localYmm = dyM / metersPerMm - tileCenterMmY;
    const px = ((localXmm + halfSpanMm) / (halfSpanMm * 2)) * (gridSize - 1);
    const py = ((localYmm + halfSpanMm) / (halfSpanMm * 2)) * (gridSize - 1);
    return [px, py];
  };

  // Nozzle-safe line width: at least 0.85 mm in physical print space
  const pxPerMm = (gridSize - 1) / (halfSpanMm * 2);
  const minNozzlePx = Math.max(1.2, 0.85 * pxPerMm);

  const drawPath = (
    ctx: OffscreenCanvasRenderingContext2D,
    pts: Array<{ lat: number; lon: number }>,
    fill: boolean,
    lineWidthPx = minNozzlePx
  ) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    const [sx, sy] = projectToGrid(pts[0].lon, pts[0].lat);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = projectToGrid(pts[i].lon, pts[i].lat);
      ctx.lineTo(px, py);
    }
    if (fill) {
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    } else {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lineWidthPx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  };

  const allowedRoadSet = new Set(profile.includedRoads);
  if (allowedRoadSet.has('residential')) {
    allowedRoadSet.add('minor');
  }

  for (const el of elements) {
    if (el.kind === 'water') {
      for (const r of el.rings) drawPath(wCtx, r, true);
    } else if (el.kind === 'waterway') {
      for (const r of el.rings) drawPath(wCtx, r, false, minNozzlePx * 1.25);
    } else if (el.kind === 'forest' && profile.includeForests) {
      for (const r of el.rings) drawPath(fCtx, r, true);
    } else if (el.kind === 'road' && el.roadClass && allowedRoadSet.has(el.roadClass)) {
      const wMul = el.roadClass === 'motorway' || el.roadClass === 'trunk' ? 1.45 : 1.0;
      for (const r of el.rings) drawPath(rCtx, r, false, minNozzlePx * wMul);
    } else if (el.kind === 'building' && profile.includeBuildings) {
      for (const r of el.rings) drawPath(bCtx, r, true);
    }
  }

  const extractChannel = (ctx: OffscreenCanvasRenderingContext2D): Float32Array => {
    const d = ctx.getImageData(0, 0, gridSize, gridSize).data;
    const out = new Float32Array(gridSize * gridSize);
    for (let i = 0; i < gridSize * gridSize; i++) {
      out[i] = d[i * 4] / 255;
    }
    return out;
  };

  return {
    size: gridSize,
    water: extractChannel(wCtx),
    forest: extractChannel(fCtx),
    road: extractChannel(rCtx),
    building: extractChannel(bCtx),
  };
}

export function computeTilesUnionBbox(params: {
  tiles: Array<{ centerMmX: number; centerMmY: number }>;
  anchorLng: number;
  anchorLat: number;
  gridRotationDeg: number;
  tilePrintSizeMm: number;
  tileRealSizeKm: number;
  halfSpanMm: number;
}): { south: number; west: number; north: number; east: number } {
  const {
    tiles,
    anchorLng,
    anchorLat,
    gridRotationDeg,
    tilePrintSizeMm,
    tileRealSizeKm,
    halfSpanMm,
  } = params;
  const metersPerMm = (tileRealSizeKm * 1000) / tilePrintSizeMm;
  const corners: [number, number][] = [
    [-halfSpanMm, -halfSpanMm],
    [halfSpanMm, -halfSpanMm],
    [halfSpanMm, halfSpanMm],
    [-halfSpanMm, halfSpanMm],
  ];

  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;

  for (const t of tiles) {
    for (const [lx, ly] of corners) {
      const [lng, lat] = localMetersToLngLat(
        (t.centerMmX + lx) * metersPerMm,
        (t.centerMmY + ly) * metersPerMm,
        anchorLng,
        anchorLat,
        gridRotationDeg
      );
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lng);
      east = Math.max(east, lng);
    }
  }

  return { south, west, north, east };
}
