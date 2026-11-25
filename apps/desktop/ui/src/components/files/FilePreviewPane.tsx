import {
  Box,
  ExternalLink,
  File as FileIcon,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  FileItemView_Serialize,
  FilePreviewPayload_Serialize,
  UserFacingError,
} from "../../bindings/tauri";
import { getFilePreview, openFileInNativeApp } from "../../lib/filesClient";
import { formatBytes, toUserFacingError } from "../../lib/workspaceClient";
import { ErrorBanner } from "../ErrorBanner";
import { Cad3dViewer } from "./Cad3dViewer";
import { MarkdownEditor } from "./MarkdownEditor";
import { PdfViewer } from "./PdfViewer";
import { DxfViewer, SvgViewer } from "./VectorViewer";

interface FilePreviewPaneProps {
  item: FileItemView_Serialize;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  onRefreshFolder: () => void;
}

export function FilePreviewPane({
  item,
  expanded,
  onToggleExpand,
  onClose,
  onRefreshFolder,
}: FilePreviewPaneProps) {
  const [payload, setPayload] = useState<FilePreviewPayload_Serialize | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [openingNative, setOpeningNative] = useState(false);
  const [error, setError] = useState<UserFacingError | null>(null);
  const [imageZoom, setImageZoom] = useState(1);
  const [imageRotation, setImageRotation] = useState(0);

  const isMarkdown = item.previewKind === "markdown";

  useEffect(() => {
    setError(null);
    setImageZoom(1);
    setImageRotation(0);

    if (isMarkdown) {
      setPayload(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setPayload(null);

    getFilePreview(item.entry.path)
      .then((res) => {
        if (!cancelled) setPayload(res);
      })
      .catch((err) => {
        if (!cancelled) setError(toUserFacingError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [item.entry.path, isMarkdown]);

  async function handleOpenNative() {
    setOpeningNative(true);
    setError(null);
    try {
      await openFileInNativeApp(item.entry.path);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setOpeningNative(false);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {item.entry.name}
          </p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
            {formatBytes(item.entry.size)}
            {item.entry.modifiedAt
              ? ` · Modified ${new Date(item.entry.modifiedAt).toLocaleString()}`
              : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={openingNative}
            onClick={() => void handleOpenNative()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {openingNative ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" />
            )}
            {item.previewKind === "solidWorks"
              ? "Open in SolidWorks"
              : "Open in Native App"}
          </button>

          <button
            type="button"
            onClick={onToggleExpand}
            title={expanded ? "Restore split view" : "Expand preview"}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            {expanded ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            title="Close preview"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error && (
          <div className="mb-3">
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {isMarkdown ? (
          <MarkdownEditor
            path={item.entry.path}
            onSaved={() => onRefreshFolder()}
          />
        ) : loading ? (
          <div className="flex h-64 items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading preview...
          </div>
        ) : !payload ? null : (
          <div className="flex h-full flex-col gap-3">
            {payload.note && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                {payload.note}
              </div>
            )}

            {payload.previewKind === "image" && payload.mediaUrl && (
              <div className="flex h-full flex-col gap-3">
                <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {payload.imageDimensions
                      ? `${payload.imageDimensions.width} × ${payload.imageDimensions.height} px`
                      : "Image preview"}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setImageZoom((z) =>
                          Math.max(0.25, Number((z - 0.25).toFixed(2))),
                        )
                      }
                      className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
                      aria-label="Zoom out"
                    >
                      <ZoomOut className="h-4 w-4" />
                    </button>
                    <span className="w-12 text-center text-xs font-medium text-slate-600 dark:text-slate-300">
                      {Math.round(imageZoom * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setImageZoom((z) =>
                          Math.min(5, Number((z + 0.25).toFixed(2))),
                        )
                      }
                      className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
                      aria-label="Zoom in"
                    >
                      <ZoomIn className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setImageRotation((r) => (r + 90) % 360)}
                      className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
                      aria-label="Rotate 90 degrees"
                    >
                      <RotateCw className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="fr-checkerboard flex flex-1 items-center justify-center overflow-auto rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <img
                    src={payload.mediaUrl}
                    alt={payload.entry.name}
                    style={{
                      transform: `scale(${imageZoom}) rotate(${imageRotation}deg)`,
                    }}
                    className="max-h-[520px] max-w-full rounded-md object-contain shadow-sm transition-transform"
                  />
                </div>
              </div>
            )}

            {payload.previewKind === "video" && payload.mediaUrl && (
              <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-slate-200 bg-black p-2 dark:border-slate-800">
                <video
                  key={payload.mediaUrl}
                  src={payload.mediaUrl}
                  controls
                  preload="metadata"
                  className="max-h-[520px] w-full rounded-lg"
                />
              </div>
            )}

            {(payload.previewKind === "pdf" ||
              payload.previewKind === "vectorAi") &&
              payload.mediaUrl && (
                <PdfViewer
                  url={payload.mediaUrl}
                  fileName={payload.entry.name}
                  onFallbackNote={
                    payload.previewKind === "vectorAi"
                      ? 'This Adobe Illustrator (.ai) file was saved without PDF compatibility. Click "Open in Native App" to view it in Illustrator.'
                      : undefined
                  }
                />
              )}

            {payload.previewKind === "vectorSvg" && payload.textContent && (
              <SvgViewer svgText={payload.textContent} />
            )}

            {payload.previewKind === "vectorDxf" && payload.textContent && (
              <DxfViewer dxfText={payload.textContent} />
            )}

            {payload.previewKind === "solidWorks" && (
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-6 lg:col-span-2 dark:border-slate-800 dark:bg-slate-950">
                  {payload.solidworks?.thumbnailDataUrl ? (
                    <img
                      src={payload.solidworks.thumbnailDataUrl}
                      alt={payload.entry.name}
                      className="max-h-[420px] max-w-full rounded-lg object-contain shadow-sm"
                    />
                  ) : (
                    <div className="text-center text-slate-500">
                      <Box className="mx-auto h-10 w-10 text-slate-400" />
                      <p className="mt-2 text-sm font-medium">
                        No embedded preview image found
                      </p>
                      <p className="mt-1 text-xs">
                        Click &ldquo;Open in SolidWorks&rdquo; to inspect the 3D model.
                      </p>
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
                  <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
                    Engineering Metadata
                  </h3>
                  <dl className="space-y-2 text-xs">
                    <MetaRow
                      label="Title"
                      value={payload.solidworks?.metadata.title}
                    />
                    <MetaRow
                      label="Author"
                      value={payload.solidworks?.metadata.author}
                    />
                    <MetaRow
                      label="Last saved by"
                      value={payload.solidworks?.metadata.lastSavedBy}
                    />
                    <MetaRow
                      label="Application"
                      value={payload.solidworks?.metadata.applicationName}
                    />
                    <MetaRow
                      label="Created"
                      value={payload.solidworks?.metadata.createdAt}
                    />
                    <MetaRow
                      label="Last saved"
                      value={payload.solidworks?.metadata.lastSavedAt}
                    />
                    <MetaRow
                      label="Comments"
                      value={payload.solidworks?.metadata.comments}
                    />
                    <MetaRow
                      label="OLE2 streams"
                      value={
                        payload.solidworks
                          ? String(payload.solidworks.streamCount)
                          : null
                      }
                    />
                  </dl>
                </div>
              </div>
            )}

            {payload.previewKind === "cad3d" && payload.mediaUrl && (
              <Cad3dViewer url={payload.mediaUrl} fileName={payload.entry.name} />
            )}

            {payload.previewKind === "plainText" && payload.textContent !== null && (
              <pre className="max-h-[540px] overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
                {payload.textContent}
              </pre>
            )}

            {(payload.previewKind === "vectorEps" ||
              payload.previewKind === "unsupported") && (
              <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-8 text-center dark:border-slate-800 dark:bg-slate-950">
                {payload.thumbnailDataUrl ? (
                  <img
                    src={payload.thumbnailDataUrl}
                    alt={payload.entry.name}
                    className="mb-4 max-h-72 rounded-lg object-contain shadow-sm"
                  />
                ) : (
                  <FileIcon className="mb-3 h-10 w-10 text-slate-400" />
                )}
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {payload.entry.name}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {payload.entry.mimeType || "Binary file"} ·{" "}
                  {formatBytes(payload.entry.size)}
                </p>
                <button
                  type="button"
                  onClick={() => void handleOpenNative()}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open in Native App
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <dt className="font-medium text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
        {value || "—"}
      </dd>
    </div>
  );
}
