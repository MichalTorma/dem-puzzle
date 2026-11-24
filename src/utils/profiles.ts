import type { PuzzleConfig } from '../types';

export interface PersistedSettings {
  config: PuzzleConfig;
  packMode: 'plates' | 'individual';
  bedPreset: string;
  bedWidthMm: number;
  bedDepthMm: number;
  partGapMm: number;
  singleFilamentColor: string;
}

export interface SavedProfile {
  id: string;
  name: string;
  builtIn?: boolean;
  settings: PersistedSettings;
}

const SETTINGS_STORAGE_KEY = 'topojigsaw:settings:v1';
const PROFILES_STORAGE_KEY = 'topojigsaw:profiles:v1';

export function loadPersistedSettings(defaults: PersistedSettings): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    const parsedConfig = (parsed.config ?? {}) as Omit<
      Partial<PuzzleConfig>,
      'waterMode' | 'roadMode' | 'previewMode'
    > & {
      waterMode?: string;
      roadMode?: string;
      previewMode?: string;
    };
    return {
      ...defaults,
      ...parsed,
      config: {
        ...defaults.config,
        ...parsedConfig,
        waterMode: parsedConfig.waterMode === 'none' ? 'none' : 'color',
        roadMode: parsedConfig.roadMode === 'none' ? 'none' : 'color',
        previewMode:
          parsedConfig.previewMode === 'clay'
            ? 'clay'
            : parsedConfig.previewMode === 'ironing' || parsedConfig.previewMode === 'single'
              ? 'single'
              : 'multicolor',
      },
    };
  } catch {
    return defaults;
  }
}

export function savePersistedSettings(settings: PersistedSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or private-browsing errors
  }
}

export function getBuiltInProfiles(defaults: PersistedSettings): SavedProfile[] {
  return [
    {
      id: 'builtin-default-30mm',
      name: 'Default (30mm Hex)',
      builtIn: true,
      settings: defaults,
    },
    {
      id: 'builtin-jigsaw-26mm',
      name: 'Micro Jigsaw (26mm)',
      builtIn: true,
      settings: {
        ...defaults,
        config: {
          ...defaults.config,
          tilePrintSizeMm: 26,
          tileRealSizeKm: 1.2,
          baseThicknessMm: 2.0,
          maxReliefMm: 7,
          gridRadius: 4,
        },
      },
    },
    {
      id: 'builtin-display-110mm',
      name: 'Display Tile (110mm)',
      builtIn: true,
      settings: {
        ...defaults,
        config: {
          ...defaults.config,
          tilePrintSizeMm: 110,
          tileRealSizeKm: 4.5,
          baseThicknessMm: 3.0,
          maxReliefMm: 18,
          gridRadius: 2,
        },
      },
    },
  ];
}

export function loadProfiles(defaults: PersistedSettings): SavedProfile[] {
  const builtIns = getBuiltInProfiles(defaults);
  try {
    const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
    if (!raw) return builtIns;
    const custom = JSON.parse(raw) as SavedProfile[];
    if (!Array.isArray(custom)) return builtIns;
    return [
      ...builtIns,
      ...custom.filter((p) => !p.builtIn && p.id && p.name && p.settings?.config),
    ];
  } catch {
    return builtIns;
  }
}

export function saveCustomProfiles(profiles: SavedProfile[]): void {
  try {
    const custom = profiles.filter((p) => !p.builtIn);
    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(custom));
  } catch {
    // Ignore storage quota or private-browsing errors
  }
}
