import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';

maplibregl.setWorkerUrl(maplibreWorkerUrl);
import {
  Check,
  Circle,
  Grid,
  Hexagon,
  MapPin,
  PaintBucket,
  RectangleHorizontal,
  Search,
  SlidersHorizontal,
  Zap,
} from 'lucide-react';
import type { GridShape, TileSpec } from '../types';
import { findTileAtLngLat, type FootprintShape } from '../utils/grid';
import { PuzzleShaderLayer } from '../utils/puzzleShaderLayer';

export type SelectionStage = 'pin' | 'shape' | 'refine';

interface MapExplorerProps {
  stage: SelectionStage;
  onStageChange: (stage: SelectionStage) => void;
  anchorLng: number;
  anchorLat: number;
  tiles: TileSpec[];
  selectedIds: Set<string>;
  footprint: FootprintShape;
  onFootprintChange: (fp: FootprintShape) => void;
  gridShape: GridShape;
  onGridShapeChange: (shape: GridShape) => void;
  gridRadius: number;
  onGridRadiusChange: (r: number) => void;
  rectWidth: number;
  rectHeight: number;
  onRectSizeChange: (w: number, h: number) => void;
  tilePrintSizeMm: number;
  tileRealSizeKm: number;
  onTileRealSizeKmChange: (km: number) => void;
  gridRotationDeg: number;
  onPlantPin: (lng: number, lat: number) => void;
  onToggleTile: (id: string) => void;
  onSetTileSelected: (id: string, selected: boolean) => void;
  onSelectTileOnly: (id: string) => void;
  onClearSelection: () => void;
  onSelectAll: () => void;
  onGenerate: () => void;
}

interface NominatimHit {
  display_name: string;
  lat: string;
  lon: string;
}

export function MapExplorer({
  stage,
  onStageChange,
  anchorLng,
  anchorLat,
  tiles,
  selectedIds,
  footprint,
  onFootprintChange,
  gridShape,
  onGridShapeChange,
  gridRadius,
  onGridRadiusChange,
  rectWidth,
  rectHeight,
  onRectSizeChange,
  tilePrintSizeMm,
  tileRealSizeKm,
  onTileRealSizeKmChange,
  gridRotationDeg,
  onPlantPin,
  onToggleTile,
  onSetTileSelected,
  onSelectTileOnly,
  onClearSelection,
  onSelectAll,
  onGenerate,
}: MapExplorerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const shaderLayerRef = useRef<PuzzleShaderLayer | null>(null);
  const centerMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [paintMode, setPaintMode] = useState(false);
  const [pinPlantedAtMs, setPinPlantedAtMs] = useState(-10000);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<NominatimHit[]>([]);
  const [searching, setSearching] = useState(false);

  const stageRef = useRef(stage);
  stageRef.current = stage;
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const paintModeRef = useRef(paintMode);
  paintModeRef.current = paintMode;
  const brushTargetRef = useRef<boolean | null>(null);

  const onPlantPinRef = useRef(onPlantPin);
  onPlantPinRef.current = onPlantPin;
  const onToggleRef = useRef(onToggleTile);
  onToggleRef.current = onToggleTile;
  const onSetTileSelectedRef = useRef(onSetTileSelected);
  onSetTileSelectedRef.current = onSetTileSelected;
  const onSelectOnlyRef = useRef(onSelectTileOnly);
  onSelectOnlyRef.current = onSelectTileOnly;

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let map: maplibregl.Map | null = null;

    const initMap = async () => {
      let style: maplibregl.StyleSpecification | string =
        'https://tiles.openfreemap.org/styles/liberty';
      try {
        const res = await fetch('https://tiles.openfreemap.org/styles/liberty');
        if (res.ok) {
          const json = (await res.json()) as maplibregl.StyleSpecification;
          if (json.layers) {
            json.layers = json.layers.filter((layer) => {
              const id = layer.id.toLowerCase();
              return !id.includes('3d') && !id.includes('extrusion');
            });
          }
          style = json;
        }
      } catch {
        // Fallback to URL
      }

      if (disposed || !containerRef.current) return;

      map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: [anchorLng, anchorLat],
        zoom: 1.45,
        pitch: 0,
        maxPitch: 0,
        bearing: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        canvasContextAttributes: { antialias: true },
      });

      map.on('styleimagemissing', (e) => {
        if (map && !map.hasImage(e.id)) {
          map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
        }
      });

      map.addControl(
        new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }),
        'bottom-right'
      );
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left');

      map.on('load', () => {
        if (!map) return;

        try {
          (map as unknown as { setProjection?: (p: { type: string }) => void }).setProjection?.({
            type: 'globe',
          });
        } catch {
          // Mercator fallback
        }

        const shaderLayer = new PuzzleShaderLayer();
        shaderLayerRef.current = shaderLayer;
        map.addLayer(shaderLayer);

        map.addSource('puzzle-grid-labels', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer({
          id: 'puzzle-grid-labels',
          type: 'symbol',
          source: 'puzzle-grid-labels',
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Regular'],
            'text-size': 11,
            'text-allow-overlap': false,
            'text-ignore-placement': false,
          },
          paint: {
            'text-color': [
              'case',
              ['boolean', ['get', 'selected'], false],
              '#f8fafc',
              'rgba(203, 213, 225, 0.72)',
            ],
            'text-halo-color': 'rgba(6, 12, 24, 0.9)',
            'text-halo-width': 1.5,
          },
        });

        map.on('click', (e: maplibregl.MapMouseEvent) => {
          if (stageRef.current === 'pin') {
            setPinPlantedAtMs(performance.now());
            onPlantPinRef.current(e.lngLat.lng, e.lngLat.lat);
            map?.flyTo({
              center: [e.lngLat.lng, e.lngLat.lat],
              zoom: Math.max(map.getZoom(), 11.2),
              pitch: 0,
              duration: 1500,
              essential: true,
            });
            return;
          }

          if (stageRef.current === 'refine') {
            if (brushTargetRef.current !== null) return;
            const hit = findTileAtLngLat(tilesRef.current, e.lngLat.lng, e.lngLat.lat);
            if (!hit) return;
            if (e.originalEvent.altKey) {
              onSelectOnlyRef.current(hit.id);
            } else {
              onToggleRef.current(hit.id);
            }
          }
        });

        map.on('mousedown', (e: maplibregl.MapMouseEvent) => {
          if (stageRef.current !== 'refine') return;
          if (!(paintModeRef.current || e.originalEvent.shiftKey) || e.originalEvent.button !== 0) {
            brushTargetRef.current = null;
            return;
          }
          const hit = findTileAtLngLat(tilesRef.current, e.lngLat.lng, e.lngLat.lat);
          if (!hit) return;
          e.preventDefault();
          const nextState = !selectedIdsRef.current.has(hit.id);
          brushTargetRef.current = nextState;
          onSetTileSelectedRef.current(hit.id, nextState);
        });

        map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
          if (stageRef.current === 'pin') {
            if (map) map.getCanvas().style.cursor = 'crosshair';
            shaderLayer.setHoverTileId(null);
            return;
          }

          const hit = findTileAtLngLat(tilesRef.current, e.lngLat.lng, e.lngLat.lat);
          shaderLayer.setHoverTileId(stageRef.current === 'refine' ? (hit?.id ?? null) : null);
          if (map) {
            map.getCanvas().style.cursor =
              stageRef.current === 'refine' && hit ? 'pointer' : '';
          }

          if (
            stageRef.current === 'refine' &&
            e.originalEvent.buttons === 1 &&
            (paintModeRef.current || e.originalEvent.shiftKey) &&
            hit
          ) {
            if (brushTargetRef.current === null) {
              brushTargetRef.current = !selectedIdsRef.current.has(hit.id);
            }
            onSetTileSelectedRef.current(hit.id, brushTargetRef.current);
          }
        });

        map.on('mouseup', () => {
          if (brushTargetRef.current !== null) {
            setTimeout(() => {
              brushTargetRef.current = null;
            }, 0);
          }
        });

        setMapReady(true);
      });

      mapRef.current = map;
    };

    void initMap();

    return () => {
      disposed = true;
      centerMarkerRef.current?.remove();
      centerMarkerRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Draggable center marker once the puzzle center has been planted
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (stage === 'pin') {
      centerMarkerRef.current?.remove();
      centerMarkerRef.current = null;
      return;
    }

    if (!centerMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'center-pin-marker';
      el.title = 'Drag to move puzzle center';
      el.innerHTML = '<div class="center-pin-ring"></div><div class="center-pin-dot"></div>';

      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([anchorLng, anchorLat])
        .addTo(map);

      marker.on('drag', () => {
        const ll = marker.getLngLat();
        onPlantPinRef.current(ll.lng, ll.lat);
      });
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        setPinPlantedAtMs(performance.now());
        onPlantPinRef.current(ll.lng, ll.lat);
      });

      centerMarkerRef.current = marker;
    } else {
      centerMarkerRef.current.setLngLat([anchorLng, anchorLat]);
    }
  }, [stage, anchorLng, anchorLat, mapReady]);

  // Push geometry, selection texture & footprint uniforms to 60fps WebGL shader layer
  useEffect(() => {
    const visible = stage !== 'pin';
    shaderLayerRef.current?.updateState({
      visible,
      tiles,
      selectedIds,
      pinLng: anchorLng,
      pinLat: anchorLat,
      pinPlantedAtMs,
      footprint,
      gridShape,
      radius: gridRadius,
      rectWidth,
      rectHeight,
      tilePrintSizeMm,
      gridRotationDeg,
    });
  }, [
    stage,
    tiles,
    selectedIds,
    anchorLng,
    anchorLat,
    pinPlantedAtMs,
    footprint,
    gridShape,
    gridRadius,
    rectWidth,
    rectHeight,
    tilePrintSizeMm,
    gridRotationDeg,
  ]);

  // Update lightweight label points only when tile geometry or stage changes (never on click!)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const labelSrc = map.getSource('puzzle-grid-labels') as maplibregl.GeoJSONSource | undefined;
    if (!labelSrc) return;

    const visible = stage !== 'pin';
    const features = visible
      ? tiles.map((t) => ({
          type: 'Feature' as const,
          properties: {
            label: t.label,
            selected: false,
          },
          geometry: {
            type: 'Point' as const,
            coordinates: [t.centerLng, t.centerLat],
          },
        }))
      : [];

    labelSrc.setData({ type: 'FeatureCollection', features });
  }, [stage, tiles, mapReady]);

  // Disable map drag-pan while Brush mode is active in refine stage
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (paintMode && stage === 'refine') {
      map.dragPan.disable();
    } else {
      map.dragPan.enable();
    }
  }, [paintMode, stage]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(
        query.trim()
      )}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const hits = (await res.json()) as NominatimHit[];
        setSearchResults(hits);
      }
    } finally {
      setSearching(false);
    }
  };

  const jumpToPlace = (hit: NominatimHit) => {
    const lng = parseFloat(hit.lon);
    const lat = parseFloat(hit.lat);
    setSearchResults([]);
    setPinPlantedAtMs(performance.now());
    onPlantPin(lng, lat);
    mapRef.current?.flyTo({
      center: [lng, lat],
      zoom: 11.2,
      pitch: 0,
      duration: 1600,
      essential: true,
    });
  };

  return (
    <div className="map-stage">
      <div ref={containerRef} className="map-canvas" />

      {/* Clean single search bubble */}
      <div className="map-floating-bar">
        <form onSubmit={handleSearch} className="search-box">
          <Search size={15} className="search-icon" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mountain, city, island, fjord..."
            aria-label="Search place on map"
          />
          <button type="submit" disabled={searching}>
            {searching ? '...' : 'Find'}
          </button>
        </form>

        {stage !== 'pin' && (
          <div className="drag-pin-hint">
            <MapPin size={13} />
            <span>Drag center marker to move</span>
          </div>
        )}
      </div>

      {searchResults.length > 0 && (
        <ul className="search-dropdown" role="listbox">
          {searchResults.map((hit, idx) => (
            <li key={idx}>
              <button type="button" onClick={() => jumpToPlace(hit)}>
                {hit.display_name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Stage 1: Define puzzle center */}
      {stage === 'pin' && (
        <div className="map-hint-pill cinematic-prompt">
          <MapPin size={15} />
          <span>
            <strong>Step 1:</strong> Search above or click anywhere on the map to place your puzzle center
          </span>
        </div>
      )}

      {/* Stage 2: Tile shape, footprint, coverage & tile count */}
      {stage === 'shape' && (
        <div className="cinematic-dock">
          <div className="dock-row">
            <span className="dock-label">Tiles</span>
            <div className="segmented compact">
              <button
                type="button"
                className={gridShape === 'hex' ? 'active' : ''}
                onClick={() => onGridShapeChange('hex')}
              >
                <Hexagon size={13} /> Hexagons
              </button>
              <button
                type="button"
                className={gridShape === 'rect' ? 'active' : ''}
                onClick={() => onGridShapeChange('rect')}
              >
                <Grid size={13} /> Squares
              </button>
            </div>

            <span className="dock-label">Shape</span>
            <div className="segmented compact">
              <button
                type="button"
                className={footprint === 'hex-ring' ? 'active' : ''}
                onClick={() => onFootprintChange('hex-ring')}
              >
                <Hexagon size={13} /> Hex
              </button>
              <button
                type="button"
                className={footprint === 'circle' ? 'active' : ''}
                onClick={() => onFootprintChange('circle')}
              >
                <Circle size={13} /> Circle
              </button>
              <button
                type="button"
                className={footprint === 'rect-frame' ? 'active' : ''}
                onClick={() => onFootprintChange('rect-frame')}
              >
                <RectangleHorizontal size={13} /> Rectangle
              </button>
            </div>
          </div>

          <div className="dock-row">
            {footprint === 'rect-frame' ? (
              <div className="dock-sliders">
                <label>
                  <span>Cols: {rectWidth}</span>
                  <input
                    type="range"
                    min={1}
                    max={15}
                    step={1}
                    value={rectWidth}
                    onChange={(e) => onRectSizeChange(Number(e.target.value), rectHeight)}
                  />
                </label>
                <label>
                  <span>Rows: {rectHeight}</span>
                  <input
                    type="range"
                    min={1}
                    max={15}
                    step={1}
                    value={rectHeight}
                    onChange={(e) => onRectSizeChange(rectWidth, Number(e.target.value))}
                  />
                </label>
                <label>
                  <span>Size: {(rectWidth * tileRealSizeKm).toFixed(1)} km</span>
                  <input
                    type="range"
                    min={0.5}
                    max={250}
                    step={0.5}
                    value={Math.min(250, Number((rectWidth * tileRealSizeKm).toFixed(1)))}
                    onChange={(e) =>
                      onTileRealSizeKmChange(
                        Math.max(0.1, Math.min(100, Number((Number(e.target.value) / rectWidth).toFixed(2))))
                      )
                    }
                  />
                </label>
              </div>
            ) : (
              <div className="dock-sliders">
                <label>
                  <span>Tiles: {selectedIds.size} (R{gridRadius})</span>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    step={1}
                    value={gridRadius}
                    onChange={(e) => onGridRadiusChange(Number(e.target.value))}
                  />
                </label>
                <label>
                  <span>Coverage: {((gridRadius + 0.5) * tileRealSizeKm * 2).toFixed(1)} km across</span>
                  <input
                    type="range"
                    min={1}
                    max={500}
                    step={0.5}
                    value={Math.min(500, Number(((gridRadius + 0.5) * tileRealSizeKm * 2).toFixed(1)))}
                    onChange={(e) =>
                      onTileRealSizeKmChange(
                        Math.max(
                          0.1,
                          Math.min(
                            100,
                            Number((Number(e.target.value) / ((gridRadius + 0.5) * 2)).toFixed(2))
                          )
                        )
                      )
                    }
                  />
                </label>
              </div>
            )}

            <div className="dock-actions">
              <button type="button" className="chip-btn" onClick={() => onStageChange('refine')}>
                <SlidersHorizontal size={13} /> Fine-Tune ({selectedIds.size})
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={selectedIds.size === 0}
                onClick={onGenerate}
              >
                <Zap size={14} /> Generate {selectedIds.size} Tiles
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === 'refine' && (
        <div className="cinematic-dock">
          <div className="dock-row">
            <span className="dock-hint">
              Click tile to toggle • <strong>Shift+Drag</strong> to brush •{' '}
              <strong>{selectedIds.size}</strong> selected
            </span>
          </div>
          <div className="dock-actions">
            <button type="button" className="chip-btn" onClick={() => onStageChange('shape')}>
              ← Outer Shape
            </button>
            <button
              type="button"
              className={`chip-btn ${paintMode ? 'active' : ''}`}
              onClick={() => setPaintMode((v) => !v)}
            >
              <PaintBucket size={13} /> {paintMode ? 'Brush: ON' : 'Brush'}
            </button>
            <button type="button" className="chip-btn" onClick={onSelectAll}>
              Select All ({tiles.length})
            </button>
            <button type="button" className="chip-btn" onClick={onClearSelection}>
              Clear
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={selectedIds.size === 0}
              onClick={onGenerate}
            >
              <Check size={14} /> Confirm &amp; Generate {selectedIds.size}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
