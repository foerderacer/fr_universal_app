import { isTauri } from "@tauri-apps/api/core";
import {
  commands,
  type CloudModelPayload,
  type MaterialPreset_Deserialize,
  type MaterialPreset_Serialize,
  type PlateBoundsMm,
  type QualityPreset,
  type SliceGcodeDownload,
  type SliceJobRecord_Serialize,
  type SlicerBinaryInfo_Serialize,
  type SlicerOverview_Serialize,
  type StartSliceJobRequest_Deserialize,
} from "../bindings/tauri";

import { PREVIEW_SLICE_JOBS } from "./previewFixtures";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function triggerGcodeDownload(fileName: string, base64Data: string) {
  const bytes = base64ToBytes(base64Data);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function getSlicerOverview(): Promise<SlicerOverview_Serialize> {
  if (!isTauri()) {
    return {
      printer: {
        id: "prusa_mk3s_04",
        name: "Original Prusa i3 MK3S (0.4 mm)",
        bedXMm: 250,
        bedYMm: 210,
        bedZMm: 210,
        nozzleDiameterMm: 0.4,
        maxNozzleTempC: 300,
        maxBedTempC: 120,
      },
      binary: {
        available: true,
        path: "/usr/bin/prusa-slicer",
        version: "PrusaSlicer 2.8.1",
        source: "browser_preview",
      },
      rigidityPresets: [
        {
          id: "low",
          label: "Low",
          subtitle: "Fast, lightweight prototypes.",
          perimeters: 2,
          fillDensityPercent: 15,
          topSolidLayers: 3,
          bottomSolidLayers: 3,
          fillPattern: "grid",
        },
        {
          id: "medium",
          label: "Medium",
          subtitle: "Balanced everyday strength (default).",
          perimeters: 3,
          fillDensityPercent: 25,
          topSolidLayers: 4,
          bottomSolidLayers: 4,
          fillPattern: "gyroid",
        },
        {
          id: "high",
          label: "High",
          subtitle: "Heavy-duty structural parts.",
          perimeters: 4,
          fillDensityPercent: 50,
          topSolidLayers: 5,
          bottomSolidLayers: 5,
          fillPattern: "gyroid",
        },
        {
          id: "mold",
          label: "Mold",
          subtitle: "Dense, leak-resistant shells for casting molds.",
          perimeters: 5,
          fillDensityPercent: 95,
          topSolidLayers: 6,
          bottomSolidLayers: 6,
          fillPattern: "rectilinear",
        },
      ],
      qualityPresets: [
        {
          id: "fine",
          label: "Fine",
          subtitle: "Smooth surfaces and crisp details.",
          layerHeightMm: 0.1,
        },
        {
          id: "standard",
          label: "Standard",
          subtitle: "Great detail and dependable speed.",
          layerHeightMm: 0.2,
        },
        {
          id: "fast",
          label: "Fast",
          subtitle: "Quick draft iterations.",
          layerHeightMm: 0.3,
        },
      ],
      materials: [
        {
          id: "pla",
          name: "PLA",
          filamentType: "PLA",
          builtIn: true,
          nozzleTempC: 215,
          firstLayerNozzleTempC: 215,
          bedTempC: 60,
          firstLayerBedTempC: 60,
          fanMinPercent: 100,
          fanMaxPercent: 100,
          disableFanFirstLayers: 1,
          maxVolumetricSpeedMm3S: 15,
          extrusionMultiplier: 1,
          hint: null,
        },
        {
          id: "petg",
          name: "PETG",
          filamentType: "PETG",
          builtIn: true,
          nozzleTempC: 240,
          firstLayerNozzleTempC: 230,
          bedTempC: 85,
          firstLayerBedTempC: 85,
          fanMinPercent: 30,
          fanMaxPercent: 50,
          disableFanFirstLayers: 3,
          maxVolumetricSpeedMm3S: 10,
          extrusionMultiplier: 1,
          hint: null,
        },
        {
          id: "abs",
          name: "ABS",
          filamentType: "ABS",
          builtIn: true,
          nozzleTempC: 255,
          firstLayerNozzleTempC: 255,
          bedTempC: 100,
          firstLayerBedTempC: 100,
          fanMinPercent: 15,
          fanMaxPercent: 30,
          disableFanFirstLayers: 4,
          maxVolumetricSpeedMm3S: 11,
          extrusionMultiplier: 1,
          hint: "Recommended with enclosure & ventilation on open-frame MK3S.",
        },
        {
          id: "tpu",
          name: "TPU",
          filamentType: "FLEX",
          builtIn: true,
          nozzleTempC: 230,
          firstLayerNozzleTempC: 230,
          bedTempC: 50,
          firstLayerBedTempC: 50,
          fanMinPercent: 70,
          fanMaxPercent: 100,
          disableFanFirstLayers: 3,
          maxVolumetricSpeedMm3S: 3.5,
          extrusionMultiplier: 1.05,
          hint: null,
        },
      ],
      materialDraft: null,
      recentJobs: PREVIEW_SLICE_JOBS,
    };
  }
  return commands.getSlicerOverview();
}

export async function setPrusaSlicerPath(
  path: string | null,
): Promise<SlicerBinaryInfo_Serialize> {
  return commands.setPrusaslicerPath(path);
}

export async function saveCustomMaterialPreset(
  preset: MaterialPreset_Deserialize,
): Promise<MaterialPreset_Serialize> {
  return commands.saveCustomMaterialPreset(preset);
}

export async function deleteCustomMaterialPreset(id: string): Promise<void> {
  await commands.deleteCustomMaterialPreset(id);
}

export async function saveMaterialPresetDraft(
  draft: MaterialPreset_Deserialize,
): Promise<void> {
  await commands.saveMaterialPresetDraft(draft);
}

export async function clearMaterialPresetDraft(): Promise<void> {
  await commands.clearMaterialPresetDraft();
}

export async function validateSlicerPlate(
  fileName: string,
  modelSizeBytes: number,
  bounds: PlateBoundsMm | null,
  quality: QualityPreset,
  materialId: string,
): Promise<void> {
  await commands.validateSlicerPlate(
    fileName,
    modelSizeBytes,
    bounds,
    quality,
    materialId,
  );
}

export async function loadCloudModelBase64(
  cloudPath: string,
): Promise<CloudModelPayload> {
  return commands.loadCloudModelBase64(cloudPath);
}

export async function startSliceJob(
  request: StartSliceJobRequest_Deserialize,
): Promise<SliceJobRecord_Serialize> {
  return commands.startSliceJob(request);
}

export async function cancelSliceJob(
  jobId: string,
): Promise<SliceJobRecord_Serialize> {
  return commands.cancelSliceJob(jobId);
}

export async function getSliceJobStatus(
  jobId: string,
): Promise<SliceJobRecord_Serialize> {
  return commands.getSliceJobStatus(jobId);
}

export async function readSliceJobGcodeBase64(
  jobId: string,
): Promise<SliceGcodeDownload> {
  return commands.readSliceJobGcodeBase64(jobId);
}

export async function saveSliceJobToNextcloud(
  jobId: string,
  folderPath: string,
): Promise<SliceJobRecord_Serialize> {
  return commands.saveSliceJobToNextcloud(jobId, folderPath);
}
