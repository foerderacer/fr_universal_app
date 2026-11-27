import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Box,
  ChevronRight,
  ChevronUp,
  CloudUpload,
  Copy,
  Crosshair,
  Download,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  Grid2x2,
  Home,
  Info,
  Loader2,
  Maximize2,
  Minimize2,
  PanelBottom,
  Pencil,
  Plus,
  Printer,
  RotateCw,
  Sliders,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type {
  FileItemView_Serialize,
  MaterialPreset_Serialize,
  QualityPreset,
  RigidityPreset,
  SliceJobRecord_Serialize,
  SlicerOverview_Serialize,
  UserFacingError,
} from "../bindings/tauri";
import { ErrorBanner } from "../components/ErrorBanner";
import { NoticeBanner } from "../components/shell/NoticeBanner";
import { WorkspaceLayout } from "../components/shell/WorkspaceLayout";
import { BuildPlateViewport } from "../components/slicer/BuildPlateViewport";
import {
  MK3S_BED_X,
  MK3S_BED_Y,
  computeObjectPrinterBounds,
  computePlateBounds,
  exportPlateToBinaryStl,
  parseModelToGeometry,
  type PlateObject,
} from "../components/slicer/plateGeometry";
import { InlineDeleteConfirm } from "../components/ui/InlineDeleteConfirm";
import { Select } from "../components/ui/Select";
import { Modal } from "../components/ui/Modal";
import { Switch } from "../components/ui/Switch";
import { IconButton, Kbd, Tooltip } from "../components/ui/Tooltip";
import { listFiles } from "../lib/filesClient";
import { IS_MAC_PLATFORM, QUICK_CHAT_SHORTCUT } from "../lib/platform";
import {
  areSingleKeyShortcutsEnabled,
  handleToolbarKeyDown,
  hasActiveOverlay,
  isBlockedArrowScope,
  isEditableTarget,
} from "../lib/shortcuts";
import {
  base64ToBytes,
  bytesToBase64,
  cancelSliceJob,
  clearMaterialPresetDraft,
  deleteCustomMaterialPreset,
  getSlicerOverview,
  loadCloudModelBase64,
  readSliceJobGcodeBase64,
  saveCustomMaterialPreset,
  saveMaterialPresetDraft,
  saveSliceJobToNextcloud,
  setPrusaSlicerPath,
  startSliceJob,
  triggerGcodeDownload,
} from "../lib/slicerClient";
import {
  formatBytes,
  openExternalUrl,
  toUserFacingError,
} from "../lib/workspaceClient";

interface SlicerViewProps {
  isNextcloudConnected: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSetSidebarOpen: (open: boolean) => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onSetInspectorOpen: (open: boolean) => void;
  quickChatOpen?: boolean;
  onSetQuickChatOpen?: (open: boolean) => void;
  quickChatInspector?: React.ReactNode;
  banners?: React.ReactNode;
}

interface SlicerProgressPayload {
  jobId: string;
  percent: number;
  stage: string;
}

const MAX_LOCAL_MODEL_BYTES = 100 * 1024 * 1024;
const PRUSASLICER_DOWNLOAD_URL = "https://www.prusa3d.com/page/prusaslicer_424/";
const SLICE_SHORTCUT = IS_MAC_PLATFORM ? "⌘↵" : "Ctrl+↵";

function createPreviewBracketGeometry(): {
  geometry: THREE.BufferGeometry;
  baseSizeMm: { x: number; y: number; z: number };
} {
  // Clean mechanical L-bracket / mount for browser preview mode only
  const shape = new THREE.Shape();
  shape.moveTo(-36, -24);
  shape.lineTo(36, -24);
  shape.lineTo(36, 24);
  shape.lineTo(14, 24);
  shape.lineTo(14, -4);
  shape.lineTo(-14, -4);
  shape.lineTo(-14, 24);
  shape.lineTo(-36, 24);
  shape.closePath();

  const extrude = new THREE.ExtrudeGeometry(shape, {
    depth: 28,
    bevelEnabled: true,
    bevelThickness: 1.5,
    bevelSize: 1.5,
    bevelSegments: 2,
  });
  extrude.rotateX(-Math.PI / 2);
  extrude.computeBoundingBox();
  const box = extrude.boundingBox!;
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  extrude.translate(-center.x, -box.min.y, -center.z);
  extrude.computeVertexNormals();
  return {
    geometry: extrude,
    baseSizeMm: {
      x: Number(size.x.toFixed(1)),
      y: Number(size.z.toFixed(1)),
      z: Number(size.y.toFixed(1)),
    },
  };
}

export function SlicerView({
  isNextcloudConnected,
  sidebarOpen,
  onToggleSidebar,
  onSetSidebarOpen,
  inspectorOpen,
  onToggleInspector,
  onSetInspectorOpen,
  quickChatOpen = false,
  onSetQuickChatOpen,
  quickChatInspector,
  banners,
}: SlicerViewProps) {
  const [overview, setOverview] = useState<SlicerOverview_Serialize | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UserFacingError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDeleteMaterialId, setConfirmDeleteMaterialId] = useState<
    string | null
  >(null);
  const [confirmRemoveObjectId, setConfirmRemoveObjectId] = useState<
    string | null
  >(null);
  const [confirmDiscardDraftBanner, setConfirmDiscardDraftBanner] =
    useState(false);
  const [confirmDiscardDraftModal, setConfirmDiscardDraftModal] =
    useState(false);
  const [confirmCancelSlice, setConfirmCancelSlice] = useState(false);
  const startSliceRef = useRef<() => void>(() => {});

  // Build plate objects (multi-object STL + 3MF support)
  const [objects, setObjects] = useState<PlateObject[]>(() => {
    if (isTauri()) return [];
    const { geometry, baseSizeMm } = createPreviewBracketGeometry();
    return [
      {
        id: "preview-part-1",
        name: "brake-duct-mount.stl",
        positionX: 125,
        positionY: 105,
        rotXDeg: 0,
        rotYDeg: 0,
        rotZDeg: 0,
        scalePercent: 100,
        baseSizeMm,
        geometry,
      },
    ];
  });
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(() =>
    isTauri() ? null : "preview-part-1",
  );
  const [bottomDrawerOpen, setBottomDrawerOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("fr.slicer.transformDrawer.v1") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "fr.slicer.transformDrawer.v1",
        bottomDrawerOpen ? "1" : "0",
      );
    } catch {
      // Ignore storage write errors in restricted webviews.
    }
  }, [bottomDrawerOpen]);

  const focusRestoreRef = useRef<{
    sidebar: boolean;
    inspector: boolean;
    drawer: boolean;
    quickChat: boolean;
  } | null>(null);

  const isViewportFocused =
    !sidebarOpen && !inspectorOpen && !bottomDrawerOpen && !quickChatOpen;

  const toggleFocusViewport = useCallback(() => {
    if (isViewportFocused) {
      const saved = focusRestoreRef.current;
      onSetSidebarOpen(saved ? saved.sidebar : true);
      onSetInspectorOpen(saved ? saved.inspector : true);
      setBottomDrawerOpen(saved ? saved.drawer : false);
      if (saved?.quickChat && onSetQuickChatOpen) {
        onSetQuickChatOpen(true);
      }
    } else {
      focusRestoreRef.current = {
        sidebar: sidebarOpen,
        inspector: inspectorOpen,
        drawer: bottomDrawerOpen,
        quickChat: quickChatOpen,
      };
      onSetSidebarOpen(false);
      onSetInspectorOpen(false);
      setBottomDrawerOpen(false);
      if (quickChatOpen && onSetQuickChatOpen) {
        onSetQuickChatOpen(false);
      }
    }
  }, [
    isViewportFocused,
    sidebarOpen,
    inspectorOpen,
    bottomDrawerOpen,
    quickChatOpen,
    onSetSidebarOpen,
    onSetInspectorOpen,
    onSetQuickChatOpen,
  ]);

  // Slicer-specific shortcuts: Ctrl/Cmd+Enter (Slice), F (Focus 3D viewport), B (Toggle bottom transform drawer), Arrows (1mm/5mm nudge)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasActiveOverlay()) {
        return;
      }
      const inInput = isEditableTarget(e.target);
      if (inInput) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        startSliceRef.current();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented) return;
      if (areSingleKeyShortcutsEnabled() && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleFocusViewport();
      } else if (areSingleKeyShortcutsEnabled() && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setBottomDrawerOpen((v) => !v);
      } else if (
        selectedObjectId &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown")
      ) {
        if (isBlockedArrowScope(document.activeElement)) {
          return;
        }
        e.preventDefault();
        const step = e.shiftKey ? 5 : 1;
        const dx =
          e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        const dy =
          e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        setObjects((prev) =>
          prev.map((o) =>
            o.id === selectedObjectId
              ? {
                  ...o,
                  positionX: Math.max(
                    0,
                    Math.min(MK3S_BED_X, Number((o.positionX + dx).toFixed(1))),
                  ),
                  positionY: Math.max(
                    0,
                    Math.min(MK3S_BED_Y, Number((o.positionY + dy).toFixed(1))),
                  ),
                }
              : o,
          ),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFocusViewport, selectedObjectId]);

  const handleMoveObjectOnPlate = useCallback(
    (id: string, positionX: number, positionY: number) => {
      setObjects((prev) =>
        prev.map((o) => (o.id === id ? { ...o, positionX, positionY } : o)),
      );
    },
    [],
  );

  // Three simple orthogonal choices
  const [rigidity, setRigidity] = useState<RigidityPreset>("medium");
  const [quality, setQuality] = useState<QualityPreset>("standard");
  const [materialId, setMaterialId] = useState<string>("pla");
  const [supportMaterial, setSupportMaterial] = useState(false);
  const [useBrim, setUseBrim] = useState(false);
  const [outputName, setOutputName] = useState(() =>
    isTauri() ? "" : "brake_duct_mount",
  );
  const [autoSaveCloud, setAutoSaveCloud] = useState(false);
  const [cloudOutputFolder, setCloudOutputFolder] = useState("/3D Prints");

  // Slicing job state
  const [activeJob, setActiveJob] = useState<SliceJobRecord_Serialize | null>(
    null,
  );
  const [recentJobs, setRecentJobs] = useState<SliceJobRecord_Serialize[]>([]);
  const [startingSlice, setStartingSlice] = useState(false);
  const [downloadingJobId, setDownloadingJobId] = useState<string | null>(null);
  const [savingCloudJobId, setSavingCloudJobId] = useState<string | null>(null);
  const [showTechLog, setShowTechLog] = useState(false);

  // PrusaSlicer path configuration popover
  const [showEngineSetup, setShowEngineSetup] = useState(false);
  const [enginePathInput, setEnginePathInput] = useState("");
  const [savingEnginePath, setSavingEnginePath] = useState(false);

  // Cloud model picker modal
  const [showCloudPicker, setShowCloudPicker] = useState(false);
  const [pickerPath, setPickerPath] = useState("/");
  const [pickerItems, setPickerItems] = useState<FileItemView_Serialize[]>([]);
  const [loadingPicker, setLoadingPicker] = useState(false);
  const [loadingCloudModelPath, setLoadingCloudModelPath] = useState<
    string | null
  >(null);

  // Custom material editor modal
  const [showMaterialModal, setShowMaterialModal] = useState(false);
  const [editingMaterial, setEditingMaterial] =
    useState<MaterialPreset_Serialize | null>(null);
  const [restoredDraftNotice, setRestoredDraftNotice] = useState(false);
  const [savingMaterial, setSavingMaterial] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const pendingMaterialDraftRef = useRef<MaterialPreset_Serialize | null>(null);
  const pickerSeqRef = useRef<number>(0);
  const objectsRef = useRef<PlateObject[]>([]);
  objectsRef.current = objects;

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => {
      setNotice((prev) => (prev === msg ? null : prev));
    }, 5000);
  }, []);

  const flushMaterialDraft = useCallback(() => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const draft = pendingMaterialDraftRef.current;
    if (!draft) return;
    pendingMaterialDraftRef.current = null;
    setOverview((prev) => (prev ? { ...prev, materialDraft: draft } : prev));
    setRestoredDraftNotice(true);
    void saveMaterialPresetDraft(draft).catch((err) => {
      setError(toUserFacingError(err));
    });
  }, []);

  const refreshOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSlicerOverview();
      setOverview(data);
      setRecentJobs(data.recentJobs);
      setActiveJob((prev) => {
        if (prev) {
          const updated = data.recentJobs.find((j) => j.id === prev.id);
          if (updated) return updated;
        }
        return (
          data.recentJobs.find(
            (j) => j.state === "queued" || j.state === "running",
          ) ??
          data.recentJobs[0] ??
          null
        );
      });
      setEnginePathInput((prev) => (prev ? prev : (data.binary.path ?? "")));
      setMaterialId((prev) =>
        data.materials.length > 0 && !data.materials.some((m) => m.id === prev)
          ? data.materials[0].id
          : prev,
      );
      if (data.materialDraft) {
        setRestoredDraftNotice(true);
      }
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  useEffect(() => {
    return () => {
      flushMaterialDraft();
      for (const obj of objectsRef.current) {
        obj.geometry.dispose();
      }
    };
  }, [flushMaterialDraft]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisteners: (() => void)[] = [];

    const isTerminal = (state: SliceJobRecord_Serialize["state"]) =>
      state === "completed" || state === "failed" || state === "cancelled";

    void listen<SlicerProgressPayload>("slicer://progress", (event) => {
      if (cancelled) return;
      const { jobId, percent, stage } = event.payload;
      setActiveJob((prev) =>
        prev && prev.id === jobId && !isTerminal(prev.state)
          ? { ...prev, state: "running", percent, stage }
          : prev,
      );
      setRecentJobs((prev) =>
        prev.map((j) =>
          j.id === jobId && !isTerminal(j.state)
            ? { ...j, state: "running", percent, stage }
            : j,
        ),
      );
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    void listen<SliceJobRecord_Serialize>("slicer://job-updated", (event) => {
      if (cancelled) return;
      const updated = event.payload;
      setActiveJob((prev) =>
        !prev || prev.id === updated.id ? updated : prev,
      );
      setRecentJobs((prev) => {
        const exists = prev.some((j) => j.id === updated.id);
        return exists
          ? prev.map((j) => (j.id === updated.id ? updated : j))
          : [updated, ...prev];
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
    };
  }, []);

  const selectedObject = useMemo(
    () => objects.find((o) => o.id === selectedObjectId) ?? null,
    [objects, selectedObjectId],
  );

  const selectedMaterial = useMemo(
    () =>
      overview?.materials.find((m) => m.id === materialId) ??
      overview?.materials[0] ??
      null,
    [overview, materialId],
  );

  const selectedQualityPreset = useMemo(
    () => overview?.qualityPresets.find((q) => q.id === quality) ?? null,
    [overview, quality],
  );

  const plateBounds = useMemo(() => computePlateBounds(objects), [objects]);
  const anyOutOfBounds = useMemo(
    () => objects.some((o) => computeObjectPrinterBounds(o).outOfBounds),
    [objects],
  );

  const addParsedModel = useCallback(
    (fileName: string, buffer: ArrayBuffer) => {
      const { geometry, baseSizeMm } = parseModelToGeometry(fileName, buffer);
      const id = `part-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      setObjects((prev) => {
        const offsetIdx = prev.length;
        const posX = Math.min(
          MK3S_BED_X - baseSizeMm.x / 2 - 5,
          Math.max(
            baseSizeMm.x / 2 + 5,
            MK3S_BED_X / 2 + (offsetIdx % 3) * 18 - (offsetIdx > 0 ? 18 : 0),
          ),
        );
        const posY = Math.min(
          MK3S_BED_Y - baseSizeMm.y / 2 - 5,
          Math.max(
            baseSizeMm.y / 2 + 5,
            MK3S_BED_Y / 2 + Math.floor(offsetIdx / 3) * 18,
          ),
        );
        const nextObj: PlateObject = {
          id,
          name: fileName,
          positionX: Number(posX.toFixed(1)),
          positionY: Number(posY.toFixed(1)),
          rotXDeg: 0,
          rotYDeg: 0,
          rotZDeg: 0,
          scalePercent: 100,
          baseSizeMm,
          geometry,
        };
        return [...prev, nextObj];
      });
      setSelectedObjectId(id);
      setOutputName((prev) =>
        prev.trim() ? prev : fileName.replace(/\.(stl|3mf)$/i, ""),
      );
    },
    [],
  );

  async function handleLocalFileSelected(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setError(null);

    for (const file of files) {
      if (file.size > MAX_LOCAL_MODEL_BYTES) {
        setError({
          code: "invalid_input",
          title: "Model file is too large",
          message: `"${file.name}" (${formatBytes(file.size)}) exceeds the 100 MiB limit.`,
          recoveryHint: "Decimate or simplify the mesh in CAD and try again.",
          technicalDetails: null,
        });
        continue;
      }
      try {
        const buf = await file.arrayBuffer();
        addParsedModel(file.name, buf);
      } catch (err) {
        setError(toUserFacingError(err));
      }
    }
  }

  const loadPickerFolder = useCallback(async (path: string) => {
    const seq = ++pickerSeqRef.current;
    setLoadingPicker(true);
    setError(null);
    try {
      const items = await listFiles(path);
      if (pickerSeqRef.current !== seq) return;
      setPickerPath(path);
      setPickerItems(items);
    } catch (err) {
      if (pickerSeqRef.current === seq) {
        setError(toUserFacingError(err));
      }
    } finally {
      if (pickerSeqRef.current === seq) {
        setLoadingPicker(false);
      }
    }
  }, []);

  async function handleOpenCloudPicker() {
    setShowCloudPicker(true);
    await loadPickerFolder("/");
  }

  async function handleAddCloudModel(item: FileItemView_Serialize) {
    setLoadingCloudModelPath(item.entry.path);
    setError(null);
    try {
      const payload = await loadCloudModelBase64(item.entry.path);
      const bytes = base64ToBytes(payload.dataBase64);
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      addParsedModel(payload.fileName, ab);
      setShowCloudPicker(false);
      flashNotice(`Loaded "${payload.fileName}" onto MK3S build plate.`);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setLoadingCloudModelPath(null);
    }
  }

  function updateSelectedObject(patch: Partial<PlateObject>) {
    if (!selectedObjectId) return;
    setObjects((prev) =>
      prev.map((o) => (o.id === selectedObjectId ? { ...o, ...patch } : o)),
    );
  }

  function handleDuplicateObject(obj: PlateObject) {
    const id = `part-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const clone: PlateObject = {
      ...obj,
      id,
      name: `${obj.name} (copy)`,
      positionX: Math.min(MK3S_BED_X - 15, obj.positionX + 20),
      geometry: obj.geometry.clone(),
    };
    setObjects((prev) => [...prev, clone]);
    setSelectedObjectId(id);
  }

  function handleRemoveObject(id: string) {
    const target = objects.find((o) => o.id === id);
    const remaining = objects.filter((o) => o.id !== id);
    target?.geometry.dispose();
    setObjects(remaining);
    if (selectedObjectId === id) {
      setSelectedObjectId(remaining[0]?.id ?? null);
    }
  }

  function handleAutoArrange() {
    if (objects.length === 0) return;
    const gap = 8;
    const measured = objects.map((o) => {
      const b = computeObjectPrinterBounds(o);
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      return {
        obj: o,
        w: Math.max(1, b.maxX - b.minX),
        d: Math.max(1, b.maxY - b.minY),
        offsetX: cx - o.positionX,
        offsetY: cy - o.positionY,
      };
    });

    let cursorX = gap;
    let cursorY = gap;
    let rowDepth = 0;
    const placed: {
      id: string;
      centerX: number;
      centerY: number;
      offsetX: number;
      offsetY: number;
    }[] = [];

    for (const item of measured) {
      if (cursorX + item.w + gap > MK3S_BED_X && cursorX > gap) {
        cursorX = gap;
        cursorY += rowDepth + gap;
        rowDepth = 0;
      }
      placed.push({
        id: item.obj.id,
        centerX: cursorX + item.w / 2,
        centerY: cursorY + item.d / 2,
        offsetX: item.offsetX,
        offsetY: item.offsetY,
      });
      cursorX += item.w + gap;
      rowDepth = Math.max(rowDepth, item.d);
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < placed.length; i++) {
      minX = Math.min(minX, placed[i].centerX - measured[i].w / 2);
      maxX = Math.max(maxX, placed[i].centerX + measured[i].w / 2);
      minY = Math.min(minY, placed[i].centerY - measured[i].d / 2);
      maxY = Math.max(maxY, placed[i].centerY + measured[i].d / 2);
    }
    const shiftX = MK3S_BED_X / 2 - (minX + maxX) / 2;
    const shiftY = MK3S_BED_Y / 2 - (minY + maxY) / 2;

    const coords = new Map(
      placed.map((p) => [
        p.id,
        {
          x: Number((p.centerX + shiftX - p.offsetX).toFixed(1)),
          y: Number((p.centerY + shiftY - p.offsetY).toFixed(1)),
        },
      ]),
    );
    setObjects((prev) =>
      prev.map((o) => {
        const c = coords.get(o.id);
        return c ? { ...o, positionX: c.x, positionY: c.y } : o;
      }),
    );
  }

  async function handleSaveEnginePath(e: React.FormEvent) {
    e.preventDefault();
    setSavingEnginePath(true);
    setError(null);
    try {
      const bin = await setPrusaSlicerPath(enginePathInput.trim() || null);
      setOverview((prev) => (prev ? { ...prev, binary: bin } : prev));
      if (bin.available) {
        setShowEngineSetup(false);
        flashNotice(`PrusaSlicer ready (${bin.version ?? bin.path}).`);
      } else {
        flashNotice("PrusaSlicer was not found automatically.");
      }
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setSavingEnginePath(false);
    }
  }

  function openNewCustomMaterial(base?: MaterialPreset_Serialize) {
    const source = base ?? selectedMaterial ?? overview?.materials[0];
    const draft: MaterialPreset_Serialize = source
      ? {
          ...source,
          id: base && !base.builtIn ? base.id : "",
          name:
            base && !base.builtIn
              ? base.name
              : `${source.name} (Custom)`,
          builtIn: false,
        }
      : {
          id: "",
          name: "Custom Filament",
          filamentType: "PLA",
          builtIn: false,
          nozzleTempC: 215,
          firstLayerNozzleTempC: 215,
          bedTempC: 60,
          firstLayerBedTempC: 60,
          fanMinPercent: 80,
          fanMaxPercent: 100,
          disableFanFirstLayers: 1,
          maxVolumetricSpeedMm3S: 12,
          extrusionMultiplier: 1.0,
          hint: null,
        };
    setEditingMaterial(draft);
    setShowMaterialModal(true);
  }

  function resumeMaterialDraft() {
    if (!overview?.materialDraft) return;
    setEditingMaterial(overview.materialDraft);
    setShowMaterialModal(true);
  }

  function updateEditingMaterial(patch: Partial<MaterialPreset_Serialize>) {
    setEditingMaterial((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      pendingMaterialDraftRef.current = next;
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
      }
      draftTimerRef.current = window.setTimeout(() => {
        draftTimerRef.current = null;
        const latest = pendingMaterialDraftRef.current;
        if (!latest) return;
        pendingMaterialDraftRef.current = null;
        setOverview((o) => (o ? { ...o, materialDraft: latest } : o));
        void saveMaterialPresetDraft(latest).catch((err) => {
          setError(toUserFacingError(err));
        });
      }, 350);
      return next;
    });
  }

  async function handleSaveCustomMaterial(e: React.FormEvent) {
    e.preventDefault();
    if (!editingMaterial) return;
    setSavingMaterial(true);
    setError(null);
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    pendingMaterialDraftRef.current = null;
    try {
      const saved = await saveCustomMaterialPreset(editingMaterial);
      setMaterialId(saved.id);
      setShowMaterialModal(false);
      setEditingMaterial(null);
      setRestoredDraftNotice(false);
      await refreshOverview();
      flashNotice(`Saved custom material "${saved.name}".`);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setSavingMaterial(false);
    }
  }

  async function handleDiscardMaterialDraft() {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    pendingMaterialDraftRef.current = null;
    await clearMaterialPresetDraft().catch(() => {});
    setEditingMaterial(null);
    setShowMaterialModal(false);
    setRestoredDraftNotice(false);
    setOverview((prev) => (prev ? { ...prev, materialDraft: null } : prev));
  }

  async function handleDeleteCustomMaterial(id: string, name: string) {
    setError(null);
    try {
      await deleteCustomMaterialPreset(id);
      if (materialId === id) setMaterialId("pla");
      await refreshOverview();
      flashNotice(`Deleted "${name}".`);
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function handleStartSlice() {
    if (objects.length === 0 || startingSlice) return;
    setError(null);
    setShowTechLog(false);
    setStartingSlice(true);
    try {
      const stlBytes = exportPlateToBinaryStl(objects);
      if (stlBytes.byteLength > MAX_LOCAL_MODEL_BYTES) {
        setError({
          code: "invalid_input",
          title: "Combined build plate is too large",
          message: `The arranged plate (${formatBytes(stlBytes.byteLength)}) exceeds the 100 MiB slicing limit.`,
          recoveryHint: "Remove an object or simplify the mesh before slicing.",
          technicalDetails: null,
        });
        return;
      }
      const modelBase64 = bytesToBase64(stlBytes);
      const job = await startSliceJob({
        modelFileName: "plate.stl",
        modelBase64,
        outputName: outputName.trim() || objects[0].name,
        bounds: plateBounds,
        materialId,
        rigidity,
        quality,
        overrides: {
          supportMaterial,
          brimWidthMm: useBrim ? 5.0 : null,
        },
        saveToCloudFolder:
          isNextcloudConnected && autoSaveCloud ? cloudOutputFolder : null,
      });
      setActiveJob((prev) =>
        prev &&
        prev.id === job.id &&
        (prev.state === "completed" ||
          prev.state === "failed" ||
          prev.state === "cancelled")
          ? prev
          : job,
      );
      setRecentJobs((prev) => {
        const existing = prev.find((j) => j.id === job.id);
        if (
          existing &&
          (existing.state === "completed" ||
            existing.state === "failed" ||
            existing.state === "cancelled")
        ) {
          return prev;
        }
        return [job, ...prev.filter((j) => j.id !== job.id)];
      });
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setStartingSlice(false);
    }
  }

  async function handleCancelSlice(jobId: string) {
    try {
      const cancelled = await cancelSliceJob(jobId);
      setActiveJob(cancelled);
      setRecentJobs((prev) =>
        prev.map((j) => (j.id === cancelled.id ? cancelled : j)),
      );
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function handleDownloadGcode(jobId: string) {
    setDownloadingJobId(jobId);
    setError(null);
    try {
      const dl = await readSliceJobGcodeBase64(jobId);
      triggerGcodeDownload(dl.fileName, dl.dataBase64);
      flashNotice(`Saved "${dl.fileName}" for Prusa MK3S SD card.`);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setDownloadingJobId(null);
    }
  }

  async function handleSaveJobToNextcloud(jobId: string) {
    setSavingCloudJobId(jobId);
    setError(null);
    try {
      const updated = await saveSliceJobToNextcloud(jobId, cloudOutputFolder);
      setActiveJob((prev) => (prev && prev.id === updated.id ? updated : prev));
      setRecentJobs((prev) =>
        prev.map((j) => (j.id === updated.id ? updated : j)),
      );
      flashNotice(
        `Saved G-code to ${updated.cloudSavedPath ?? cloudOutputFolder}.`,
      );
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setSavingCloudJobId(null);
    }
  }

  const isSlicing =
    startingSlice ||
    activeJob?.state === "queued" ||
    activeJob?.state === "running";

  const sidebarNode = (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2.5">
        {/* Plate Objects Tree */}
        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <h2 className="text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
              Build Plate
            </h2>
            <span className="mono-num text-[10px] text-[var(--text-muted)]">
              {objects.length}
            </span>
          </div>

          {objects.length === 0 ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center gap-2 rounded-md border border-dashed border-[var(--border-strong)] px-2.5 py-2 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Upload className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              <span>Add STL or 3MF…</span>
            </button>
          ) : (
            <div className="space-y-0.5">
              {objects.map((obj) => {
                const active = obj.id === selectedObjectId;
                const oob = computeObjectPrinterBounds(obj).outOfBounds;
                return (
                  <div
                    key={obj.id}
                    className={`group relative flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                      active
                        ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r bg-[var(--accent)]"
                      />
                    )}
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      onClick={() => setSelectedObjectId(obj.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Box
                        className={`h-3.5 w-3.5 shrink-0 ${
                          oob
                            ? "text-[var(--status-danger-text)]"
                            : active
                              ? "text-[var(--accent)]"
                              : "text-[var(--text-muted)]"
                        }`}
                        strokeWidth={1.5}
                      />
                      <span className="truncate">{obj.name}</span>
                    </button>
                    <div
                      className={`shrink-0 items-center gap-0.5 ${
                        confirmRemoveObjectId === obj.id
                          ? "flex"
                          : "hidden group-focus-within:flex group-hover:flex"
                      }`}
                    >
                      {confirmRemoveObjectId !== obj.id && (
                        <IconButton
                          size="xs"
                          label="Duplicate part"
                          onClick={() => handleDuplicateObject(obj)}
                        >
                          <Copy className="h-3 w-3" strokeWidth={1.5} />
                        </IconButton>
                      )}
                      <InlineDeleteConfirm
                        armed={confirmRemoveObjectId === obj.id}
                        onArm={() => setConfirmRemoveObjectId(obj.id)}
                        onCancel={() => setConfirmRemoveObjectId(null)}
                        onConfirm={() => {
                          setConfirmRemoveObjectId(null);
                          handleRemoveObject(obj.id);
                        }}
                        label={`Remove ${obj.name}`}
                        iconClassName="h-3 w-3"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Print Queue & Recent Slices */}
        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <h2 className="text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
              Print Queue
            </h2>
            <span className="mono-num text-[10px] text-[var(--text-muted)]">
              {recentJobs.length}
            </span>
          </div>
          {recentJobs.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]">
              No sliced jobs yet.
            </p>
          ) : (
            <div className="space-y-0.5">
              {recentJobs.slice(0, 8).map((job) => {
                const isSelected = activeJob?.id === job.id;
                const dotColor =
                  job.state === "completed"
                    ? "bg-[var(--status-positive)]"
                    : job.state === "failed"
                      ? "bg-[var(--status-danger)]"
                      : job.state === "running" || job.state === "queued"
                        ? "bg-[var(--accent)]"
                        : "bg-[var(--text-muted)]";
                return (
                  <button
                    key={job.id}
                    type="button"
                    aria-current={isSelected ? "true" : undefined}
                    onClick={() => setActiveJob(job)}
                    className={`relative w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                      isSelected
                        ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {isSelected && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r bg-[var(--accent)]"
                      />
                    )}
                    <div className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
                      <span className="truncate text-[11px] font-medium text-[var(--text-primary)]">
                        {job.outputFileName}
                      </span>
                    </div>
                    <div className="mono-num mt-0.5 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                      <span>
                        {job.materialName} · {job.rigidity}
                      </span>
                      <span>
                        {job.estimatedTime ??
                          (job.state === "running" ? `${job.percent}%` : job.state)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Unified h-8 Engine Status Readout Footer (flush with telemetry strip) */}
      <div className="mono-num flex h-8 shrink-0 items-center gap-1.5 border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            overview?.binary.available
              ? "bg-[var(--status-positive)]"
              : "bg-[var(--status-warning)]"
          }`}
        />
        <span className="truncate">
          {overview?.binary.available
            ? overview.binary.version || "PrusaSlicer ready"
            : "PrusaSlicer CLI missing"}
        </span>
      </div>
    </div>
  );

  startSliceRef.current = () => {
    if (objects.length > 0 && !anyOutOfBounds && !isSlicing) {
      void handleStartSlice();
    }
  };

  const inspectorNode = quickChatInspector ? (
    quickChatInspector
  ) : (
    <div className="flex h-full flex-col bg-[var(--bg-sidebar)]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-3">
        <span className="text-xs font-medium text-[var(--text-primary)]">
          Print Profile
        </span>
        <span className="mono-num text-[10px] text-[var(--text-muted)]">
          0.4 mm nozzle
        </span>
      </div>

      <div className="min-h-0 flex-1 divide-y divide-[var(--border-hairline)] overflow-y-auto">
        {/* Infill & Strength */}
        <section className="space-y-2 p-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
              Infill &amp; Strength
            </h2>
            <span className="text-[10px] text-[var(--text-muted)]">
              Walls &amp; density
            </span>
          </div>
          <div
            role="radiogroup"
            aria-label="Infill and strength preset"
            className="grid grid-cols-2 gap-1.5"
          >
            {(() => {
              const list = overview?.rigidityPresets ?? [];
              const hasActive = list.some((p) => p.id === rigidity);
              return list.map((preset, idx) => {
                const active = rigidity === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active || (!hasActive && idx === 0) ? 0 : -1}
                    onClick={() => setRigidity(preset.id)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "ArrowRight" ||
                        e.key === "ArrowDown" ||
                        e.key === "ArrowLeft" ||
                        e.key === "ArrowUp"
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                        const delta =
                          e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
                        const nextIdx = (idx + delta + list.length) % list.length;
                        setRigidity(list[nextIdx].id);
                        const parent = e.currentTarget.parentElement;
                        const radios =
                          parent?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
                        radios?.[nextIdx]?.focus();
                      }
                    }}
                    className={`flex flex-col items-start justify-start rounded-md border p-2 text-left transition-colors ${
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                        : "border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/40"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-xs font-medium text-[var(--text-primary)]">
                        {preset.label}
                      </span>
                      <span className="mono-num text-[11px] text-[var(--text-muted)]">
                        {preset.fillDensityPercent}%
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">
                      {preset.subtitle}
                    </p>
                  </button>
                );
              });
            })()}
          </div>
        </section>

        {/* Layer Quality */}
        <section className="space-y-2 p-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
              Layer Quality
            </h2>
            {selectedQualityPreset &&
              selectedQualityPreset.layerHeightMm !== null && (
                <span className="mono-num text-[11px] text-[var(--text-muted)]">
                  {selectedQualityPreset.layerHeightMm.toFixed(2)} mm
                </span>
              )}
          </div>
          <div
            role="radiogroup"
            aria-label="Layer quality preset"
            className="grid grid-cols-3 gap-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-app)] p-0.5"
          >
            {(() => {
              const list = overview?.qualityPresets ?? [];
              const hasActive = list.some((p) => p.id === quality);
              return list.map((preset, idx) => {
                const active = quality === preset.id;
                return (
                  <Tooltip key={preset.id} label={preset.subtitle}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={active || (!hasActive && idx === 0) ? 0 : -1}
                      onClick={() => setQuality(preset.id)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "ArrowRight" ||
                          e.key === "ArrowDown" ||
                          e.key === "ArrowLeft" ||
                          e.key === "ArrowUp"
                        ) {
                          e.preventDefault();
                          e.stopPropagation();
                          const delta =
                            e.key === "ArrowRight" || e.key === "ArrowDown"
                              ? 1
                              : -1;
                          const nextIdx =
                            (idx + delta + list.length) % list.length;
                          setQuality(list[nextIdx].id);
                          const group = e.currentTarget.closest('[role="radiogroup"]');
                          const radios =
                            group?.querySelectorAll<HTMLButtonElement>(
                              '[role="radio"]',
                            );
                          radios?.[nextIdx]?.focus();
                        }
                      }}
                      className={`w-full rounded border py-1.5 text-center text-xs font-medium transition-colors ${
                        active
                          ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                          : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/50 hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {preset.label}
                    </button>
                  </Tooltip>
                );
              });
            })()}
          </div>
          {selectedQualityPreset && (
            <p className="text-[11px] text-[var(--text-muted)]">
              {selectedQualityPreset.subtitle}
            </p>
          )}
        </section>

        {/* Filament */}
        <section className="space-y-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
              Filament
            </h2>
            <div className="flex items-center gap-0.5">
              {selectedMaterial && !selectedMaterial.builtIn && (
                <>
                  <IconButton
                    size="xs"
                    label="Edit custom material"
                    onClick={() => openNewCustomMaterial(selectedMaterial)}
                  >
                    <Pencil className="h-3 w-3" strokeWidth={1.5} />
                  </IconButton>
                  <InlineDeleteConfirm
                    armed={confirmDeleteMaterialId === selectedMaterial.id}
                    onArm={() =>
                      setConfirmDeleteMaterialId(selectedMaterial.id)
                    }
                    onCancel={() => setConfirmDeleteMaterialId(null)}
                    onConfirm={() => {
                      setConfirmDeleteMaterialId(null);
                      void handleDeleteCustomMaterial(
                        selectedMaterial.id,
                        selectedMaterial.name,
                      );
                    }}
                    label="Delete custom material"
                    iconClassName="h-3 w-3"
                  />
                </>
              )}
              <IconButton
                size="xs"
                label="New custom filament preset"
                onClick={() => openNewCustomMaterial()}
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            </div>
          </div>
          <div
            role="radiogroup"
            aria-label="Filament preset"
            className="flex flex-wrap gap-1.5"
          >
            {(() => {
              const list = overview?.materials ?? [];
              const hasActive = list.some((m) => m.id === materialId);
              return list.map((mat, idx) => {
                const active = materialId === mat.id;
                return (
                  <button
                    key={mat.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active || (!hasActive && idx === 0) ? 0 : -1}
                    onClick={() => setMaterialId(mat.id)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "ArrowRight" ||
                        e.key === "ArrowDown" ||
                        e.key === "ArrowLeft" ||
                        e.key === "ArrowUp"
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                        const delta =
                          e.key === "ArrowRight" || e.key === "ArrowDown"
                            ? 1
                            : -1;
                        const nextIdx =
                          (idx + delta + list.length) % list.length;
                        setMaterialId(list[nextIdx].id);
                        const group = e.currentTarget.closest('[role="radiogroup"]');
                        const radios =
                          group?.querySelectorAll<HTMLButtonElement>(
                            '[role="radio"]',
                          );
                        radios?.[nextIdx]?.focus();
                      }
                    }}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                        : "border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/40"
                    }`}
                  >
                    {mat.name}
                  </button>
                );
              });
            })()}
          </div>

          {selectedMaterial?.hint && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)] p-2 text-[11px] text-[var(--text-primary)]">
              <Info
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-warning-text)]"
                strokeWidth={1.5}
              />
              <span className="text-[var(--text-secondary)]">
                {selectedMaterial.hint}
              </span>
            </div>
          )}
        </section>

        {/* 4. Options */}
        <section className="space-y-2.5 p-3 text-xs">
          <div className="flex items-center justify-between text-[var(--text-secondary)]">
            <span>Supports (overhangs)</span>
            <Switch
              checked={supportMaterial}
              onChange={setSupportMaterial}
              ariaLabel="Toggle support material"
            />
          </div>
          <div className="flex items-center justify-between text-[var(--text-secondary)]">
            <span>Adhesion brim (5 mm)</span>
            <Switch
              checked={useBrim}
              onChange={setUseBrim}
              ariaLabel="Toggle adhesion brim"
            />
          </div>

          <div className="space-y-1 pt-0.5">
            <label
              htmlFor="slicer-output-name"
              className="block text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase"
            >
              Output G-code Name
            </label>
            <input
              id="slicer-output-name"
              type="text"
              value={outputName}
              onChange={(e) => setOutputName(e.target.value)}
              placeholder="mk3s_print"
              className="mono-num h-7 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </div>

          {isNextcloudConnected && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                <span>Save .gcode to Nextcloud</span>
                <Switch
                  checked={autoSaveCloud}
                  onChange={setAutoSaveCloud}
                  ariaLabel="Toggle automatic save to Nextcloud"
                />
              </div>
              {autoSaveCloud && (
                <input
                  type="text"
                  aria-label="Nextcloud output folder"
                  value={cloudOutputFolder}
                  onChange={(e) => setCloudOutputFolder(e.target.value)}
                  placeholder="/3D Prints"
                  className="mono-num h-7 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
              )}
            </div>
          )}
        </section>

        {/* 5. Active Job / Output */}
        {activeJob &&
          (activeJob.state === "completed" ||
            activeJob.state === "failed" ||
            activeJob.state === "cancelled") && (
            <section className="space-y-2.5 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="mono-num truncate text-[11px] font-medium text-[var(--text-primary)]">
                  {activeJob.outputFileName}
                </span>
                <span
                  className={`shrink-0 text-[10px] font-medium capitalize ${
                    activeJob.state === "completed"
                      ? "text-[var(--status-positive-text)]"
                      : activeJob.state === "failed"
                        ? "text-[var(--status-danger-text)]"
                        : "text-[var(--text-muted)]"
                  }`}
                >
                  {activeJob.state}
                </span>
              </div>

              {activeJob.state === "completed" && (
                <>
                  <div className="grid grid-cols-2 divide-x divide-[var(--border-hairline)] border-y border-[var(--border-hairline)] py-1.5">
                    <div className="pr-2.5">
                      <span className="block text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                        Print time
                      </span>
                      <span className="mono-num text-xs font-medium text-[var(--text-primary)]">
                        {activeJob.estimatedTime ?? "Ready"}
                      </span>
                    </div>
                    <div className="pl-2.5">
                      <span className="block text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                        Filament
                      </span>
                      <span className="mono-num text-xs font-medium text-[var(--text-primary)]">
                        {activeJob.filamentGrams != null
                          ? `${activeJob.filamentGrams.toFixed(1)} g`
                          : activeJob.gcodeSizeBytes != null
                            ? formatBytes(activeJob.gcodeSizeBytes)
                            : "—"}
                      </span>
                    </div>
                  </div>
                </>
              )}

              {activeJob.state === "failed" && activeJob.errorMessage && (
                <p className="text-[11px] text-[var(--status-danger-text)]">
                  {activeJob.errorMessage}
                </p>
              )}

              {activeJob.technicalLog && (
                <div>
                  <button
                    type="button"
                    aria-expanded={showTechLog}
                    onClick={() => setShowTechLog((prev) => !prev)}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    {showTechLog ? "Hide log" : "Show slicer log"}
                  </button>
                  {showTechLog && (
                    <pre className="mono-num mt-1.5 max-h-28 overflow-auto rounded border border-[var(--border-hairline)] bg-[var(--bg-app)] p-2 text-[10px] text-[var(--text-secondary)]">
                      {activeJob.technicalLog}
                    </pre>
                  )}
                </div>
              )}
            </section>
          )}
      </div>

      {/* Anchored Slice & Output Action Footer (keeps Download .gcode above the fold) */}
      <div className="shrink-0 space-y-1.5 border-t border-[var(--border-hairline)] p-3">
        {!isSlicing && activeJob?.state === "completed" && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={downloadingJobId === activeJob.id}
              onClick={() => void handleDownloadGcode(activeJob.id)}
              className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              {downloadingJobId === activeJob.id ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  strokeWidth={1.5}
                />
              ) : (
                <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
              Download .gcode
            </button>
            {isNextcloudConnected && (
              <IconButton
                size="sm"
                label={
                  activeJob.cloudSavedPath
                    ? `Saved to ${activeJob.cloudSavedPath}`
                    : `Save .gcode to ${cloudOutputFolder}`
                }
                disabled={savingCloudJobId === activeJob.id}
                onClick={() => void handleSaveJobToNextcloud(activeJob.id)}
              >
                <CloudUpload className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            )}
          </div>
        )}
        {isSlicing && activeJob ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                {activeJob.stage}
              </span>
              <span className="mono-num text-[var(--text-secondary)]">
                {activeJob.percent}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-label="Slicing progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(activeJob.percent)}
              className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]"
            >
              <div
                className="h-full bg-[var(--accent)] transition-all duration-300"
                style={{ width: `${activeJob.percent}%` }}
              />
            </div>
            <div className="flex justify-end">
              <InlineDeleteConfirm
                armed={confirmCancelSlice}
                onArm={() => setConfirmCancelSlice(true)}
                onCancel={() => setConfirmCancelSlice(false)}
                onConfirm={() => {
                  setConfirmCancelSlice(false);
                  void handleCancelSlice(activeJob.id);
                }}
                label="Cancel active slicing job"
                triggerLabel="Cancel slicing"
                confirmLabel="Cancel job"
              />
            </div>
          </div>
        ) : (
          <Tooltip label="Slice build plate" shortcut={SLICE_SHORTCUT} className="w-full">
            <button
              type="button"
              disabled={objects.length === 0 || anyOutOfBounds || isSlicing}
              onClick={() => void handleStartSlice()}
              className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Printer className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span>Slice for Prusa MK3S</span>
              <Kbd className="border-white/30 bg-black/25 text-white">
                {SLICE_SHORTCUT}
              </Kbd>
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );

  return (
    <WorkspaceLayout
      moduleId="slicer"
      headerLeft={
        <div className="flex items-center gap-2">
          <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
            3D Printing
          </h1>
          <span className="mono-num hidden rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] sm:inline-block">
            Prusa MK3S
          </span>
        </div>
      }
      headerRight={
        <div
          role="toolbar"
          aria-label="3D printing actions"
          onKeyDown={handleToolbarKeyDown}
          className="flex items-center gap-1"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".stl,.3mf"
            multiple
            className="hidden"
            onChange={(e) => void handleLocalFileSelected(e)}
          />
          <IconButton
            label="Add local STL / 3MF"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          {isNextcloudConnected && (
            <IconButton
              label="Load model from Nextcloud"
              onClick={() => void handleOpenCloudPicker()}
            >
              <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.5} />
            </IconButton>
          )}
          <IconButton
            label="Auto-arrange plate"
            disabled={objects.length === 0}
            onClick={handleAutoArrange}
          >
            <Grid2x2 className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            label={
              bottomDrawerOpen
                ? "Collapse part transform drawer"
                : "Expand part transform drawer"
            }
            shortcut="B"
            active={bottomDrawerOpen}
            onClick={() => setBottomDrawerOpen((v) => !v)}
          >
            <PanelBottom className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            label={isViewportFocused ? "Restore panels" : "Focus 3D viewport"}
            shortcut="F"
            active={isViewportFocused}
            onClick={toggleFocusViewport}
          >
            {isViewportFocused ? (
              <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
          </IconButton>
          <IconButton
            label={
              overview?.binary.available
                ? "PrusaSlicer CLI configured"
                : "Setup PrusaSlicer CLI"
            }
            active={showEngineSetup}
            onClick={() => setShowEngineSetup((prev) => !prev)}
          >
            <Wrench className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      }
      sidebar={sidebarNode}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={onToggleSidebar}
      inspector={inspectorNode}
      inspectorOpen={Boolean(quickChatInspector) || inspectorOpen}
      onToggleInspector={onToggleInspector}
      inspectorLabel={quickChatInspector ? "Quick chat" : "Details inspector"}
      inspectorToggleLabel={quickChatInspector ? "Close quick chat" : undefined}
      inspectorToggleShortcut={quickChatInspector ? QUICK_CHAT_SHORTCUT : undefined}
      banners={banners}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {error && (
          <div className="border-b border-[var(--border-hairline)] p-2.5">
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {notice && (
          <NoticeBanner message={notice} onDismiss={() => setNotice(null)} />
        )}

        {restoredDraftNotice && overview?.materialDraft && (
          <div className="flex items-center justify-between border-b border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)] px-4 py-1.5 text-xs text-[var(--text-primary)]">
            <span>
              Unsaved filament draft:{" "}
              <strong>{overview.materialDraft.name || "Untitled"}</strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resumeMaterialDraft}
                className="rounded bg-[var(--status-warning)] px-2 py-0.5 text-[11px] font-medium text-[var(--status-warning-fg)]"
              >
                Resume
              </button>
              <InlineDeleteConfirm
                armed={confirmDiscardDraftBanner}
                onArm={() => setConfirmDiscardDraftBanner(true)}
                onCancel={() => setConfirmDiscardDraftBanner(false)}
                onConfirm={() => {
                  setConfirmDiscardDraftBanner(false);
                  void handleDiscardMaterialDraft();
                }}
                label="Discard filament draft"
                triggerLabel="Discard"
                confirmLabel="Discard"
              />
            </div>
          </div>
        )}

        {/* Collapsible PrusaSlicer CLI Setup Strip (toggled on demand, never steals viewport permanently) */}
        {showEngineSetup && (
          <form
            onSubmit={handleSaveEnginePath}
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sidebar)] px-3 py-2 text-xs"
          >
            <div className="min-w-0 flex-1">
              <span className="font-medium text-[var(--text-primary)]">
                {overview?.binary.available
                  ? `PrusaSlicer (${overview.binary.source})`
                  : "PrusaSlicer CLI not found"}
              </span>
              <span className="ml-2 text-[11px] text-[var(--text-muted)]">
                Path to <span className="mono-num">prusa-slicer-console.exe</span> /{" "}
                <span className="mono-num">PrusaSlicer</span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                type="text"
                aria-label="PrusaSlicer executable path"
                value={enginePathInput}
                onChange={(e) => setEnginePathInput(e.target.value)}
                placeholder="Auto-detect or full path…"
                className="mono-num h-7 w-56 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
              <button
                type="submit"
                disabled={savingEnginePath}
                className="h-7 rounded-md bg-[var(--accent)] px-2.5 text-[11px] font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {savingEnginePath ? "Checking…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => void openExternalUrl(PRUSASLICER_DOWNLOAD_URL)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border-strong)] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                Download
                <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
              </button>
            </div>
          </form>
        )}

        {/* Unobstructed Neutral Dark 3D Viewport */}
        <div className="relative min-h-0 flex-1">
          {loading && !overview ? (
            <div
              role="status"
              aria-live="polite"
              className="flex h-full items-center justify-center gap-2 text-xs text-[var(--text-muted)]"
            >
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
              Initializing build plate…
            </div>
          ) : (
            <BuildPlateViewport
              objects={objects}
              selectedId={selectedObjectId}
              onSelectObject={setSelectedObjectId}
              onMoveObject={handleMoveObjectOnPlate}
            />
          )}
        </div>

        {/* Sleek Always-On Telemetry Strip + Collapsible Part Transform Drawer (seamless bg-app matching sidebar footer) */}
        <div className="shrink-0 border-t border-[var(--border-hairline)] bg-[var(--bg-app)]">
          {/* Monospace Printer & Profile Telemetry Bar (strictly single-row h-8 matching all module footers) */}
          <div className="mono-num flex h-8 flex-nowrap items-center justify-between gap-3 overflow-hidden px-3 text-[11px]">
            <div className="flex min-w-0 flex-nowrap items-center gap-3 overflow-hidden whitespace-nowrap text-[var(--text-secondary)]">
              <span>
                <span className="text-[var(--text-muted)]">NOZ </span>
                {selectedMaterial?.nozzleTempC ?? 215}°
              </span>
              <span>
                <span className="text-[var(--text-muted)]">BED </span>
                {selectedMaterial?.bedTempC ?? 60}°
              </span>
              <span>
                <span className="text-[var(--text-muted)]">LAYER </span>
                {(selectedQualityPreset?.layerHeightMm ?? 0.2).toFixed(2)}mm
              </span>
              {plateBounds &&
                plateBounds.maxX !== null &&
                plateBounds.minX !== null &&
                plateBounds.maxY !== null &&
                plateBounds.minY !== null &&
                plateBounds.maxZ !== null &&
                plateBounds.minZ !== null && (
                  <span className="hidden xl:inline">
                    <span className="text-[var(--text-muted)]">ENV </span>
                    {(plateBounds.maxX - plateBounds.minX).toFixed(0)}×
                    {(plateBounds.maxY - plateBounds.minY).toFixed(0)}×
                    {(plateBounds.maxZ - plateBounds.minZ).toFixed(0)}mm
                  </span>
                )}
            </div>

            <div className="flex shrink-0 flex-nowrap items-center gap-2.5 whitespace-nowrap">
              {anyOutOfBounds && (
                <span className="inline-flex items-center gap-1 text-[var(--status-danger-text)]">
                  <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
                  Outside plate
                </span>
              )}
              {activeJob && (
                <span className="text-[var(--text-secondary)]">
                  <span className="text-[var(--text-muted)]">JOB </span>
                  {activeJob.state === "running"
                    ? `${activeJob.percent}%`
                    : (activeJob.estimatedTime ?? activeJob.state)}
                </span>
              )}
              <button
                type="button"
                aria-expanded={bottomDrawerOpen}
                onClick={() => setBottomDrawerOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <span>Transform</span>
                <ChevronUp
                  className={`h-3 w-3 transition-transform ${
                    bottomDrawerOpen ? "rotate-180" : ""
                  }`}
                  strokeWidth={1.5}
                />
              </button>
            </div>
          </div>

          {bottomDrawerOpen && (
            <div className="border-t border-[var(--border-subtle)]">
              {/* Selected Object Compact Transform Row */}
              {selectedObject ? (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                    Pos (mm)
                  </span>
                  <label className="flex items-center gap-1 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 focus-within:border-[var(--accent)]">
                    <span className="text-[10px] text-[var(--text-muted)]">X</span>
                    <input
                      type="number"
                      step="1"
                      aria-label="Position X in millimeters"
                      value={selectedObject.positionX}
                      onChange={(e) =>
                        updateSelectedObject({
                          positionX: Number(e.target.value) || 0,
                        })
                      }
                      className="mono-num w-12 bg-transparent text-right text-[11px] text-[var(--text-primary)] focus:outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-1 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 focus-within:border-[var(--accent)]">
                    <span className="text-[10px] text-[var(--text-muted)]">Y</span>
                    <input
                      type="number"
                      step="1"
                      aria-label="Position Y in millimeters"
                      value={selectedObject.positionY}
                      onChange={(e) =>
                        updateSelectedObject({
                          positionY: Number(e.target.value) || 0,
                        })
                      }
                      className="mono-num w-12 bg-transparent text-right text-[11px] text-[var(--text-primary)] focus:outline-none"
                    />
                  </label>
                  <IconButton
                    size="xs"
                    label="Center part on bed"
                    onClick={() =>
                      updateSelectedObject({
                        positionX: MK3S_BED_X / 2,
                        positionY: MK3S_BED_Y / 2,
                      })
                    }
                  >
                    <Crosshair className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </IconButton>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                    Rot (°)
                  </span>
                  {(["rotXDeg", "rotYDeg", "rotZDeg"] as const).map(
                    (axis, i) => {
                      const label = ["X", "Y", "Z"][i];
                      return (
                        <div
                          key={axis}
                          className="flex items-center gap-0.5 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 focus-within:border-[var(--accent)]"
                        >
                          <label className="flex items-center gap-0.5">
                            <span className="text-[10px] text-[var(--text-muted)]">
                              {label}
                            </span>
                            <input
                              type="number"
                              step="15"
                              aria-label={`Rotate ${label} degrees`}
                              value={selectedObject[axis]}
                              onChange={(e) =>
                                updateSelectedObject({
                                  [axis]: Number(e.target.value) || 0,
                                })
                              }
                              className="mono-num w-9 bg-transparent text-right text-[11px] text-[var(--text-primary)] focus:outline-none"
                            />
                          </label>
                          <Tooltip label={`Rotate ${label} +90°`}>
                            <button
                              type="button"
                              aria-label={`Rotate ${label} +90°`}
                              onClick={() =>
                                updateSelectedObject({
                                  [axis]: (selectedObject[axis] + 90) % 360,
                                })
                              }
                              className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            >
                              <RotateCw className="h-3 w-3" strokeWidth={1.5} />
                            </button>
                          </Tooltip>
                        </div>
                      );
                    },
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                    Scale
                  </span>
                  <label className="flex items-center gap-1 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 focus-within:border-[var(--accent)]">
                    <input
                      type="number"
                      min={10}
                      max={500}
                      step={5}
                      aria-label="Scale percent"
                      value={selectedObject.scalePercent}
                      onChange={(e) =>
                        updateSelectedObject({
                          scalePercent: Math.max(
                            10,
                            Math.min(500, Number(e.target.value) || 100),
                          ),
                        })
                      }
                      className="mono-num w-10 bg-transparent text-right text-[11px] text-[var(--text-primary)] focus:outline-none"
                    />
                    <span className="text-[10px] text-[var(--text-muted)]">%</span>
                  </label>
                  <span className="mono-num text-[11px] text-[var(--text-muted)]">
                    {(
                      (selectedObject.baseSizeMm.x * selectedObject.scalePercent) /
                      100
                    ).toFixed(0)}
                    ×
                    {(
                      (selectedObject.baseSizeMm.y * selectedObject.scalePercent) /
                      100
                    ).toFixed(0)}
                    ×
                    {(
                      (selectedObject.baseSizeMm.z * selectedObject.scalePercent) /
                      100
                    ).toFixed(0)}{" "}
                    mm
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between px-3 py-2 text-[11px] text-[var(--text-muted)]">
                <span>Load an STL or 3MF model to arrange parts on the MK3S bed.</span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="font-medium text-[var(--accent-text)] hover:underline"
                >
                  Choose file
                </button>
              </div>
            )}
            </div>
          )}
        </div>
      </div>

      {/* Modal: Browse Nextcloud Files for .STL / .3MF */}
      {showCloudPicker && (
        <Modal
          ariaLabel="Load 3D Model from Nextcloud"
          onClose={() => setShowCloudPicker(false)}
        >
          <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)]">
            <div className="flex h-11 items-center justify-between border-b border-[var(--border-hairline)] px-4">
              <h2 className="text-xs font-medium text-[var(--text-primary)]">
                Load STL or 3MF from Nextcloud
              </h2>
              <IconButton
                size="xs"
                label="Close"
                onClick={() => setShowCloudPicker(false)}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            </div>
            {error && (
              <div className="border-b border-[var(--border-hairline)] p-3">
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 py-1.5 text-xs">
              <button
                type="button"
                onClick={() => void loadPickerFolder("/")}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                <Home className="h-3.5 w-3.5" strokeWidth={1.5} />
                Root
              </button>
              {pickerPath
                .split("/")
                .filter(Boolean)
                .map((seg, idx, arr) => {
                  const target = `/${arr.slice(0, idx + 1).join("/")}`;
                  return (
                    <span key={target} className="inline-flex items-center gap-1">
                      <ChevronRight
                        className="h-3 w-3 text-[var(--text-muted)]"
                        strokeWidth={1.5}
                      />
                      <button
                        type="button"
                        onClick={() => void loadPickerFolder(target)}
                        className="rounded px-1.5 py-0.5 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        {seg}
                      </button>
                    </span>
                  );
                })}
            </div>
            <div className="flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
              {loadingPicker ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center justify-center gap-2 p-8 text-xs text-[var(--text-muted)]"
                >
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                  Loading folder…
                </div>
              ) : (
                pickerItems
                  .filter(
                    (it) =>
                      it.entry.kind === "directory" ||
                      /\.(stl|3mf)$/i.test(it.entry.name),
                  )
                  .map((item) => {
                    const isDir = item.entry.kind === "directory";
                    const busy = loadingCloudModelPath === item.entry.path;
                    return (
                      <div
                        key={item.entry.path}
                        className="flex items-center justify-between gap-3 px-4 py-2 text-xs hover:bg-[var(--bg-hover)]/60"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            isDir
                              ? void loadPickerFolder(item.entry.path)
                              : void handleAddCloudModel(item)
                          }
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          {isDir ? (
                            <Folder
                              className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
                              strokeWidth={1.5}
                            />
                          ) : (
                            <FileIcon
                              className="h-4 w-4 shrink-0 text-[var(--accent)]"
                              strokeWidth={1.5}
                            />
                          )}
                          <span className="truncate font-medium text-[var(--text-primary)]">
                            {item.entry.name}
                          </span>
                        </button>
                        {!isDir && (
                          <button
                            type="button"
                            disabled={Boolean(loadingCloudModelPath)}
                            onClick={() => void handleAddCloudModel(item)}
                            className="inline-flex h-6 items-center gap-1 rounded bg-[var(--accent)] px-2 text-[11px] font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                          >
                            {busy && (
                              <Loader2
                                className="h-3 w-3 animate-spin"
                                strokeWidth={1.5}
                              />
                            )}
                            Add
                          </button>
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Modal: Custom Material Preset Editor */}
      {showMaterialModal && editingMaterial && (
        <Modal
          ariaLabel="Custom Filament Preset"
          onClose={() => {
            flushMaterialDraft();
            setShowMaterialModal(false);
          }}
        >
          <form
            onSubmit={handleSaveCustomMaterial}
            className="w-full max-w-md overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)]"
          >
            <div className="flex h-11 items-center justify-between border-b border-[var(--border-hairline)] px-4">
              <h2 className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                <Sliders className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.5} />
                Custom Filament Preset (MK3S)
              </h2>
              <IconButton
                size="xs"
                label="Close"
                onClick={() => {
                  flushMaterialDraft();
                  setShowMaterialModal(false);
                }}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            </div>
            <div className="space-y-3 p-4 text-xs">
              {error && (
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="slicer-mat-name"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Preset name *
                  </label>
                  <input
                    id="slicer-mat-name"
                    type="text"
                    required
                    value={editingMaterial.name}
                    onChange={(e) =>
                      updateEditingMaterial({ name: e.target.value })
                    }
                    className="h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="slicer-mat-family"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Base family
                  </label>
                  <Select
                    id="slicer-mat-family"
                    ariaLabel="Filament base family"
                    value={editingMaterial.filamentType}
                    onChange={(val) =>
                      updateEditingMaterial({ filamentType: val })
                    }
                    options={[
                      { value: "PLA", label: "PLA" },
                      { value: "PETG", label: "PETG" },
                      { value: "ABS", label: "ABS" },
                      { value: "FLEX", label: "TPU / FLEX" },
                    ]}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="slicer-mat-nozzle"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Nozzle (°C, 160–300)
                  </label>
                  <input
                    id="slicer-mat-nozzle"
                    type="number"
                    min={160}
                    max={300}
                    value={editingMaterial.nozzleTempC}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 215;
                      updateEditingMaterial({
                        nozzleTempC: v,
                        firstLayerNozzleTempC: v,
                      });
                    }}
                    className="mono-num h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="slicer-mat-bed"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Bed (°C, 0–120)
                  </label>
                  <input
                    id="slicer-mat-bed"
                    type="number"
                    min={0}
                    max={120}
                    value={editingMaterial.bedTempC}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 60;
                      updateEditingMaterial({
                        bedTempC: v,
                        firstLayerBedTempC: v,
                      });
                    }}
                    className="mono-num h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="slicer-mat-fan-min"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Fan min (%)
                  </label>
                  <input
                    id="slicer-mat-fan-min"
                    type="number"
                    min={0}
                    max={100}
                    value={editingMaterial.fanMinPercent}
                    onChange={(e) =>
                      updateEditingMaterial({
                        fanMinPercent: Number(e.target.value) || 0,
                      })
                    }
                    className="mono-num h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="slicer-mat-fan-max"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Fan max (%)
                  </label>
                  <input
                    id="slicer-mat-fan-max"
                    type="number"
                    min={0}
                    max={100}
                    value={editingMaterial.fanMaxPercent}
                    onChange={(e) =>
                      updateEditingMaterial({
                        fanMaxPercent: Number(e.target.value) || 100,
                      })
                    }
                    className="mono-num h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="slicer-mat-hint"
                  className="block text-[11px] text-[var(--text-secondary)]"
                >
                  Optional note for teammates
                </label>
                <input
                  id="slicer-mat-hint"
                  type="text"
                  value={editingMaterial.hint ?? ""}
                  onChange={(e) =>
                    updateEditingMaterial({
                      hint: e.target.value.trim() ? e.target.value : null,
                    })
                  }
                  placeholder="e.g. Dry spool for 4h before printing"
                  className="h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              <p className="text-[11px] text-[var(--text-muted)]">
                Changes auto-save as a local draft so edits are never lost.
              </p>
            </div>
            <div className="flex items-center justify-between border-t border-[var(--border-hairline)] px-4 py-3">
              <InlineDeleteConfirm
                armed={confirmDiscardDraftModal}
                onArm={() => setConfirmDiscardDraftModal(true)}
                onCancel={() => setConfirmDiscardDraftModal(false)}
                onConfirm={() => {
                  setConfirmDiscardDraftModal(false);
                  void handleDiscardMaterialDraft();
                }}
                label="Discard filament draft"
                triggerLabel="Discard draft"
                confirmLabel="Discard"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    flushMaterialDraft();
                    setShowMaterialModal(false);
                  }}
                  className="h-8 rounded-md border border-[var(--border-strong)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={savingMaterial}
                  className="h-8 rounded-md bg-[var(--accent)] px-3.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {savingMaterial ? "Saving…" : "Save preset"}
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}
    </WorkspaceLayout>
  );
}
