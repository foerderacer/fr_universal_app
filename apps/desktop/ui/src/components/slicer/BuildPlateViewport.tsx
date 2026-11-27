import {
  ArrowDownToLine,
  Box,
  Grid3x3,
  Layers,
  RotateCcw,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  areSingleKeyShortcutsEnabled,
  handleToolbarKeyDown,
  hasActiveOverlay,
  isBlockedArrowScope,
  isEditableTarget,
} from "../../lib/shortcuts";
import { IconButton } from "../ui/Tooltip";
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
  onMoveObject?: (id: string, positionX: number, positionY: number) => void;
}

type CameraPreset = "iso" | "top" | "front";

function readCssTokenColor(
  token: string,
  darkFallback: string,
  lightFallback: string,
): THREE.Color {
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  if (val) return new THREE.Color(val);
  const isDark = document.documentElement.classList.contains("dark");
  return new THREE.Color(isDark ? darkFallback : lightFallback);
}

export function BuildPlateViewport({
  objects,
  selectedId,
  onSelectObject,
  onMoveObject,
}: BuildPlateViewportProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const objectsGroupRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const clipPlaneRef = useRef<THREE.Plane>(
    new THREE.Plane(new THREE.Vector3(0, -1, 0), MK3S_BED_Z + 1),
  );

  const onSelectRef = useRef(onSelectObject);
  onSelectRef.current = onSelectObject;
  const onMoveRef = useRef(onMoveObject);
  onMoveRef.current = onMoveObject;
  const objectsRef = useRef(objects);
  objectsRef.current = objects;

  const [wireframe, setWireframe] = useState(false);
  const [layerPreview, setLayerPreview] = useState(false);
  const [clipZMm, setClipZMm] = useState(MK3S_BED_Z);

  const maxModelHeightMm = objects.reduce((acc, o) => {
    const b = computeObjectPrinterBounds(o);
    return Math.max(acc, Math.ceil(b.maxZ));
  }, 60);

  useEffect(() => {
    if (!layerPreview) {
      clipPlaneRef.current.constant = MK3S_BED_Z + 10;
    } else {
      const clamped = Math.min(clipZMm, maxModelHeightMm);
      clipPlaneRef.current.constant = clamped;
    }
  }, [layerPreview, clipZMm, maxModelHeightMm]);

  const applyCameraPreset = useCallback((preset: CameraPreset) => {
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    if (!cam || !ctrl) return;
    const aspect = cam.aspect || 1;
    // Scale camera distance gently on narrow viewports so the full 250×210×210mm build volume never crops
    const fitScale = aspect < 1.35 ? 1.42 / Math.max(0.75, aspect) : 1.1;
    if (preset === "top") {
      cam.position.set(0, 340 * fitScale, 0.01);
      ctrl.target.set(0, 0, 0);
    } else if (preset === "front") {
      cam.position.set(0, 80, 320 * fitScale);
      ctrl.target.set(0, 48, 0);
    } else {
      cam.position.set(240 * fitScale, 225 * fitScale, 310 * fitScale);
      ctrl.target.set(0, 40, 0);
    }
    ctrl.update();
  }, []);

  // Viewport keyboard shortcuts matching tooltip hints: 1 (Iso), 2 (Top), 3 (Front), W (Wireframe), L (Layer Z-cut)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!areSingleKeyShortcutsEnabled()) return;
      if (hasActiveOverlay()) {
        return;
      }
      if (isEditableTarget(e.target)) {
        return;
      }
      // Do not hijack viewport keys when keyboard focus sits inside sidebars, headers, or radio presets
      if (isBlockedArrowScope(document.activeElement)) {
        return;
      }
      if (e.key === "1") {
        e.preventDefault();
        applyCameraPreset("iso");
      } else if (e.key === "2") {
        e.preventDefault();
        applyCameraPreset("top");
      } else if (e.key === "3") {
        e.preventDefault();
        applyCameraPreset("front");
      } else if (e.key.toLowerCase() === "w") {
        e.preventDefault();
        setWireframe((w) => !w);
      } else if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        setLayerPreview((prev) => {
          const next = !prev;
          if (next) setClipZMm(maxModelHeightMm);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyCameraPreset, maxModelHeightMm]);

  // Initialize Three.js scene, MK3S build plate, lighting, camera, OrbitControls, and direct plate dragging.
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = readCssTokenColor("--bg-viewport", "#111216", "#eef0f4");
    sceneRef.current = scene;

    const width = container.clientWidth || 640;
    const height = container.clientHeight || 420;
    const aspect = width / height;
    const fitScale = aspect < 1.35 ? 1.42 / Math.max(0.75, aspect) : 1.1;
    const camera = new THREE.PerspectiveCamera(40, aspect, 0.5, 2500);
    camera.position.set(240 * fitScale, 225 * fitScale, 310 * fitScale);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.localClippingEnabled = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 18, 0);
    controls.maxDistance = 900;
    controls.minDistance = 40;
    controls.update();
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const key = new THREE.DirectionalLight(0xffffff, 0.92);
    key.position.set(180, 280, 200);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd4d8e2, 0.35);
    fill.position.set(-160, 140, -180);
    scene.add(fill);

    // Neutral charcoal steel build plate (250x210 mm) read from CSS tokens
    const bedGeom = new THREE.PlaneGeometry(MK3S_BED_X, MK3S_BED_Y);
    bedGeom.rotateX(-Math.PI / 2);
    const bedMat = new THREE.MeshStandardMaterial({
      color: readCssTokenColor("--vp-plate", "#191b21", "#e2e5ec"),
      roughness: 0.84,
      metalness: 0.16,
    });
    const bedMesh = new THREE.Mesh(bedGeom, bedMat);
    bedMesh.position.y = -0.15;
    scene.add(bedMesh);

    // Subtle 10 mm grid lines
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
      color: readCssTokenColor("--vp-grid", "#292c36", "#cdd2de"),
      transparent: true,
      opacity: 0.9,
    });
    scene.add(new THREE.LineSegments(gridGeom, gridMat));

    // Restrained hairline front-edge orientation strip (Y = 0 on MK3S = +halfY in Three.js Z)
    const frontBarGeom = new THREE.BoxGeometry(MK3S_BED_X, 0.45, 0.7);
    const frontBarMat = new THREE.MeshBasicMaterial({
      color: readCssTokenColor("--vp-front-edge", "#4e5678", "#6f77b8"),
      transparent: true,
      opacity: 0.85,
    });
    const frontBar = new THREE.Mesh(frontBarGeom, frontBarMat);
    frontBar.position.set(0, 0.2, halfY + 0.35);
    scene.add(frontBar);

    // Hairline 250x210x210 mm build volume wireframe
    const cageGeom = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(MK3S_BED_X, MK3S_BED_Z, MK3S_BED_Y),
    );
    const cageMat = new THREE.LineBasicMaterial({
      color: readCssTokenColor("--vp-cage", "#343845", "#bcc2d0"),
      transparent: true,
      opacity: 0.45,
    });
    const cage = new THREE.LineSegments(cageGeom, cageMat);
    cage.position.set(0, MK3S_BED_Z / 2, 0);
    scene.add(cage);

    const objectsGroup = new THREE.Group();
    scene.add(objectsGroup);
    objectsGroupRef.current = objectsGroup;

    // Click-to-select & direct drag-to-move on the MK3S build plate plane (y = 0)
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const bedPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const planeHit = new THREE.Vector3();

    let draggingObjectId: string | null = null;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const setPointerFromEvent = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      setPointerFromEvent(e);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(objectsGroup.children, false);
      if (hits.length > 0) {
        const hitId = hits[0].object.userData?.plateObjectId as
          | string
          | undefined;
        if (hitId) {
          onSelectRef.current(hitId);
          if (onMoveRef.current && raycaster.ray.intersectPlane(bedPlane, planeHit)) {
            const obj = objectsRef.current.find((o) => o.id === hitId);
            if (obj) {
              // Printer X = threeX + halfX; Printer Y = halfY - threeZ
              const hitPrinterX = planeHit.x + halfX;
              const hitPrinterY = halfY - planeHit.z;
              draggingObjectId = hitId;
              dragOffsetX = obj.positionX - hitPrinterX;
              dragOffsetY = obj.positionY - hitPrinterY;
              controls.enabled = false;
              renderer.domElement.style.cursor = "grabbing";
            }
          }
        }
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!draggingObjectId || !onMoveRef.current) return;
      setPointerFromEvent(e);
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.ray.intersectPlane(bedPlane, planeHit)) {
        const rawX = planeHit.x + halfX + dragOffsetX;
        const rawY = halfY - planeHit.z + dragOffsetY;
        const nextX = Math.max(
          -40,
          Math.min(MK3S_BED_X + 40, Math.round(rawX * 2) / 2),
        );
        const nextY = Math.max(
          -40,
          Math.min(MK3S_BED_Y + 40, Math.round(rawY * 2) / 2),
        );
        onMoveRef.current(draggingObjectId, nextX, nextY);
      }
    };

    const handlePointerUp = () => {
      if (draggingObjectId) {
        draggingObjectId = null;
        controls.enabled = true;
        renderer.domElement.style.cursor = "";
      }
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth || 640;
      const h = container.clientHeight || 420;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    const themeObserver = new MutationObserver(() => {
      scene.background = readCssTokenColor("--bg-viewport", "#111216", "#eef0f4");
      bedMat.color = readCssTokenColor("--vp-plate", "#191b21", "#e2e5ec");
      gridMat.color = readCssTokenColor("--vp-grid", "#292c36", "#cdd2de");
      frontBarMat.color = readCssTokenColor(
        "--vp-front-edge",
        "#4e5678",
        "#6f77b8",
      );
      cageMat.color = readCssTokenColor("--vp-cage", "#343845", "#bcc2d0");
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      controls.dispose();
      cameraRef.current = null;
      controlsRef.current = null;
      while (objectsGroup.children.length > 0) {
        const child = objectsGroup.children[0];
        objectsGroup.remove(child);
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          if (child.userData?.ownsGeometry) child.geometry.dispose();
          const mat = child.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      }
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

  // Sync PlateObjects into the 3D scene whenever objects, selection, wireframe, or clipping changes.
  useEffect(() => {
    const group = objectsGroupRef.current;
    if (!group) return;

    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        if (child.userData?.ownsGeometry) child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    }

    const meshColor = readCssTokenColor("--vp-mesh", "#9aa0ae", "#737b8c");
    const selectedEdgeColor = readCssTokenColor(
      "--vp-mesh-selected",
      "#636ec9",
      "#555fc4",
    );
    const oobColor = readCssTokenColor("--vp-mesh-oob", "#e5534b", "#c93b34");

    for (const obj of objects) {
      const { matrix } = buildObjectTransformMatrix(obj);
      const { outOfBounds } = computeObjectPrinterBounds(obj);
      const isSelected = obj.id === selectedId;
      // Keep 3D meshes 95% neutral monochrome; signify selection with a crisp hairline edge overlay
      const mat = new THREE.MeshStandardMaterial({
        color: outOfBounds ? oobColor : meshColor,
        roughness: 0.46,
        metalness: 0.16,
        wireframe,
        clippingPlanes: [clipPlaneRef.current],
        side: layerPreview ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(obj.geometry, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.userData = { plateObjectId: obj.id };
      group.add(mesh);

      if (isSelected && !wireframe) {
        const edgeGeom = new THREE.EdgesGeometry(obj.geometry, 24);
        const edgeMat = new THREE.LineBasicMaterial({
          color: outOfBounds ? oobColor : selectedEdgeColor,
          transparent: true,
          opacity: 0.9,
          clippingPlanes: [clipPlaneRef.current],
        });
        const edges = new THREE.LineSegments(edgeGeom, edgeMat);
        edges.matrixAutoUpdate = false;
        edges.matrix.copy(matrix);
        edges.userData = { ownsGeometry: true };
        group.add(edges);
      }
    }
  }, [objects, selectedId, wireframe, layerPreview]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--bg-viewport)]">
      <div ref={mountRef} className="h-full w-full" />

      {/* Minimal Floating Icon-Only Viewport Controls (solid neutral surface, crisp hairline, no blur) */}
      <div
        role="toolbar"
        aria-label="Viewport camera and display controls"
        onKeyDown={handleToolbarKeyDown}
        className="absolute top-3 right-3 flex items-center gap-0.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-viewport-overlay)] p-0.5"
      >
        <IconButton
          size="xs"
          label="Isometric view"
          shortcut="1"
          onClick={() => applyCameraPreset("iso")}
        >
          <Box className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
        <IconButton
          size="xs"
          label="Top view"
          shortcut="2"
          onClick={() => applyCameraPreset("top")}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
        <IconButton
          size="xs"
          label="Front view"
          shortcut="3"
          onClick={() => applyCameraPreset("front")}
        >
          <Square className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
        <span className="mx-0.5 h-3.5 w-px bg-[var(--border-hairline)]" />
        <IconButton
          size="xs"
          label="Wireframe"
          shortcut="W"
          active={wireframe}
          onClick={() => setWireframe((w) => !w)}
        >
          <Grid3x3 className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
        <IconButton
          size="xs"
          label="Layer Z-clip preview"
          shortcut="L"
          active={layerPreview}
          onClick={() => {
            setLayerPreview((prev) => {
              const next = !prev;
              if (next) setClipZMm(maxModelHeightMm);
              return next;
            });
          }}
        >
          <Layers className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
        <span className="mx-0.5 h-3.5 w-px bg-[var(--border-hairline)]" />
        <IconButton
          size="xs"
          label="Reset camera"
          onClick={() => applyCameraPreset("iso")}
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
      </div>

      {/* Layer Z-clip slider overlay (only visible when Layer Preview is toggled) */}
      {layerPreview && (
        <div className="absolute right-3 bottom-3 flex items-center gap-2.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-viewport-overlay)] px-2.5 py-1.5">
          <span className="text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
            Z-Cut
          </span>
          <input
            type="range"
            min={0.4}
            max={Math.max(10, maxModelHeightMm)}
            step={0.2}
            value={Math.min(clipZMm, Math.max(10, maxModelHeightMm))}
            onChange={(e) => setClipZMm(Number(e.target.value))}
            aria-label="Layer height cut in millimeters"
            className="fr-slider w-32"
          />
          <span className="mono-num w-14 text-right text-[11px] text-[var(--text-primary)]">
            {Math.min(clipZMm, Math.max(10, maxModelHeightMm)).toFixed(1)} mm
          </span>
        </div>
      )}

      {/* Subtle corner plate coordinate readout */}
      <div className="mono-num pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-viewport-overlay)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
        <span>MK3S · 250×210×210 mm · Drag or ↑↓←→ 1mm (Shift 5mm)</span>
      </div>
    </div>
  );
}
