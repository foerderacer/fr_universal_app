import {
  Box,
  ChevronRight,
  Cloud,
  ExternalLink,
  File as FileIcon,
  FileCode2,
  FilePlus,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Home,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  LogIn,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FileItemView_Serialize,
  NextcloudConnectionStatus,
  PreviewKind,
  UserAccountInfo_Serialize,
  UserFacingError,
  WorkspaceOverview_Serialize,
} from "../bindings/tauri";
import { ErrorBanner } from "../components/ErrorBanner";
import { FilePreviewPane } from "../components/files/FilePreviewPane";
import {
  createFolder,
  deleteFile,
  joinCloudPath,
  listFiles,
  renameFile,
  saveMarkdownFile,
  searchFiles,
  togglePinFolder,
  uploadFileBytes,
} from "../lib/filesClient";
import {
  formatBytes,
  openExternalUrl,
  toUserFacingError,
} from "../lib/workspaceClient";

interface FilesViewProps {
  connectionStatus: NextcloudConnectionStatus;
  accountInfo: UserAccountInfo_Serialize | null;
  pinnedFolders: string[];
  loginPendingUrl: string | null;
  loginStarting: boolean;
  error: UserFacingError | null;
  onClearError: () => void;
  onStartLogin: () => Promise<void>;
  onCancelLogin: () => Promise<void>;
  onOpenSettings: () => void;
  onOverviewUpdated: (overview: WorkspaceOverview_Serialize) => void;
}

const SUPPORTED_FORMATS = [
  {
    icon: FileText,
    label: "Markdown Notes",
    detail: "WYSIWYG editor + raw mode with conflict protection (.md)",
  },
  {
    icon: ImageIcon,
    label: "Images & PDFs",
    detail: "Zoom, pan, and document search (.png, .jpg, .webp, .pdf)",
  },
  {
    icon: Film,
    label: "Video Streaming",
    detail: "Instant playback via local Range proxy (.mp4, .mov, .webm)",
  },
  {
    icon: Layers,
    label: "Vector Files",
    detail: "Sanitized SVG, Illustrator AI, DXF CAD & EPS",
  },
  {
    icon: Box,
    label: "SolidWorks CAD",
    detail: "Client-side thumbnails & metadata (.sldprt, .sldasm, .slddrw)",
  },
  {
    icon: FileCode2,
    label: "Native Open",
    detail: "Launch any file directly in its desktop app with one click",
  },
];

function ItemIcon({
  kind,
  previewKind,
}: {
  kind: "directory" | "file";
  previewKind: PreviewKind | null;
}) {
  if (kind === "directory") {
    return <Folder className="h-4 w-4 shrink-0 text-amber-500" />;
  }
  switch (previewKind) {
    case "markdown":
      return <FileText className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />;
    case "image":
      return <ImageIcon className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />;
    case "video":
      return <Film className="h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400" />;
    case "pdf":
    case "vectorAi":
      return <FileText className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />;
    case "vectorSvg":
    case "vectorDxf":
    case "vectorEps":
      return <Layers className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />;
    case "solidWorks":
    case "cad3d":
      return <Box className="h-4 w-4 shrink-0 text-cyan-600 dark:text-cyan-400" />;
    default:
      return <FileIcon className="h-4 w-4 shrink-0 text-slate-400" />;
  }
}

export function FilesView({
  connectionStatus,
  accountInfo,
  pinnedFolders,
  loginPendingUrl,
  loginStarting,
  error,
  onClearError,
  onStartLogin,
  onCancelLogin,
  onOpenSettings,
  onOverviewUpdated,
}: FilesViewProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [items, setItems] = useState<FileItemView_Serialize[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [filterText, setFilterText] = useState("");
  const [deepSearch, setDeepSearch] = useState(false);
  const [selectedFile, setSelectedFile] =
    useState<FileItemView_Serialize | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [explorerError, setExplorerError] = useState<UserFacingError | null>(
    null,
  );
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newItemMode, setNewItemMode] = useState<"folder" | "markdown" | null>(
    null,
  );
  const [newItemName, setNewItemName] = useState("");
  const [renamingItem, setRenamingItem] =
    useState<FileItemView_Serialize | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const isConnected = connectionStatus.state === "connected";

  const loadDirectory = useCallback(
    async (targetPath: string) => {
      if (!isConnected) return;
      setLoading(true);
      setExplorerError(null);
      try {
        const list = await listFiles(targetPath);
        setItems(list);
      } catch (err) {
        setExplorerError(toUserFacingError(err));
      } finally {
        setLoading(false);
      }
    },
    [isConnected],
  );

  useEffect(() => {
    if (isConnected) {
      setDeepSearch(false);
      void loadDirectory(currentPath);
    }
  }, [isConnected, currentPath, loadDirectory]);

  const breadcrumbs = useMemo(() => {
    const parts = currentPath.split("/").filter(Boolean);
    const crumbs: Array<{ label: string; path: string }> = [
      { label: "All Files", path: "/" },
    ];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }, [currentPath]);

  const visibleItems = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q || deepSearch) return items;
    return items.filter((item) => item.entry.name.toLowerCase().includes(q));
  }, [items, filterText, deepSearch]);

  async function handleDeepSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = filterText.trim();
    if (!q) {
      setDeepSearch(false);
      await loadDirectory(currentPath);
      return;
    }
    setLoading(true);
    setDeepSearch(true);
    setExplorerError(null);
    try {
      const results = await searchFiles(currentPath, q);
      setItems(results);
    } catch (err) {
      setExplorerError(toUserFacingError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleUploadFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setUploading(true);
    setExplorerError(null);
    try {
      for (const file of files) {
        const dest = joinCloudPath(currentPath, file.name);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await uploadFileBytes(dest, bytes);
      }
      await loadDirectory(currentPath);
    } catch (err) {
      setExplorerError(toUserFacingError(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleCreateNew(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newItemName.trim();
    if (!trimmed || !newItemMode) return;
    setExplorerError(null);
    try {
      if (newItemMode === "folder") {
        await createFolder(joinCloudPath(currentPath, trimmed));
      } else {
        const fileName = trimmed.toLowerCase().endsWith(".md")
          ? trimmed
          : `${trimmed}.md`;
        const fullPath = joinCloudPath(currentPath, fileName);
        await saveMarkdownFile(fullPath, `# ${trimmed.replace(/\.md$/i, "")}\n\n`, null, false);
      }
      setNewItemMode(null);
      setNewItemName("");
      await loadDirectory(currentPath);
    } catch (err) {
      setExplorerError(toUserFacingError(err));
    }
  }

  async function handleRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!renamingItem) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renamingItem.entry.name) {
      setRenamingItem(null);
      return;
    }
    const parent = renamingItem.entry.path.includes("/")
      ? renamingItem.entry.path.slice(0, renamingItem.entry.path.lastIndexOf("/")) || "/"
      : "/";
    try {
      await renameFile(renamingItem.entry.path, joinCloudPath(parent, trimmed));
      if (selectedFile?.entry.path === renamingItem.entry.path) {
        setSelectedFile(null);
      }
      setRenamingItem(null);
      await loadDirectory(currentPath);
    } catch (err) {
      setExplorerError(toUserFacingError(err));
    }
  }

  async function handleDelete(item: FileItemView_Serialize) {
    const confirmed = window.confirm(
      `Delete "${item.entry.name}" from Nextcloud?`,
    );
    if (!confirmed) return;
    setExplorerError(null);
    try {
      await deleteFile(item.entry.path);
      if (selectedFile?.entry.path === item.entry.path) {
        setSelectedFile(null);
      }
      await loadDirectory(currentPath);
    } catch (err) {
      setExplorerError(toUserFacingError(err));
    }
  }

  async function handleTogglePin(folderPath: string) {
    setExplorerError(null);
    try {
      const updated = await togglePinFolder(folderPath);
      onOverviewUpdated(updated);
    } catch (err) {
      setExplorerError(toUserFacingError(err));
    }
  }

  // Signed-out / Login Flow v2 onboarding state
  if (!isConnected) {
    const configuredServer =
      connectionStatus.state === "notConfigured"
        ? null
        : connectionStatus.serverUrl;

    return (
      <div className="mx-auto max-w-4xl space-y-6">
        {error && <ErrorBanner error={error} onDismiss={onClearError} />}

        {loginPendingUrl ? (
          <section className="rounded-2xl border border-blue-200 bg-white p-6 shadow-xs dark:border-blue-900/60 dark:bg-slate-900">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    Finish signing in via your browser
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    We opened Nextcloud in your browser. Click{" "}
                    <span className="font-medium text-slate-900 dark:text-slate-200">
                      Log in
                    </span>{" "}
                    and{" "}
                    <span className="font-medium text-slate-900 dark:text-slate-200">
                      Grant access
                    </span>{" "}
                    — this window will connect automatically.
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void openExternalUrl(loginPendingUrl)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open browser again
                </button>
                <button
                  type="button"
                  onClick={() => void onCancelLogin()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 px-3.5 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-300 dark:hover:bg-rose-950/40"
                >
                  <X className="h-3.5 w-3.5" />
                  Cancel
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
                  <Cloud className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    Connect your Nextcloud workspace
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {configuredServer ? (
                      <>
                        Sign in with one click to{" "}
                        <span className="font-medium text-slate-900 dark:text-slate-200">
                          {configuredServer}
                        </span>
                        . Supports 2FA and SSO automatically.
                      </>
                    ) : (
                      "Enter your team's Nextcloud server address in Settings to get started."
                    )}
                  </p>
                  {configuredServer && (
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="mt-2 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
                    >
                      Change server…
                    </button>
                  )}
                </div>
              </div>

              {configuredServer ? (
                <button
                  type="button"
                  disabled={loginStarting}
                  onClick={() => void onStartLogin()}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {loginStarting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <LogIn className="h-4 w-4" />
                  )}
                  {loginStarting ? "Opening browser..." : "Sign in with Nextcloud"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-blue-700"
                >
                  <Settings className="h-4 w-4" />
                  Configure Server
                </button>
              )}
            </div>
          </section>
        )}

        <section>
          <h3 className="mb-3 text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
            Built for your team&apos;s files
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SUPPORTED_FORMATS.map(({ icon: Icon, label, detail }) => (
              <div
                key={label}
                className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {label}
                  </p>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                  {detail}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  }

  const isCurrentPinned = pinnedFolders.includes(currentPath);

  return (
    <div className="flex h-full flex-col gap-4">
      {(error || explorerError) && (
        <ErrorBanner
          error={(explorerError ?? error)!}
          onDismiss={() => {
            setExplorerError(null);
            onClearError();
          }}
        />
      )}

      {/* Pinned folders + Quota strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setCurrentPath("/")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${
              currentPath === "/"
                ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            <Home className="h-3.5 w-3.5" />
            Root
          </button>
          {pinnedFolders.map((folder) => {
            const label = folder.split("/").filter(Boolean).pop() || folder;
            return (
              <div
                key={folder}
                className={`inline-flex items-center rounded-lg text-xs font-medium ${
                  currentPath === folder
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                    : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setCurrentPath(folder)}
                  className="inline-flex items-center gap-1 px-2 py-1"
                >
                  <Pin className="h-3 w-3 text-blue-500" />
                  {label}
                </button>
                <button
                  type="button"
                  onClick={() => void handleTogglePin(folder)}
                  title="Unpin folder"
                  className="pr-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>

        {accountInfo && (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {formatBytes(accountInfo.quotaUsedBytes)}
            {accountInfo.quotaTotalBytes
              ? ` / ${formatBytes(accountInfo.quotaTotalBytes)}`
              : ""}
          </span>
        )}
      </div>

      {/* Main Split Workspace */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-12">
        {!(selectedFile && previewExpanded) && (
          <section
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              if (e.dataTransfer.files.length > 0) {
                void handleUploadFiles(e.dataTransfer.files);
              }
            }}
            className={`flex min-h-0 flex-col rounded-2xl border bg-white shadow-xs transition-colors dark:bg-slate-900 ${
              dragActive
                ? "border-blue-500 ring-2 ring-blue-500/20"
                : "border-slate-200 dark:border-slate-800"
            } ${selectedFile ? "lg:col-span-5" : "lg:col-span-12"}`}
          >
            {/* Explorer Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
                {breadcrumbs.map((crumb, idx) => (
                  <span key={crumb.path} className="inline-flex items-center gap-1">
                    {idx > 0 && <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
                    <button
                      type="button"
                      onClick={() => setCurrentPath(crumb.path)}
                      className={`rounded px-1.5 py-0.5 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 ${
                        idx === breadcrumbs.length - 1
                          ? "text-slate-900 dark:text-slate-100"
                          : "text-slate-500 dark:text-slate-400"
                      }`}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <form onSubmit={(e) => void handleDeepSearch(e)} className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={filterText}
                    onChange={(e) => {
                      setFilterText(e.target.value);
                      if (deepSearch && !e.target.value.trim()) {
                        setDeepSearch(false);
                        void loadDirectory(currentPath);
                      }
                    }}
                    placeholder="Filter (Enter = deep)"
                    className="w-40 rounded-lg border border-slate-300 bg-white py-1 pr-2 pl-7 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </form>

                {currentPath !== "/" && (
                  <button
                    type="button"
                    onClick={() => void handleTogglePin(currentPath)}
                    title={isCurrentPinned ? "Unpin folder" : "Pin folder"}
                    className="rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {isCurrentPinned ? (
                      <PinOff className="h-3.5 w-3.5 text-blue-600" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setNewItemMode("folder");
                    setNewItemName("");
                  }}
                  title="New folder"
                  className="rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setNewItemMode("markdown");
                    setNewItemName("");
                  }}
                  title="New Markdown note"
                  className="rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <FilePlus className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => uploadInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  Upload
                </button>
                <input
                  ref={uploadInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) void handleUploadFiles(e.target.files);
                    e.target.value = "";
                  }}
                />

                <button
                  type="button"
                  onClick={() =>
                    setViewMode((m) => (m === "list" ? "grid" : "list"))
                  }
                  title="Toggle list / grid view"
                  className="rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {viewMode === "list" ? (
                    <LayoutGrid className="h-3.5 w-3.5" />
                  ) : (
                    <ListIcon className="h-3.5 w-3.5" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => void loadDirectory(currentPath)}
                  title="Refresh"
                  className="rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>

            {/* Inline New Folder / New Note Prompt */}
            {newItemMode && (
              <form
                onSubmit={(e) => void handleCreateNew(e)}
                className="flex items-center gap-2 border-b border-slate-200 bg-blue-50/50 px-4 py-2.5 dark:border-slate-800 dark:bg-blue-950/20"
              >
                <input
                  type="text"
                  autoFocus
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  placeholder={
                    newItemMode === "folder"
                      ? "Folder name..."
                      : "Note name (e.g. meeting-notes.md)..."
                  }
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setNewItemMode(null)}
                  className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
              </form>
            )}

            {/* Inline Rename Prompt */}
            {renamingItem && (
              <form
                onSubmit={(e) => void handleRenameSubmit(e)}
                className="flex items-center gap-2 border-b border-slate-200 bg-amber-50/60 px-4 py-2.5 dark:border-slate-800 dark:bg-amber-950/20"
              >
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  Rename:
                </span>
                <input
                  type="text"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setRenamingItem(null)}
                  className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
              </form>
            )}

            {/* File List / Grid */}
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {loading && items.length === 0 ? (
                <div className="flex h-48 items-center justify-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading folder...
                </div>
              ) : visibleItems.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center text-center text-sm text-slate-500">
                  <Folder className="mb-2 h-8 w-8 text-slate-300 dark:text-slate-700" />
                  <p>This folder is empty</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Drag &amp; drop files here or click Upload to add files.
                  </p>
                </div>
              ) : viewMode === "list" ? (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {visibleItems.map((item) => {
                    const isSelected = selectedFile?.entry.path === item.entry.path;
                    return (
                      <li
                        key={item.entry.path}
                        className={`group flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 transition-colors ${
                          isSelected
                            ? "bg-blue-50 dark:bg-blue-950/50"
                            : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (item.entry.kind === "directory") {
                              setCurrentPath(item.entry.path);
                            } else {
                              setSelectedFile(item);
                            }
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                        >
                          <ItemIcon
                            kind={item.entry.kind}
                            previewKind={item.previewKind}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                              {item.entry.name}
                            </p>
                            {deepSearch && (
                              <p className="truncate text-[11px] text-slate-400">
                                {item.entry.path}
                              </p>
                            )}
                          </div>
                        </button>

                        <div className="flex shrink-0 items-center gap-2">
                          {item.entry.kind === "file" && (
                            <span className="text-xs text-slate-400">
                              {formatBytes(item.entry.size)}
                            </span>
                          )}
                          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            {item.entry.kind === "directory" && (
                              <button
                                type="button"
                                onClick={() => void handleTogglePin(item.entry.path)}
                                title="Pin / unpin folder"
                                className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-blue-600 dark:hover:bg-slate-700"
                              >
                                <Pin className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setRenamingItem(item);
                                setRenameValue(item.entry.name);
                              }}
                              title="Rename"
                              className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDelete(item)}
                              title="Delete"
                              className="rounded p-1 text-slate-400 hover:bg-rose-100 hover:text-rose-600 dark:hover:bg-rose-950/60"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {visibleItems.map((item) => {
                    const isSelected = selectedFile?.entry.path === item.entry.path;
                    return (
                      <button
                        key={item.entry.path}
                        type="button"
                        onClick={() => {
                          if (item.entry.kind === "directory") {
                            setCurrentPath(item.entry.path);
                          } else {
                            setSelectedFile(item);
                          }
                        }}
                        className={`flex flex-col items-start rounded-xl border p-3 text-left transition-colors ${
                          isSelected
                            ? "border-blue-500 bg-blue-50/70 dark:bg-blue-950/40"
                            : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
                        }`}
                      >
                        <ItemIcon
                          kind={item.entry.kind}
                          previewKind={item.previewKind}
                        />
                        <p className="mt-2 w-full truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                          {item.entry.name}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {item.entry.kind === "directory"
                            ? "Folder"
                            : formatBytes(item.entry.size)}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}

        {selectedFile && (
          <section
            className={`min-h-0 ${
              previewExpanded ? "lg:col-span-12" : "lg:col-span-7"
            }`}
          >
            <FilePreviewPane
              item={selectedFile}
              expanded={previewExpanded}
              onToggleExpand={() => setPreviewExpanded((e) => !e)}
              onClose={() => {
                setSelectedFile(null);
                setPreviewExpanded(false);
              }}
              onRefreshFolder={() => void loadDirectory(currentPath)}
            />
          </section>
        )}
      </div>
    </div>
  );
}
