import { Grid3x3, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { handleToolbarKeyDown } from "../../lib/shortcuts";
import { IconButton } from "../ui/Tooltip";

interface Cad3dViewerProps {
  url: string;
  fileName: string;
}

function parseStlToGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
  const view = new DataView(buffer);
  const textHead = new TextDecoder().decode(
    new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength)),
  );
  const isBinary =
    buffer.byteLength >= 84 &&
    (!textHead.trimStart().startsWith("solid") ||
      84 + view.getUint32(80, true) * 50 === buffer.byteLength);

  const positions: number[] = [];

  if (isBinary) {
    const triCount = view.getUint32(80, true);
    let offset = 84;
    for (let i = 0; i < triCount && offset + 50 <= buffer.byteLength; i += 1) {
      offset += 12;
      for (let v = 0; v < 3; v += 1) {
        positions.push(
          view.getFloat32(offset, true),
          view.getFloat32(offset + 4, true),
          view.getFloat32(offset + 8, true),
        );
        offset += 12;
      }
      offset += 2;
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const regex =
      /vertex\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      positions.push(Number(match[1]), Number(match[2]), Number(match[3]));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}

export function Cad3dViewer({ url, fileName }: Cad3dViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const meshMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const wireframeRef = useRef(false);
  wireframeRef.current = wireframe;
  const [error, setError] = useState<{
    message: string;
    details: string | null;
  } | null>(null);

  useEffect(() => {
    if (meshMaterialRef.current) {
      meshMaterialRef.current.wireframe = wireframe;
    }
  }, [wireframe]);

  useEffect(() => {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext !== "stl") {
      setError({
        message: `Interactive 3D preview renders .stl meshes directly. Open in native app to inspect .${ext ?? "cad"} files.`,
        details: null,
      });
      return;
    }

    const container = containerRef.current;
    if (!container) return;
    setError(null);

    let disposed = false;
    let animId = 0;

    const scene = new THREE.Scene();
    const isDark = document.documentElement.classList.contains("dark");
    const cssBg =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--bg-viewport")
        .trim() || (isDark ? "#111216" : "#eef0f4");
    scene.background = new THREE.Color(cssBg);
    const width = container.clientWidth || 560;
    const height = container.clientHeight || 400;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.95);
    keyLight.position.set(1.5, 2.5, 3);
    scene.add(keyLight);

    const pivot = new THREE.Group();
    scene.add(pivot);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let distance = 4;

    resetViewRef.current = () => {
      pivot.rotation.set(0, 0, 0);
      distance = 4;
      camera.position.set(0, 0.6, distance);
      camera.lookAt(0, 0, 0);
    };

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      pivot.rotation.y += (e.clientX - lastX) * 0.01;
      pivot.rotation.x += (e.clientY - lastY) * 0.01;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = () => {
      dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      distance = Math.max(1.2, Math.min(20, distance + e.deltaY * 0.003));
      camera.position.z = distance;
    };

    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    dom.addEventListener("wheel", onWheel, { passive: false });

    void fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (disposed) return;
        const geometry = parseStlToGeometry(buf);
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        if (box) {
          const center = new THREE.Vector3();
          const size = new THREE.Vector3();
          box.getCenter(center);
          box.getSize(size);
          geometry.translate(-center.x, -center.y, -center.z);
          const maxDim = Math.max(size.x, size.y, size.z, 0.001);
          const scale = 2.0 / maxDim;
          geometry.scale(scale, scale, scale);
        }
        const cssMesh =
          getComputedStyle(document.documentElement)
            .getPropertyValue("--vp-mesh")
            .trim() || (isDark ? "#9aa0ae" : "#737b8c");
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(cssMesh),
          metalness: 0.2,
          roughness: 0.45,
          wireframe: wireframeRef.current,
        });
        meshMaterialRef.current = material;
        const mesh = new THREE.Mesh(geometry, material);
        pivot.add(mesh);
        camera.position.set(0, 0.6, distance);
        camera.lookAt(0, 0, 0);

        const renderLoop = () => {
          if (disposed) return;
          animId = requestAnimationFrame(renderLoop);
          renderer.render(scene, camera);
        };
        renderLoop();
      })
      .catch((err) => {
        if (!disposed) {
          setError({
            message:
              'We couldn\'t display this 3D model in the app. Use "Open in native app" to inspect it in your CAD viewer.',
            details: err instanceof Error ? err.message : String(err),
          });
        }
      });

    const resizeObserver = new ResizeObserver(() => {
      if (disposed || !container) return;
      const w = container.clientWidth || 560;
      const h = container.clientHeight || 400;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    const themeObserver = new MutationObserver(() => {
      if (disposed) return;
      const dark = document.documentElement.classList.contains("dark");
      const nextBg =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-viewport")
          .trim() || (dark ? "#111216" : "#eef0f4");
      scene.background = new THREE.Color(nextBg);
      if (meshMaterialRef.current) {
        const nextMesh =
          getComputedStyle(document.documentElement)
            .getPropertyValue("--vp-mesh")
            .trim() || (dark ? "#9aa0ae" : "#737b8c");
        meshMaterialRef.current.color = new THREE.Color(nextMesh);
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      meshMaterialRef.current = null;
      resetViewRef.current = null;
      cancelAnimationFrame(animId);
      dom.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dom.removeEventListener("wheel", onWheel);
      renderer.dispose();
    };
  }, [url, fileName]);

  if (error) {
    return (
      <div className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5 text-center text-xs text-[var(--text-secondary)]">
        <p>{error.message}</p>
        {error.details && (
          <details className="mt-2 text-[11px] text-[var(--text-muted)]">
            <summary className="cursor-pointer font-medium">Technical details</summary>
            <p className="mono-num mt-1 break-all">{error.details}</p>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[380px] w-full overflow-hidden rounded-md border border-[var(--border-hairline)] bg-[var(--bg-viewport)]">
      <div ref={containerRef} className="h-full w-full" />
      <div
        role="toolbar"
        aria-label="3D viewer controls"
        onKeyDown={handleToolbarKeyDown}
        className="absolute top-2 right-2 flex items-center gap-0.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-0.5"
      >
        <IconButton
          label="Toggle wireframe"
          size="xs"
          active={wireframe}
          onClick={() => setWireframe((w) => !w)}
        >
          <Grid3x3 className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
        <IconButton
          label="Reset camera"
          size="xs"
          onClick={() => resetViewRef.current?.()}
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
      </div>
    </div>
  );
}
