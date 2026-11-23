import { localMetersToLngLat } from './grid';

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

interface CachedTile {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const tileCache = new Map<string, Promise<CachedTile>>();

export function lngLatToTileXY(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = ((lng + 180) / 360) * n;
  const latRad = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

function fetchTerrariumTile(
  z: number,
  x: number,
  y: number,
  onStatus?: (key: string, fromCache: boolean) => void
): Promise<CachedTile> {
  const n = 2 ** z;
  const wrappedX = ((x % n) + n) % n;
  const clampedY = Math.max(0, Math.min(n - 1, y));
  const key = `${z}/${wrappedX}/${clampedY}`;

  const existing = tileCache.get(key);
  if (existing) {
    onStatus?.(key, true);
    return existing;
  }

  const promise = (async () => {
    const url = `${TERRARIUM_URL}/${z}/${wrappedX}/${clampedY}.png`;
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) {
      throw new Error(`DEM tile fetch failed (${resp.status}) for ${key}`);
    }
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    onStatus?.(key, false);
    return {
      width: imgData.width,
      height: imgData.height,
      data: imgData.data,
    };
  })();

  tileCache.set(key, promise);
  return promise;
}

function decodeTerrariumPixel(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

function sampleTileBilinear(tile: CachedTile, fx: number, fy: number): number {
  const x0 = Math.max(0, Math.min(tile.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(tile.height - 1, Math.floor(fy)));
  const x1 = Math.min(tile.width - 1, x0 + 1);
  const y1 = Math.min(tile.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const idx = (x: number, y: number) => (y * tile.width + x) * 4;
  const d = tile.data;

  const e00 = decodeTerrariumPixel(d[idx(x0, y0)], d[idx(x0, y0) + 1], d[idx(x0, y0) + 2]);
  const e10 = decodeTerrariumPixel(d[idx(x1, y0)], d[idx(x1, y0) + 1], d[idx(x1, y0) + 2]);
  const e01 = decodeTerrariumPixel(d[idx(x0, y1)], d[idx(x0, y1) + 1], d[idx(x0, y1) + 2]);
  const e11 = decodeTerrariumPixel(d[idx(x1, y1)], d[idx(x1, y1) + 1], d[idx(x1, y1) + 2]);

  const top = e00 * (1 - tx) + e10 * tx;
  const bot = e01 * (1 - tx) + e11 * tx;
  return top * (1 - ty) + bot * ty;
}

export interface HeightfieldSample {
  size: number;
  /** Half-span in mm around tile center (includes jigsaw tab margin) */
  halfSpanMm: number;
  elevations: Float32Array;
  minElevM: number;
  maxElevM: number;
}

/**
 * Samples an N x N heightfield in meters for a single puzzle tile's local mm frame.
 */
export async function sampleTileHeightfield(params: {
  anchorLng: number;
  anchorLat: number;
  gridRotationDeg: number;
  tileCenterMmX: number;
  tileCenterMmY: number;
  tilePrintSizeMm: number;
  tileRealSizeKm: number;
  halfSpanMm: number;
  gridSize: number;
  demZoom: number;
  onDemTileLoaded?: (key: string, fromCache: boolean) => void;
}): Promise<HeightfieldSample> {
  const {
    anchorLng,
    anchorLat,
    gridRotationDeg,
    tileCenterMmX,
    tileCenterMmY,
    tilePrintSizeMm,
    tileRealSizeKm,
    halfSpanMm,
    gridSize,
    demZoom,
    onDemTileLoaded,
  } = params;

  const metersPerMm = (tileRealSizeKm * 1000) / tilePrintSizeMm;
  const elevations = new Float32Array(gridSize * gridSize);

  // Precompute sample tile coords & collect needed tiles
  const needed = new Map<string, { x: number; y: number }>();
  const sampleCoords = new Float32Array(gridSize * gridSize * 2);

  for (let row = 0; row < gridSize; row++) {
    const localYmm = -halfSpanMm + (row / (gridSize - 1)) * (halfSpanMm * 2);
    const dyM = (tileCenterMmY + localYmm) * metersPerMm;

    for (let col = 0; col < gridSize; col++) {
      const localXmm = -halfSpanMm + (col / (gridSize - 1)) * (halfSpanMm * 2);
      const dxM = (tileCenterMmX + localXmm) * metersPerMm;

      const [lng, lat] = localMetersToLngLat(dxM, dyM, anchorLng, anchorLat, gridRotationDeg);
      const { x, y } = lngLatToTileXY(lng, lat, demZoom);
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      needed.set(`${tx},${ty}`, { x: tx, y: ty });

      const ptr = (row * gridSize + col) * 2;
      sampleCoords[ptr] = x;
      sampleCoords[ptr + 1] = y;
    }
  }

  const loaded = new Map<string, CachedTile>();
  await Promise.all(
    Array.from(needed.entries()).map(async ([k, { x, y }]) => {
      try {
        const tile = await fetchTerrariumTile(demZoom, x, y, onDemTileLoaded);
        loaded.set(k, tile);
      } catch {
        // Ignore individual missing tile; fallback to 0m
      }
    })
  );

  let minElevM = Infinity;
  let maxElevM = -Infinity;

  for (let i = 0; i < gridSize * gridSize; i++) {
    const x = sampleCoords[i * 2];
    const y = sampleCoords[i * 2 + 1];
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const tile = loaded.get(`${tx},${ty}`);
    let elev = 0;
    if (tile) {
      const fx = (x - tx) * tile.width;
      const fy = (y - ty) * tile.height;
      elev = sampleTileBilinear(tile, fx, fy);
    }
    elevations[i] = elev;
    if (elev < minElevM) minElevM = elev;
    if (elev > maxElevM) maxElevM = elev;
  }

  if (!Number.isFinite(minElevM)) minElevM = 0;
  if (!Number.isFinite(maxElevM)) maxElevM = 10;

  return { size: gridSize, halfSpanMm, elevations, minElevM, maxElevM };
}
