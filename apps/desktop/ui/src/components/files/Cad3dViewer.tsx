import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

interface Cad3dViewerProps {
  url: string;
  fileName: string;
}

function parseStlToGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
  const view = new DataView(buffer);
  const textHead = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength)));
  const isBinary =
    buffer.byteLength >= 84 &&
    (!textHead.trimStart().startsWith("solid") ||
      84 + view.getUint32(80, true) * 50 === buffer.byteLength);

  const positions: number[] = [];

  if (isBinary) {
    const triCount = view.getUint32(80, true);
    let offset = 84;
    for (let i = 0; i < triCount && offset + 50 <= buffer.byteLength; i += 1) {
      offset += 12; // skip normal
      for (let v = 0; v < 3; v += 1) {
        positions.push(
          view.getFloat32(offset, true),
          view.getFloat32(offset + 4, true),
          view.getFloat32(offset + 8, true),
        );
        offset += 12;
      }
      offset += 2; // attribute byte count
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const regex = /vertex\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext !== "stl") {
      setError(
        `Interactive 3D preview currently renders .stl meshes directly. Click "Open in Native App" to inspect .${ext ?? "cad"} files.`,
      );
      return;
    }

    const container = containerRef.current;
    if (!container) return;
    setError(null);

    let disposed = false;
    let animId = 0;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 420;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(1, 2, 3);
    scene.add(keyLight);

    const pivot = new THREE.Group();
    scene.add(pivot);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let distance = 4;

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
        const material = new THREE.MeshStandardMaterial({
          color: 0x38bdf8,
          metalness: 0.25,
          roughness: 0.45,
        });
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
          setError(`Failed to load 3D model (${err instanceof Error ? err.message : String(err)}).`);
        }
      });

    return () => {
      disposed = true;
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
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Drag to orbit · Scroll to zoom
      </p>
      <div
        ref={containerRef}
        className="h-[440px] w-full overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800"
      />
    </div>
  );
}
