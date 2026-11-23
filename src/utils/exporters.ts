import JSZip from 'jszip';
import type { ExportFormat, GeneratedTileMesh } from '../types';
import type { PackedPlate } from './platePacker';

export function exportTileToSTL(mesh: GeneratedTileMesh): Blob {
  const triCount = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);

  // 80-byte header
  const header = `TopoJigsaw ${mesh.label} (mm)`;
  for (let i = 0; i < Math.min(80, header.length); i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triCount, true);

  let offset = 84;
  const pos = mesh.positions;
  const idx = mesh.indices;

  for (let t = 0; t < triCount; t++) {
    const ia = idx[t * 3] * 3;
    const ib = idx[t * 3 + 1] * 3;
    const ic = idx[t * 3 + 2] * 3;

    const abx = pos[ib] - pos[ia];
    const aby = pos[ib + 1] - pos[ia + 1];
    const abz = pos[ib + 2] - pos[ia + 2];
    const acx = pos[ic] - pos[ia];
    const acy = pos[ic + 1] - pos[ia + 1];
    const acz = pos[ic + 2] - pos[ia + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);

    view.setFloat32(offset + 12, pos[ia], true);
    view.setFloat32(offset + 16, pos[ia + 1], true);
    view.setFloat32(offset + 20, pos[ia + 2], true);

    view.setFloat32(offset + 24, pos[ib], true);
    view.setFloat32(offset + 28, pos[ib + 1], true);
    view.setFloat32(offset + 32, pos[ib + 2], true);

    view.setFloat32(offset + 36, pos[ic], true);
    view.setFloat32(offset + 40, pos[ic + 1], true);
    view.setFloat32(offset + 44, pos[ic + 2], true);

    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }

  return new Blob([buffer], { type: 'model/stl' });
}

function serializeMeshXml(
  id: number,
  name: string,
  positions: Float32Array,
  indices: Uint32Array
): string {
  const verts: string[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    verts.push(
      `<vertex x="${positions[i].toFixed(3)}" y="${positions[i + 1].toFixed(3)}" z="${positions[i + 2].toFixed(3)}"/>`
    );
  }
  const tris: string[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    tris.push(`<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>`);
  }
  return `
    <object id="${id}" name="${name}" type="model">
      <mesh>
        <vertices>
          ${verts.join('\n          ')}
        </vertices>
        <triangles>
          ${tris.join('\n          ')}
        </triangles>
      </mesh>
    </object>`;
}

interface PartMeta {
  id: number;
  name: string;
  role: 'terrain' | 'water' | 'road' | 'forest' | 'alpine';
  triCount: number;
}

function appendTileModifierParts(
  mesh: GeneratedTileMesh,
  baseId: number,
  parts: PartMeta[],
  objectsXml: string[]
): void {
  const modifiers: Array<{
    offset: number;
    name: string;
    role: PartMeta['role'];
    positions?: Float32Array;
    indices?: Uint32Array;
  }> = [
    {
      offset: 1,
      name: `Water_Ironing_Zone_${mesh.label}`,
      role: 'water',
      positions: mesh.waterModifierPositions,
      indices: mesh.waterModifierIndices,
    },
    {
      offset: 2,
      name: `Road_Zone_${mesh.label}`,
      role: 'road',
      positions: mesh.roadModifierPositions,
      indices: mesh.roadModifierIndices,
    },
    {
      offset: 3,
      name: `Forest_Hilbert_Zone_${mesh.label}`,
      role: 'forest',
      positions: mesh.forestModifierPositions,
      indices: mesh.forestModifierIndices,
    },
    {
      offset: 4,
      name: `Alpine_Fuzzy_Zone_${mesh.label}`,
      role: 'alpine',
      positions: mesh.alpineModifierPositions,
      indices: mesh.alpineModifierIndices,
    },
  ];

  for (const mod of modifiers) {
    if (!mod.positions || !mod.indices || mod.indices.length === 0) continue;
    const id = baseId + mod.offset;
    objectsXml.push(serializeMeshXml(id, mod.name, mod.positions, mod.indices));
    parts.push({
      id,
      name: mod.name,
      role: mod.role,
      triCount: mod.indices.length / 3,
    });
  }
}

const ROLE_EXTRUDER: Record<PartMeta['role'], number> = {
  terrain: 1,
  water: 2,
  road: 3,
  forest: 4,
  alpine: 5,
};

function buildOrcaPartsXml(parts: PartMeta[], useModifier: boolean): string {
  return parts
    .map((c) => {
      const subtype = c.role === 'terrain' || !useModifier ? 'normal_part' : 'modifier_part';
      const extruder = ROLE_EXTRUDER[c.role];
      let extra = '';
      if (c.role === 'water') {
        extra = `
      <metadata key="ironing_type" value="top"/>
      <metadata key="ironing_flow" value="12"/>
      <metadata key="top_surface_pattern" value="monotonic"/>`;
      } else if (c.role === 'road') {
        extra = `
      <metadata key="ironing_type" value="top"/>
      <metadata key="top_surface_pattern" value="concentric"/>`;
      } else if (c.role === 'forest') {
        extra = `
      <metadata key="top_surface_pattern" value="hilbertcurve"/>`;
      } else if (c.role === 'alpine') {
        extra = `
      <metadata key="fuzzy_skin" value="external"/>
      <metadata key="fuzzy_skin_thickness" value="0.18"/>
      <metadata key="fuzzy_skin_point_distance" value="0.45"/>
      <metadata key="top_surface_pattern" value="archimedeanchords"/>`;
      }
      return `    <part id="${c.id}" subtype="${subtype}">
      <metadata key="name" value="${c.name}"/>
      <metadata key="extruder" value="${extruder}"/>${extra}
    </part>`;
    })
    .join('\n');
}

function buildMergedPrusaMeshXml(
  objectId: number,
  mesh: GeneratedTileMesh,
  txMm = 0,
  tyMm = 0
): { xml: string; parts: PartMeta[] } {
  const subMeshes: Array<{
    name: string;
    role: PartMeta['role'];
    positions: Float32Array;
    indices: Uint32Array;
  }> = [
    {
      name: `Terrain_${mesh.label}`,
      role: 'terrain',
      positions: mesh.positions,
      indices: mesh.indices,
    },
  ];
  if (mesh.waterModifierPositions && mesh.waterModifierIndices && mesh.waterModifierIndices.length > 0) {
    subMeshes.push({
      name: `Water_Ironing_Zone_${mesh.label}`,
      role: 'water',
      positions: mesh.waterModifierPositions,
      indices: mesh.waterModifierIndices,
    });
  }
  if (mesh.roadModifierPositions && mesh.roadModifierIndices && mesh.roadModifierIndices.length > 0) {
    subMeshes.push({
      name: `Road_Zone_${mesh.label}`,
      role: 'road',
      positions: mesh.roadModifierPositions,
      indices: mesh.roadModifierIndices,
    });
  }
  if (mesh.forestModifierPositions && mesh.forestModifierIndices && mesh.forestModifierIndices.length > 0) {
    subMeshes.push({
      name: `Forest_Hilbert_Zone_${mesh.label}`,
      role: 'forest',
      positions: mesh.forestModifierPositions,
      indices: mesh.forestModifierIndices,
    });
  }
  if (mesh.alpineModifierPositions && mesh.alpineModifierIndices && mesh.alpineModifierIndices.length > 0) {
    subMeshes.push({
      name: `Alpine_Fuzzy_Zone_${mesh.label}`,
      role: 'alpine',
      positions: mesh.alpineModifierPositions,
      indices: mesh.alpineModifierIndices,
    });
  }

  const vertsChunks: string[] = [];
  const trisChunks: string[] = [];
  const parts: PartMeta[] = [];
  let vertOffset = 0;

  for (const sub of subMeshes) {
    const vCount = sub.positions.length / 3;
    const tCount = sub.indices.length / 3;
    const vLines: string[] = [];
    for (let i = 0; i < sub.positions.length; i += 3) {
      vLines.push(
        `<vertex x="${(sub.positions[i] + txMm).toFixed(3)}" y="${(sub.positions[i + 1] + tyMm).toFixed(3)}" z="${sub.positions[i + 2].toFixed(3)}"/>`
      );
    }
    vertsChunks.push(vLines.join('\n          '));

    const tLines: string[] = [];
    for (let i = 0; i < sub.indices.length; i += 3) {
      tLines.push(
        `<triangle v1="${sub.indices[i] + vertOffset}" v2="${sub.indices[i + 1] + vertOffset}" v3="${sub.indices[i + 2] + vertOffset}"/>`
      );
    }
    trisChunks.push(tLines.join('\n          '));

    parts.push({
      id: objectId,
      name: sub.name,
      role: sub.role,
      triCount: tCount,
    });
    vertOffset += vCount;
  }

  const xml = `    <object id="${objectId}" name="Tile_${mesh.label}" type="model">
      <mesh>
        <vertices>
          ${vertsChunks.join('\n          ')}
        </vertices>
        <triangles>
          ${trisChunks.join('\n          ')}
        </triangles>
      </mesh>
    </object>`;

  return { xml, parts };
}

function buildPrusaVolumesXml(parts: PartMeta[], useModifier: boolean): string {
  let triCursor = 0;
  return parts
    .map((c) => {
      const firstId = triCursor;
      const lastId = triCursor + Math.max(1, c.triCount) - 1;
      triCursor += c.triCount;
      const volType = c.role === 'terrain' || !useModifier ? 'ModelPart' : 'ParameterModifier';
      const extruder = ROLE_EXTRUDER[c.role];
      let extra = '';
      if (c.role === 'water') {
        extra = `
      <metadata type="volume" key="ironing" value="1"/>
      <metadata type="volume" key="ironing_type" value="top"/>
      <metadata type="volume" key="ironing_flowrate" value="15%"/>
      <metadata type="volume" key="ironing_spacing" value="0.1"/>
      <metadata type="volume" key="ironing_speed" value="15"/>
      <metadata type="volume" key="top_fill_pattern" value="monotonic"/>`;
      } else if (c.role === 'road') {
        extra = `
      <metadata type="volume" key="ironing" value="1"/>
      <metadata type="volume" key="ironing_type" value="top"/>
      <metadata type="volume" key="ironing_flowrate" value="15%"/>
      <metadata type="volume" key="ironing_spacing" value="0.1"/>
      <metadata type="volume" key="ironing_speed" value="15"/>
      <metadata type="volume" key="top_fill_pattern" value="concentric"/>`;
      } else if (c.role === 'forest') {
        extra = `
      <metadata type="volume" key="top_fill_pattern" value="hilbertcurve"/>`;
      } else if (c.role === 'alpine') {
        extra = `
      <metadata type="volume" key="fuzzy_skin" value="external"/>
      <metadata type="volume" key="fuzzy_skin_thickness" value="0.18"/>
      <metadata type="volume" key="fuzzy_skin_point_distance" value="0.45"/>
      <metadata type="volume" key="top_fill_pattern" value="archimedeanchords"/>`;
      }
      return `    <volume firstid="${firstId}" lastid="${lastId}">
      <metadata type="volume" key="name" value="${c.name}"/>
      <metadata type="volume" key="volume_type" value="${volType}"/>
      <metadata type="volume" key="extruder" value="${extruder}"/>${extra}
    </volume>`;
    })
    .join('\n');
}

/**
 * Exports a 3MF archive compatible with BOTH OrcaSlicer/Bambu Studio AND PrusaSlicer.
 * Includes multi-part sub-meshes and selective-ironing modifier volumes for water/roads.
 */
export async function exportTileTo3MF(
  mesh: GeneratedTileMesh,
  format: ExportFormat
): Promise<Blob> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="text/xml"/>
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`
  );

  const isPrusaNative = format === '3mf-both';
  const useModifier = format === '3mf-both' || format === '3mf-orca';

  if (isPrusaNative) {
    const merged = buildMergedPrusaMeshXml(10, mesh);
    const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">TopoJigsaw Tile ${mesh.label}</metadata>
  <metadata name="Application">PrusaSlicer-2.9.0</metadata>
  <resources>
${merged.xml}
  </resources>
  <build>
    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </build>
</model>`;
    zip.file('3D/3dmodel.model', modelXml);

    const prusaVolumes = buildPrusaVolumesXml(merged.parts, true);
    zip.file(
      'Metadata/Slic3r_PE_model.config',
      `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="10" instances_count="1">
    <metadata type="object" key="name" value="Tile_${mesh.label}"/>
${prusaVolumes}
  </object>
</config>`
    );
  } else {
    const objectsXml: string[] = [
      serializeMeshXml(1, `Terrain_${mesh.label}`, mesh.positions, mesh.indices),
    ];
    const componentIds: PartMeta[] = [
      { id: 1, name: `Terrain_${mesh.label}`, role: 'terrain', triCount: mesh.indices.length / 3 },
    ];
    appendTileModifierParts(mesh, 1, componentIds, objectsXml);

    const componentsXml = componentIds
      .map((c) => `<component objectid="${c.id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`)
      .join('\n        ');

    const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">TopoJigsaw Tile ${mesh.label}</metadata>
  <metadata name="Application">TopoJigsaw PWA</metadata>
  <resources>
    ${objectsXml.join('\n')}
    <object id="10" name="Tile_${mesh.label}" type="model">
      <components>
        ${componentsXml}
      </components>
    </object>
  </resources>
  <build>
    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </build>
</model>`;

    zip.file('3D/3dmodel.model', modelXml);

    const orcaParts = buildOrcaPartsXml(componentIds, useModifier);
    zip.file(
      'Metadata/model_settings.config',
      `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="10">
    <metadata key="name" value="Tile_${mesh.label}"/>
    <metadata key="extruder" value="1"/>
${orcaParts}
  </object>
</config>`
    );
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportBatchZip(
  meshes: GeneratedTileMesh[],
  format: ExportFormat
): Promise<Blob> {
  const zip = new JSZip();
  for (const m of meshes) {
    if (format === 'stl') {
      zip.file(`tile_${m.label}.stl`, exportTileToSTL(m));
    } else {
      zip.file(`tile_${m.label}.3mf`, await exportTileTo3MF(m, format));
    }
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

export function exportPlateToSTL(plate: PackedPlate): Blob {
  let totalTris = 0;
  for (const it of plate.items) {
    totalTris += it.mesh.indices.length / 3;
  }

  const buffer = new ArrayBuffer(84 + totalTris * 50);
  const view = new DataView(buffer);
  const header = `TopoJigsaw Plate ${plate.plateIndex} (${plate.items.length} tiles, mm)`;
  for (let i = 0; i < Math.min(80, header.length); i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, totalTris, true);

  let offset = 84;
  for (const it of plate.items) {
    const pos = it.mesh.positions;
    const idx = it.mesh.indices;
    const tx = it.txMm;
    const ty = it.tyMm;
    const triCount = idx.length / 3;

    for (let t = 0; t < triCount; t++) {
      const ia = idx[t * 3] * 3;
      const ib = idx[t * 3 + 1] * 3;
      const ic = idx[t * 3 + 2] * 3;

      const abx = pos[ib] - pos[ia];
      const aby = pos[ib + 1] - pos[ia + 1];
      const abz = pos[ib + 2] - pos[ia + 2];
      const acx = pos[ic] - pos[ia];
      const acy = pos[ic + 1] - pos[ia + 1];
      const acz = pos[ic + 2] - pos[ia + 2];
      let nx = aby * acz - abz * acy;
      let ny = abz * acx - abx * acz;
      let nz = abx * acy - aby * acx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);

      view.setFloat32(offset + 12, pos[ia] + tx, true);
      view.setFloat32(offset + 16, pos[ia + 1] + ty, true);
      view.setFloat32(offset + 20, pos[ia + 2], true);

      view.setFloat32(offset + 24, pos[ib] + tx, true);
      view.setFloat32(offset + 28, pos[ib + 1] + ty, true);
      view.setFloat32(offset + 32, pos[ib + 2], true);

      view.setFloat32(offset + 36, pos[ic] + tx, true);
      view.setFloat32(offset + 40, pos[ic + 1] + ty, true);
      view.setFloat32(offset + 44, pos[ic + 2], true);

      view.setUint16(offset + 48, 0, true);
      offset += 50;
    }
  }

  return new Blob([buffer], { type: 'model/stl' });
}

export async function exportPlateTo3MF(
  plate: PackedPlate,
  format: ExportFormat
): Promise<Blob> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="text/xml"/>
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`
  );

  const objectsXml: string[] = [];
  const assembliesXml: string[] = [];
  const buildItemsXml: string[] = [];
  const orcaObjectsXml: string[] = [];
  const prusaObjectsXml: string[] = [];
  const isPrusaNative = format === '3mf-both';
  const useModifier = format === '3mf-both' || format === '3mf-orca';

  plate.items.forEach((item, idx) => {
    const m = item.mesh;
    const baseId = idx * 10 + 1;
    const assemblyId = baseId + 9;

    if (isPrusaNative) {
      const merged = buildMergedPrusaMeshXml(assemblyId, m, item.txMm, item.tyMm);
      objectsXml.push(merged.xml);
      buildItemsXml.push(
        `    <item objectid="${assemblyId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`
      );
      const prusaVols = buildPrusaVolumesXml(merged.parts, true);
      prusaObjectsXml.push(`  <object id="${assemblyId}" instances_count="1">
    <metadata type="object" key="name" value="Tile_${m.label}"/>
${prusaVols}
  </object>`);
    } else {
      const parts: PartMeta[] = [
        { id: baseId, name: `Terrain_${m.label}`, role: 'terrain', triCount: m.indices.length / 3 },
      ];
      objectsXml.push(serializeMeshXml(baseId, `Terrain_${m.label}`, m.positions, m.indices));
      appendTileModifierParts(m, baseId, parts, objectsXml);

      const comps = parts
        .map((p) => `<component objectid="${p.id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`)
        .join('\n        ');

      assembliesXml.push(`    <object id="${assemblyId}" name="Tile_${m.label}" type="model">
      <components>
        ${comps}
      </components>
    </object>`);

      buildItemsXml.push(
        `    <item objectid="${assemblyId}" transform="1 0 0 0 1 0 0 0 1 ${item.txMm.toFixed(3)} ${item.tyMm.toFixed(3)} 0"/>`
      );

      const orcaParts = buildOrcaPartsXml(parts, useModifier);
      orcaObjectsXml.push(`  <object id="${assemblyId}">
    <metadata key="name" value="Tile_${m.label}"/>
    <metadata key="extruder" value="1"/>
${orcaParts}
  </object>`);
    }
  });

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">TopoJigsaw Plate ${plate.plateIndex}</metadata>
  <metadata name="Application">${isPrusaNative ? 'PrusaSlicer-2.9.0' : 'TopoJigsaw PWA'}</metadata>
  <resources>
    ${objectsXml.join('\n')}
    ${assembliesXml.join('\n')}
  </resources>
  <build>
${buildItemsXml.join('\n')}
  </build>
</model>`;

  zip.file('3D/3dmodel.model', modelXml);

  if (isPrusaNative) {
    zip.file(
      'Metadata/Slic3r_PE_model.config',
      `<?xml version="1.0" encoding="UTF-8"?>
<config>
${prusaObjectsXml.join('\n')}
</config>`
    );
  } else {
    zip.file(
      'Metadata/model_settings.config',
      `<?xml version="1.0" encoding="UTF-8"?>
<config>
${orcaObjectsXml.join('\n')}
</config>`
    );
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function exportPackedPlatesZip(
  plates: PackedPlate[],
  format: ExportFormat
): Promise<Blob> {
  const zip = new JSZip();
  for (const plate of plates) {
    const pad = String(plate.plateIndex).padStart(2, '0');
    if (format === 'stl') {
      zip.file(`plate_${pad}.stl`, exportPlateToSTL(plate));
    } else {
      zip.file(`plate_${pad}.3mf`, await exportPlateTo3MF(plate, format));
    }
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}
