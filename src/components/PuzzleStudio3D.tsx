import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GeneratedTileMesh, PreviewMode } from '../types';

interface PuzzleStudio3DProps {
  meshes: GeneratedTileMesh[];
  explodeFactor: number;
  previewMode: PreviewMode;
  singleFilamentColor: string;
  activeTileId: string | null;
  onSelectTile: (id: string) => void;
}

export function PuzzleStudio3D({
  meshes,
  explodeFactor,
  previewMode,
  singleFilamentColor,
  activeTileId,
  onSelectTile,
}: PuzzleStudio3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const puzzleGroupRef = useRef<THREE.Group | null>(null);
  const tileGroupsRef = useRef<Map<string, { group: THREE.Group; baseX: number; baseY: number }>>(
    new Map()
  );
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const onSelectTileRef = useRef(onSelectTile);
  onSelectTileRef.current = onSelectTile;

  // Initialize WebGL 2 Three.js scene once
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#090d14');
    scene.fog = new THREE.FogExp2('#090d14', 0.00085);

    const camera = new THREE.PerspectiveCamera(
      42,
      container.clientWidth / Math.max(1, container.clientHeight),
      1,
      4000
    );
    camera.position.set(180, 185, 230);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI * 0.49;

    // Studio 3-point + hemisphere lighting
    const hemi = new THREE.HemisphereLight('#b8d4ff', '#1e2430', 0.85);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight('#fff4e6', 2.2);
    keyLight.position.set(180, 260, 140);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 20;
    keyLight.shadow.camera.far = 900;
    const d = 280;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0004;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight('#38bdf8', 0.7);
    rimLight.position.set(-200, 90, -180);
    scene.add(rimLight);

    // Architectural studio build-plate grid
    const grid = new THREE.GridHelper(640, 32, '#1e293b', '#111827');
    grid.position.y = -0.2;
    scene.add(grid);

    const puzzleGroup = new THREE.Group();
    // Convert mesh Z-up to Three.js Y-up
    puzzleGroup.rotation.x = -Math.PI / 2;
    scene.add(puzzleGroup);

    sceneRef.current = scene;
    puzzleGroupRef.current = puzzleGroup;
    cameraRef.current = camera;
    controlsRef.current = controls;

    // Raycast click to select individual tile
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPos = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(puzzleGroup.children, true);
      const hitTileId = hits[0]?.object?.userData?.tileId as string | undefined;
      if (hitTileId) onSelectTileRef.current(hitTileId);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    const onResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Rebuild meshes when generated data changes
  useEffect(() => {
    const puzzleGroup = puzzleGroupRef.current;
    if (!puzzleGroup) return;

    // Dispose old geometries and unique materials
    const disposedMats = new Set<THREE.Material>();
    for (const { group } of tileGroupsRef.current.values()) {
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) {
            if (!disposedMats.has(mat)) {
              disposedMats.add(mat);
              mat.dispose();
            }
          }
        }
      });
      puzzleGroup.remove(group);
    }
    tileGroupsRef.current.clear();

    if (meshes.length === 0) return;

    // Compute centroid so puzzle is centered at world origin
    let avgX = 0;
    let avgY = 0;
    for (const m of meshes) {
      avgX += m.centerMmX;
      avgY += m.centerMmY;
    }
    avgX /= meshes.length;
    avgY /= meshes.length;

    const isIroning = previewMode === 'ironing';
    const isClay = previewMode === 'clay';
    const isMulti = previewMode === 'multicolor';

    // Share one material across all non-active tiles to avoid N shader/uniform allocations
    const sharedBaseMat = new THREE.MeshStandardMaterial({
      vertexColors: isMulti,
      color: isMulti ? '#ffffff' : isClay ? '#e5e0d8' : singleFilamentColor,
      roughness: isIroning ? 0.94 : isClay ? 0.86 : 0.68,
      metalness: isIroning ? 0.02 : 0.04,
    });

    const sharedActiveMat = new THREE.MeshStandardMaterial({
      vertexColors: isMulti,
      color: isMulti ? '#ffffff' : isClay ? '#e5e0d8' : singleFilamentColor,
      roughness: isIroning ? 0.94 : isClay ? 0.86 : 0.68,
      metalness: isIroning ? 0.02 : 0.04,
      emissive: new THREE.Color('#0ea5e9'),
      emissiveIntensity: 0.14,
    });

    const sharedIronedMat = isIroning
      ? new THREE.MeshPhysicalMaterial({
          color: singleFilamentColor,
          roughness: 0.05,
          metalness: 0.08,
          clearcoat: 1.0,
          clearcoatRoughness: 0.04,
          reflectivity: 0.95,
        })
      : null;

    for (const m of meshes) {
      const tileGroup = new THREE.Group();
      const baseX = m.centerMmX - avgX;
      const baseY = m.centerMmY - avgY;
      tileGroup.position.set(baseX * (1 + explodeFactor), baseY * (1 + explodeFactor), 0);

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      geom.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
      geom.setIndex(new THREE.BufferAttribute(m.indices, 1));

      const isActive = m.tileId === activeTileId;
      const meshObj = new THREE.Mesh(geom, isActive ? sharedActiveMat : sharedBaseMat);
      meshObj.castShadow = true;
      meshObj.receiveShadow = true;
      meshObj.userData = { tileId: m.tileId };
      tileGroup.add(meshObj);

      // In single-color selective ironing preview, render ironed water & road zones as glossy clearcoated same-filament surfaces
      if (sharedIronedMat) {
        const addIronedZone = (pos?: Float32Array, idx?: Uint32Array) => {
          if (!pos || !idx || idx.length === 0) return;
          const zGeom = new THREE.BufferGeometry();
          zGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          zGeom.setIndex(new THREE.BufferAttribute(idx, 1));
          zGeom.computeVertexNormals();
          const zMesh = new THREE.Mesh(zGeom, sharedIronedMat);
          zMesh.receiveShadow = true;
          zMesh.userData = { tileId: m.tileId };
          tileGroup.add(zMesh);
        };

        addIronedZone(m.waterModifierPositions, m.waterModifierIndices);
        addIronedZone(m.roadModifierPositions, m.roadModifierIndices);
      }

      puzzleGroup.add(tileGroup);
      tileGroupsRef.current.set(m.tileId, { group: tileGroup, baseX, baseY });
    }
  }, [meshes, previewMode, singleFilamentColor, activeTileId]);

  // Smoothly update explode offset without rebuilding geometries
  useEffect(() => {
    for (const { group, baseX, baseY } of tileGroupsRef.current.values()) {
      group.position.set(baseX * (1 + explodeFactor), baseY * (1 + explodeFactor), 0);
    }
  }, [explodeFactor]);

  return <div ref={mountRef} className="studio-canvas" />;
}
