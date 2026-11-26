import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronRight,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  Grid2x2,
  Home,
  Info,
  Loader2,
  Pencil,
  Plus,
  Printer,
  RotateCw,
  Settings2,
  Sliders,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { listFiles } from "../lib/filesClient";
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
}

interface SlicerProgressPayload {
  jobId: string;
  percent: number;
  stage: string;
}

const MAX_LOCAL_MODEL_BYTES = 100 * 1024 * 1024;
const PRUSASLICER_DOWNLOAD_URL = "https://www.prusa3d.com/page/prusaslicer_424/";

export function SlicerView({ isNextcloudConnected }: SlicerViewProps) {
  const [overview, setOverview] = useState<SlicerOverview_Serialize | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UserFacingError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Build plate objects (multi-object STL + 3MF support)
  const [objects, setObjects] = useState<PlateObject[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);

  // Three simple orthogonal choices (per Plan 07 §3)
  const [rigidity, setRigidity] = useState<RigidityPreset>("medium");
  const [quality, setQuality] = useState<QualityPreset>("standard");
  const [materialId, setMaterialId] = useState<string>("pla");
  const [supportMaterial, setSupportMaterial] = useState(false);
  const [useBrim, setUseBrim] = useState(false);
  const [outputName, setOutputName] = useState("");
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

  // Cloud model picker modal (load STL/3MF from Nextcloud via StorageBackend)
  const [showCloudPicker, setShowCloudPicker] = useState(false);
  const [pickerPath, setPickerPath] = useState("/");
  const [pickerItems, setPickerItems] = useState<FileItemView_Serialize[]>([]);
  const [loadingPicker, setLoadingPicker] = useState(false);
  const [loadingCloudModelPath, setLoadingCloudModelPath] = useState<
    string | null
  >(null);

  // Custom material editor modal (with auto-saved local draft protection)
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

  // Dismiss modals with Escape key (flushing any unsaved material draft)
  useEffect(() => {
    if (!showCloudPicker && !showMaterialModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowCloudPicker(false);
        if (showMaterialModal) {
          flushMaterialDraft();
          setShowMaterialModal(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showCloudPicker, showMaterialModal, flushMaterialDraft]);

  // Flush any pending custom material draft and dispose Three.js geometries on unmount
  useEffect(() => {
    return () => {
      flushMaterialDraft();
      for (const obj of objectsRef.current) {
        obj.geometry.dispose();
      }
    };
  }, [flushMaterialDraft]);

  // Listen to real-time slicer progress and completion events from Rust
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

  const plateBounds = useMemo(() => computePlateBounds(objects), [objects]);
  const anyOutOfBounds = useMemo(
    () => objects.some((o) => computeObjectPrinterBounds(o).outOfBounds),
    [objects],
  );

  const addParsedModel = useCallback(
    (fileName: string, buffer: ArrayBuffer) => {
      const { geometry, baseSizeMm } = parseModelToGeometry(fileName, buffer);
      const id = `part-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      // Place first object dead center; offset subsequent objects gently so they don't overlap.
      setObjects((prev) => {
        const offsetIdx = prev.length;
        const posX = Math.min(
          MK3S_BED_X - baseSizeMm.x / 2 - 5,
          Math.max(baseSizeMm.x / 2 + 5, MK3S_BED_X / 2 + (offsetIdx % 3) * 18 - (offsetIdx > 0 ? 18 : 0)),
        );
        const posY = Math.min(
          MK3S_BED_Y - baseSizeMm.y / 2 - 5,
          Math.max(baseSizeMm.y / 2 + 5, MK3S_BED_Y / 2 + Math.floor(offsetIdx / 3) * 18),
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
        prev.trim()
          ? prev
          : fileName.replace(/\.(stl|3mf)$/i, ""),
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
          recoveryHint: "Decimate or simplify the mesh in your CAD tool and try again.",
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
      flashNotice(`Loaded "${payload.fileName}" onto the MK3S build plate.`);
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

  /** Shelf-pack auto-arrange using actual rotated bounds centers with 8 mm clearance. */
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
        flashNotice("Automatic detection ran — PrusaSlicer was not found yet.");
      }
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setSavingEnginePath(false);
    }
  }

  // Custom Material Modal + Debounced Local Draft Protection
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
      flashNotice(`Deleted custom material "${name}".`);
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
      // Do not overwrite if a terminal event for this job already arrived while awaiting IPC.
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
      flashNotice(`Saved "${dl.fileName}" — copy it to your Prusa MK3S SD card.`);
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
        `Saved G-code to Nextcloud at ${updated.cloudSavedPath ?? cloudOutputFolder}.`,
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

  if (loading && !overview) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-xs text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading 3D Slicer...
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-8.5rem)] max-w-7xl flex-col gap-3">
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {notice && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            {notice}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {restoredDraftNotice && overview?.materialDraft && (
        <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <span>
            You have an unsaved custom filament draft (
            <strong>{overview.materialDraft.name || "Untitled"}</strong>).
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resumeMaterialDraft}
              className="rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-700"
            >
              Resume draft
            </button>
            <button
              type="button"
              onClick={() => void handleDiscardMaterialDraft()}
              className="text-[11px] font-medium hover:underline"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".stl,.3mf"
            multiple
            className="hidden"
            onChange={(e) => void handleLocalFileSelected(e)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700"
          >
            <Upload className="h-3.5 w-3.5" />
            Add STL / 3MF
          </button>
          {isNextcloudConnected && (
            <button
              type="button"
              onClick={() => void handleOpenCloudPicker()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <FolderOpen className="h-3.5 w-3.5 text-blue-600" />
              From Nextcloud
            </button>
          )}
          {objects.length > 0 && (
            <button
              type="button"
              onClick={handleAutoArrange}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Grid2x2 className="h-3.5 w-3.5" />
              Auto-arrange
            </button>
          )}
        </div>

        {/* Engine Status Pill */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowEngineSetup((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              overview?.binary.available
                ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300"
                : "bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/60 dark:text-amber-300"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                overview?.binary.available ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            {overview?.binary.available
              ? "PrusaSlicer ready"
              : "Setup PrusaSlicer CLI"}
            <Settings2 className="h-3 w-3 opacity-75" />
          </button>
        </div>
      </div>

      {/* Collapsible PrusaSlicer CLI Setup Panel */}
      {(showEngineSetup || !overview?.binary.available) && (
        <form
          onSubmit={handleSaveEnginePath}
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-xs dark:border-amber-900/50 dark:bg-amber-950/30"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-semibold text-slate-900 dark:text-slate-100">
              {overview?.binary.available
                ? `PrusaSlicer detected (${overview.binary.source})`
                : "PrusaSlicer CLI not found automatically"}
            </p>
            <p className="text-[11px] text-slate-600 dark:text-slate-400">
              FR Universal App runs the official prebuilt PrusaSlicer binary to
              generate safe Prusa MK3S G-code. Install it once or paste the path
              to <code>prusa-slicer-console.exe</code> (Windows) /{" "}
              <code>PrusaSlicer</code> (macOS).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={enginePathInput}
              onChange={(e) => setEnginePathInput(e.target.value)}
              placeholder="Auto-detect (leave blank) or full path..."
              className="w-64 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
            />
            <button
              type="submit"
              disabled={savingEnginePath}
              className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
            >
              {savingEnginePath ? "Checking..." : "Save & Check"}
            </button>
            <button
              type="button"
              onClick={() => void openExternalUrl(PRUSASLICER_DOWNLOAD_URL)}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              Get PrusaSlicer
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        </form>
      )}

      {/* Main Split Workspace: Left 3D Build Plate + Objects | Right Simple Controls */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {/* Left: 3D Build Plate + Object Manipulation */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
          <div className="min-h-0 flex-1">
            <BuildPlateViewport
              objects={objects}
              selectedId={selectedObjectId}
              onSelectObject={setSelectedObjectId}
            />
          </div>

          {/* Multi-object bar + Place / Rotate / Scale controls */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            {objects.length === 0 ? (
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-2">
                  <Box className="h-4 w-4 text-slate-400" />
                  Load one or more <strong>.STL</strong> or{" "}
                  <strong>.3MF</strong> models to arrange them on the MK3S bed.
                </span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="font-semibold text-blue-600 hover:underline dark:text-blue-400"
                >
                  Choose file
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Object Pills */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {objects.map((obj) => {
                    const active = obj.id === selectedObjectId;
                    const oob = computeObjectPrinterBounds(obj).outOfBounds;
                    return (
                      <div
                        key={obj.id}
                        className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                          oob
                            ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300"
                            : active
                              ? "border-orange-400 bg-orange-50 font-semibold text-orange-800 dark:border-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
                              : "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedObjectId(obj.id)}
                          className="max-w-[160px] truncate"
                        >
                          {obj.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDuplicateObject(obj)}
                          title="Duplicate part"
                          className="rounded p-0.5 opacity-70 hover:bg-black/10 hover:opacity-100"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveObject(obj.id)}
                          title="Remove from plate"
                          className="rounded p-0.5 opacity-70 hover:bg-rose-500/20 hover:opacity-100"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>

                {anyOutOfBounds && (
                  <div className="flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-1.5 text-[11px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Part highlighted in red exceeds the 250 × 210 × 210 mm Prusa
                    MK3S bed. Click Auto-arrange or adjust Position/Scale.
                  </div>
                )}

                {/* Selected Part Place / Rotate / Scale Controls */}
                {selectedObject && (
                  <div className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-2.5 text-[11px] sm:grid-cols-3 dark:border-slate-800">
                    {/* Place */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">
                          Place (mm)
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            updateSelectedObject({
                              positionX: MK3S_BED_X / 2,
                              positionY: MK3S_BED_Y / 2,
                            })
                          }
                          className="text-[10px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                        >
                          Center
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <label className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700">
                          <span className="text-slate-400">X</span>
                          <input
                            type="number"
                            step="1"
                            value={selectedObject.positionX}
                            onChange={(e) =>
                              updateSelectedObject({
                                positionX: Number(e.target.value) || 0,
                              })
                            }
                            className="w-full bg-transparent text-right font-mono text-slate-900 focus:outline-none dark:text-slate-100"
                          />
                        </label>
                        <label className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700">
                          <span className="text-slate-400">Y</span>
                          <input
                            type="number"
                            step="1"
                            value={selectedObject.positionY}
                            onChange={(e) =>
                              updateSelectedObject({
                                positionY: Number(e.target.value) || 0,
                              })
                            }
                            className="w-full bg-transparent text-right font-mono text-slate-900 focus:outline-none dark:text-slate-100"
                          />
                        </label>
                      </div>
                    </div>

                    {/* Rotate */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">
                          Rotate (°)
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            updateSelectedObject({
                              rotXDeg: 0,
                              rotYDeg: 0,
                              rotZDeg: 0,
                            })
                          }
                          className="text-[10px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                        >
                          Reset
                        </button>
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        {(["rotXDeg", "rotYDeg", "rotZDeg"] as const).map(
                          (axis, i) => {
                            const label = ["X", "Y", "Z"][i];
                            return (
                              <div
                                key={axis}
                                className="flex items-center rounded-lg border border-slate-200 px-1.5 py-1 dark:border-slate-700"
                              >
                                <span className="mr-0.5 text-slate-400">
                                  {label}
                                </span>
                                <input
                                  type="number"
                                  step="15"
                                  value={selectedObject[axis]}
                                  onChange={(e) =>
                                    updateSelectedObject({
                                      [axis]: Number(e.target.value) || 0,
                                    })
                                  }
                                  className="w-full bg-transparent text-right font-mono text-slate-900 focus:outline-none dark:text-slate-100"
                                />
                                <button
                                  type="button"
                                  title={`Rotate ${label} +90°`}
                                  onClick={() =>
                                    updateSelectedObject({
                                      [axis]: (selectedObject[axis] + 90) % 360,
                                    })
                                  }
                                  className="ml-0.5 text-slate-400 hover:text-blue-600"
                                >
                                  <RotateCw className="h-2.5 w-2.5" />
                                </button>
                              </div>
                            );
                          },
                        )}
                      </div>
                    </div>

                    {/* Scale */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">
                          Scale (%)
                        </span>
                        <span className="font-mono text-[10px] text-slate-400">
                          {(
                            (selectedObject.baseSizeMm.x *
                              selectedObject.scalePercent) /
                            100
                          ).toFixed(0)}
                          ×
                          {(
                            (selectedObject.baseSizeMm.y *
                              selectedObject.scalePercent) /
                            100
                          ).toFixed(0)}
                          ×
                          {(
                            (selectedObject.baseSizeMm.z *
                              selectedObject.scalePercent) /
                            100
                          ).toFixed(0)}{" "}
                          mm
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={10}
                          max={500}
                          step={5}
                          value={selectedObject.scalePercent}
                          onChange={(e) =>
                            updateSelectedObject({
                              scalePercent: Math.max(
                                10,
                                Math.min(500, Number(e.target.value) || 100),
                              ),
                            })
                          }
                          className="w-20 rounded-lg border border-slate-200 bg-transparent px-2 py-1 text-right font-mono text-slate-900 focus:outline-none dark:border-slate-700 dark:text-slate-100"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            updateSelectedObject({ scalePercent: 100 })
                          }
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300"
                        >
                          100%
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: Simple Non-Technical Slicing Controls */}
        <aside className="flex w-96 shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          {/* 1. RIGIDITY (Headline Control) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold tracking-wide text-slate-900 uppercase dark:text-slate-100">
                1. Rigidity
              </h3>
              <span className="text-[11px] text-slate-400">Part strength</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(overview?.rigidityPresets ?? []).map((preset) => {
                const active = rigidity === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setRigidity(preset.id)}
                    className={`rounded-xl border p-2.5 text-left transition-all ${
                      active
                        ? "border-blue-600 bg-blue-50/90 ring-1 ring-blue-600 dark:border-blue-500 dark:bg-blue-950/50"
                        : "border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                        {preset.label}
                      </span>
                      {preset.id === "mold" && (
                        <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold text-purple-700 dark:bg-purple-950 dark:text-purple-300">
                          Casting
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                      {preset.subtitle}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. QUALITY (3 fixed choices — zero raw mm numbers in primary buttons) */}
          <div className="space-y-2">
            <h3 className="text-xs font-bold tracking-wide text-slate-900 uppercase dark:text-slate-100">
              2. Quality
            </h3>
            <div className="grid grid-cols-3 gap-1.5">
              {(overview?.qualityPresets ?? []).map((preset) => {
                const active = quality === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setQuality(preset.id)}
                    title={preset.subtitle}
                    className={`rounded-xl border px-2.5 py-2 text-center text-xs font-semibold transition-all ${
                      active
                        ? "border-blue-600 bg-blue-600 text-white shadow-2xs"
                        : "border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {
                overview?.qualityPresets.find((q) => q.id === quality)
                  ?.subtitle
              }
            </p>
          </div>

          {/* 3. MATERIAL (PLA, PETG, ABS, TPU + custom) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold tracking-wide text-slate-900 uppercase dark:text-slate-100">
                3. Material
              </h3>
              <button
                type="button"
                onClick={() => openNewCustomMaterial()}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
              >
                <Plus className="h-3 w-3" />
                Custom preset
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(overview?.materials ?? []).map((mat) => {
                const active = materialId === mat.id;
                return (
                  <div key={mat.id} className="inline-flex items-center">
                    <button
                      type="button"
                      onClick={() => setMaterialId(mat.id)}
                      className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${
                        active
                          ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/60 dark:text-blue-300"
                          : "border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                      }`}
                    >
                      {mat.name}
                    </button>
                    {!mat.builtIn && active && (
                      <div className="ml-1 flex items-center gap-0.5">
                        <button
                          type="button"
                          title="Edit custom material"
                          onClick={() => openNewCustomMaterial(mat)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          title="Delete custom material"
                          onClick={() =>
                            void handleDeleteCustomMaterial(mat.id, mat.name)
                          }
                          className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Friendly Material Hint (e.g. ABS open-frame MK3S enclosure & ventilation note) */}
            {selectedMaterial?.hint && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{selectedMaterial.hint}</span>
              </div>
            )}
          </div>

          {/* Simple Print Options */}
          <div className="space-y-2 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
            <label className="flex cursor-pointer items-center justify-between">
              <span className="text-slate-700 dark:text-slate-300">
                Generate supports (overhangs)
              </span>
              <input
                type="checkbox"
                checked={supportMaterial}
                onChange={(e) => setSupportMaterial(e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between">
              <span className="text-slate-700 dark:text-slate-300">
                Add brim for extra bed adhesion
              </span>
              <input
                type="checkbox"
                checked={useBrim}
                onChange={(e) => setUseBrim(e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600"
              />
            </label>

            <div className="space-y-1 pt-1">
              <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Output G-code name
              </label>
              <input
                type="text"
                value={outputName}
                onChange={(e) => setOutputName(e.target.value)}
                placeholder="mk3s_print"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
              />
            </div>

            {isNextcloudConnected && (
              <div className="space-y-1.5 pt-1">
                <label className="flex cursor-pointer items-center justify-between">
                  <span className="text-slate-700 dark:text-slate-300">
                    Also save .gcode to Nextcloud
                  </span>
                  <input
                    type="checkbox"
                    checked={autoSaveCloud}
                    onChange={(e) => setAutoSaveCloud(e.target.checked)}
                    className="h-4 w-4 rounded accent-blue-600"
                  />
                </label>
                {autoSaveCloud && (
                  <input
                    type="text"
                    value={cloudOutputFolder}
                    onChange={(e) => setCloudOutputFolder(e.target.value)}
                    placeholder="/3D Prints"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-[11px] dark:border-slate-700 dark:bg-slate-950"
                  />
                )}
              </div>
            )}
          </div>

          {/* Primary Slice Action & Progress */}
          <div className="space-y-2.5 border-t border-slate-100 pt-3 dark:border-slate-800">
            {isSlicing && activeJob ? (
              <div className="space-y-2 rounded-xl border border-blue-200 bg-blue-50/70 p-3 dark:border-blue-900/50 dark:bg-blue-950/30">
                <div className="flex items-center justify-between text-xs font-semibold text-blue-900 dark:text-blue-200">
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {activeJob.stage}
                  </span>
                  <span>{activeJob.percent}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-blue-200/70 dark:bg-blue-950">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${activeJob.percent}%` }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void handleCancelSlice(activeJob.id)}
                  className="w-full rounded-lg border border-rose-300 bg-white py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-300"
                >
                  Cancel slicing
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={objects.length === 0 || anyOutOfBounds || isSlicing}
                onClick={() => void handleStartSlice()}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Printer className="h-4 w-4" />
                Slice for Prusa MK3S
              </button>
            )}

            {/* Completed / Failed Job Output Card (SD-card G-code only — NO G-code preview) */}
            {activeJob &&
              (activeJob.state === "completed" ||
                activeJob.state === "failed" ||
                activeJob.state === "cancelled") && (
                <div
                  className={`space-y-2 rounded-xl border p-3 text-xs ${
                    activeJob.state === "completed"
                      ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/50 dark:bg-emerald-950/30"
                      : activeJob.state === "failed"
                        ? "border-rose-200 bg-rose-50/70 dark:border-rose-900/50 dark:bg-rose-950/30"
                        : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60"
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span className="truncate">{activeJob.outputFileName}</span>
                    <span className="capitalize">{activeJob.state}</span>
                  </div>

                  {activeJob.state === "completed" && (
                    <>
                      <div className="grid grid-cols-2 gap-2 rounded-lg bg-white/80 p-2 text-[11px] dark:bg-slate-900/70">
                        <div>
                          <span className="block text-[10px] text-slate-400">
                            Estimated time
                          </span>
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {activeJob.estimatedTime ?? "Ready"}
                          </span>
                        </div>
                        <div>
                          <span className="block text-[10px] text-slate-400">
                            Filament
                          </span>
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {activeJob.filamentGrams != null
                              ? `${activeJob.filamentGrams.toFixed(1)} g`
                              : activeJob.gcodeSizeBytes != null
                                ? formatBytes(activeJob.gcodeSizeBytes)
                                : "—"}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <button
                          type="button"
                          disabled={downloadingJobId === activeJob.id}
                          onClick={() => void handleDownloadGcode(activeJob.id)}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {downloadingJobId === activeJob.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )}
                          Download .gcode for SD Card
                        </button>
                        {isNextcloudConnected && (
                          <button
                            type="button"
                            disabled={savingCloudJobId === activeJob.id}
                            onClick={() =>
                              void handleSaveJobToNextcloud(activeJob.id)
                            }
                            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                          >
                            <CloudUpload className="h-3.5 w-3.5 text-blue-600" />
                            {activeJob.cloudSavedPath
                              ? `Saved at ${activeJob.cloudSavedPath}`
                              : `Save to Nextcloud (${cloudOutputFolder})`}
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {activeJob.state === "failed" && activeJob.errorMessage && (
                    <p className="text-[11px] text-rose-800 dark:text-rose-200">
                      {activeJob.errorMessage}
                    </p>
                  )}

                  {activeJob.technicalLog && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowTechLog((prev) => !prev)}
                        className="text-[10px] font-medium text-slate-500 underline"
                      >
                        {showTechLog
                          ? "Hide slicer details"
                          : "Show slicer details"}
                      </button>
                      {showTechLog && (
                        <pre className="mt-1.5 max-h-32 overflow-auto rounded-lg bg-slate-950 p-2 font-mono text-[10px] text-slate-200">
                          {activeJob.technicalLog}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}

            {/* Recent Jobs */}
            {recentJobs.length > 0 && (
              <div className="space-y-1 pt-1">
                <p className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                  Recent slices
                </p>
                {recentJobs.slice(0, 4).map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => setActiveJob(job)}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-[11px] hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <span className="truncate font-medium text-slate-700 dark:text-slate-300">
                      {job.outputFileName}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-400">
                      {job.materialName} · {job.rigidity}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Modal: Browse Nextcloud Files for .STL / .3MF */}
      {showCloudPicker && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Load 3D Model from Nextcloud"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-xs"
        >
          <div className="flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Load STL or 3MF from Nextcloud
              </h2>
              <button
                type="button"
                onClick={() => setShowCloudPicker(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {error && (
              <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-950/60">
              <button
                type="button"
                onClick={() => void loadPickerFolder("/")}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-slate-600 hover:bg-slate-200/70 dark:text-slate-300"
              >
                <Home className="h-3.5 w-3.5" />
                Root
              </button>
              {pickerPath
                .split("/")
                .filter(Boolean)
                .map((seg, idx, arr) => {
                  const target = `/${arr.slice(0, idx + 1).join("/")}`;
                  return (
                    <span key={target} className="inline-flex items-center gap-1">
                      <ChevronRight className="h-3 w-3 text-slate-400" />
                      <button
                        type="button"
                        onClick={() => void loadPickerFolder(target)}
                        className="rounded px-1.5 py-0.5 font-medium text-slate-700 hover:bg-slate-200/70 dark:text-slate-200"
                      >
                        {seg}
                      </button>
                    </span>
                  );
                })}
            </div>
            <div className="flex-1 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {loadingPicker ? (
                <div className="flex items-center justify-center gap-2 p-8 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading folder...
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
                        className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            isDir
                              ? void loadPickerFolder(item.entry.path)
                              : void handleAddCloudModel(item)
                          }
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                        >
                          {isDir ? (
                            <Folder className="h-4 w-4 shrink-0 text-blue-500" />
                          ) : (
                            <FileIcon className="h-4 w-4 shrink-0 text-orange-500" />
                          )}
                          <span className="truncate font-medium">
                            {item.entry.name}
                          </span>
                        </button>
                        {!isDir && (
                          <button
                            type="button"
                            disabled={Boolean(loadingCloudModelPath)}
                            onClick={() => void handleAddCloudModel(item)}
                            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {busy && (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            Add to plate
                          </button>
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: Custom Material Preset Editor (with auto-saved local draft) */}
      {showMaterialModal && editingMaterial && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Custom Filament Preset"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSaveCustomMaterial}
            className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Sliders className="h-4 w-4 text-blue-600" />
                Custom Material Preset (MK3S)
              </h2>
              <button
                type="button"
                onClick={() => {
                  flushMaterialDraft();
                  setShowMaterialModal(false);
                }}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 p-5 text-xs">
              {error && (
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block font-medium">Preset name *</label>
                  <input
                    type="text"
                    required
                    value={editingMaterial.name}
                    onChange={(e) =>
                      updateEditingMaterial({ name: e.target.value })
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block font-medium">Base family</label>
                  <select
                    value={editingMaterial.filamentType}
                    onChange={(e) =>
                      updateEditingMaterial({ filamentType: e.target.value })
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="PLA">PLA</option>
                    <option value="PETG">PETG</option>
                    <option value="ABS">ABS</option>
                    <option value="FLEX">TPU / FLEX</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block font-medium">
                    Nozzle temp (°C, 160–300)
                  </label>
                  <input
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
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block font-medium">
                    Bed temp (°C, 0–120)
                  </label>
                  <input
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
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block font-medium">Fan min (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={editingMaterial.fanMinPercent}
                    onChange={(e) =>
                      updateEditingMaterial({
                        fanMinPercent: Number(e.target.value) || 0,
                      })
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block font-medium">Fan max (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={editingMaterial.fanMaxPercent}
                    onChange={(e) =>
                      updateEditingMaterial({
                        fanMaxPercent: Number(e.target.value) || 100,
                      })
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="block font-medium">
                  Optional friendly note for teammates
                </label>
                <input
                  type="text"
                  value={editingMaterial.hint ?? ""}
                  onChange={(e) =>
                    updateEditingMaterial({
                      hint: e.target.value.trim() ? e.target.value : null,
                    })
                  }
                  placeholder="e.g. Dry spool for 4h before printing"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                />
              </div>

              <p className="text-[10px] text-slate-400">
                Changes auto-save as a local draft so your edits are never lost.
              </p>
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 dark:border-slate-800">
              <button
                type="button"
                onClick={() => void handleDiscardMaterialDraft()}
                className="text-xs font-medium text-slate-500 hover:text-rose-600"
              >
                Discard draft
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    flushMaterialDraft();
                    setShowMaterialModal(false);
                  }}
                  className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium dark:border-slate-700"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={savingMaterial}
                  className="rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingMaterial ? "Saving..." : "Save preset"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
