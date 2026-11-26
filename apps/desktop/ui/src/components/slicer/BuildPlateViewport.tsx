import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  MK3S_BED_X,
  MK3S_BED_Y,
  MK3S_BED_Z,
  buildObjectTransformMatrix,
  computeObjectPrinterBounds,
  type PlateObject,
} from "./plateGeometry";

interface BuildPlateViewportProps {
  objects: PlateObject[];
  selectedId: string | null;
  onSelectObject: (id: string | null) => void;
}

export function BuildPlateViewport({
  objects,
  selectedId,
  onSelectObject,
}: BuildPlateViewportProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const objectsGroupRef = useRef<THREE.Group | null>(null);
  const onSelectRef = useRef(onSelectObject);
  onSelectRef.current = onSelectObject;

  // Initialize Three.js scene, MK3S build plate, lighting, camera, and OrbitControls once.
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    sceneRef.current = scene;

    const width = container.clientWidth || 640;
    const height = container.clientHeight || 420;
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 2500);
    camera.position.set(170, 175, 235);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 20, 0);
    controls.maxDistance = 900;
    controls.minDistance = 40;
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(180, 280, 200);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x93c5fd, 0.45);
    fill.position.set(-160, 140, -180);
    scene.add(fill);

    // Prusa MK3S 250x210 mm steel sheet surface
    const bedGeom = new THREE.PlaneGeometry(MK3S_BED_X, MK3S_BED_Y);
    bedGeom.rotateX(-Math.PI / 2);
    const bedMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.75,
      metalness: 0.25,
    });
    const bedMesh = new THREE.Mesh(bedGeom, bedMat);
    bedMesh.position.y = -0.15;
    scene.add(bedMesh);

    // 10 mm grid lines across exact 250x210 mm MK3S bed
    const gridPositions: number[] = [];
    const halfX = MK3S_BED_X / 2;
    const halfY = MK3S_BED_Y / 2;
    for (let x = -halfX; x <= halfX; x += 10) {
      gridPositions.push(x, 0.02, -halfY, x, 0.02, halfY);
    }
    for (let z = -halfY; z <= halfY; z += 10) {
      gridPositions.push(-halfX, 0.02, z, halfX, 0.02, z);
    }
    const gridGeom = new THREE.BufferGeometry();
    gridGeom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(gridPositions, 3),
    );
    const gridMat = new THREE.LineBasicMaterial({
      color: 0x334155,
      transparent: true,
      opacity: 0.85,
    });
    scene.add(new THREE.LineSegments(gridGeom, gridMat));

    // Prusa orange front-edge indicator bar (Y = 0 on MK3S = +halfY in Three.js Z)
    const frontBarGeom = new THREE.BoxGeometry(MK3S_BED_X, 1.2, 2.5);
    const frontBarMat = new THREE.MeshBasicMaterial({ color: 0xf97316 });
    const frontBar = new THREE.Mesh(frontBarGeom, frontBarMat);
    frontBar.position.set(0, 0.4, halfY + 1.25);
    scene.add(frontBar);

    // Translucent 250x210x210 mm build volume wireframe cage
    const cageGeom = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(MK3S_BED_X, MK3S_BED_Z, MK3S_BED_Y),
    );
    const cageMat = new THREE.LineBasicMaterial({
      color: 0x475569,
      transparent: true,
      opacity: 0.4,
    });
    const cage = new THREE.LineSegments(cageGeom, cageMat);
    cage.position.set(0, MK3S_BED_Z / 2, 0);
    scene.add(cage);

    const objectsGroup = new THREE.Group();
    scene.add(objectsGroup);
    objectsGroupRef.current = objectsGroup;

    // Click-to-select objects on the build plate
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;
    const handlePointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const handlePointerUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(objectsGroup.children, false);
      if (hits.length > 0) {
        const hitId = hits[0].object.userData?.plateObjectId as
          | string
          | undefined;
        if (hitId) onSelectRef.current(hitId);
      }
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth || 640;
      const h = container.clientHeight || 420;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      controls.dispose();
      bedGeom.dispose();
      bedMat.dispose();
      gridGeom.dispose();
      gridMat.dispose();
      frontBarGeom.dispose();
      frontBarMat.dispose();
      cageGeom.dispose();
      cageMat.dispose();
      renderer.dispose();
    };
  }, []);

  // Sync PlateObjects into the 3D scene whenever objects or selection changes.
  useEffect(() => {
    const group = objectsGroupRef.current;
    if (!group) return;

    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if (child instanceof THREE.Mesh) {
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    }

    for (const obj of objects) {
      const { matrix } = buildObjectTransformMatrix(obj);
      const { outOfBounds } = computeObjectPrinterBounds(obj);
      const isSelected = obj.id === selectedId;
      const color = outOfBounds
        ? 0xef4444
        : isSelected
          ? 0xf97316
          : 0x3b82f6;
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.42,
        metalness: 0.12,
        emissive: isSelected ? 0x3b1704 : 0x000000,
      });
      const mesh = new THREE.Mesh(obj.geometry, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.userData = { plateObjectId: obj.id };
      group.add(mesh);
    }
  }, [objects, selectedId]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
      <div ref={mountRef} className="h-full w-full" />
      <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-lg bg-slate-900/80 px-2.5 py-1 text-[11px] font-medium text-slate-200 backdrop-blur-xs">
        <span className="h-2 w-2 rounded-full bg-orange-500" />
        Prusa MK3S · 250 × 210 × 210 mm
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-slate-900/75 px-2.5 py-1 text-[10px] text-slate-400 backdrop-blur-xs">
        Drag to orbit · Scroll to zoom · Click a part to select · Orange bar = front of bed
      </div>
    </div>
  );
}
