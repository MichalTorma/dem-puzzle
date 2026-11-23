import type { GeneratedTileMesh } from '../types';

export interface PlacedTile {
  mesh: GeneratedTileMesh;
  /** Translation (mm) to place tile center on the build plate */
  txMm: number;
  tyMm: number;
  widthMm: number;
  depthMm: number;
}

export interface PackedPlate {
  plateIndex: number;
  bedWidthMm: number;
  bedDepthMm: number;
  items: PlacedTile[];
}

function measureTileBounds(mesh: GeneratedTileMesh): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Shelf-packs generated puzzle tiles onto one or more printer build plates
 * with a guaranteed minimum spacing between parts and bed-edge margin.
 */
export function packTilesOntoPlates(
  meshes: GeneratedTileMesh[],
  bedWidthMm: number,
  bedDepthMm: number,
  spacingMm: number,
  edgeMarginMm = 5
): PackedPlate[] {
  if (meshes.length === 0) return [];

  const usableW = Math.max(20, bedWidthMm - edgeMarginMm * 2);
  const usableD = Math.max(20, bedDepthMm - edgeMarginMm * 2);

  const measured = meshes.map((mesh) => {
    const b = measureTileBounds(mesh);
    return {
      mesh,
      b,
      w: b.maxX - b.minX,
      d: b.maxY - b.minY,
    };
  });

  const plates: PackedPlate[] = [];
  let currentItems: Array<{
    mesh: GeneratedTileMesh;
    b: { minX: number; maxX: number; minY: number; maxY: number };
    x0: number;
    y0: number;
    w: number;
    d: number;
  }> = [];

  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  const flushPlate = () => {
    if (currentItems.length === 0) return;
    // Compute used bounding box so the whole cluster is centered on the bed
    let usedMaxX = 0;
    let usedMaxY = 0;
    for (const it of currentItems) {
      usedMaxX = Math.max(usedMaxX, it.x0 + it.w);
      usedMaxY = Math.max(usedMaxY, it.y0 + it.d);
    }
    const offsetX = (bedWidthMm - usedMaxX) * 0.5;
    const offsetY = (bedDepthMm - usedMaxY) * 0.5;

    plates.push({
      plateIndex: plates.length + 1,
      bedWidthMm,
      bedDepthMm,
      items: currentItems.map((it) => ({
        mesh: it.mesh,
        txMm: offsetX + it.x0 - it.b.minX,
        tyMm: offsetY + it.y0 - it.b.minY,
        widthMm: it.w,
        depthMm: it.d,
      })),
    });

    currentItems = [];
    cursorX = 0;
    cursorY = 0;
    rowHeight = 0;
  };

  for (const item of measured) {
    // Wrap to next row if needed
    if (cursorX > 0 && cursorX + item.w > usableW) {
      cursorX = 0;
      cursorY += rowHeight + spacingMm;
      rowHeight = 0;
    }

    // Start new plate if current plate is full vertically
    if (currentItems.length > 0 && cursorY + item.d > usableD) {
      flushPlate();
    }

    currentItems.push({
      mesh: item.mesh,
      b: item.b,
      x0: cursorX,
      y0: cursorY,
      w: item.w,
      d: item.d,
    });

    cursorX += item.w + spacingMm;
    rowHeight = Math.max(rowHeight, item.d);
  }

  flushPlate();
  return plates;
}
