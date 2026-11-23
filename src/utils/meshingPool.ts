import type { GeneratedTileMesh, PuzzleConfig, ScaleProfile, TileSpec } from '../types';
import { sampleTileHeightfield } from './dem';
import {
  computeTilesUnionBbox,
  prefetchOsmRegion,
  rasterizeTileFeatureMasks,
} from './osmFeatures';
import type { MeshTileRequest, WorkerOutMessage } from '../workers/tileMesher.worker';

export interface GenerationProgress {
  stage: 'dem' | 'features' | 'meshing';
  overallPct: number;
  completed: number;
  total: number;
  detail: string;
  logs: string[];
}

function runWorkerPool(
  requests: MeshTileRequest[],
  onWorkerProgress: (tileId: string, label: string, step: string, pct: number) => void,
  onTileDone: (mesh: GeneratedTileMesh) => void
): Promise<GeneratedTileMesh[]> {
  const concurrency = Math.max(1, Math.min(requests.length, Math.min(8, navigator.hardwareConcurrency || 4)));
  const results = new Array<GeneratedTileMesh>(requests.length);
  let nextIdx = 0;

  const runWorker = () =>
    new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('../workers/tileMesher.worker.ts', import.meta.url), {
        type: 'module',
      });

      const dispatchNext = () => {
        if (nextIdx >= requests.length) {
          worker.terminate();
          resolve();
          return;
        }
        const idx = nextIdx++;
        const req = requests[idx];
        const transfers: Transferable[] = [
          req.elevations.buffer,
          req.masks.water.buffer,
          req.masks.forest.buffer,
          req.masks.road.buffer,
          req.masks.building.buffer,
        ];

        worker.onmessage = (ev: MessageEvent<WorkerOutMessage>) => {
          const msg = ev.data;
          if (msg.type === 'progress') {
            onWorkerProgress(msg.tileId, msg.label, msg.step, msg.pct);
            return;
          }
          results[idx] = msg.mesh;
          onTileDone(msg.mesh);
          dispatchNext();
        };
        worker.onerror = (err) => {
          worker.terminate();
          reject(err);
        };

        worker.postMessage(req, transfers);
      };

      dispatchNext();
    });

  return Promise.all(Array.from({ length: concurrency }, () => runWorker())).then(() => results);
}

export async function generatePuzzleMeshes(params: {
  tiles: TileSpec[];
  anchorLng: number;
  anchorLat: number;
  config: PuzzleConfig;
  profile: ScaleProfile;
  onProgress?: (p: GenerationProgress) => void;
}): Promise<GeneratedTileMesh[]> {
  const { tiles, anchorLng, anchorLat, config, profile, onProgress } = params;
  if (tiles.length === 0) return [];

  const tStart = performance.now();
  const logs: string[] = [];
  const pushLog = (line: string) => {
    const elapsed = ((performance.now() - tStart) / 1000).toFixed(1);
    logs.push(`[${elapsed}s] ${line}`);
    if (logs.length > 6) logs.shift();
  };

  const emit = (
    stage: GenerationProgress['stage'],
    overallPct: number,
    completed: number,
    total: number,
    detail: string,
    logLine?: string
  ) => {
    if (logLine) pushLog(logLine);
    onProgress?.({
      stage,
      overallPct: Math.max(0, Math.min(100, Math.round(overallPct))),
      completed,
      total,
      detail,
      logs: [...logs],
    });
  };

  // Half-span in mm includes generous margin for full-height jigsaw tabs
  const edgeLenMm =
    config.shape === 'hex' ? config.tilePrintSizeMm / Math.sqrt(3) : config.tilePrintSizeMm;
  const maxRadiusMm =
    config.shape === 'hex'
      ? config.tilePrintSizeMm / Math.sqrt(3)
      : (config.tilePrintSizeMm * Math.SQRT2) / 2;
  const tabMarginMm = edgeLenMm * config.tabSizeRatio + 4;
  const halfSpanMm = maxRadiusMm + tabMarginMm;
  const gridSize = config.resolution;

  // 1. Fetch DEM heightfields (0% -> 35%)
  let demTilesLoaded = 0;
  let demSamplesDone = 0;
  emit(
    'dem',
    2,
    0,
    tiles.length,
    `Fetching AWS Terrarium DEM (z${profile.recommendedDemZoom})...`,
    `Starting DEM elevation fetch at zoom ${profile.recommendedDemZoom}`
  );

  const heightfields = await Promise.all(
    tiles.map(async (tile) => {
      const hf = await sampleTileHeightfield({
        anchorLng,
        anchorLat,
        gridRotationDeg: config.gridRotationDeg,
        tileCenterMmX: tile.centerMmX,
        tileCenterMmY: tile.centerMmY,
        tilePrintSizeMm: config.tilePrintSizeMm,
        tileRealSizeKm: config.tileRealSizeKm,
        halfSpanMm,
        gridSize,
        demZoom: profile.recommendedDemZoom,
        onDemTileLoaded: (key, fromCache) => {
          demTilesLoaded++;
          const pct = 2 + (demSamplesDone / tiles.length) * 33;
          emit(
            'dem',
            pct,
            demSamplesDone,
            tiles.length,
            `${fromCache ? 'Cached' : 'Downloaded'} DEM tile ${key} (${demTilesLoaded} fetched)`
          );
        },
      });
      demSamplesDone++;
      const pct = 2 + (demSamplesDone / tiles.length) * 33;
      emit(
        'dem',
        pct,
        demSamplesDone,
        tiles.length,
        `Sampled elevation for tile ${tile.label} (${demSamplesDone}/${tiles.length})`,
        `Sampled heightfield ${tile.label} (${Math.round(hf.minElevM)}m–${Math.round(hf.maxElevM)}m)`
      );
      return hf;
    })
  );

  let globalMinElevM = Infinity;
  let globalMaxElevM = -Infinity;
  for (const hf of heightfields) {
    if (hf.minElevM < globalMinElevM) globalMinElevM = hf.minElevM;
    if (hf.maxElevM > globalMaxElevM) globalMaxElevM = hf.maxElevM;
  }

  // 2. Fetch scale-filtered OSM features ONCE for the region (35% -> 65%)
  emit(
    'features',
    36,
    0,
    tiles.length,
    'Querying OpenStreetMap features for selected region...',
    `Querying OSM features (${profile.label} scale filter)`
  );
  const bbox = computeTilesUnionBbox({
    tiles,
    anchorLng,
    anchorLat,
    gridRotationDeg: config.gridRotationDeg,
    tilePrintSizeMm: config.tilePrintSizeMm,
    tileRealSizeKm: config.tileRealSizeKm,
    halfSpanMm,
  });

  let lastOsmStatus = '';
  const osmElements = await prefetchOsmRegion(
    bbox.south,
    bbox.west,
    bbox.north,
    bbox.east,
    profile,
    (detail) => {
      const logChanged = detail !== lastOsmStatus && !detail.startsWith('Downloading OSM');
      lastOsmStatus = detail;
      emit('features', 46, 0, tiles.length, detail, logChanged ? detail : undefined);
    }
  );

  // Rasterize masks in small chunks and yield to keep UI at 60fps
  const masksList = new Array<ReturnType<typeof rasterizeTileFeatureMasks>>(tiles.length);
  for (let idx = 0; idx < tiles.length; idx++) {
    const tile = tiles[idx];
    masksList[idx] = rasterizeTileFeatureMasks({
      elements: osmElements,
      anchorLng,
      anchorLat,
      gridRotationDeg: config.gridRotationDeg,
      tileCenterMmX: tile.centerMmX,
      tileCenterMmY: tile.centerMmY,
      tilePrintSizeMm: config.tilePrintSizeMm,
      tileRealSizeKm: config.tileRealSizeKm,
      halfSpanMm,
      gridSize,
      profile,
    });
    const pct = 52 + ((idx + 1) / tiles.length) * 13;
    emit(
      'features',
      pct,
      idx + 1,
      tiles.length,
      `Rasterized water/forest/road masks for ${tile.label} (${idx + 1}/${tiles.length})`
    );
    if ((idx + 1) % 2 === 0 && idx + 1 < tiles.length) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  pushLog(`Rasterized masks for ${tiles.length} tiles`);

  // 3. Mesh tiles in parallel Web Workers (65% -> 100%)
  let meshDone = 0;
  const workerProgress = new Map<string, number>();
  const poolCount = Math.min(tiles.length, Math.min(8, navigator.hardwareConcurrency || 4));
  emit(
    'meshing',
    65,
    0,
    tiles.length,
    `Running ${poolCount}-worker pool for ${tiles.length} watertight jigsaw tiles...`,
    `Meshing ${tiles.length} jigsaw tiles across ${poolCount} pooled workers`
  );

  const calcMeshingPct = () => {
    let sum = 0;
    for (const t of tiles) {
      sum += workerProgress.get(t.id) ?? 0;
    }
    return 65 + (sum / tiles.length) * 35;
  };

  const requests: MeshTileRequest[] = tiles.map((tile, i) => ({
    tileId: tile.id,
    label: tile.label,
    centerMmX: tile.centerMmX,
    centerMmY: tile.centerMmY,
    edgeTypes: tile.edgeTypes,
    edgeSeeds: tile.edgeSeeds,
    config,
    halfSpanMm,
    elevations: heightfields[i].elevations,
    globalMinElevM,
    globalMaxElevM,
    masks: masksList[i],
  }));

  const meshes = await runWorkerPool(
    requests,
    (tileId, label, step, pct) => {
      workerProgress.set(tileId, pct);
      emit('meshing', calcMeshingPct(), meshDone, tiles.length, `Tile ${label}: ${step}`);
    },
    (mesh) => {
      workerProgress.set(mesh.tileId, 1);
      meshDone++;
      emit(
        'meshing',
        calcMeshingPct(),
        meshDone,
        tiles.length,
        `Finished tile ${mesh.label} (${mesh.triangleCount.toLocaleString()} tris in ${mesh.buildTimeMs} ms)`,
        `Built tile ${mesh.label}: ${mesh.triangleCount.toLocaleString()} tris (${mesh.buildTimeMs} ms)`
      );
    }
  );

  return meshes;
}

/**
 * Generates a fast 6-tile (3 interlocking pairs) calibration set testing
 * 0.12 mm (tight), 0.20 mm (standard), and 0.28 mm (loose) jigsaw clearances
 * while showcasing every surface texture & slicer modifier:
 *  - Pair 1 (0.12 mm): Glass-ironed water pad + concentric road strip + valley contours
 *  - Pair 2 (0.20 mm): Organic forest canopy domes (Hilbert top-fill) + smooth valley
 *  - Pair 3 (0.28 mm): Alpine rock strata + snow sastrugi (Fuzzy skin modifier)
 */
export async function generateCalibrationMeshes(config: PuzzleConfig): Promise<GeneratedTileMesh[]> {
  const clearances = [
    { code: '012', mm: 0.12, mode: 'water_road' as const },
    { code: '020', mm: 0.2, mode: 'forest_valley' as const },
    { code: '028', mm: 0.28, mode: 'alpine_peak' as const },
  ];
  const testSizeMm = Math.min(28, Math.max(22, config.tilePrintSizeMm));
  const halfSpanMm = testSizeMm * (0.52 + config.tabSizeRatio * 1.15);
  const demSize = 80;
  const nEdges = config.shape === 'hex' ? 6 : 4;
  const requests: MeshTileRequest[] = [];

  const makeSyntheticFields = (mode: 'water_road' | 'forest_valley' | 'alpine_peak') => {
    const elevations = new Float32Array(demSize * demSize);
    const water = new Float32Array(demSize * demSize);
    const forest = new Float32Array(demSize * demSize);
    const road = new Float32Array(demSize * demSize);
    const building = new Float32Array(demSize * demSize);

    for (let r = 0; r < demSize; r++) {
      const ny = r / (demSize - 1);
      for (let c = 0; c < demSize; c++) {
        const nx = c / (demSize - 1);
        const idx = r * demSize + c;

        if (mode === 'water_road') {
          // Flat water pad in lower-left quadrant (for ironing check), gentle valley ramp + road
          if (nx < 0.45 && ny < 0.45) {
            elevations[idx] = 100;
            water[idx] = 1;
          } else {
            elevations[idx] = 115 + (nx * 0.55 + ny * 0.45) * 60;
            if (Math.abs(ny - 0.65) < 0.055) road[idx] = 1;
          }
        } else if (mode === 'forest_valley') {
          // Rolling valley with dense forest canopy on upper/right half & contour meadow on lower/left
          const hill = Math.sin(nx * Math.PI) * Math.sin(ny * Math.PI) * 38;
          elevations[idx] = 110 + (nx * 0.4 + ny * 0.6) * 45 + hill;
          const forestMask = Math.max(0, Math.min(1, (nx + ny - 0.82) * 3.2));
          forest[idx] = forestMask;
        } else {
          // Steep alpine ridge spanning rock strata (0.52..0.78) and snow peak (>0.78)
          const ridge = Math.exp(-((nx - 0.52) ** 2 / 0.14 + (ny - 0.52) ** 2 / 0.18));
          elevations[idx] = 135 + ridge * 125;
        }
      }
    }
    return { elevations, masks: { size: demSize, water, forest, road, building } };
  };

  clearances.forEach((entry, pairIdx) => {
    const rowY = (pairIdx - 1) * testSizeMm * 1.15;
    const pairConfigs: Array<{ role: 'TAB' | 'SLOT'; xOffset: number; edgeType: 'tab' | 'blank' }> = [
      { role: 'TAB', xOffset: -testSizeMm * 0.65, edgeType: 'tab' },
      { role: 'SLOT', xOffset: testSizeMm * 0.65, edgeType: 'blank' },
    ];

    for (const p of pairConfigs) {
      const { elevations, masks } = makeSyntheticFields(entry.mode);
      const edgeTypes = Array.from({ length: nEdges }, (_, i) => {
        if (config.shape === 'hex') {
          return (p.role === 'TAB' && i === 5) || (p.role === 'SLOT' && i === 2)
            ? p.edgeType
            : 'flat';
        }
        return (p.role === 'TAB' && i === 1) || (p.role === 'SLOT' && i === 3)
          ? p.edgeType
          : 'flat';
      });
      const edgeSeeds = Array.from({ length: nEdges }, () => ({
        uShift: 0,
        skew: 0,
        sizeScale: 1,
      }));
      const tileConfig: PuzzleConfig = {
        ...config,
        tilePrintSizeMm: testSizeMm,
        maxReliefMm: Math.min(Math.max(config.maxReliefMm, 7), 10),
        resolution: Math.max(72, Math.min(config.resolution, 88)),
        jigsawClearanceMm: entry.mm,
        forestTexture: true,
        elevationBands: true,
      };
      const label = `T${entry.code}_${p.role === 'TAB' ? 'A' : 'B'}`;
      requests.push({
        tileId: label,
        label,
        centerMmX: p.xOffset,
        centerMmY: rowY,
        edgeTypes,
        edgeSeeds,
        config: tileConfig,
        halfSpanMm,
        elevations,
        globalMinElevM: 100,
        globalMaxElevM: 260,
        masks,
      });
    }
  });

  return runWorkerPool(
    requests,
    () => {},
    () => {}
  );
}
