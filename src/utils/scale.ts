import type { ScaleProfile, ScaleTier } from '../types';

/**
 * Computes spatially grounded, nozzle-safe feature filtering and DEM zoom
 * from the physical print size (mm) and real-world tile span (km).
 */
export function computeScaleProfile(
  tileRealSizeKm: number,
  tilePrintSizeMm: number,
  centerLat: number
): ScaleProfile {
  const safePrintMm = Math.max(10, tilePrintSizeMm);
  const metersPerMm = (tileRealSizeKm * 1000) / safePrintMm;
  const scaleRatio = Math.round(metersPerMm * 1000);
  // 0.4 mm nozzle needs >= 0.8 mm for reliable 2-wall features
  const minPrintableMeters = metersPerMm * 0.8;

  let tier: ScaleTier;
  let label: string;
  let includedRoads: string[];
  let includeBuildings: boolean;
  let summary: string;

  if (metersPerMm <= 25) {
    tier = 'urban';
    label = 'Neighborhood / City';
    includedRoads = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential'];
    includeBuildings = true;
    summary = 'Streets, buildings, parks & streams are >= 0.8 mm and printable.';
  } else if (metersPerMm <= 100) {
    tier = 'town';
    label = 'Town & Valley';
    includedRoads = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
    includeBuildings = false;
    summary = 'Major & connecting roads, rivers, lakes & forests; minor streets filtered out.';
  } else if (metersPerMm <= 400) {
    tier = 'regional';
    label = 'Regional / Range';
    includedRoads = ['motorway', 'trunk', 'primary', 'secondary'];
    includeBuildings = false;
    summary = 'Highways, main valley roads, large lakes, forests & mountain relief.';
  } else {
    tier = 'continental';
    label = 'Macro / Continental';
    includedRoads = [];
    includeBuildings = false;
    summary = 'Coastlines, major lakes & broad topography only for clean printability.';
  }

  // Choose Terrarium zoom so we have ~256-512 px across the tile without excessive fetches
  const cosLat = Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
  const earthCircumferenceM = 40075016.686 * cosLat;
  const targetMetersPerPx = (tileRealSizeKm * 1000) / 180;
  const rawZoom = Math.log2(earthCircumferenceM / (256 * targetMetersPerPx));
  const recommendedDemZoom = Math.max(5, Math.min(14, Math.round(rawZoom)));

  return {
    tier,
    label,
    metersPerMm,
    scaleRatio,
    minPrintableMeters,
    includedRoads,
    includeBuildings,
    includeWater: true,
    includeForests: tier !== 'continental',
    recommendedDemZoom,
    summary,
  };
}

export function formatScaleRatio(ratio: number): string {
  if (ratio >= 1_000_000) return `1:${(ratio / 1_000_000).toFixed(2)}M`;
  if (ratio >= 10_000) return `1:${Math.round(ratio / 1000)}k`;
  return `1:${ratio.toLocaleString()}`;
}
