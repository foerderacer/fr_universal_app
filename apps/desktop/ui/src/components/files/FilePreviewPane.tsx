import {
  AlertTriangle,
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
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {
  FileItemView_Serialize,
  FilePreviewPayload_Serialize,
  UserFacingError,
} from "../../bindings/tauri";
import { getFilePreview, openFileInNativeApp } from "../../lib/filesClient";
import { formatBytes, toUserFacingError } from "../../lib/workspaceClient";
import { ErrorBanner } from "../ErrorBanner";
import { IconButton, Tooltip } from "../ui/Tooltip";
import { formatIsoDate } from "../../lib/dateFormat";
import { hasActiveOverlay, isEditableTarget } from "../../lib/shortcuts";

const Cad3dViewer = lazy(() =>
  import("./Cad3dViewer").then((m) => ({ default: m.Cad3dViewer })),
);
const MarkdownEditor = lazy(() =>
  import("./MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })),
);
const PdfViewer = lazy(() =>
  import("./PdfViewer").then((m) => ({ default: m.PdfViewer })),
);
const DxfViewer = lazy(() =>
  import("./VectorViewer").then((m) => ({ default: m.DxfViewer })),
);
const SvgViewer = lazy(() =>
  import("./VectorViewer").then((m) => ({ default: m.SvgViewer })),
);

function ViewerFallback({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-56 items-center justify-center gap-2 text-xs text-[var(--text-muted)]"
    >
      <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
      {label}
    </div>
  );
}

interface FilePreviewPaneProps {
  item: FileItemView_Serialize;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  onRefreshFolder: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPreviewError?: (error: UserFacingError) => void;
}

export function FilePreviewPane({
  item,
  expanded,
  onToggleExpand,
  onClose,
  onRefreshFolder,
  onDirtyChange,
  onPreviewError,
}: FilePreviewPaneProps) {
  const [payload, setPayload] = useState<FilePreviewPayload_Serialize | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [openingNative, setOpeningNative] = useState(false);
  const [execConfirmWarning, setExecConfirmWarning] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<UserFacingError | null>(null);
  const [imageZoom, setImageZoom] = useState(1);
  const [imageRotation, setImageRotation] = useState(0);

  const isMarkdown = item.previewKind === "markdown";
  const onPreviewErrorRef = useRef(onPreviewError);
  onPreviewErrorRef.current = onPreviewError;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Consistently honor the advertised Esc shortcut in every module hosting FilePreviewPane (Files, Finance, Chat)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (hasActiveOverlay()) {
        return;
      }
      if (isEditableTarget(e.target)) {
        return;
      }
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setError(null);
    setExecConfirmWarning(null);
    setImageZoom(1);
    setImageRotation(0);

    if (isMarkdown) {
      setPayload(null);
      setLoading(false);
      return;
    }

    onDirtyChange?.(false);

    let cancelled = false;
    setLoading(true);
    setPayload(null);

    getFilePreview(item.entry.path)
      .then((res) => {
        if (!cancelled) setPayload(res);
      })
      .catch((err) => {
        if (!cancelled) {
          const uf = toUserFacingError(err);
          setError(uf);
          onPreviewErrorRef.current?.(uf);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [item.entry.path, isMarkdown, onDirtyChange]);

  async function handleOpenNative(allowExecutable = false) {
    setOpeningNative(true);
    setError(null);
    setExecConfirmWarning(null);
    try {
      await openFileInNativeApp(item.entry.path, allowExecutable);
    } catch (err) {
      const uf = toUserFacingError(err);
      if (uf.code === "executable_blocked") {
        setExecConfirmWarning(uf.message);
      } else {
        setError(uf);
      }
    } finally {
      setOpeningNative(false);
    }
  }

  const extLabel = (
    item.entry.name.split(".").pop()?.toUpperCase() || "FILE"
  ).slice(0, 8);

  return (
    <div className="flex h-full flex-col bg-[var(--bg-sidebar)]">
      {/* Compact Flush Preview Header */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="mono-num shrink-0 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
            {extLabel}
          </span>
          <p className="truncate text-xs font-medium text-[var(--text-primary)]">
            {item.entry.name}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label={
              item.previewKind === "solidWorks"
                ? "Open in SolidWorks"
                : "Open in native app"
            }
            size="xs"
            disabled={openingNative}
            onClick={() => void handleOpenNative()}
          >
            {openingNative ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
          </IconButton>

          <IconButton
            label={expanded ? "Restore split view" : "Expand preview"}
            size="xs"
            onClick={onToggleExpand}
          >
            {expanded ? (
              <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
          </IconButton>

          <IconButton label="Close preview" shortcut="Esc" size="xs" onClick={onClose}>
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error && (
          <div className="mb-3">
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {execConfirmWarning && (
          <div
            role="alert"
            aria-label="Confirm opening executable file"
            className="mb-3 rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] p-3 text-xs text-[var(--text-primary)]"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning-text)]"
                strokeWidth={1.5}
              />
              <div className="flex-1">
                <p className="font-medium">Confirm opening executable file</p>
                <p className="mt-0.5 text-[var(--text-secondary)]">
                  {execConfirmWarning}
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={openingNative}
                    onClick={() => void handleOpenNative(true)}
                    className="rounded-md bg-[var(--status-warning)] px-2.5 py-1 text-[11px] font-medium text-[var(--status-warning-fg)] disabled:opacity-50"
                  >
                    Open anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => setExecConfirmWarning(null)}
                    className="rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {isMarkdown ? (
          <Suspense fallback={<ViewerFallback label="Loading editor…" />}>
            <MarkdownEditor
              path={item.entry.path}
              onSaved={() => onRefreshFolder()}
              onDirtyChange={onDirtyChange}
            />
          </Suspense>
        ) : loading ? (
          <div className="flex h-56 items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
            Loading preview…
          </div>
        ) : !payload ? null : (
          <div className="flex h-full flex-col gap-2.5">
            {payload.note && (
              <div className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
                {payload.note}
              </div>
            )}

            {payload.previewKind === "image" && payload.mediaUrl && (
              <div className="flex h-full flex-col gap-2">
                <div className="flex items-center justify-between rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1">
                  <span className="mono-num text-[11px] text-[var(--text-secondary)]">
                    {payload.imageDimensions
                      ? `${payload.imageDimensions.width} × ${payload.imageDimensions.height} px`
                      : "Image"}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <IconButton
                      label="Zoom out"
                      size="xs"
                      onClick={() =>
                        setImageZoom((z) =>
                          Math.max(0.25, Number((z - 0.25).toFixed(2))),
                        )
                      }
                    >
                      <ZoomOut className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </IconButton>
                    <span className="mono-num w-10 text-center text-[11px] text-[var(--text-secondary)]">
                      {Math.round(imageZoom * 100)}%
                    </span>
                    <IconButton
                      label="Zoom in"
                      size="xs"
                      onClick={() =>
                        setImageZoom((z) =>
                          Math.min(5, Number((z + 0.25).toFixed(2))),
                        )
                      }
                    >
                      <ZoomIn className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </IconButton>
                    <IconButton
                      label="Rotate 90°"
                      size="xs"
                      onClick={() => setImageRotation((r) => (r + 90) % 360)}
                    >
                      <RotateCw className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </IconButton>
                  </div>
                </div>
                <div className="fr-checkerboard flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border border-[var(--border-hairline)] p-4">
                  <img
                    src={payload.mediaUrl}
                    alt={payload.entry.name}
                    style={{
                      transform: `scale(${imageZoom}) rotate(${imageRotation}deg)`,
                    }}
                    className="max-h-full max-w-full rounded object-contain transition-transform"
                  />
                </div>
              </div>
            )}

            {payload.previewKind === "video" && payload.mediaUrl && (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-md border border-[var(--border-hairline)] bg-[var(--bg-app)] p-2">
                <video
                  key={payload.mediaUrl}
                  src={payload.mediaUrl}
                  controls
                  preload="metadata"
                  className="max-h-full w-full rounded"
                />
              </div>
            )}

            {(payload.previewKind === "pdf" ||
              payload.previewKind === "vectorAi") &&
              payload.mediaUrl && (
                <Suspense fallback={<ViewerFallback label="Loading PDF viewer…" />}>
                  <PdfViewer
                    url={payload.mediaUrl}
                    fileName={payload.entry.name}
                    onFallbackNote={
                      payload.previewKind === "vectorAi"
                        ? 'This Adobe Illustrator (.ai) file was saved without PDF compatibility. Use "Open in native app" to view it in Illustrator.'
                        : undefined
                    }
                  />
                </Suspense>
              )}

            {payload.previewKind === "vectorSvg" && payload.textContent && (
              <Suspense fallback={<ViewerFallback label="Loading vector preview…" />}>
                <SvgViewer svgText={payload.textContent} />
              </Suspense>
            )}

            {payload.previewKind === "vectorDxf" && payload.textContent && (
              <Suspense fallback={<ViewerFallback label="Loading DXF viewer…" />}>
                <DxfViewer dxfText={payload.textContent} />
              </Suspense>
            )}

            {payload.previewKind === "solidWorks" && (
              <div className="flex flex-col gap-3">
                <div className="flex min-h-[200px] flex-col items-center justify-center rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
                  {payload.solidworks?.thumbnailDataUrl ? (
                    <img
                      src={payload.solidworks.thumbnailDataUrl}
                      alt={payload.entry.name}
                      className="max-h-[340px] max-w-full rounded object-contain"
                    />
                  ) : (
                    <div className="text-center text-[var(--text-muted)]">
                      <Box className="mx-auto h-7 w-7 opacity-60" strokeWidth={1.5} />
                      <p className="mt-2 text-xs font-medium text-[var(--text-secondary)]">
                        No embedded preview image
                      </p>
                      <p className="mt-0.5 text-[11px]">
                        Open in SolidWorks to inspect full 3D geometry.
                      </p>
                    </div>
                  )}
                </div>

                <div className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
                  <h2 className="mb-2 text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                    CAD Properties
                  </h2>
                  <dl className="divide-y divide-[var(--border-subtle)] text-xs">
                    <MetaRow label="Title" value={payload.solidworks?.metadata.title} />
                    <MetaRow label="Author" value={payload.solidworks?.metadata.author} />
                    <MetaRow
                      label="Saved by"
                      value={payload.solidworks?.metadata.lastSavedBy}
                    />
                    <MetaRow
                      label="Application"
                      value={payload.solidworks?.metadata.applicationName}
                    />
                    <MetaRow
                      label="Created"
                      value={payload.solidworks?.metadata.createdAt}
                      mono
                    />
                    <MetaRow
                      label="Saved"
                      value={payload.solidworks?.metadata.lastSavedAt}
                      mono
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
                      mono
                    />
                  </dl>
                </div>
              </div>
            )}

            {payload.previewKind === "cad3d" && payload.mediaUrl && (
              <Suspense fallback={<ViewerFallback label="Loading 3D viewer…" />}>
                <Cad3dViewer url={payload.mediaUrl} fileName={payload.entry.name} />
              </Suspense>
            )}

            {payload.previewKind === "plainText" && payload.textContent !== null && (
              <pre className="mono-num max-h-[540px] overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11px] leading-relaxed text-[var(--text-primary)]">
                {payload.textContent}
              </pre>
            )}

            {(payload.previewKind === "image" ||
              payload.previewKind === "video" ||
              payload.previewKind === "pdf" ||
              payload.previewKind === "vectorAi" ||
              payload.previewKind === "cad3d") &&
              !payload.mediaUrl && (
                <div className="flex flex-1 flex-col items-center justify-center rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 text-center">
                  <FileIcon
                    className="mb-2.5 h-7 w-7 text-[var(--text-muted)]"
                    strokeWidth={1.5}
                  />
                  <p className="text-xs font-medium text-[var(--text-primary)]">
                    In-app stream unavailable
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Open in native app to view this file directly.
                  </p>
                </div>
              )}

            {(payload.previewKind === "vectorSvg" ||
              payload.previewKind === "vectorDxf" ||
              payload.previewKind === "plainText") &&
              payload.textContent === null && (
                <div className="flex flex-1 flex-col items-center justify-center rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 text-center">
                  <FileIcon
                    className="mb-2.5 h-7 w-7 text-[var(--text-muted)]"
                    strokeWidth={1.5}
                  />
                  <p className="text-xs font-medium text-[var(--text-primary)]">
                    Preview skipped for large file
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Open in native app to inspect full contents.
                  </p>
                </div>
              )}

            {(payload.previewKind === "vectorEps" ||
              payload.previewKind === "unsupported") && (
              <div className="flex flex-1 flex-col items-center justify-center rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 text-center">
                {payload.thumbnailDataUrl ? (
                  <img
                    src={payload.thumbnailDataUrl}
                    alt={payload.entry.name}
                    className="mb-3 max-h-64 rounded object-contain"
                  />
                ) : (
                  <FileIcon
                    className="mb-2.5 h-7 w-7 text-[var(--text-muted)]"
                    strokeWidth={1.5}
                  />
                )}
                <p className="text-xs font-medium text-[var(--text-primary)]">
                  {payload.entry.name}
                </p>
                <p className="mono-num mt-1 text-[11px] text-[var(--text-muted)]">
                  {payload.entry.mimeType || "Binary"} · {formatBytes(payload.entry.size)}
                </p>
                <button
                  type="button"
                  onClick={() => void handleOpenNative()}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
                >
                  <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Open in Native App
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Compact Monospace Metadata Footer */}
      <footer className="flex h-8 shrink-0 items-center justify-between gap-2 border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <Tooltip label={item.entry.path} side="top">
          <span className="mono-num block max-w-[230px] truncate">
            {item.entry.path}
          </span>
        </Tooltip>
        <div className="mono-num flex shrink-0 items-center gap-2.5">
          <span>{formatBytes(item.entry.size)}</span>
          <span className="h-2.5 w-px bg-[var(--border-hairline)]" />
          <span>{formatIsoDate(item.entry.modifiedAt)}</span>
        </div>
      </footer>
    </div>
  );
}

function MetaRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[11px] text-[var(--text-muted)]">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-[11px] text-[var(--text-primary)] ${
          mono ? "mono-num" : ""
        }`}
      >
        {value || "—"}
      </dd>
    </div>
  );
}
