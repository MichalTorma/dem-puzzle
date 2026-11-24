export type GridShape = 'hex' | 'rect';
export type EdgeKind = 'tab' | 'blank' | 'flat';

export interface EdgeSeed {
  /** Shift of tab center along edge (-0.07..+0.07), negated on reversed neighbor edge */
  uShift: number;
  /** Subtle asymmetric lean (-0.015..+0.015), negated on reversed neighbor edge */
  skew: number;
  /** Scale multiplier for tab depth & width (0.86..1.14), identical on both neighbors */
  sizeScale: number;
  /** Narrower neck & wider bulb for high-sensitivity clearance calibration */
  extremeInterlock?: boolean;
}
export type ScaleTier = 'urban' | 'town' | 'regional' | 'continental';
export type WaterMode = 'color' | 'none';
export type RoadMode = 'color' | 'none';
export type ExportFormat = '3mf-both' | '3mf-orca' | '3mf-multipart' | 'stl';
export type PreviewMode = 'multicolor' | 'single' | 'clay';

export interface ScaleProfile {
  tier: ScaleTier;
  label: string;
  metersPerMm: number;
  scaleRatio: number;
  minPrintableMeters: number;
  includedRoads: string[];
  includeBuildings: boolean;
  includeWater: boolean;
  includeForests: boolean;
  recommendedDemZoom: number;
  summary: string;
}

export interface TileSpec {
  id: string;
  label: string;
  q: number;
  r: number;
  centerLng: number;
  centerLat: number;
  /** Local center offset in mm relative to grid origin */
  centerMmX: number;
  centerMmY: number;
  /** 2D footprint vertices in [lng, lat] for MapLibre overlay */
  polygonLngLat: [number, number][];
  /** Deterministic edge types (6 for hex, 4 for rect) */
  edgeTypes: EdgeKind[];
  /** Per-edge canonical seed for unique jigsaw fit */
  edgeSeeds: EdgeSeed[];
}

export interface PuzzleConfig {
  shape: GridShape;
  gridRadius: number;
  tilePrintSizeMm: number;
  tileRealSizeKm: number;
  gridRotationDeg: number;
  baseThicknessMm: number;
  maxReliefMm: number;
  zExaggeration: number;
  jigsawClearanceMm: number;
  tabSizeRatio: number;
  perimeterFlatEdges: boolean;
  resolution: number;
  waterMode: WaterMode;
  forestTexture: boolean;
  roadMode: RoadMode;
  contourSteps: number;
  elevationBands: boolean;
  undersideLabel: boolean;
  exportFormat: ExportFormat;
  previewMode: PreviewMode;
}

export interface FeatureMasks {
  /** Grid size N x N matching heightfield */
  size: number;
  /** 0..1 water coverage */
  water: Float32Array;
  /** 0..1 forest/park coverage */
  forest: Float32Array;
  /** 0..1 road/rail coverage */
  road: Float32Array;
  /** 0..1 building footprint coverage (urban scale) */
  building: Float32Array;
}

export interface GeneratedTileMesh {
  tileId: string;
  label: string;
  centerMmX: number;
  centerMmY: number;
  /** Main terrain geometry (interleaved or separate Float32Arrays) */
  positions: Float32Array;
  normals: Float32Array;
  /** Vertex colors RGB 0..1 for WebGL 2 preview */
  colors: Float32Array;
  /** Zone tag per triangle (0=terrain, 1=water, 2=forest, 3=road, 4=alpine) */
  triangleZones: Uint8Array;
  indices: Uint32Array;
  /** Optional separate water modifier mesh for 3MF */
  waterModifierPositions?: Float32Array;
  waterModifierIndices?: Uint32Array;
  /** Optional road modifier mesh for 3MF */
  roadModifierPositions?: Float32Array;
  roadModifierIndices?: Uint32Array;
  /** Optional forest canopy modifier mesh for 3MF (Hilbert top-fill) */
  forestModifierPositions?: Float32Array;
  forestModifierIndices?: Uint32Array;
  /** Optional alpine/rock modifier mesh for 3MF (Fuzzy skin + rock strata) */
  alpineModifierPositions?: Float32Array;
  alpineModifierIndices?: Uint32Array;
  /** Stats */
  minElevM: number;
  maxElevM: number;
  triangleCount: number;
  buildTimeMs: number;
}
