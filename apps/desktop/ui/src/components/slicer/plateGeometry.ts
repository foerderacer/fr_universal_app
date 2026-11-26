import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { PlateBoundsMm } from "../../bindings/tauri";

export const MK3S_BED_X = 250;
export const MK3S_BED_Y = 210;
export const MK3S_BED_Z = 210;

export interface PlateObject {
  id: string;
  name: string;
  /** Printer X center in mm (0..250). */
  positionX: number;
  /** Printer Y center in mm (0..210). */
  positionY: number;
  /** Rotation in degrees around printer X/Y/Z axes. */
  rotXDeg: number;
  rotYDeg: number;
  rotZDeg: number;
  /** Uniform scale percentage (10..500). */
  scalePercent: number;
  /** Unscaled, unrotated dimensions in printer mm (X, Y, Z). */
  baseSizeMm: { x: number; y: number; z: number };
  /** Normalized Three.js geometry centered in X/Z with min Y = 0 (Y-up scene space). */
  geometry: THREE.BufferGeometry;
}

/**
 * Parses an STL or 3MF ArrayBuffer into a merged, normalized `BufferGeometry`
 * centered in X/Z with its bottom sitting flush at `y = 0` in Three.js Y-up space.
 * For 3MF files, imports model geometry only (our preset system remains authoritative).
 */
export function parseModelToGeometry(
  fileName: string,
  buffer: ArrayBuffer,
): {
  geometry: THREE.BufferGeometry;
  baseSizeMm: { x: number; y: number; z: number };
} {
  const lower = fileName.trim().toLowerCase();
  let merged: THREE.BufferGeometry;

  if (lower.endsWith(".3mf")) {
    const loader = new ThreeMFLoader();
    const group = loader.parse(buffer);
    group.updateMatrixWorld(true);
    const geometries: THREE.BufferGeometry[] = [];
    group.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const g = child.geometry.clone();
        g.applyMatrix4(child.matrixWorld);
        geometries.push(g);
      }
    });
    if (geometries.length === 0) {
      throw new Error(
        "This 3MF archive did not contain any printable 3D meshes.",
      );
    }
    merged = mergeBufferGeometriesSimple(geometries);
    for (const g of geometries) g.dispose();
  } else if (lower.endsWith(".stl")) {
    const loader = new STLLoader();
    merged = loader.parse(buffer);
  } else {
    throw new Error("Only STL (.stl) and 3MF (.3mf) files are supported.");
  }

  // Convert CAD/3D-printing Z-up coordinates to Three.js Y-up scene coordinates.
  merged.rotateX(-Math.PI / 2);
  merged.computeBoundingBox();
  const box = merged.boundingBox;
  if (!box || box.isEmpty()) {
    merged.dispose();
    throw new Error("The imported 3D model has no geometry.");
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Center in X and Z, sit bottom flush on build plate (y = 0).
  merged.translate(-center.x, -box.min.y, -center.z);
  merged.computeVertexNormals();
  merged.computeBoundingBox();

  return {
    geometry: merged,
    baseSizeMm: {
      x: Number(size.x.toFixed(2)),
      y: Number(size.z.toFixed(2)), // Three.js Z maps to printer Y
      z: Number(size.y.toFixed(2)), // Three.js Y maps to printer Z (height)
    },
  };
}

/** Lightweight non-indexed BufferGeometry merger for multi-mesh 3MF files. */
function mergeBufferGeometriesSimple(
  geoms: THREE.BufferGeometry[],
): THREE.BufferGeometry {
  let totalVerts = 0;
  const nonIndexed = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of nonIndexed) {
    const pos = g.getAttribute("position");
    if (pos) totalVerts += pos.count;
  }
  const positions = new Float32Array(totalVerts * 3);
  let offset = 0;
  for (const g of nonIndexed) {
    const pos = g.getAttribute("position");
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) {
      positions[offset++] = pos.getX(i);
      positions[offset++] = pos.getY(i);
      positions[offset++] = pos.getZ(i);
    }
    if (!geoms.includes(g)) g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.computeVertexNormals();
  return out;
}

/** Builds a positioned Three.js transform matrix for a PlateObject sitting flush on y = 0. */
export function buildObjectTransformMatrix(obj: PlateObject): {
  matrix: THREE.Matrix4;
  worldBox: THREE.Box3;
} {
  const s = Math.max(0.05, obj.scalePercent / 100);
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(obj.rotXDeg),
    THREE.MathUtils.degToRad(obj.rotZDeg),
    THREE.MathUtils.degToRad(-obj.rotYDeg),
    "XYZ",
  );
  const q = new THREE.Quaternion().setFromEuler(euler);
  const scaleVec = new THREE.Vector3(s, s, s);

  const preMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, 0),
    q,
    scaleVec,
  );
  const geomBox =
    obj.geometry.boundingBox?.clone() ??
    new THREE.Box3().setFromBufferAttribute(
      obj.geometry.getAttribute("position") as THREE.BufferAttribute,
    );
  const rotatedBox = geomBox.clone().applyMatrix4(preMatrix);

  const sceneX = obj.positionX - MK3S_BED_X / 2;
  const sceneY = -rotatedBox.min.y;
  const sceneZ = MK3S_BED_Y / 2 - obj.positionY;

  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(sceneX, sceneY, sceneZ),
    q,
    scaleVec,
  );
  const worldBox = geomBox.clone().applyMatrix4(matrix);
  return { matrix, worldBox };
}

/** Computes axis-aligned bounding box of a single PlateObject in printer mm coordinates. */
export function computeObjectPrinterBounds(obj: PlateObject): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  outOfBounds: boolean;
} {
  const { worldBox } = buildObjectTransformMatrix(obj);
  const minX = worldBox.min.x + MK3S_BED_X / 2;
  const maxX = worldBox.max.x + MK3S_BED_X / 2;
  const minY = MK3S_BED_Y / 2 - worldBox.max.z;
  const maxY = MK3S_BED_Y / 2 - worldBox.min.z;
  const minZ = worldBox.min.y;
  const maxZ = worldBox.max.y;
  const eps = 0.5;
  const outOfBounds =
    minX < -eps ||
    maxX > MK3S_BED_X + eps ||
    minY < -eps ||
    maxY > MK3S_BED_Y + eps ||
    minZ < -eps ||
    maxZ > MK3S_BED_Z + eps;
  return { minX, maxX, minY, maxY, minZ, maxZ, outOfBounds };
}

/** Computes aggregate bounding box across all objects on the MK3S build plate. */
export function computePlateBounds(objects: PlateObject[]): PlateBoundsMm | null {
  if (objects.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const obj of objects) {
    const b = computeObjectPrinterBounds(obj);
    minX = Math.min(minX, b.minX);
    maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY);
    maxY = Math.max(maxY, b.maxY);
    minZ = Math.min(minZ, b.minZ);
    maxZ = Math.max(maxZ, b.maxZ);
  }
  return {
    minX: Number(minX.toFixed(2)),
    maxX: Number(maxX.toFixed(2)),
    minY: Number(minY.toFixed(2)),
    maxY: Number(maxY.toFixed(2)),
    minZ: Number(minZ.toFixed(2)),
    maxZ: Number(maxZ.toFixed(2)),
    objectCount: objects.length,
  };
}

/**
 * Exports all objects on the build plate into a single binary STL in Prusa MK3S
 * Z-up printer coordinates (`X: 0..250, Y: 0..210, Z: 0..210 mm`).
 */
export function exportPlateToBinaryStl(objects: PlateObject[]): Uint8Array {
  const exportGroup = new THREE.Group();
  const toPrinterSpace = new THREE.Matrix4()
    .makeTranslation(MK3S_BED_X / 2, MK3S_BED_Y / 2, 0)
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));

  const tempMeshes: THREE.Mesh[] = [];
  for (const obj of objects) {
    const { matrix } = buildObjectTransformMatrix(obj);
    const cloned = obj.geometry.clone();
    cloned.applyMatrix4(matrix);
    cloned.applyMatrix4(toPrinterSpace);
    const mesh = new THREE.Mesh(cloned);
    exportGroup.add(mesh);
    tempMeshes.push(mesh);
  }
  exportGroup.updateMatrixWorld(true);

  const exporter = new STLExporter();
  const dataView = exporter.parse(exportGroup, { binary: true });
  for (const m of tempMeshes) {
    m.geometry.dispose();
  }
  return new Uint8Array(
    dataView.buffer,
    dataView.byteOffset,
    dataView.byteLength,
  );
}
