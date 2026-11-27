import {
  ArrowDown,
  ArrowUp,
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
import { InspectorEmptyPane } from "../components/shell/InspectorEmptyPane";
import { WorkspaceLayout } from "../components/shell/WorkspaceLayout";
import { InlineDeleteConfirm } from "../components/ui/InlineDeleteConfirm";
import { IconButton, Kbd } from "../components/ui/Tooltip";
import { formatIsoDate } from "../lib/dateFormat";
import { QUICK_CHAT_SHORTCUT } from "../lib/platform";
import {
  areSingleKeyShortcutsEnabled,
  handleToolbarKeyDown,
  hasActiveOverlay,
  isBlockedArrowScope,
  isEditableTarget,
  useSingleKeyShortcutsEnabled,
} from "../lib/shortcuts";
import {
  createFolder,
  createMarkdownFile,
  deleteFile,
  joinCloudPath,
  listFiles,
  renameFile,
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
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onSetInspectorOpen: (open: boolean) => void;
  quickChatInspector?: React.ReactNode;
  banners?: React.ReactNode;
}

type CategoryFilter = "all" | "notes" | "docs" | "media" | "cad";
type SortField = "name" | "size" | "modified";

function ItemIcon({
  kind,
  previewKind,
}: {
  kind: "directory" | "file";
  previewKind: PreviewKind | null;
}) {
  if (kind === "directory") {
    return (
      <Folder
        className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
        strokeWidth={1.5}
      />
    );
  }
  switch (previewKind) {
    case "markdown":
      return (
        <FileText
          className="h-4 w-4 shrink-0 text-[var(--accent)]"
          strokeWidth={1.5}
        />
      );
    case "image":
      return (
        <ImageIcon
          className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
        />
      );
    case "video":
      return (
        <Film
          className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
        />
      );
    case "pdf":
    case "vectorAi":
      return (
        <FileText
          className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
        />
      );
    case "vectorSvg":
    case "vectorDxf":
    case "vectorEps":
      return (
        <Layers
          className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
        />
      );
    case "solidWorks":
    case "cad3d":
      return (
        <Box
          className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
        />
      );
    case "plainText":
      return (
        <FileCode2
          className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
        />
      );
    default:
      return (
        <FileIcon
          className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
          strokeWidth={1.5}
        />
      );
  }
}

function typeLabel(item: FileItemView_Serialize): string {
  if (item.entry.kind === "directory") return "DIR";
  const ext = item.entry.name.split(".").pop();
  if (ext && ext !== item.entry.name) return ext.toUpperCase().slice(0, 6);
  return "FILE";
}

function matchesCategory(
  item: FileItemView_Serialize,
  cat: CategoryFilter,
): boolean {
  if (cat === "all") return true;
  if (item.entry.kind === "directory") return false;
  switch (cat) {
    case "notes":
      return item.previewKind === "markdown" || item.previewKind === "plainText";
    case "docs":
      return item.previewKind === "pdf" || item.previewKind === "vectorAi";
    case "media":
      return (
        item.previewKind === "image" ||
        item.previewKind === "video" ||
        item.previewKind === "vectorSvg"
      );
    case "cad":
      return (
        item.previewKind === "solidWorks" ||
        item.previewKind === "cad3d" ||
        item.previewKind === "vectorDxf"
      );
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
  sidebarOpen,
  onToggleSidebar,
  inspectorOpen,
  onToggleInspector,
  onSetInspectorOpen,
  quickChatInspector,
  banners,
}: FilesViewProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [items, setItems] = useState<FileItemView_Serialize[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [sortBy, setSortBy] = useState<SortField>("name");
  const [sortAsc, setSortAsc] = useState(true);
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
  const [pendingDelete, setPendingDelete] =
    useState<FileItemView_Serialize | null>(null);
  const [pendingUploadOverwrite, setPendingUploadOverwrite] = useState<{
    dest: string;
    name: string;
    bytes: Uint8Array;
  } | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [pendingNavAction, setPendingNavAction] = useState<(() => void) | null>(
    null,
  );
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const singleKeyEnabled = useSingleKeyShortcutsEnabled();

  const isConnected = connectionStatus.state === "connected";

  const guardUnsavedEditor = useCallback(
    (action: () => void) => {
      if (editorDirty && selectedFile?.previewKind === "markdown") {
        setPendingNavAction(() => action);
        return;
      }
      action();
    },
    [editorDirty, selectedFile],
  );

  const navigateToFolder = useCallback(
    (targetPath: string) => {
      guardUnsavedEditor(() => {
        setSelectedFile(null);
        setPreviewExpanded(false);
        setEditorDirty(false);
        setCategoryFilter("all");
        setCurrentPath(targetPath);
      });
    },
    [guardUnsavedEditor],
  );

  const selectFileSafely = useCallback(
    (item: FileItemView_Serialize) => {
      if (selectedFile?.entry.path === item.entry.path) {
        onSetInspectorOpen(true);
        return;
      }
      guardUnsavedEditor(() => {
        setEditorDirty(false);
        setSelectedFile(item);
        onSetInspectorOpen(true);
      });
    },
    [guardUnsavedEditor, selectedFile, onSetInspectorOpen],
  );

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

  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const visibleItemsRef = useRef<FileItemView_Serialize[]>([]);

  // Module keyboard shortcuts: / focus filter, G toggle view, Esc close prompts, ArrowUp/Down + Enter navigate items
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasActiveOverlay()) {
        return;
      }
      if (e.key === "Escape") {
        if (pendingNavAction) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setPendingNavAction(null);
          return;
        }
        if (renamingItem) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setRenamingItem(null);
          searchInputRef.current?.focus();
          return;
        }
        if (newItemMode) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setNewItemMode(null);
          searchInputRef.current?.focus();
          return;
        }
        if (pendingDelete) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setPendingDelete(null);
          return;
        }
        return;
      }

      const inInput = isEditableTarget(e.target);
      if (inInput) return;

      if (
        areSingleKeyShortcutsEnabled() &&
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (
        areSingleKeyShortcutsEnabled() &&
        e.key.toLowerCase() === "g" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        setViewMode((m) => (m === "list" ? "grid" : "list"));
      } else if (
        !e.defaultPrevented &&
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        if (isBlockedArrowScope(document.activeElement)) {
          return;
        }
        const list = visibleItemsRef.current;
        if (list.length === 0) return;
        e.preventDefault();
        const activeKey = focusedPath ?? selectedFile?.entry.path ?? null;
        const curIdx = activeKey
          ? list.findIndex((it) => it.entry.path === activeKey)
          : -1;
        const nextIdx =
          e.key === "ArrowDown"
            ? curIdx < 0
              ? 0
              : Math.min(list.length - 1, curIdx + 1)
            : curIdx <= 0
              ? 0
              : curIdx - 1;
        const nextItem = list[nextIdx];
        setFocusedPath(nextItem.entry.path);
        const rowEl = document.querySelector<HTMLElement>(
          `[data-file-path="${CSS.escape(nextItem.entry.path)}"]`,
        );
        rowEl?.focus({ preventScroll: false });
        rowEl?.scrollIntoView({ block: "nearest" });
      } else if (
        !e.defaultPrevented &&
        (e.key === "Enter" || e.key === " ") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        focusedPath &&
        (document.activeElement === document.body ||
          (document.activeElement instanceof HTMLElement &&
            document.activeElement.hasAttribute("data-file-path")))
      ) {
        const item = visibleItemsRef.current.find(
          (it) => it.entry.path === focusedPath,
        );
        if (!item) return;
        e.preventDefault();
        if (item.entry.kind === "directory") {
          navigateToFolder(item.entry.path);
        } else {
          selectFileSafely(item);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    pendingNavAction,
    renamingItem,
    newItemMode,
    pendingDelete,
    selectedFile,
    focusedPath,
    navigateToFolder,
    selectFileSafely,
  ]);

  const breadcrumbs = useMemo(() => {
    const parts = currentPath.split("/").filter(Boolean);
    const crumbs: Array<{ label: string; path: string }> = [
      { label: "Files", path: "/" },
    ];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }, [currentPath]);

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: items.length,
      notes: 0,
      docs: 0,
      media: 0,
      cad: 0,
    };
    for (const it of items) {
      if (matchesCategory(it, "notes")) counts.notes += 1;
      if (matchesCategory(it, "docs")) counts.docs += 1;
      if (matchesCategory(it, "media")) counts.media += 1;
      if (matchesCategory(it, "cad")) counts.cad += 1;
    }
    return counts;
  }, [items]);

  const visibleItems = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (!matchesCategory(item, categoryFilter)) return false;
      if (!q || deepSearch) return true;
      return item.entry.name.toLowerCase().includes(q);
    });
    return [...filtered].sort((a, b) => {
      // Directories first
      if (a.entry.kind !== b.entry.kind) {
        return a.entry.kind === "directory" ? -1 : 1;
      }
      let cmp = 0;
      if (sortBy === "size") {
        cmp = (a.entry.size ?? 0) - (b.entry.size ?? 0);
      } else if (sortBy === "modified") {
        const ta = a.entry.modifiedAt ? Date.parse(a.entry.modifiedAt) : 0;
        const tb = b.entry.modifiedAt ? Date.parse(b.entry.modifiedAt) : 0;
        cmp = ta - tb;
      } else {
        cmp = a.entry.name.localeCompare(b.entry.name);
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [items, filterText, deepSearch, categoryFilter, sortBy, sortAsc]);
  visibleItemsRef.current = visibleItems;

  function toggleSort(field: SortField) {
    if (sortBy === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortBy(field);
      setSortAsc(field === "name");
    }
  }

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
        try {
          await uploadFileBytes(dest, bytes, false);
        } catch (err) {
          const uf = toUserFacingError(err);
          if (uf.code === "already_exists") {
            setPendingUploadOverwrite({ dest, name: file.name, bytes });
            return;
          }
          throw err;
        }
      }
      await loadDirectory(currentPath);
    } catch (err) {
      setExplorerError(toUserFacingError(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleConfirmUploadOverwrite() {
    if (!pendingUploadOverwrite) return;
    const { dest, bytes } = pendingUploadOverwrite;
    setPendingUploadOverwrite(null);
    setUploading(true);
    setExplorerError(null);
    try {
      await uploadFileBytes(dest, bytes, true);
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
        await createMarkdownFile(
          fullPath,
          `# ${trimmed.replace(/\.md$/i, "")}\n\n`,
        );
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

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    const item = pendingDelete;
    setPendingDelete(null);
    setExplorerError(null);
    try {
      await deleteFile(item.entry.path);
      if (selectedFile?.entry.path === item.entry.path) {
        setSelectedFile(null);
        setEditorDirty(false);
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

  // Signed-out onboarding inside unified shell
  if (!isConnected) {
    const configuredServer =
      connectionStatus.state === "notConfigured"
        ? null
        : connectionStatus.serverUrl;

    return (
      <WorkspaceLayout
        moduleId="files"
        headerLeft={
          <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
            Files
          </h1>
        }
        sidebarOpen={false}
        onToggleSidebar={onToggleSidebar}
        inspectorOpen={Boolean(quickChatInspector)}
        inspector={quickChatInspector}
        onToggleInspector={onToggleInspector}
        banners={banners}
      >
        <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
          <div className="w-full max-w-lg space-y-4">
            {error && <ErrorBanner error={error} onDismiss={onClearError} />}

            {loginPendingUrl ? (
              <section className="rounded-md border border-[var(--accent-border)] bg-[var(--bg-sidebar)] p-5">
                <div className="flex items-start gap-3">
                  <Loader2
                    className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--accent)]"
                    strokeWidth={1.5}
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium text-[var(--text-primary)]">
                      Finish signing in via your browser
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
                      Approve access in the opened Nextcloud tab — this workspace
                      will connect automatically.
                    </p>
                    <div className="mt-4 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void openExternalUrl(loginPendingUrl)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
                        Open browser again
                      </button>
                      <button
                        type="button"
                        onClick={() => void onCancelLogin()}
                        className="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            ) : (
              <section className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-5">
                <div className="flex items-start gap-3">
                  <Cloud
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]"
                    strokeWidth={1.5}
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium text-[var(--text-primary)]">
                      Connect Nextcloud Workspace
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
                      {configuredServer ? (
                        <>
                          Sign in with one click to{" "}
                          <span className="mono-num text-[var(--text-primary)]">
                            {configuredServer}
                          </span>
                          . Supports 2FA and SSO automatically.
                        </>
                      ) : (
                        "Enter your team's Nextcloud server address in Settings to get started."
                      )}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {configuredServer ? (
                        <>
                          <button
                            type="button"
                            disabled={loginStarting}
                            onClick={() => void onStartLogin()}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                          >
                            {loginStarting ? (
                              <Loader2
                                className="h-3.5 w-3.5 animate-spin"
                                strokeWidth={1.5}
                              />
                            ) : (
                              <LogIn className="h-3.5 w-3.5" strokeWidth={1.5} />
                            )}
                            {loginStarting ? "Opening browser…" : "Sign in"}
                          </button>
                          <button
                            type="button"
                            onClick={onOpenSettings}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                          >
                            <Settings className="h-3.5 w-3.5" strokeWidth={1.5} />
                            Change server
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={onOpenSettings}
                          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
                        >
                          <Settings className="h-3.5 w-3.5" strokeWidth={1.5} />
                          Configure server
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </WorkspaceLayout>
    );
  }

  const isCurrentPinned = pinnedFolders.includes(currentPath);
  const quotaPct =
    accountInfo &&
    accountInfo.quotaUsedBytes !== null &&
    accountInfo.quotaTotalBytes &&
    accountInfo.quotaTotalBytes > 0
      ? Math.min(
          100,
          Math.round(
            (accountInfo.quotaUsedBytes / accountInfo.quotaTotalBytes) * 100,
          ),
        )
      : null;

  const sidebarNode = (
    <div className="flex h-full flex-col">
      {/* Sidebar: Locations & File Type Filter */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2.5">
        {/* Locations */}
        <div>
          <h2 className="mb-1 px-2 text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
            Locations
          </h2>
          <div className="space-y-0.5">
            <button
              type="button"
              aria-current={
                currentPath === "/" && categoryFilter === "all"
                  ? "page"
                  : undefined
              }
              onClick={() => navigateToFolder("/")}
              className={`relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                currentPath === "/" && categoryFilter === "all"
                  ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              }`}
            >
              {currentPath === "/" && categoryFilter === "all" && (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r bg-[var(--accent)]"
                />
              )}
              <Home className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              <span className="truncate">All Files</span>
            </button>

            {pinnedFolders.map((folder) => {
              const label = folder.split("/").filter(Boolean).pop() || folder;
              const active = currentPath === folder;
              return (
                <div
                  key={folder}
                  className={`group relative flex items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors ${
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
                    aria-current={active ? "page" : undefined}
                    onClick={() => navigateToFolder(folder)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Pin
                      className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                      strokeWidth={1.5}
                    />
                    <span className="truncate">{label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleTogglePin(folder)}
                    aria-label={`Unpin ${label}`}
                    className="rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-[var(--text-primary)] focus-visible:opacity-100"
                  >
                    <X className="h-3 w-3" strokeWidth={1.5} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* File Type Filter */}
        <div>
          <h2 className="mb-1 px-2 text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
            Filter
          </h2>
          <div className="space-y-0.5">
            {(
              [
                { id: "all", label: "Everything", icon: Folder },
                { id: "notes", label: "Notes & Code", icon: FileText },
                { id: "docs", label: "PDF & Docs", icon: Layers },
                { id: "media", label: "Images & Media", icon: ImageIcon },
                { id: "cad", label: "CAD & 3D", icon: Box },
              ] as const
            ).map(({ id, label, icon: Icon }) => {
              const active = categoryFilter === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setCategoryFilter(id)}
                  className={`relative flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
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
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon
                      className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                      strokeWidth={1.5}
                    />
                    <span className="truncate">{label}</span>
                  </span>
                  <span className="mono-num text-[10px] text-[var(--text-muted)]">
                    {categoryCounts[id]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Unified h-8 Storage Quota Footer (byte-identical baseline recipe across all modules) */}
      <div className="mono-num relative flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <span>Storage</span>
        <span>
          {accountInfo
            ? `${formatBytes(accountInfo.quotaUsedBytes)}${accountInfo.quotaTotalBytes ? ` / ${formatBytes(accountInfo.quotaTotalBytes)}` : ""}`
            : "—"}
        </span>
        {quotaPct !== null && (
          <div
            role="progressbar"
            aria-label="Storage quota used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(quotaPct)}
            className="pointer-events-none absolute right-0 bottom-0 left-0 h-[2px] bg-[var(--bg-elevated)]"
          >
            <div
              className="h-full bg-[var(--text-muted)]"
              style={{ width: `${Math.max(2, quotaPct)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );

  const inspectorNode = quickChatInspector ? (
    quickChatInspector
  ) : selectedFile ? (
    <FilePreviewPane
      item={selectedFile}
      expanded={previewExpanded}
      onToggleExpand={() => setPreviewExpanded((e) => !e)}
      onClose={() =>
        guardUnsavedEditor(() => {
          setSelectedFile(null);
          setPreviewExpanded(false);
          setEditorDirty(false);
          onSetInspectorOpen(false);
        })
      }
      onRefreshFolder={() => void loadDirectory(currentPath)}
      onDirtyChange={setEditorDirty}
    />
  ) : (
    <InspectorEmptyPane
      icon={FileIcon}
      title="No file selected"
      description="Select any file to preview PDF, images, Markdown, SVG, CAD, or 3D meshes."
      footerLeft={currentPath}
      footerRight={`${visibleItems.length} items`}
    />
  );

  return (
    <WorkspaceLayout
      moduleId="files"
      headerLeft={
        <div className="flex min-w-0 items-center">
          <h1 className="sr-only">Files</h1>
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-1 overflow-x-auto text-[13px]"
          >
          {breadcrumbs.map((crumb, idx) => (
            <span key={crumb.path} className="inline-flex shrink-0 items-center gap-1">
              {idx > 0 && (
                <ChevronRight
                  className="h-3.5 w-3.5 text-[var(--text-muted)]"
                  strokeWidth={1.5}
                />
              )}
              <button
                type="button"
                onClick={() => navigateToFolder(crumb.path)}
                className={`rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-hover)] ${
                  idx === breadcrumbs.length - 1
                    ? "font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)]"
                }`}
              >
                {crumb.label}
              </button>
            </span>
          ))}
          </nav>
        </div>
      }
      headerRight={
        <div className="flex items-center gap-1">
          <form
            onSubmit={(e) => void handleDeepSearch(e)}
            className="relative mr-1 flex items-center gap-1"
          >
            {deepSearch && (
              <button
                type="button"
                onClick={() => {
                  setDeepSearch(false);
                  setFilterText("");
                  void loadDirectory(currentPath);
                }}
                aria-label="Clear recursive search"
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-[var(--accent)] bg-[var(--accent-soft)] px-1.5 text-[11px] font-medium text-[var(--accent-text)] hover:bg-[var(--bg-hover)]"
              >
                <span>All folders</span>
                <X className="h-3 w-3" strokeWidth={1.5} />
              </button>
            )}
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
                strokeWidth={1.5}
              />
              <input
                ref={searchInputRef}
                type="text"
                aria-label="Filter files (press Enter to search all folders)"
                value={filterText}
                onChange={(e) => {
                  setFilterText(e.target.value);
                  if (deepSearch && !e.target.value.trim()) {
                    setDeepSearch(false);
                    void loadDirectory(currentPath);
                  }
                }}
                placeholder="Filter files…"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (filterText || deepSearch) {
                      e.preventDefault();
                      setFilterText("");
                      if (deepSearch) {
                        setDeepSearch(false);
                        void loadDirectory(currentPath);
                      }
                    } else {
                      e.currentTarget.blur();
                    }
                  }
                }}
                className="h-7 w-44 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] pr-6 pl-7 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
              {!filterText && singleKeyEnabled && (
                <Kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2">
                  /
                </Kbd>
              )}
            </div>
          </form>

          <div
            role="toolbar"
            aria-label="File actions"
            onKeyDown={handleToolbarKeyDown}
            className="flex items-center gap-1"
          >
          <IconButton
            label={viewMode === "list" ? "Grid view" : "List view"}
            shortcut="G"
            onClick={() =>
              setViewMode((m) => (m === "list" ? "grid" : "list"))
            }
          >
            {viewMode === "list" ? (
              <LayoutGrid className="h-3.5 w-3.5" strokeWidth={1.5} />
            ) : (
              <ListIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
          </IconButton>

          {currentPath !== "/" && (
            <IconButton
              label={isCurrentPinned ? "Unpin folder" : "Pin folder"}
              active={isCurrentPinned}
              onClick={() => void handleTogglePin(currentPath)}
            >
              {isCurrentPinned ? (
                <PinOff className="h-3.5 w-3.5" strokeWidth={1.5} />
              ) : (
                <Pin className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
            </IconButton>
          )}

          <span className="mx-0.5 h-4 w-px bg-[var(--border-hairline)]" />

          <IconButton
            label="New folder"
            onClick={() => {
              setNewItemMode("folder");
              setNewItemName("");
            }}
          >
            <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>

          <IconButton
            label="New Markdown note"
            onClick={() => {
              setNewItemMode("markdown");
              setNewItemName("");
            }}
          >
            <FilePlus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>

          <IconButton
            label="Upload files"
            tone="accent"
            disabled={uploading}
            onClick={() => uploadInputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
            ) : (
              <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
          </IconButton>
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

          <IconButton
            label="Refresh folder"
            onClick={() => void loadDirectory(currentPath)}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              strokeWidth={1.5}
            />
          </IconButton>
          </div>
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
      inspectorExpanded={Boolean(selectedFile && previewExpanded && !quickChatInspector)}
      banners={banners}
    >
      <div
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
        className={`flex min-h-0 flex-1 flex-col overflow-hidden ${
          dragActive ? "ring-1 ring-inset ring-[var(--accent)]" : ""
        }`}
      >
        {/* Inline Alerts & Prompts */}
        {(error || explorerError) && (
          <div className="border-b border-[var(--border-hairline)] p-2.5">
            <ErrorBanner
              error={(explorerError ?? error)!}
              onDismiss={() => {
                setExplorerError(null);
                onClearError();
              }}
            />
          </div>
        )}

        {pendingNavAction && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)] px-4 py-2 text-xs text-[var(--text-primary)]"
          >
            <span>
              Unsaved edits in Markdown note. A local draft will be kept.
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  const fn = pendingNavAction;
                  setPendingNavAction(null);
                  fn();
                }}
                className="rounded bg-[var(--status-warning)] px-2.5 py-1 text-[11px] font-medium text-[var(--status-warning-fg)]"
              >
                Leave &amp; keep draft
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => setPendingNavAction(null)}
                className="rounded border border-[var(--border-strong)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Stay
              </button>
            </div>
          </div>
        )}

        {pendingUploadOverwrite && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)] px-4 py-2 text-xs text-[var(--text-primary)]"
          >
            <span>
              &ldquo;{pendingUploadOverwrite.name}&rdquo; already exists. Replace on
              Nextcloud?
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleConfirmUploadOverwrite()}
                className="rounded bg-[var(--status-warning)] px-2.5 py-1 text-[11px] font-medium text-[var(--status-warning-fg)]"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() => setPendingUploadOverwrite(null)}
                className="rounded border border-[var(--border-strong)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {newItemMode && (
          <form
            onSubmit={(e) => void handleCreateNew(e)}
            className="flex items-center gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sidebar)] px-3 py-2"
          >
            <input
              type="text"
              autoFocus
              aria-label={
                newItemMode === "folder" ? "New folder name" : "New note name"
              }
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder={
                newItemMode === "folder"
                  ? "New folder name…"
                  : "New note name (e.g. spec.md)…"
              }
              className="h-7 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="submit"
              className="h-7 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setNewItemMode(null)}
              className="h-7 rounded-md px-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
          </form>
        )}

        {renamingItem && (
          <form
            onSubmit={(e) => void handleRenameSubmit(e)}
            className="flex items-center gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sidebar)] px-3 py-2"
          >
            <label
              htmlFor="files-rename-input"
              className="text-[11px] text-[var(--text-muted)]"
            >
              Rename
            </label>
            <input
              id="files-rename-input"
              type="text"
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="h-7 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="submit"
              className="h-7 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setRenamingItem(null)}
              className="h-7 rounded-md px-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
          </form>
        )}

        {/* File List / Grid */}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && items.length === 0 ? (
            <div
              role="status"
              aria-live="polite"
              className="flex h-48 items-center justify-center gap-2 text-xs text-[var(--text-muted)]"
            >
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
              Loading folder…
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center text-center">
              <Folder
                className="mb-2 h-7 w-7 text-[var(--text-muted)] opacity-50"
                strokeWidth={1.5}
              />
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                No matching items
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Drop files here or use the Upload action in the toolbar.
              </p>
            </div>
          ) : viewMode === "list" ? (
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-[var(--border-hairline)] bg-[var(--bg-sidebar)] text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                <tr>
                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "name"
                        ? sortAsc
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="h-8 px-4 font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort("name")}
                      className="inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
                    >
                      Name
                      {sortBy === "name" &&
                        (sortAsc ? (
                          <ArrowUp className="h-2.5 w-2.5" strokeWidth={1.75} />
                        ) : (
                          <ArrowDown className="h-2.5 w-2.5" strokeWidth={1.75} />
                        ))}
                    </button>
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "size"
                        ? sortAsc
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="h-8 w-24 px-3 text-right font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort("size")}
                      className="ml-auto inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
                    >
                      Size
                      {sortBy === "size" &&
                        (sortAsc ? (
                          <ArrowUp className="h-2.5 w-2.5" strokeWidth={1.75} />
                        ) : (
                          <ArrowDown className="h-2.5 w-2.5" strokeWidth={1.75} />
                        ))}
                    </button>
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "modified"
                        ? sortAsc
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="hidden h-8 w-28 px-4 text-right font-medium md:table-cell"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort("modified")}
                      className="ml-auto inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
                    >
                      Modified
                      {sortBy === "modified" &&
                        (sortAsc ? (
                          <ArrowUp className="h-2.5 w-2.5" strokeWidth={1.75} />
                        ) : (
                          <ArrowDown className="h-2.5 w-2.5" strokeWidth={1.75} />
                        ))}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {(() => {
                  const hasFocused = Boolean(
                    focusedPath &&
                      visibleItems.some((it) => it.entry.path === focusedPath),
                  );
                  const hasSelected = Boolean(
                    selectedFile &&
                      visibleItems.some(
                        (it) => it.entry.path === selectedFile.entry.path,
                      ),
                  );
                  return visibleItems.map((item, idx) => {
                    const isSelected =
                      selectedFile?.entry.path === item.entry.path;
                    const isFocused = focusedPath === item.entry.path;
                    const isTabStop =
                      (hasFocused && isFocused) ||
                      (!hasFocused && hasSelected && isSelected) ||
                      (!hasFocused && !hasSelected && idx === 0);
                    return (
                    <tr
                      key={item.entry.path}
                      data-file-path={item.entry.path}
                      tabIndex={isTabStop ? 0 : -1}
                      onFocus={() => setFocusedPath(item.entry.path)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (item.entry.kind === "directory") {
                            navigateToFolder(item.entry.path);
                          } else {
                            selectFileSafely(item);
                          }
                        }
                      }}
                      onClick={() => {
                        setFocusedPath(item.entry.path);
                        if (item.entry.kind === "directory") {
                          navigateToFolder(item.entry.path);
                        } else {
                          selectFileSafely(item);
                        }
                      }}
                      aria-current={isSelected ? "true" : undefined}
                      className={`group cursor-pointer transition-colors focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)] ${
                        isSelected
                          ? "bg-[var(--accent-soft)] text-[var(--text-primary)]"
                          : isFocused
                            ? "bg-[var(--bg-hover)]/75"
                            : "hover:bg-[var(--bg-hover)]/65"
                      }`}
                    >
                      <td className="relative max-w-0 px-4 py-1.5">
                        {isSelected && (
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 left-0 w-0.5 bg-[var(--accent)]"
                          />
                        )}
                        <div className="flex items-center gap-2.5">
                          <ItemIcon
                            kind={item.entry.kind}
                            previewKind={item.previewKind}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                              {item.entry.name}
                            </p>
                            {deepSearch && (
                              <p className="mono-num truncate text-[11px] text-[var(--text-muted)]">
                                {item.entry.path}
                              </p>
                            )}
                          </div>
                        </div>
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className={`absolute inset-y-0 right-2 flex items-center gap-0.5 rounded-md bg-[var(--bg-elevated)] px-1 transition-opacity ${
                            pendingDelete?.entry.path === item.entry.path
                              ? "pointer-events-auto opacity-100"
                              : "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                          }`}
                        >
                          {pendingDelete?.entry.path !== item.entry.path && (
                            <>
                              {item.entry.kind === "directory" && (
                                <IconButton
                                  size="xs"
                                  tabIndex={isTabStop ? 0 : -1}
                                  label={
                                    pinnedFolders.includes(item.entry.path)
                                      ? "Unpin folder"
                                      : "Pin folder"
                                  }
                                  onClick={() =>
                                    void handleTogglePin(item.entry.path)
                                  }
                                >
                                  <Pin className="h-3.5 w-3.5" strokeWidth={1.5} />
                                </IconButton>
                              )}
                              <IconButton
                                size="xs"
                                tabIndex={isTabStop ? 0 : -1}
                                label="Rename"
                                onClick={() => {
                                  setRenamingItem(item);
                                  setRenameValue(item.entry.name);
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                              </IconButton>
                            </>
                          )}
                          <InlineDeleteConfirm
                            armed={pendingDelete?.entry.path === item.entry.path}
                            tabIndex={isTabStop ? 0 : -1}
                            onArm={() => setPendingDelete(item)}
                            onCancel={() => setPendingDelete(null)}
                            onConfirm={() => void handleConfirmDelete()}
                            label={`Delete ${item.entry.name}`}
                          />
                        </div>
                      </td>
                      <td className="mono-num px-3 py-1 text-right whitespace-nowrap text-[11px] text-[var(--text-secondary)]">
                        {item.entry.kind === "directory"
                          ? "—"
                          : formatBytes(item.entry.size)}
                      </td>
                      <td className="mono-num hidden px-4 py-1 text-right whitespace-nowrap text-[11px] text-[var(--text-muted)] md:table-cell">
                        {formatIsoDate(item.entry.modifiedAt)}
                      </td>
                    </tr>
                  );
                  });
                })()}
              </tbody>
            </table>
          ) : (
            <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {(() => {
                const hasFocused = Boolean(
                  focusedPath &&
                    visibleItems.some((it) => it.entry.path === focusedPath),
                );
                const hasSelected = Boolean(
                  selectedFile &&
                    visibleItems.some(
                      (it) => it.entry.path === selectedFile.entry.path,
                    ),
                );
                return visibleItems.map((item, idx) => {
                const isSelected = selectedFile?.entry.path === item.entry.path;
                const isFocused = focusedPath === item.entry.path;
                const isTabStop =
                  (hasFocused && isFocused) ||
                  (!hasFocused && hasSelected && isSelected) ||
                  (!hasFocused && !hasSelected && idx === 0);
                const isArmed = pendingDelete?.entry.path === item.entry.path;
                return (
                  <div
                    key={item.entry.path}
                    className={`group relative flex flex-col rounded-md border transition-colors ${
                      isSelected
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border-strong)] bg-[var(--bg-sidebar)] hover:bg-[var(--bg-elevated)]"
                    }`}
                  >
                    <button
                      type="button"
                      data-file-path={item.entry.path}
                      tabIndex={isTabStop ? 0 : -1}
                      aria-current={isSelected ? "true" : undefined}
                      onFocus={() => setFocusedPath(item.entry.path)}
                      onClick={() => {
                        setFocusedPath(item.entry.path);
                        if (item.entry.kind === "directory") {
                          navigateToFolder(item.entry.path);
                        } else {
                          selectFileSafely(item);
                        }
                      }}
                      className="flex flex-1 flex-col items-start rounded-md p-3 text-left"
                    >
                      <div className="flex w-full items-center justify-between">
                        <ItemIcon
                          kind={item.entry.kind}
                          previewKind={item.previewKind}
                        />
                        <span className="mono-num text-[11px] text-[var(--text-muted)]">
                          {typeLabel(item)}
                        </span>
                      </div>
                      <p className="mt-2.5 w-full truncate text-xs font-medium text-[var(--text-primary)]">
                        {item.entry.name}
                      </p>
                      {deepSearch && (
                        <p className="mono-num mt-0.5 w-full truncate text-[11px] text-[var(--text-muted)]">
                          {item.entry.path}
                        </p>
                      )}
                      <p className="mono-num mt-0.5 flex w-full items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                        <span>
                          {item.entry.kind === "directory"
                            ? "Folder"
                            : formatBytes(item.entry.size)}
                        </span>
                        <span>{formatIsoDate(item.entry.modifiedAt)}</span>
                      </p>
                    </button>
                    <div
                      className={`absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-[var(--bg-elevated)] p-0.5 transition-opacity ${
                        isArmed
                          ? "pointer-events-auto opacity-100"
                          : "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                      }`}
                    >
                      {!isArmed && (
                        <>
                          {item.entry.kind === "directory" && (
                            <IconButton
                              size="xs"
                              tabIndex={isTabStop ? 0 : -1}
                              label={
                                pinnedFolders.includes(item.entry.path)
                                  ? "Unpin folder"
                                  : "Pin folder"
                              }
                              onClick={() =>
                                void handleTogglePin(item.entry.path)
                              }
                            >
                              <Pin className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </IconButton>
                          )}
                          <IconButton
                            size="xs"
                            tabIndex={isTabStop ? 0 : -1}
                            label="Rename"
                            onClick={() => {
                              setRenamingItem(item);
                              setRenameValue(item.entry.name);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                          </IconButton>
                        </>
                      )}
                      <InlineDeleteConfirm
                        armed={isArmed}
                        tabIndex={isTabStop ? 0 : -1}
                        onArm={() => setPendingDelete(item)}
                        onCancel={() => setPendingDelete(null)}
                        onConfirm={() => void handleConfirmDelete()}
                        label={`Delete ${item.entry.name}`}
                      />
                    </div>
                  </div>
                );
                });
              })()}
            </div>
          )}
        </div>
      </div>
    </WorkspaceLayout>
  );
}
