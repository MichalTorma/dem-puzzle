import * as maplibregl from 'maplibre-gl';
import type { GridShape, TileSpec } from '../types';
import { localMetersToLngLat, type FootprintShape } from './grid';

export interface ShaderOverlayState {
  visible: boolean;
  tiles: TileSpec[];
  selectedIds: Set<string>;
  pinLng: number;
  pinLat: number;
  pinPlantedAtMs: number;
  footprint: FootprintShape;
  gridShape: GridShape;
  radius: number;
  rectWidth: number;
  rectHeight: number;
  tilePrintSizeMm: number;
  gridRotationDeg: number;
}

function buildVertexSrc(prelude: string, define: string): string {
  return `#version 300 es
precision highp float;
${prelude}
${define}

layout(location = 0) in vec2 a_mercator;
layout(location = 1) in vec2 a_localMm;
layout(location = 2) in float a_edgeDist;
layout(location = 3) in float a_tileIdx;
layout(location = 4) in float a_tileHash;
layout(location = 5) in float a_isBackdrop;

out vec2 v_localMm;
out float v_edgeDist;
out float v_tileIdx;
out float v_tileHash;
out float v_isBackdrop;

void main() {
  gl_Position = projectTile(a_mercator);
  v_localMm = a_localMm;
  v_edgeDist = a_edgeDist;
  v_tileIdx = a_tileIdx;
  v_tileHash = a_tileHash;
  v_isBackdrop = a_isBackdrop;
}
`;
}

const FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_localMm;
in float v_edgeDist;
in float v_tileIdx;
in float v_tileHash;
in float v_isBackdrop;

uniform sampler2D u_selectedTex;
uniform float u_time;
uniform float u_pulseAge;
uniform float u_hoverHash;
uniform int u_footprintType; // 0 = hex-ring, 1 = circle, 2 = rect-frame
uniform float u_outerRadiusMm;
uniform vec2 u_outerHalfRectMm;
uniform float u_tileSizeMm;
uniform float u_hasTiles;

out vec4 fragColor;

float sdHexagon(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdOuterFootprint(vec2 p) {
  if (u_footprintType == 1) {
    return length(p) - u_outerRadiusMm;
  }
  if (u_footprintType == 2) {
    return sdBox(p, u_outerHalfRectMm);
  }
  // Hexagonal ring aligned with pointy-top tile cluster (outer vertices at 0, 60, 120, 180 deg)
  return sdHexagon(p, u_outerRadiusMm);
}

void main() {
  float distFromPin = length(v_localMm);

  // Expanding shockwave ripple when pin is planted
  float shock = 0.0;
  if (u_pulseAge >= 0.0 && u_pulseAge < 2.2) {
    float waveR = u_pulseAge * max(40.0, u_outerRadiusMm * 1.45);
    float band = exp(-pow((distFromPin - waveR) / max(8.0, u_tileSizeMm * 0.4), 2.0));
    shock = band * (1.0 - u_pulseAge / 2.2);
  }

  // Backdrop pass: outside dimming + outer glowing footprint halo + pin beacon
  if (v_isBackdrop > 0.5) {
    vec3 col = vec3(0.0);
    float alpha = 0.0;

    if (u_hasTiles > 0.5) {
      float sdf = sdOuterFootprint(v_localMm);
      float aa = max(1.0, fwidth(sdf));

      // Dim terrain outside the active footprint
      float outsideMask = smoothstep(-aa, aa * 2.0, sdf);
      col = mix(col, vec3(0.03, 0.06, 0.12), outsideMask);
      alpha = max(alpha, outsideMask * 0.48);

      // Glowing outer perimeter halo
      float border = exp(-abs(sdf) / max(2.2, u_tileSizeMm * 0.09));
      float innerRim = smoothstep(aa * 1.8, 0.0, abs(sdf));
      float shimmer = 0.85 + 0.15 * sin(distFromPin * 0.08 - u_time * 3.0);
      vec3 rimCol = mix(vec3(0.18, 0.72, 0.98), vec3(0.55, 0.92, 1.0), shimmer);
      col = mix(col, rimCol, clamp(border * 0.75 + innerRim, 0.0, 1.0));
      alpha = max(alpha, border * 0.55 + innerRim * 0.92);
    }

    // Shockwave ring
    if (shock > 0.01) {
      col = mix(col, vec3(0.45, 0.90, 1.0), clamp(shock * 1.3, 0.0, 1.0));
      alpha = max(alpha, shock * 0.85);
    }

    // Glowing pin beacon at localMm = (0, 0)
    float pinR = max(2.5, u_tileSizeMm * 0.11);
    float core = 1.0 - smoothstep(pinR * 0.45, pinR, distFromPin);
    float ring1 = exp(-pow((distFromPin - pinR * (1.7 + 0.35 * sin(u_time * 3.2))) / (pinR * 0.45), 2.0));
    float ring2 = exp(-pow((distFromPin - pinR * 3.2) / (pinR * 0.55), 2.0)) * (0.45 + 0.35 * cos(u_time * 2.1));
    float pinGlow = clamp(core + ring1 * 0.85 + ring2 * 0.6, 0.0, 1.0);
    if (pinGlow > 0.01) {
      vec3 beaconCol = mix(vec3(0.22, 0.74, 0.97), vec3(0.98, 0.85, 0.35), core);
      col = mix(col, beaconCol, pinGlow);
      alpha = max(alpha, pinGlow * 0.95);
    }

    if (alpha < 0.005) discard;
    fragColor = vec4(col * alpha, alpha);
    return;
  }

  // Tile polygon pass
  int tidx = int(v_tileIdx + 0.5);
  float isSelected = (tidx >= 0) ? texelFetch(u_selectedTex, ivec2(tidx & 255, tidx >> 8), 0).r : 0.0;
  float isHovered = (u_hoverHash > 0.5 && abs(v_tileHash - u_hoverHash) < 0.25) ? 1.0 : 0.0;
  float edgeWidth = max(0.015, fwidth(v_edgeDist) * 1.6);
  float borderMask = smoothstep(1.0 - edgeWidth * 1.8, 1.0, v_edgeDist);

  // Subtle holographic radial topo pulse across selected tiles
  float topoWave = 0.5 + 0.5 * sin(distFromPin * 0.14 - u_time * 2.6);
  float scanRing = exp(-pow(fract(distFromPin * 0.015 - u_time * 0.35) - 0.5, 2.0) * 18.0);

  vec3 fillCol = vec3(0.08, 0.15, 0.26);
  float fillAlpha = 0.06;

  if (isSelected > 0.5) {
    fillCol = mix(vec3(0.14, 0.66, 0.95), vec3(0.35, 0.88, 1.0), topoWave * 0.35 + scanRing * 0.25);
    fillAlpha = 0.24 + scanRing * 0.08;
  }

  if (isHovered > 0.5) {
    fillCol = mix(fillCol, vec3(0.98, 0.82, 0.36), 0.55);
    fillAlpha = max(fillAlpha, 0.38);
  }

  vec3 edgeCol = isSelected > 0.5
    ? vec3(0.45, 0.88, 1.0)
    : vec3(0.58, 0.66, 0.78);
  if (isHovered > 0.5) edgeCol = vec3(0.99, 0.86, 0.42);

  float edgeAlpha = isSelected > 0.5 ? 0.88 : 0.36;
  if (isHovered > 0.5) edgeAlpha = 0.98;

  float finalAlpha = mix(fillAlpha, edgeAlpha, borderMask);
  vec3 finalCol = mix(fillCol, edgeCol, borderMask);

  if (shock > 0.01) {
    finalCol = mix(finalCol, vec3(0.65, 0.95, 1.0), shock * 0.7);
    finalAlpha = max(finalAlpha, shock * 0.55);
  }

  if (finalAlpha < 0.005) discard;
  fragColor = vec4(finalCol * finalAlpha, finalAlpha);
}
`;

export function hashTileId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h & 0xffff) + 1;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compile error: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

interface CachedProgram {
  program: WebGLProgram;
  u_projection_matrix: WebGLUniformLocation | null;
  u_projection_fallback_matrix: WebGLUniformLocation | null;
  u_projection_transition: WebGLUniformLocation | null;
  u_projection_tile_mercator_coords: WebGLUniformLocation | null;
  u_projection_clipping_plane: WebGLUniformLocation | null;
  u_selectedTex: WebGLUniformLocation | null;
  u_time: WebGLUniformLocation | null;
  u_pulseAge: WebGLUniformLocation | null;
  u_hoverHash: WebGLUniformLocation | null;
  u_footprintType: WebGLUniformLocation | null;
  u_outerRadiusMm: WebGLUniformLocation | null;
  u_outerHalfRectMm: WebGLUniformLocation | null;
  u_tileSizeMm: WebGLUniformLocation | null;
  u_hasTiles: WebGLUniformLocation | null;
}

const SEL_TEX_W = 256;
const SEL_TEX_H = 8; // 2048 tiles max

export class PuzzleShaderLayer implements maplibregl.CustomLayerInterface {
  id = 'puzzle-shader-overlay';
  type = 'custom' as const;
  renderingMode = '2d' as const;

  private map: maplibregl.Map | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private programs = new Map<string, CachedProgram>();
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private selectedTex: WebGLTexture | null = null;
  private selectedData = new Uint8Array(SEL_TEX_W * SEL_TEX_H);
  private vertexCount = 0;
  private hoverHash = 0;
  private startTime = performance.now();
  private rafId: number | null = null;

  private state: ShaderOverlayState = {
    visible: false,
    tiles: [],
    selectedIds: new Set(),
    pinLng: 0,
    pinLat: 0,
    pinPlantedAtMs: -10000,
    footprint: 'hex-ring',
    gridShape: 'hex',
    radius: 2,
    rectWidth: 4,
    rectHeight: 4,
    tilePrintSizeMm: 30,
    gridRotationDeg: 0,
  };

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;

    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.selectedTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.selectedTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      SEL_TEX_W,
      SEL_TEX_H,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      this.selectedData
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 20);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 28);
    gl.bindVertexArray(null);

    this.rebuildBuffers();
    this.startLoop();
  }

  private getProgramForVariant(
    gl: WebGL2RenderingContext,
    shaderData: maplibregl.CustomRenderMethodInput['shaderData']
  ): CachedProgram {
    const key = shaderData.variantName;
    const existing = this.programs.get(key);
    if (existing) return existing;

    const vs = compileShader(
      gl,
      gl.VERTEX_SHADER,
      buildVertexSrc(shaderData.vertexShaderPrelude, shaderData.define)
    );
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const cached: CachedProgram = {
      program,
      u_projection_matrix: gl.getUniformLocation(program, 'u_projection_matrix'),
      u_projection_fallback_matrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
      u_projection_transition: gl.getUniformLocation(program, 'u_projection_transition'),
      u_projection_tile_mercator_coords: gl.getUniformLocation(
        program,
        'u_projection_tile_mercator_coords'
      ),
      u_projection_clipping_plane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
      u_selectedTex: gl.getUniformLocation(program, 'u_selectedTex'),
      u_time: gl.getUniformLocation(program, 'u_time'),
      u_pulseAge: gl.getUniformLocation(program, 'u_pulseAge'),
      u_hoverHash: gl.getUniformLocation(program, 'u_hoverHash'),
      u_footprintType: gl.getUniformLocation(program, 'u_footprintType'),
      u_outerRadiusMm: gl.getUniformLocation(program, 'u_outerRadiusMm'),
      u_outerHalfRectMm: gl.getUniformLocation(program, 'u_outerHalfRectMm'),
      u_tileSizeMm: gl.getUniformLocation(program, 'u_tileSizeMm'),
      u_hasTiles: gl.getUniformLocation(program, 'u_hasTiles'),
    };
    this.programs.set(key, cached);
    return cached;
  }

  onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.selectedTex) gl.deleteTexture(this.selectedTex);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    for (const c of this.programs.values()) {
      gl.deleteProgram(c.program);
    }
    this.programs.clear();
    this.map = null;
    this.gl = null;
  }

  private updateSelectedTexture(): void {
    const gl = this.gl;
    if (!gl || !this.selectedTex) return;
    const { tiles, selectedIds } = this.state;
    const limit = Math.min(tiles.length, SEL_TEX_W * SEL_TEX_H);
    for (let i = 0; i < limit; i++) {
      this.selectedData[i] = selectedIds.has(tiles[i].id) ? 255 : 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.selectedTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      SEL_TEX_W,
      SEL_TEX_H,
      gl.RED,
      gl.UNSIGNED_BYTE,
      this.selectedData
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  updateState(next: ShaderOverlayState): void {
    const geometryChanged =
      this.state.visible !== next.visible ||
      this.state.tiles !== next.tiles ||
      this.state.pinLng !== next.pinLng ||
      this.state.pinLat !== next.pinLat;
    const selectionChanged = geometryChanged || this.state.selectedIds !== next.selectedIds;

    this.state = next;
    if (geometryChanged) {
      this.rebuildBuffers();
    }
    if (selectionChanged) {
      this.updateSelectedTexture();
    }
    this.map?.triggerRepaint();
  }

  setHoverTileId(id: string | null): void {
    const nextHash = id ? hashTileId(id) : 0;
    if (nextHash === this.hoverHash) return;
    this.hoverHash = nextHash;
    this.map?.triggerRepaint();
  }

  private startLoop(): void {
    const tick = () => {
      if (this.map && this.state.visible) {
        this.map.triggerRepaint();
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private rebuildBuffers(): void {
    const gl = this.gl;
    if (!gl || !this.vbo || !this.vao) return;

    if (!this.state.visible) {
      this.vertexCount = 0;
      return;
    }

    const verts: number[] = [];
    const { tiles, pinLng, pinLat, tilePrintSizeMm } = this.state;

    // 1. Tile fill triangles (fan from tile center)
    for (let tIdx = 0; tIdx < tiles.length; tIdx++) {
      const t = tiles[tIdx];
      const cMerc = maplibregl.MercatorCoordinate.fromLngLat([t.centerLng, t.centerLat]);
      const th = hashTileId(t.id);
      const poly = t.polygonLngLat;
      const n = poly.length;

      // Approximate vertex localMm using tile circumradius offset from centerMm
      const rMm =
        this.state.gridShape === 'hex'
          ? tilePrintSizeMm / Math.sqrt(3)
          : tilePrintSizeMm * Math.SQRT1_2;

      for (let i = 0; i < n; i++) {
        const p0 = poly[i];
        const p1 = poly[(i + 1) % n];
        const m0 = maplibregl.MercatorCoordinate.fromLngLat([p0[0], p0[1]]);
        const m1 = maplibregl.MercatorCoordinate.fromLngLat([p1[0], p1[1]]);

        const ang0 =
          this.state.gridShape === 'hex'
            ? ((30 + i * 60) * Math.PI) / 180
            : ((45 + i * 90) * Math.PI) / 180;
        const ang1 =
          this.state.gridShape === 'hex'
            ? ((30 + ((i + 1) % n) * 60) * Math.PI) / 180
            : ((45 + ((i + 1) % n) * 90) * Math.PI) / 180;

        // Center
        verts.push(cMerc.x, cMerc.y, t.centerMmX, t.centerMmY, 0.0, tIdx, th, 0.0);
        // Edge start
        verts.push(
          m0.x,
          m0.y,
          t.centerMmX + rMm * Math.cos(ang0),
          t.centerMmY + rMm * Math.sin(ang0),
          1.0,
          tIdx,
          th,
          0.0
        );
        // Edge end
        verts.push(
          m1.x,
          m1.y,
          t.centerMmX + rMm * Math.cos(ang1),
          t.centerMmY + rMm * Math.sin(ang1),
          1.0,
          tIdx,
          th,
          0.0
        );
      }
    }

    // 2. Subdivided 12x12 backdrop mesh projected with exact localMetersToLngLat
    // so (0, 0) stays pinned to E0N0 at every zoom, latitude, pitch, and globe curvature.
    let metersPerMm = 100;
    let maxDistMm = tilePrintSizeMm * 4;
    const cosLat = Math.max(0.15, Math.cos((pinLat * Math.PI) / 180));
    for (const t of tiles) {
      const dMm = Math.hypot(t.centerMmX, t.centerMmY);
      if (dMm > maxDistMm) maxDistMm = dMm;
      if (dMm > tilePrintSizeMm * 0.5 && metersPerMm === 100) {
        const dEastM = (t.centerLng - pinLng) * 111320 * cosLat;
        const dNorthM = (t.centerLat - pinLat) * 111320;
        metersPerMm = Math.hypot(dEastM, dNorthM) / dMm;
      }
    }

    const spanMm = maxDistMm * 1.85 + tilePrintSizeMm * 3;
    const subN = 12;
    const gridPts: Array<{ mx: number; my: number; lx: number; ly: number }> = [];
    for (let r = 0; r <= subN; r++) {
      const ly = -spanMm + (2 * spanMm * r) / subN;
      for (let c = 0; c <= subN; c++) {
        const lx = -spanMm + (2 * spanMm * c) / subN;
        const [lng, lat] = localMetersToLngLat(
          lx * metersPerMm,
          ly * metersPerMm,
          pinLng,
          pinLat,
          this.state.gridRotationDeg
        );
        const mc = maplibregl.MercatorCoordinate.fromLngLat([lng, lat]);
        gridPts.push({ mx: mc.x, my: mc.y, lx, ly });
      }
    }

    const strideN = subN + 1;
    for (let r = 0; r < subN; r++) {
      for (let c = 0; c < subN; c++) {
        const p00 = gridPts[r * strideN + c];
        const p10 = gridPts[r * strideN + c + 1];
        const p11 = gridPts[(r + 1) * strideN + c + 1];
        const p01 = gridPts[(r + 1) * strideN + c];

        verts.push(p00.mx, p00.my, p00.lx, p00.ly, 0, -1, 0, 1);
        verts.push(p10.mx, p10.my, p10.lx, p10.ly, 0, -1, 0, 1);
        verts.push(p11.mx, p11.my, p11.lx, p11.ly, 0, -1, 0, 1);

        verts.push(p00.mx, p00.my, p00.lx, p00.ly, 0, -1, 0, 1);
        verts.push(p11.mx, p11.my, p11.lx, p11.ly, 0, -1, 0, 1);
        verts.push(p01.mx, p01.my, p01.lx, p01.ly, 0, -1, 0, 1);
      }
    }

    this.vertexCount = verts.length / 8;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);

    const stride = 8 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 20);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 28);
    gl.bindVertexArray(null);
  }

  render(gl: WebGL2RenderingContext, options: maplibregl.CustomRenderMethodInput): void {
    if (!this.state.visible || !this.vao || this.vertexCount === 0) return;

    const proj = options.defaultProjectionData;
    if (!proj?.mainMatrix) return;

    const cached = this.getProgramForVariant(gl, options.shaderData);
    gl.useProgram(cached.program);
    gl.bindVertexArray(this.vao);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.selectedTex);
    gl.uniform1i(cached.u_selectedTex, 0);

    const nowSec = (performance.now() - this.startTime) / 1000;
    const pulseAge = (performance.now() - this.state.pinPlantedAtMs) / 1000;

    const fpType =
      this.state.footprint === 'circle' ? 1 : this.state.footprint === 'rect-frame' ? 2 : 0;
    const outerRadiusMm =
      this.state.footprint === 'circle'
        ? (this.state.radius + 0.35) * this.state.tilePrintSizeMm
        : (this.state.radius + 0.5) * this.state.tilePrintSizeMm;
    const halfRectW =
      this.state.rectWidth * 0.5 * this.state.tilePrintSizeMm + this.state.tilePrintSizeMm * 0.15;
    const halfRectH =
      this.state.rectHeight * 0.5 * this.state.tilePrintSizeMm + this.state.tilePrintSizeMm * 0.15;

    gl.uniformMatrix4fv(cached.u_projection_matrix, false, proj.mainMatrix);
    gl.uniformMatrix4fv(cached.u_projection_fallback_matrix, false, proj.fallbackMatrix);
    gl.uniform1f(cached.u_projection_transition, proj.projectionTransition);
    gl.uniform4fv(cached.u_projection_tile_mercator_coords, proj.tileMercatorCoords);
    gl.uniform4fv(cached.u_projection_clipping_plane, proj.clippingPlane);

    gl.uniform1f(cached.u_time, nowSec);
    gl.uniform1f(cached.u_pulseAge, pulseAge);
    gl.uniform1f(cached.u_hoverHash, this.hoverHash);
    gl.uniform1i(cached.u_footprintType, fpType);
    gl.uniform1f(cached.u_outerRadiusMm, outerRadiusMm);
    gl.uniform2f(cached.u_outerHalfRectMm, halfRectW, halfRectH);
    gl.uniform1f(cached.u_tileSizeMm, this.state.tilePrintSizeMm);
    gl.uniform1f(cached.u_hasTiles, this.state.tiles.length > 0 ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    gl.bindVertexArray(null);
  }
}
