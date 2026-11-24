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
 * Generates a 2-tile hexagonal calibration set where every tab of CAL_TABS
 * fits every slot of CAL_SLOTS in all 36 combinations, using an extreme
 * high-undercut interlock to stress-test 6 jigsaw clearances in one print:
 *  - CAL_TABS: 6 nominal tabs (0.00 mm inset) + water zone, road, & forest canopy
 *  - CAL_SLOTS: 6 slots with 0.08 / 0.12 / 0.16 / 0.20 / 0.24 / 0.28 mm clearance
 *    (debossed on the underside as 08, 12, 16, 20, 24, 28) + alpine ridge & snow peak
 */
export async function generateCalibrationMeshes(config: PuzzleConfig): Promise<GeneratedTileMesh[]> {
  const slotClearancesMm = [0.08, 0.12, 0.16, 0.2, 0.24, 0.28];
  const slotEdgeLabels = ['08', '12', '16', '20', '24', '28'];
  const testSizeMm = Math.min(34, Math.max(28, config.tilePrintSizeMm));
  const tabSizeRatio = Math.max(config.tabSizeRatio, 0.28);
  const halfSpanMm = testSizeMm * (0.55 + tabSizeRatio * 1.15);
  const demSize = 84;
  const nEdges = 6;
  const requests: MeshTileRequest[] = [];

  const makeSyntheticFields = (mode: 'tabs_surface' | 'slots_alpine') => {
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

        if (mode === 'tabs_surface') {
          // Lower-left water zone, mid-upper road strip, & upper-right forest canopy
          if (nx < 0.44 && ny < 0.44) {
            elevations[idx] = 100;
            water[idx] = 1;
          } else {
            const hill = Math.sin(nx * Math.PI) * Math.sin(ny * Math.PI) * 28;
            elevations[idx] = 112 + (nx * 0.45 + ny * 0.55) * 48 + hill;
            if (Math.abs(ny - 0.62) < 0.05) road[idx] = 1;
            forest[idx] = Math.max(0, Math.min(1, (nx + ny - 0.92) * 3.2));
          }
        } else {
          // Steep alpine ridge spanning rock strata and snow peak
          const ridge = Math.exp(-((nx - 0.5) ** 2 / 0.13 + (ny - 0.5) ** 2 / 0.16));
          elevations[idx] = 130 + ridge * 130;
        }
      }
    }
    return { elevations, masks: { size: demSize, water, forest, road, building } };
  };

  const edgeSeeds = Array.from({ length: nEdges }, () => ({
    uShift: 0,
    skew: 0,
    sizeScale: 1,
    extremeInterlock: true,
  }));

  const tileConfig: PuzzleConfig = {
    ...config,
    shape: 'hex',
    tilePrintSizeMm: testSizeMm,
    tabSizeRatio,
    maxReliefMm: Math.min(Math.max(config.maxReliefMm, 8), 11),
    resolution: Math.max(76, Math.min(config.resolution, 92)),
    jigsawClearanceMm: 0.2,
    forestTexture: true,
    elevationBands: true,
  };

  const tabsField = makeSyntheticFields('tabs_surface');
  requests.push({
    tileId: 'CAL_TABS',
    label: 'CAL_TABS',
    centerMmX: -testSizeMm * 0.72,
    centerMmY: 0,
    edgeTypes: Array(nEdges).fill('tab'),
    edgeSeeds,
    edgeClearancesMm: Array(nEdges).fill(0),
    config: tileConfig,
    halfSpanMm,
    elevations: tabsField.elevations,
    globalMinElevM: 100,
    globalMaxElevM: 260,
    masks: tabsField.masks,
  });

  const slotsField = makeSyntheticFields('slots_alpine');
  requests.push({
    tileId: 'CAL_SLOTS',
    label: 'CAL_SLOTS',
    centerMmX: testSizeMm * 0.72,
    centerMmY: 0,
    edgeTypes: Array(nEdges).fill('blank'),
    edgeSeeds,
    edgeClearancesMm: slotClearancesMm,
    edgeLabels: slotEdgeLabels,
    config: tileConfig,
    halfSpanMm,
    elevations: slotsField.elevations,
    globalMinElevM: 100,
    globalMaxElevM: 260,
    masks: slotsField.masks,
  });

  return runWorkerPool(
    requests,
    () => {},
    () => {}
  );
}
