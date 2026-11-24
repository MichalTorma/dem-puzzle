import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bookmark,
  Box,
  Download,
  Hexagon,
  Layers,
  Map as MapIcon,
  Printer,
  RotateCcw,
  Save,
  Sliders,
  Square,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { MapExplorer, type SelectionStage } from './components/MapExplorer';
import { PuzzleStudio3D } from './components/PuzzleStudio3D';
import type { GeneratedTileMesh, PuzzleConfig } from './types';
import {
  exportBatchZip,
  exportPackedPlatesZip,
  exportPlateTo3MF,
  exportPlateToSTL,
  exportTileTo3MF,
  exportTileToSTL,
  triggerDownload,
} from './utils/exporters';
import {
  generateGridTiles,
  selectTilesByFootprint,
  type FootprintShape,
} from './utils/grid';
import {
  generateCalibrationMeshes,
  generatePuzzleMeshes,
  type GenerationProgress,
} from './utils/meshingPool';
import { packTilesOntoPlates } from './utils/platePacker';
import {
  loadPersistedSettings,
  loadProfiles,
  saveCustomProfiles,
  savePersistedSettings,
  type PersistedSettings,
  type SavedProfile,
} from './utils/profiles';
import { computeScaleProfile, formatScaleRatio } from './utils/scale';

// Start zoomed out looking at the whole planet
const DEFAULT_LNG = 12;
const DEFAULT_LAT = 22;

const DEFAULT_SELECTED = new Set<string>();

const DEFAULT_CONFIG: PuzzleConfig = {
  shape: 'hex',
  gridRadius: 2,
  tilePrintSizeMm: 30,
  tileRealSizeKm: 2.4,
  gridRotationDeg: 0,
  baseThicknessMm: 3.0,
  maxReliefMm: 18,
  zExaggeration: 1.6,
  jigsawClearanceMm: 0.2,
  tabSizeRatio: 0.22,
  perimeterFlatEdges: true,
  resolution: 96,
  waterMode: 'color',
  forestTexture: true,
  roadMode: 'color',
  contourSteps: 0,
  elevationBands: true,
  undersideLabel: true,
  exportFormat: '3mf-both',
  previewMode: 'multicolor',
};

const DEFAULT_PERSISTED: PersistedSettings = {
  config: DEFAULT_CONFIG,
  packMode: 'plates',
  bedPreset: '256x256',
  bedWidthMm: 256,
  bedDepthMm: 256,
  partGapMm: 4,
  singleFilamentColor: '#64748b',
};

export function App() {
  const initialSettings = useMemo(() => loadPersistedSettings(DEFAULT_PERSISTED), []);
  const [viewMode, setViewMode] = useState<'map' | 'studio'>('map');
  const [selectionStage, setSelectionStage] = useState<SelectionStage>('pin');
  const [footprint, setFootprint] = useState<FootprintShape>('hex-ring');
  const [rectWidth, setRectWidth] = useState(4);
  const [rectHeight, setRectHeight] = useState(4);
  const [anchor, setAnchor] = useState({ lng: DEFAULT_LNG, lat: DEFAULT_LAT });
  const [config, setConfig] = useState<PuzzleConfig>(initialSettings.config);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(DEFAULT_SELECTED);
  const [meshes, setMeshes] = useState<GeneratedTileMesh[]>([]);
  const [generatedSignature, setGeneratedSignature] = useState<string | null>(null);
  const [isCalibration, setIsCalibration] = useState(false);
  const [activeTileId, setActiveTileId] = useState<string | null>(null);
  const [explodeFactor, setExplodeFactor] = useState(0.12);
  const [singleFilamentColor, setSingleFilamentColor] = useState(initialSettings.singleFilamentColor);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [packMode, setPackMode] = useState<'plates' | 'individual'>(initialSettings.packMode);
  const [bedPreset, setBedPreset] = useState<string>(initialSettings.bedPreset);
  const [bedWidthMm, setBedWidthMm] = useState(initialSettings.bedWidthMm);
  const [bedDepthMm, setBedDepthMm] = useState(initialSettings.bedDepthMm);
  const [partGapMm, setPartGapMm] = useState(initialSettings.partGapMm);
  const [profiles, setProfiles] = useState<SavedProfile[]>(() => loadProfiles(DEFAULT_PERSISTED));
  const [activeProfileId, setActiveProfileId] = useState<string>('builtin-default-30mm');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);

  useEffect(() => {
    savePersistedSettings({
      config,
      packMode,
      bedPreset,
      bedWidthMm,
      bedDepthMm,
      partGapMm,
      singleFilamentColor,
    });
  }, [config, packMode, bedPreset, bedWidthMm, bedDepthMm, partGapMm, singleFilamentColor]);

  const applySettings = (s: PersistedSettings) => {
    setConfig(s.config);
    setPackMode(s.packMode);
    setBedPreset(s.bedPreset);
    setBedWidthMm(s.bedWidthMm);
    setBedDepthMm(s.bedDepthMm);
    setPartGapMm(s.partGapMm);
    setSingleFilamentColor(s.singleFilamentColor);
  };

  const handleSelectProfile = (id: string) => {
    setActiveProfileId(id);
    const found = profiles.find((p) => p.id === id);
    if (found) applySettings(found.settings);
  };

  const handleSaveProfile = () => {
    const rawName = window.prompt('Save current settings as profile:', 'My Printer Profile');
    const name = rawName?.trim();
    if (!name) return;
    const currentSettings: PersistedSettings = {
      config,
      packMode,
      bedPreset,
      bedWidthMm,
      bedDepthMm,
      partGapMm,
      singleFilamentColor,
    };
    const existingIdx = profiles.findIndex(
      (p) => !p.builtIn && p.name.toLowerCase() === name.toLowerCase()
    );
    let nextProfiles: SavedProfile[];
    let targetId: string;
    if (existingIdx >= 0) {
      targetId = profiles[existingIdx].id;
      nextProfiles = profiles.map((p, i) =>
        i === existingIdx ? { ...p, name, settings: currentSettings } : p
      );
    } else {
      targetId = `custom-${Date.now()}`;
      nextProfiles = [...profiles, { id: targetId, name, settings: currentSettings }];
    }
    setProfiles(nextProfiles);
    saveCustomProfiles(nextProfiles);
    setActiveProfileId(targetId);
  };

  const handleDeleteProfile = () => {
    const target = profiles.find((p) => p.id === activeProfileId);
    if (!target || target.builtIn) return;
    const nextProfiles = profiles.filter((p) => p.id !== activeProfileId);
    setProfiles(nextProfiles);
    saveCustomProfiles(nextProfiles);
    setActiveProfileId('builtin-default-30mm');
  };

  const handleResetDefaults = () => {
    applySettings(DEFAULT_PERSISTED);
    setActiveProfileId('builtin-default-30mm');
  };

  const scaleProfile = useMemo(
    () => computeScaleProfile(config.tileRealSizeKm, config.tilePrintSizeMm, anchor.lat),
    [config.tileRealSizeKm, config.tilePrintSizeMm, anchor.lat]
  );

  const effectiveGridRadius =
    footprint === 'rect-frame'
      ? Math.max(config.gridRadius, Math.ceil(Math.max(rectWidth, rectHeight) / 2))
      : config.gridRadius;

const EMPTY_SELECTED_SET = new Set<string>();

  const allTiles = useMemo(
    () =>
      generateGridTiles({
        shape: config.shape,
        anchorLng: anchor.lng,
        anchorLat: anchor.lat,
        tileRealSizeKm: config.tileRealSizeKm,
        tilePrintSizeMm: config.tilePrintSizeMm,
        gridRotationDeg: config.gridRotationDeg,
        radius: effectiveGridRadius,
        selectedIds: EMPTY_SELECTED_SET,
        perimeterFlatEdges: false,
      }),
    [
      config.shape,
      effectiveGridRadius,
      config.tileRealSizeKm,
      config.tilePrintSizeMm,
      config.gridRotationDeg,
      anchor.lng,
      anchor.lat,
    ]
  );

  useEffect(() => {
    if (selectionStage !== 'shape') return;
    const next = selectTilesByFootprint(allTiles, {
      footprint,
      radius: config.gridRadius,
      rectWidth,
      rectHeight,
      tilePrintSizeMm: config.tilePrintSizeMm,
      shape: config.shape,
    });
    setSelectedIds((prev) => {
      if (prev.size === next.size && [...prev].every((id) => next.has(id))) {
        return prev;
      }
      return next;
    });
  }, [
    selectionStage,
    allTiles,
    footprint,
    config.gridRadius,
    rectWidth,
    rectHeight,
    config.tilePrintSizeMm,
    config.shape,
  ]);

  const handlePlantPin = useCallback((lng: number, lat: number) => {
    setAnchor({ lng, lat });
    setSelectionStage('shape');
  }, []);

  const selectedTiles = useMemo(() => {
    if (selectedIds.size === 0) return [];
    if (!config.perimeterFlatEdges) {
      return allTiles.filter((t) => selectedIds.has(t.id));
    }
    return generateGridTiles({
      shape: config.shape,
      anchorLng: anchor.lng,
      anchorLat: anchor.lat,
      tileRealSizeKm: config.tileRealSizeKm,
      tilePrintSizeMm: config.tilePrintSizeMm,
      gridRotationDeg: config.gridRotationDeg,
      radius: effectiveGridRadius,
      selectedIds,
      perimeterFlatEdges: true,
    }).filter((t) => selectedIds.has(t.id));
  }, [
    allTiles,
    selectedIds,
    config.perimeterFlatEdges,
    config.shape,
    anchor.lng,
    anchor.lat,
    config.tileRealSizeKm,
    config.tilePrintSizeMm,
    config.gridRotationDeg,
    effectiveGridRadius,
  ]);

  const updateConfig = <K extends keyof PuzzleConfig>(key: K, val: PuzzleConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: val }));
  };

  const toggleTile = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setTileSelected = useCallback((id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const has = prev.has(id);
      if (has === selected) return prev;
      const next = new Set(prev);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const selectTileOnly = useCallback((id: string) => {
    setSelectedIds(new Set([id]));
  }, []);

  const currentCalibrationSignature = useMemo(() => {
    const { previewMode: _pm, exportFormat: _ef, ...meshCfg } = config;
    return JSON.stringify({ calibration: true, meshCfg });
  }, [config]);

  const currentMeshSignature = useMemo(() => {
    const { previewMode: _pm, exportFormat: _ef, ...meshCfg } = config;
    const sortedIds = Array.from(selectedIds).sort();
    return JSON.stringify({
      calibration: false,
      meshCfg,
      anchorLng: Number(anchor.lng.toFixed(6)),
      anchorLat: Number(anchor.lat.toFixed(6)),
      sortedIds,
    });
  }, [config, anchor, selectedIds]);

  const isMeshStale =
    meshes.length > 0 &&
    generatedSignature !== null &&
    generatedSignature !== (isCalibration ? currentCalibrationSignature : currentMeshSignature);

  const handleGenerateCalibration = async () => {
    const sig = currentCalibrationSignature;
    setViewMode('studio');
    setProgress({
      stage: 'meshing',
      overallPct: 50,
      completed: 0,
      total: 2,
      detail: 'Building 2-tile hex calibration set (0.08–0.28 mm clearances + extreme interlock)...',
      logs: [],
    });
    try {
      const result = await generateCalibrationMeshes(config);
      setMeshes(result);
      setIsCalibration(true);
      setGeneratedSignature(sig);
      setActiveTileId(result[0]?.tileId ?? null);
    } finally {
      setProgress(null);
    }
  };

  const handleGenerate = async () => {
    if (selectedTiles.length === 0) return;
    const sig = currentMeshSignature;
    setViewMode('studio');
    setProgress({
      stage: 'dem',
      overallPct: 0,
      completed: 0,
      total: selectedTiles.length,
      detail: 'Initializing DEM & feature pipeline...',
      logs: [],
    });
    try {
      const result = await generatePuzzleMeshes({
        tiles: selectedTiles,
        anchorLng: anchor.lng,
        anchorLat: anchor.lat,
        config,
        profile: scaleProfile,
        onProgress: setProgress,
      });
      setMeshes(result);
      setIsCalibration(false);
      setGeneratedSignature(sig);
      setActiveTileId(result[0]?.tileId ?? null);
    } finally {
      setProgress(null);
    }
  };

  const handleDownloadSingle = async (mesh: GeneratedTileMesh) => {
    setExporting(true);
    try {
      if (config.exportFormat === 'stl') {
        triggerDownload(exportTileToSTL(mesh), `topojigsaw_${mesh.label}.stl`);
      } else {
        const blob = await exportTileTo3MF(mesh, config.exportFormat);
        triggerDownload(blob, `topojigsaw_${mesh.label}.3mf`);
      }
    } finally {
      setExporting(false);
    }
  };

  const packedPlates = useMemo(
    () =>
      packMode === 'plates'
        ? packTilesOntoPlates(meshes, bedWidthMm, bedDepthMm, partGapMm)
        : [],
    [meshes, packMode, bedWidthMm, bedDepthMm, partGapMm]
  );

  const handleDownloadAll = async () => {
    if (meshes.length === 0) return;
    if (meshes.length === 1) {
      await handleDownloadSingle(meshes[0]);
      return;
    }
    setExporting(true);
    try {
      if (packMode === 'plates') {
        if (packedPlates.length === 1) {
          const plate = packedPlates[0];
          if (config.exportFormat === 'stl') {
            triggerDownload(exportPlateToSTL(plate), `topojigsaw_plate01.stl`);
          } else {
            const blob = await exportPlateTo3MF(plate, config.exportFormat);
            triggerDownload(blob, `topojigsaw_plate01.3mf`);
          }
        } else {
          const zipBlob = await exportPackedPlatesZip(packedPlates, config.exportFormat);
          triggerDownload(
            zipBlob,
            `topojigsaw_${packedPlates.length}plates_${bedWidthMm}x${bedDepthMm}.zip`
          );
        }
      } else {
        const zipBlob = await exportBatchZip(meshes, config.exportFormat);
        triggerDownload(zipBlob, `topojigsaw_${config.shape}_${meshes.length}tiles.zip`);
      }
    } finally {
      setExporting(false);
    }
  };

  const activeMesh = meshes.find((m) => m.tileId === activeTileId) ?? meshes[0] ?? null;

  return (
    <div className="app-shell">
      {/* Top Header */}
      <header className="topbar">
        <div className="brand">
          <Hexagon size={22} className="brand-icon" />
          <div>
            <h1>TopoJigsaw</h1>
            <span className="brand-sub">WebGL 2 Terrain Puzzle Studio</span>
          </div>
        </div>

        <nav className="mode-tabs" aria-label="Workspace view">
          <button
            type="button"
            className={viewMode === 'map' ? 'active' : ''}
            onClick={() => setViewMode('map')}
          >
            <MapIcon size={15} />
            Map Explorer
          </button>
          <button
            type="button"
            className={viewMode === 'studio' ? 'active' : ''}
            onClick={() => setViewMode('studio')}
          >
            <Box size={15} />
            3D Puzzle Studio
            {meshes.length > 0 && <span className="badge">{meshes.length}</span>}
          </button>
        </nav>

        <div className="topbar-cta" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            className={`chip-btn ${advancedOpen ? 'active' : ''}`}
            onClick={() => setAdvancedOpen((v) => !v)}
            title="Open advanced print, relief, clearance & profile settings"
          >
            <Sliders size={14} />
            Advanced
          </button>
          <button
            type="button"
            className="chip-btn"
            disabled={progress !== null}
            onClick={handleGenerateCalibration}
            title="Generate 2 interlocking hex test tiles (6 clearances: 0.08–0.28 mm, extreme interlock + surface modifiers)"
          >
            <Printer size={14} />
            Test Print
          </button>
          <button
            type="button"
            className={`primary-btn ${isMeshStale && !isCalibration ? 'stale' : ''}`}
            disabled={selectedTiles.length === 0 || progress !== null}
            onClick={handleGenerate}
          >
            <Zap size={15} />
            {progress
              ? `${progress.overallPct}% • ${progress.stage.toUpperCase()}`
              : isMeshStale && !isCalibration
                ? `Re-generate ${selectedTiles.length} ${selectedTiles.length === 1 ? 'Tile' : 'Tiles'}`
                : `Generate ${selectedTiles.length} ${selectedTiles.length === 1 ? 'Tile' : 'Tiles'}`}
          </button>
        </div>
      </header>

      <div className="workspace">
        {/* Main Full-Screen Viewport */}
        {advancedOpen && (
          <div className="drawer-backdrop" onClick={() => setAdvancedOpen(false)}>
            <aside className="sidebar advanced-drawer" onClick={(e) => e.stopPropagation()}>
              <div className="drawer-header">
                <strong>Advanced Settings</strong>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setAdvancedOpen(false)}
                  aria-label="Close advanced settings"
                >
                  <X size={16} />
                </button>
              </div>
          {/* Profiles & Auto-Saved Settings */}
          <section className="panel">
            <div className="panel-title">
              <Bookmark size={14} />
              <span>Settings Profiles</span>
              <span className="scale-pill">Auto-Saved</span>
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <select
                value={activeProfileId}
                onChange={(e) => handleSelectProfile(e.target.value)}
                style={{ flex: 1 }}
                aria-label="Settings Profile"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="chip-btn"
                onClick={handleSaveProfile}
                title="Save current settings as a new profile"
              >
                <Save size={13} />
              </button>
              {!profiles.find((p) => p.id === activeProfileId)?.builtIn && (
                <button
                  type="button"
                  className="chip-btn"
                  onClick={handleDeleteProfile}
                  title="Delete selected custom profile"
                >
                  <Trash2 size={13} />
                </button>
              )}
              <button
                type="button"
                className="chip-btn"
                onClick={handleResetDefaults}
                title="Reset to default settings"
              >
                <RotateCcw size={13} />
              </button>
            </div>
          </section>

          {/* Spatially Grounded Scale Readout */}
          <section className="panel scale-card">
            <div className="panel-title">
              <Layers size={14} />
              <span>Scale & Printability</span>
              <span className="scale-pill">{formatScaleRatio(scaleProfile.scaleRatio)}</span>
            </div>
            <div className="scale-meta">
              <strong>{scaleProfile.label}</strong>
              <span>1 mm = {Math.round(scaleProfile.metersPerMm)} m</span>
            </div>
            <p className="scale-summary">{scaleProfile.summary}</p>
          </section>

          {/* Grid & Jigsaw Geometry */}
          <section className="panel">
            <div className="panel-title">
              <Sliders size={14} />
              <span>Puzzle Grid & Joints</span>
            </div>

            <div className="segmented">
              <button
                type="button"
                className={config.shape === 'hex' ? 'active' : ''}
                onClick={() => updateConfig('shape', 'hex')}
              >
                <Hexagon size={14} /> Hexagons
              </button>
              <button
                type="button"
                className={config.shape === 'rect' ? 'active' : ''}
                onClick={() => updateConfig('shape', 'rect')}
              >
                <Square size={14} /> Rectangles
              </button>
            </div>

            <div className="segmented">
              <button
                type="button"
                className={config.tilePrintSizeMm <= 36 ? 'active' : ''}
                onClick={() =>
                  setConfig((prev) => ({
                    ...prev,
                    tilePrintSizeMm: 26,
                    tileRealSizeKm: Math.min(prev.tileRealSizeKm, 1.2),
                    baseThicknessMm: 2.0,
                    maxReliefMm: 7,
                    gridRadius: Math.max(prev.gridRadius, 8),
                  }))
                }
              >
                Jigsaw (26 mm)
              </button>
              <button
                type="button"
                className={config.tilePrintSizeMm > 36 ? 'active' : ''}
                onClick={() =>
                  setConfig((prev) => ({
                    ...prev,
                    tilePrintSizeMm: 110,
                    baseThicknessMm: 3.0,
                    maxReliefMm: 18,
                  }))
                }
              >
                Display Tile (110 mm)
              </button>
            </div>

            <label className="field">
              <span>
                Grid Extent (Radius {config.gridRadius} • {allTiles.length} tiles)
              </span>
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={config.gridRadius}
                onChange={(e) => updateConfig('gridRadius', Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>Tile Print Size ({config.tilePrintSizeMm} mm)</span>
              <input
                type="range"
                min={18}
                max={240}
                step={2}
                value={config.tilePrintSizeMm}
                onChange={(e) => updateConfig('tilePrintSizeMm', Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>Real-World Span ({config.tileRealSizeKm.toFixed(1)} km)</span>
              <input
                type="range"
                min={0.1}
                max={100}
                step={0.1}
                value={config.tileRealSizeKm}
                onChange={(e) => updateConfig('tileRealSizeKm', Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>Grid Rotation ({config.gridRotationDeg}°)</span>
              <input
                type="range"
                min={-45}
                max={45}
                step={1}
                value={config.gridRotationDeg}
                onChange={(e) => updateConfig('gridRotationDeg', Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>Jigsaw Clearance ({config.jigsawClearanceMm.toFixed(2)} mm)</span>
              <input
                type="range"
                min={0.1}
                max={0.4}
                step={0.05}
                value={config.jigsawClearanceMm}
                onChange={(e) => updateConfig('jigsawClearanceMm', Number(e.target.value))}
              />
            </label>

            <label className="check-field">
              <input
                type="checkbox"
                checked={config.perimeterFlatEdges}
                onChange={(e) => updateConfig('perimeterFlatEdges', e.target.checked)}
              />
              <span>Flat outer perimeter edges</span>
            </label>
          </section>

          {/* Relief & Surface Texture */}
          <section className="panel">
            <div className="panel-title">
              <Layers size={14} />
              <span>Terrain & Surface Texture</span>
            </div>

            <label className="field">
              <span>Z Exaggeration ({config.zExaggeration.toFixed(1)}×)</span>
              <input
                type="range"
                min={0.5}
                max={3.5}
                step={0.1}
                value={config.zExaggeration}
                onChange={(e) => updateConfig('zExaggeration', Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>Base Thickness ({config.baseThicknessMm.toFixed(1)} mm)</span>
              <input
                type="range"
                min={1.2}
                max={8.0}
                step={0.2}
                value={config.baseThicknessMm}
                onChange={(e) => updateConfig('baseThicknessMm', Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>Max Relief ({config.maxReliefMm} mm)</span>
              <input
                type="range"
                min={2}
                max={36}
                step={1}
                value={config.maxReliefMm}
                onChange={(e) => updateConfig('maxReliefMm', Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>Terraced Contours ({config.contourSteps === 0 ? 'Smooth' : `${config.contourSteps} steps`})</span>
              <input
                type="range"
                min={0}
                max={24}
                step={2}
                value={config.contourSteps}
                onChange={(e) => updateConfig('contourSteps', Number(e.target.value))}
              />
            </label>

            <div className="select-row">
              <label>
                <span>Water</span>
                <select
                  value={config.waterMode}
                  onChange={(e) => updateConfig('waterMode', e.target.value as PuzzleConfig['waterMode'])}
                >
                  <option value="color">Multi-Color</option>
                  <option value="none">Off</option>
                </select>
              </label>

              <label>
                <span>Roads</span>
                <select
                  value={config.roadMode}
                  onChange={(e) => updateConfig('roadMode', e.target.value as PuzzleConfig['roadMode'])}
                >
                  <option value="color">Multi-Color</option>
                  <option value="none">Off</option>
                </select>
              </label>
            </div>

            <label className="check-field">
              <input
                type="checkbox"
                checked={config.forestTexture}
                onChange={(e) => updateConfig('forestTexture', e.target.checked)}
              />
              <span>Baked forest canopy micro-texture</span>
            </label>

            <label className="check-field">
              <input
                type="checkbox"
                checked={config.elevationBands}
                onChange={(e) => updateConfig('elevationBands', e.target.checked)}
              />
              <span>Alpine rock & snow elevation bands</span>
            </label>
          </section>
            </aside>
          </div>
        )}

        {/* Main Viewport */}
        <main className="viewport">
          <div
            style={{
              position: 'absolute',
              inset: 0,
              visibility: viewMode === 'map' ? 'visible' : 'hidden',
              pointerEvents: viewMode === 'map' ? 'auto' : 'none',
            }}
          >
            <MapExplorer
              stage={selectionStage}
              onStageChange={setSelectionStage}
              anchorLng={anchor.lng}
              anchorLat={anchor.lat}
              tiles={allTiles}
              selectedIds={selectedIds}
              footprint={footprint}
              onFootprintChange={setFootprint}
              gridShape={config.shape}
              onGridShapeChange={(shape) => updateConfig('shape', shape)}
              gridRadius={config.gridRadius}
              onGridRadiusChange={(r) => updateConfig('gridRadius', r)}
              rectWidth={rectWidth}
              rectHeight={rectHeight}
              onRectSizeChange={(w, h) => {
                setRectWidth(w);
                setRectHeight(h);
              }}
              tilePrintSizeMm={config.tilePrintSizeMm}
              tileRealSizeKm={config.tileRealSizeKm}
              onTileRealSizeKmChange={(km) => updateConfig('tileRealSizeKm', km)}
              gridRotationDeg={config.gridRotationDeg}
              onPlantPin={handlePlantPin}
              onToggleTile={toggleTile}
              onSetTileSelected={setTileSelected}
              onSelectTileOnly={selectTileOnly}
              onClearSelection={() => setSelectedIds(new Set())}
              onSelectAll={() => setSelectedIds(new Set(allTiles.map((t) => t.id)))}
              onGenerate={handleGenerate}
            />
          </div>
          {viewMode === 'studio' && (
            <div className={`studio-stage ${isMeshStale ? 'is-stale' : ''}`}>
              {isMeshStale && progress === null && (
                <div className="stale-banner" role="status">
                  <span>Settings changed — 3D preview &amp; exports are outdated</span>
                  <button
                    type="button"
                    onClick={isCalibration ? handleGenerateCalibration : handleGenerate}
                  >
                    {isCalibration ? 'Re-generate Test Print' : 'Re-generate Now'}
                  </button>
                </div>
              )}
              <PuzzleStudio3D
                meshes={meshes}
                explodeFactor={explodeFactor}
                previewMode={config.previewMode}
                singleFilamentColor={singleFilamentColor}
                activeTileId={activeTileId}
                onSelectTile={(id) => setActiveTileId(id)}
              />

              {/* Studio HUD */}
              <div className="studio-hud-top">
                <div className="segmented compact">
                  <button
                    type="button"
                    className={config.previewMode === 'multicolor' ? 'active' : ''}
                    onClick={() => updateConfig('previewMode', 'multicolor')}
                  >
                    Multi-Color
                  </button>
                  <button
                    type="button"
                    className={config.previewMode === 'single' ? 'active' : ''}
                    onClick={() => updateConfig('previewMode', 'single')}
                  >
                    Single-Color
                  </button>
                  <button
                    type="button"
                    className={config.previewMode === 'clay' ? 'active' : ''}
                    onClick={() => updateConfig('previewMode', 'clay')}
                  >
                    Studio Clay
                  </button>
                </div>

                {config.previewMode === 'single' && (
                  <div className="filament-swatches" aria-label="Single-color filament">
                    {[
                      { name: 'Slate PLA', hex: '#64748b' },
                      { name: 'Matte Ivory', hex: '#e7e2d8' },
                      { name: 'Terracotta', hex: '#b4533c' },
                      { name: 'Sage Olive', hex: '#4d6b53' },
                      { name: 'Charcoal', hex: '#272c36' },
                    ].map((swatch) => (
                      <button
                        key={swatch.hex}
                        type="button"
                        title={swatch.name}
                        className={`swatch-btn ${singleFilamentColor === swatch.hex ? 'active' : ''}`}
                        style={{ backgroundColor: swatch.hex }}
                        onClick={() => setSingleFilamentColor(swatch.hex)}
                      />
                    ))}
                  </div>
                )}

                <label className="explode-slider">
                  <span>Explode</span>
                  <input
                    type="range"
                    min={0}
                    max={0.65}
                    step={0.01}
                    value={explodeFactor}
                    onChange={(e) => setExplodeFactor(Number(e.target.value))}
                  />
                </label>

                <button
                  type="button"
                  className="primary-btn"
                  disabled={meshes.length === 0 || exporting}
                  onClick={() => setExportModalOpen(true)}
                >
                  <Download size={14} />
                  {exporting ? 'Packaging...' : `Export (${meshes.length} ${meshes.length === 1 ? 'Tile' : 'Tiles'})`}
                </button>
              </div>

              {activeMesh && (
                <div className="studio-hud-bottom">
                  <div>
                    <strong>Tile {activeMesh.label}</strong> •{' '}
                    {Math.round(activeMesh.minElevM)}m – {Math.round(activeMesh.maxElevM)}m •{' '}
                    {activeMesh.triangleCount.toLocaleString()} tris ({activeMesh.buildTimeMs} ms)
                  </div>
                  <button
                    type="button"
                    className="chip-btn"
                    disabled={exporting}
                    onClick={() => handleDownloadSingle(activeMesh)}
                  >
                    <Download size={13} />
                    Download {activeMesh.label} ({config.exportFormat === 'stl' ? '.stl' : '.3mf'})
                  </button>
                </div>
              )}

              {progress && (
                <div className="progress-overlay" role="status" aria-live="polite">
                  <div className="progress-header">
                    <strong>Generating 3D Puzzle</strong>
                    <span className="progress-pct">{progress.overallPct}%</span>
                  </div>
                  <progress max={100} value={progress.overallPct} />
                  <div className="progress-stages">
                    <span className={progress.stage === 'dem' ? 'active' : 'done'}>
                      1. DEM Elevation
                    </span>
                    <span
                      className={
                        progress.stage === 'features'
                          ? 'active'
                          : progress.stage === 'meshing'
                            ? 'done'
                            : ''
                      }
                    >
                      2. OSM Features
                    </span>
                    <span className={progress.stage === 'meshing' ? 'active' : ''}>
                      3. Jigsaw Workers
                    </span>
                  </div>
                  <div className="progress-detail">{progress.detail}</div>
                  {progress.logs.length > 0 && (
                    <ul className="progress-logs">
                      {progress.logs.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {meshes.length === 0 && !progress && (
                <div className="empty-studio">
                  <Box size={40} />
                  <h2>No 3D tiles generated yet</h2>
                  <p>Select tiles on the map and click Generate to build watertight jigsaw meshes.</p>
                  <button type="button" className="primary-btn" onClick={handleGenerate}>
                    Generate Selected ({selectedTiles.length})
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Export Options Modal */}
      {exportModalOpen && (
        <div className="modal-backdrop" onClick={() => setExportModalOpen(false)}>
          <div
            className="export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h2 id="export-modal-title">Export 3D Puzzle</h2>
                <p className="modal-sub">
                  Choose prepared printer build plates or individual tile files.
                </p>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setExportModalOpen(false)}
                aria-label="Close export dialog"
              >
                <X size={16} />
              </button>
            </div>

            <div className="export-style-grid">
              <button
                type="button"
                className={`export-style-card ${packMode === 'plates' ? 'active' : ''}`}
                onClick={() => setPackMode('plates')}
              >
                <Printer size={18} />
                <strong>Prepared Build Plates</strong>
                <span>Auto-packed for your printer bed</span>
              </button>
              <button
                type="button"
                className={`export-style-card ${packMode === 'individual' ? 'active' : ''}`}
                onClick={() => setPackMode('individual')}
              >
                <Layers size={18} />
                <strong>Individual Tile Files</strong>
                <span>Separate file per puzzle piece (.zip)</span>
              </button>
            </div>

            {packMode === 'plates' && (
              <div className="modal-section">
                <label className="field">
                  <span>Printer Bed Size</span>
                  <select
                    value={bedPreset}
                    onChange={(e) => {
                      const val = e.target.value;
                      setBedPreset(val);
                      if (val !== 'custom') {
                        const [w, d] = val.split('x').map(Number);
                        setBedWidthMm(w);
                        setBedDepthMm(d);
                      }
                    }}
                  >
                    <optgroup label="Compact / Mini">
                      <option value="120x120">Voron 0 / Compact (120×120 mm)</option>
                      <option value="180x180">Prusa Mini / Bambu A1 Mini (180×180 mm)</option>
                    </optgroup>
                    <optgroup label="Standard">
                      <option value="200x200">Prusa i3 / MK1 (200×200 mm)</option>
                      <option value="220x220">Ender 3 / Creality K1 (220×220 mm)</option>
                      <option value="235x235">Ender 3 V2 / S1 / Neptune (235×235 mm)</option>
                      <option value="250x210">Prusa MK3S+ / MK4 / CORE One (250×210 mm)</option>
                      <option value="256x256">Bambu A1 / P1S / X1C (256×256 mm)</option>
                    </optgroup>
                    <optgroup label="Large / XL">
                      <option value="300x300">K1 Max / CR-10 / Voron 300 (300×300 mm)</option>
                      <option value="325x320">Bambu Lab H2D (325×320 mm)</option>
                      <option value="350x350">Voron 2.4 350 / QIDI (350×350 mm)</option>
                      <option value="360x360">Prusa XL (360×360 mm)</option>
                      <option value="400x400">Neptune 4 Max / Kobra Max (400×400 mm)</option>
                      <option value="500x500">RatRig 500 / CR-10 S5 (500×500 mm)</option>
                    </optgroup>
                    <option value="custom">Custom Dimensions...</option>
                  </select>
                </label>

                {bedPreset === 'custom' && (
                  <div className="select-row">
                    <label>
                      <span>Width (mm)</span>
                      <input
                        type="number"
                        min={80}
                        max={600}
                        value={bedWidthMm}
                        onChange={(e) => setBedWidthMm(Math.max(80, Number(e.target.value)))}
                      />
                    </label>
                    <label>
                      <span>Depth (mm)</span>
                      <input
                        type="number"
                        min={80}
                        max={600}
                        value={bedDepthMm}
                        onChange={(e) => setBedDepthMm(Math.max(80, Number(e.target.value)))}
                      />
                    </label>
                  </div>
                )}

                <label className="field">
                  <span>Min Part Spacing ({partGapMm} mm)</span>
                  <input
                    type="range"
                    min={1}
                    max={15}
                    step={0.5}
                    value={partGapMm}
                    onChange={(e) => setPartGapMm(Number(e.target.value))}
                  />
                </label>

                {packedPlates.length > 0 && (
                  <p className="hint-text">
                    <strong>
                      {meshes.length} tiles → {packedPlates.length}{' '}
                      {packedPlates.length === 1 ? 'plate' : 'plates'}
                    </strong>{' '}
                    ({bedWidthMm}×{bedDepthMm} mm, {partGapMm} mm gap)
                  </p>
                )}
              </div>
            )}

            <div className="modal-section">
              <label className="field">
                <span>Slicer / File Format</span>
                <select
                  value={config.exportFormat}
                  onChange={(e) =>
                    updateConfig('exportFormat', e.target.value as PuzzleConfig['exportFormat'])
                  }
                >
                  <option value="3mf-both">3MF PrusaSlicer (Modifiers &amp; Multi-Color)</option>
                  <option value="3mf-orca">3MF OrcaSlicer / Bambu Studio</option>
                  <option value="3mf-multipart">3MF Multi-Part Bodies Only</option>
                  <option value="stl">Binary STL (Single Body)</option>
                </select>
              </label>
            </div>

            <div className="modal-actions">
              {activeMesh && (
                <button
                  type="button"
                  className="chip-btn"
                  disabled={exporting}
                  onClick={() => handleDownloadSingle(activeMesh)}
                >
                  <Download size={14} />
                  Single Tile ({activeMesh.label})
                </button>
              )}
              <button
                type="button"
                className="primary-btn"
                disabled={meshes.length === 0 || exporting}
                onClick={async () => {
                  await handleDownloadAll();
                  setExportModalOpen(false);
                }}
              >
                <Download size={14} />
                {exporting
                  ? 'Packaging...'
                  : meshes.length === 1
                    ? 'Download Tile'
                    : packMode === 'plates'
                      ? packedPlates.length === 1
                        ? `Download Plate (${meshes.length} tiles)`
                        : `Download ${packedPlates.length} Plates (.zip)`
                      : `Download ${meshes.length} Tiles (.zip)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default App;
