import { isTauri } from "@tauri-apps/api/core";
import {
  commands,
  type Etag,
  type FileItemView_Serialize,
  type FilePreviewPayload_Serialize,
  type MarkdownDocument_Serialize,
  type SaveMarkdownResponse,
  type WorkspaceOverview_Serialize,
} from "../bindings/tauri";

import {
  getPreviewFilePayload,
  getPreviewMarkdownDoc,
  PREVIEW_FILES_BY_DIR,
} from "./previewFixtures";

function requireDesktop(action: string): never {
  throw {
    code: "browser_preview",
    title: "Desktop app required",
    message: `${action} is available inside the FR Universal App desktop window.`,
    recoveryHint: "Launch via `npm run tauri -- dev`.",
    technicalDetails: null,
  };
}

export async function listFiles(path: string): Promise<FileItemView_Serialize[]> {
  if (!isTauri()) {
    return PREVIEW_FILES_BY_DIR[path] ?? [];
  }
  return commands.listFiles(path);
}

export async function searchFiles(
  path: string,
  query: string,
): Promise<FileItemView_Serialize[]> {
  if (!isTauri()) {
    const q = query.trim().toLowerCase();
    return Object.values(PREVIEW_FILES_BY_DIR)
      .flat()
      .filter(
        (it) =>
          it.entry.path.startsWith(path === "/" ? "/" : path) &&
          it.entry.name.toLowerCase().includes(q),
      );
  }
  return commands.searchFiles(path, query);
}

export async function createFolder(path: string): Promise<void> {
  if (!isTauri()) requireDesktop("Creating folders");
  await commands.createFolder(path);
}

export async function renameFile(from: string, to: string): Promise<void> {
  if (!isTauri()) requireDesktop("Renaming files");
  await commands.renameFile(from, to);
}

export async function deleteFile(path: string): Promise<void> {
  if (!isTauri()) requireDesktop("Deleting files");
  await commands.deleteFile(path);
}

export async function uploadFileBytes(
  path: string,
  bytes: Uint8Array,
  overwrite = false,
): Promise<Etag> {
  if (!isTauri()) requireDesktop("Uploading files");
  const base64 = uint8ToBase64(bytes);
  return commands.uploadFileBase64(path, base64, overwrite);
}

export async function togglePinFolder(
  folderPath: string,
): Promise<WorkspaceOverview_Serialize> {
  if (!isTauri()) requireDesktop("Pinning folders");
  return commands.togglePinFolder(folderPath);
}

export async function createMarkdownFile(
  path: string,
  content: string,
): Promise<SaveMarkdownResponse> {
  if (!isTauri()) requireDesktop("Creating Markdown notes");
  return commands.createMarkdownFile(path, content);
}

export async function readMarkdownFile(
  path: string,
): Promise<MarkdownDocument_Serialize> {
  if (!isTauri()) return getPreviewMarkdownDoc(path);
  return commands.readMarkdownFile(path);
}

export async function saveMarkdownFile(
  path: string,
  content: string,
  expectedEtag: Etag | null,
  forceOverwrite: boolean,
): Promise<SaveMarkdownResponse> {
  if (!isTauri()) requireDesktop("Saving Markdown");
  return commands.saveMarkdownFile(path, content, expectedEtag, forceOverwrite);
}

export async function saveMarkdownCopy(
  originalPath: string,
  content: string,
): Promise<SaveMarkdownResponse> {
  if (!isTauri()) requireDesktop("Saving a copy");
  return commands.saveMarkdownCopy(originalPath, content);
}

export async function saveMarkdownDraft(
  path: string,
  content: string,
  baseEtag: Etag | null,
): Promise<void> {
  if (!isTauri()) return;
  await commands.saveMarkdownDraft(path, content, baseEtag);
}

export async function discardMarkdownDraft(path: string): Promise<void> {
  if (!isTauri()) return;
  await commands.discardMarkdownDraft(path);
}

export async function getFilePreview(
  path: string,
): Promise<FilePreviewPayload_Serialize> {
  if (!isTauri()) return getPreviewFilePayload(path);
  return commands.getFilePreview(path);
}

export async function getFileThumbnail(
  fileId: string,
  width = 256,
  height = 256,
): Promise<string | null> {
  if (!isTauri()) return null;
  return commands.getFileThumbnail(fileId, width, height);
}

export async function getMediaProxyUrl(path: string): Promise<string | null> {
  if (!isTauri()) return null;
  return commands.getMediaProxyUrl(path);
}

export async function openFileInNativeApp(
  path: string,
  allowExecutable = false,
): Promise<string> {
  if (!isTauri()) requireDesktop("Opening in native app");
  return commands.openFileInNativeApp(path, allowExecutable);
}

export function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function joinCloudPath(dir: string, name: string): string {
  const cleanDir = dir === "/" ? "" : dir.replace(/\/+$/, "");
  const cleanName = name.replace(/^\/+/, "");
  return `${cleanDir}/${cleanName}`;
}
