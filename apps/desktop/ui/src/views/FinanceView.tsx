import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Download,
  Eye,
  FileText,
  Folder,
  Landmark,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Tag,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FileItemView_Serialize,
  FinanceCurrencySummary,
  FinanceEntryKind,
  FinanceEntryStatus,
  FinanceEntry_Serialize,
  UserFacingError,
  WorkspaceOverview_Serialize,
} from "../bindings/tauri";
import { ErrorBanner } from "../components/ErrorBanner";
import { FilePreviewPane } from "../components/files/FilePreviewPane";
import { InspectorEmptyPane } from "../components/shell/InspectorEmptyPane";
import { NoticeBanner } from "../components/shell/NoticeBanner";
import { WorkspaceLayout } from "../components/shell/WorkspaceLayout";
import { Combobox } from "../components/ui/Combobox";
import { DateInput } from "../components/ui/DateInput";
import { InlineDeleteConfirm } from "../components/ui/InlineDeleteConfirm";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { IconButton, Kbd } from "../components/ui/Tooltip";
import { listFiles } from "../lib/filesClient";
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
  deleteFinanceEntry,
  exportFinanceCsv,
  formatCurrencyCents,
  getFinanceSummary,
  listFinanceEntries,
  parseAmountToCents,
  setFinanceFolder,
  upsertFinanceEntry,
} from "../lib/financeClient";
import { toUserFacingError } from "../lib/workspaceClient";

interface FinanceViewProps {
  financeFolder: string;
  isNextcloudConnected: boolean;
  onOverviewUpdated: (overview: WorkspaceOverview_Serialize) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onSetInspectorOpen: (open: boolean) => void;
  quickChatInspector?: React.ReactNode;
  banners?: React.ReactNode;
}

interface EntryDraft {
  id: string | null;
  kind: FinanceEntryKind;
  vendor: string;
  description: string;
  category: string;
  amountText: string;
  currency: string;
  entryDate: string;
  status: FinanceEntryStatus;
  cloudFilePath: string;
}

function todayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function emptyDraft(): EntryDraft {
  return {
    id: null,
    kind: "invoice",
    vendor: "",
    description: "",
    category: "Operations",
    amountText: "",
    currency: "EUR",
    entryDate: todayIsoDate(),
    status: "pending",
    cloudFilePath: "",
  };
}

function draftFromEntry(entry: FinanceEntry_Serialize): EntryDraft {
  const cents = entry.amountCents ?? 0;
  return {
    id: entry.id,
    kind: entry.kind,
    vendor: entry.vendor,
    description: entry.description,
    category: entry.category,
    amountText: (cents / 100).toFixed(2),
    currency: entry.currency,
    entryDate: entry.entryDate,
    status: entry.status,
    cloudFilePath: entry.cloudFilePath ?? "",
  };
}

function statusDotColor(status: FinanceEntryStatus): string {
  switch (status) {
    case "paid":
      return "bg-[var(--status-positive)]";
    case "approved":
      return "bg-[var(--accent)]";
    default:
      return "bg-[var(--status-warning)]";
  }
}

export function FinanceView({
  financeFolder,
  isNextcloudConnected,
  onOverviewUpdated,
  sidebarOpen,
  onToggleSidebar,
  inspectorOpen,
  onToggleInspector,
  onSetInspectorOpen,
  quickChatInspector,
  banners,
}: FinanceViewProps) {
  const [entries, setEntries] = useState<FinanceEntry_Serialize[]>([]);
  const [summaries, setSummaries] = useState<FinanceCurrencySummary[]>([]);
  const [folderFiles, setFolderFiles] = useState<FileItemView_Serialize[]>([]);
  const [folderInput, setFolderInput] = useState(financeFolder);
  const [savingFolder, setSavingFolder] = useState(false);

  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<FinanceEntryKind | "all">("all");
  const [statusFilter, setStatusFilter] = useState<FinanceEntryStatus | "all">(
    "all",
  );
  const [categoryFilter, setCategoryFilter] = useState<string | "all">("all");
  const [sortBy, setSortBy] = useState<
    "date" | "vendor" | "category" | "status" | "amount"
  >("date");
  const [sortAsc, setSortAsc] = useState(false);
  const [showChart, setShowChart] = useState(true);

  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [savingEntry, setSavingEntry] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<FileItemView_Serialize | null>(
    null,
  );
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<UserFacingError | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const singleKeyEnabled = useSingleKeyShortcutsEnabled();
  const [confirmDiscardDraft, setConfirmDiscardDraft] = useState(false);
  const draftOpenRef = useRef(false);
  const draftSnapshotRef = useRef<string>("");

  useEffect(() => {
    if (draft && !draftOpenRef.current) {
      draftOpenRef.current = true;
      draftSnapshotRef.current = JSON.stringify(draft);
      setConfirmDiscardDraft(false);
    } else if (!draft) {
      draftOpenRef.current = false;
      draftSnapshotRef.current = "";
      setConfirmDiscardDraft(false);
    }
  }, [draft]);

  const isDraftDirty =
    draft !== null && JSON.stringify(draft) !== draftSnapshotRef.current;

  function requestCloseDraft() {
    if (isDraftDirty) {
      setConfirmDiscardDraft(true);
    } else {
      setDraft(null);
    }
  }

  useEffect(() => {
    setFolderInput(financeFolder);
  }, [financeFolder]);

  const loadLedger = useCallback(async () => {
    if (!isNextcloudConnected) {
      setEntries([]);
      setSummaries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [list, summary] = await Promise.all([
        listFinanceEntries(),
        getFinanceSummary(),
      ]);
      setEntries(list);
      setSummaries(summary);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setLoading(false);
    }
  }, [isNextcloudConnected]);

  const loadFinanceFolderFiles = useCallback(async () => {
    if (!isNextcloudConnected) {
      setFolderFiles([]);
      return;
    }
    try {
      const items = await listFiles(financeFolder);
      setFolderFiles(items.filter((it) => it.entry.kind === "file"));
    } catch {
      setFolderFiles([]);
    }
  }, [financeFolder, isNextcloudConnected]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  useEffect(() => {
    void loadFinanceFolderFiles();
  }, [loadFinanceFolderFiles]);

  const filteredEntriesRef = useRef<FinanceEntry_Serialize[]>([]);

  // '/' focuses search, Escape closes modal or deselects row, ArrowUp/Down navigates ledger rows
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasActiveOverlay()) {
        return;
      }
      const inInput = isEditableTarget(e.target);
      if (e.key === "Escape") {
        if (inInput) return;
        if (confirmDeleteId) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setConfirmDeleteId(null);
          return;
        }
        if (!previewItem && selectedEntryId) {
          e.preventDefault();
          setSelectedEntryId(null);
          onSetInspectorOpen(false);
          return;
        }
      }
      if (inInput) return;
      if (areSingleKeyShortcutsEnabled() && e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
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
        const list = filteredEntriesRef.current;
        if (list.length === 0) return;
        e.preventDefault();
        const curIdx = selectedEntryId
          ? list.findIndex((it) => it.id === selectedEntryId)
          : -1;
        const nextIdx =
          e.key === "ArrowDown"
            ? curIdx < 0
              ? 0
              : Math.min(list.length - 1, curIdx + 1)
            : curIdx <= 0
              ? 0
              : curIdx - 1;
        const nextId = list[nextIdx].id;
        setPreviewItem(null);
        setSelectedEntryId(nextId);
        const rowEl = document.querySelector<HTMLElement>(
          `tr[data-entry-id="${CSS.escape(nextId)}"]`,
        );
        rowEl?.focus({ preventScroll: false });
        rowEl?.scrollIntoView({ block: "nearest" });
      } else if (
        !e.defaultPrevented &&
        e.key === "Enter" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        selectedEntryId &&
        !draft &&
        !previewItem &&
        (document.activeElement === document.body ||
          document.activeElement?.tagName === "TR")
      ) {
        const entry = filteredEntriesRef.current.find(
          (it) => it.id === selectedEntryId,
        );
        if (entry) {
          e.preventDefault();
          setDraft(draftFromEntry(entry));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, confirmDeleteId, previewItem, selectedEntryId, onSetInspectorOpen]);

  function flashNotice(msg: string) {
    setNotice(msg);
    window.setTimeout(() => {
      setNotice((prev) => (prev === msg ? null : prev));
    }, 4000);
  }

  async function handleSaveFolder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSavingFolder(true);
    try {
      const updated = await setFinanceFolder(folderInput);
      onOverviewUpdated(updated);
      flashNotice(`Finance folder set to ${updated.config.financeFolder}.`);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setSavingFolder(false);
    }
  }

  async function handleSaveEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const cents = parseAmountToCents(draft.amountText);
    if (cents === null) {
      setError({
        code: "invalid_amount",
        title: "Invalid amount",
        message: "Enter a valid amount with up to two decimal places (e.g. 249.90).",
        recoveryHint: null,
        technicalDetails: null,
      });
      return;
    }

    setError(null);
    setSavingEntry(true);
    try {
      await upsertFinanceEntry({
        id: draft.id,
        kind: draft.kind,
        vendor: draft.vendor,
        description: draft.description,
        category: draft.category,
        amountCents: cents,
        currency: draft.currency.trim().toUpperCase(),
        entryDate: draft.entryDate,
        status: draft.status,
        cloudFilePath: draft.cloudFilePath.trim() || null,
      });
      setDraft(null);
      await loadLedger();
      flashNotice("Entry saved.");
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setSavingEntry(false);
    }
  }

  async function handleDelete(entryId: string) {
    setError(null);
    try {
      await deleteFinanceEntry(entryId);
      setConfirmDeleteId(null);
      if (selectedEntryId === entryId) setSelectedEntryId(null);
      await loadLedger();
      flashNotice("Entry deleted.");
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function handleExportCsv() {
    setError(null);
    try {
      const csv = await exportFinanceCsv();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `finance-ledger-${todayIsoDate()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      flashNotice("Exported CSV ledger.");
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  function handlePreviewLinkedFile(cloudPath: string) {
    onSetInspectorOpen(true);
    const existing = folderFiles.find((f) => f.entry.path === cloudPath);
    if (existing) {
      setPreviewItem(existing);
      return;
    }
    const name = cloudPath.split("/").filter(Boolean).pop() ?? cloudPath;
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const previewKind =
      ext === "pdf"
        ? "pdf"
        : ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)
          ? "image"
          : ext === "md" || ext === "markdown"
            ? "markdown"
            : ext === "txt"
              ? "plainText"
              : "unsupported";
    setPreviewItem({
      entry: {
        id: cloudPath,
        name,
        path: cloudPath,
        kind: "file",
        size: null,
        mimeType: null,
        etag: null,
        modifiedAt: null,
      },
      previewKind,
      editable: previewKind === "markdown",
    });
  }

  const primaryCurrency = summaries[0]?.currency ?? entries[0]?.currency ?? null;

  const categoryTotals = useMemo(() => {
    const map = new Map<string, { cents: number; count: number; currency: string }>();
    for (const e of entries) {
      if (e.kind === "budget") continue;
      if (primaryCurrency && e.currency !== primaryCurrency) continue;
      const cur = map.get(e.category) ?? {
        cents: 0,
        count: 0,
        currency: e.currency,
      };
      cur.cents += e.amountCents ?? 0;
      cur.count += 1;
      map.set(e.category, cur);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.cents - a.cents);
  }, [entries, primaryCurrency]);

  const totalSpendCents = useMemo(
    () => categoryTotals.reduce((acc, c) => acc + c.cents, 0),
    [categoryTotals],
  );

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = entries.filter((e) => {
      if (kindFilter !== "all" && e.kind !== kindFilter) return false;
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (categoryFilter !== "all" && e.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        e.vendor.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        (e.cloudFilePath?.toLowerCase().includes(q) ?? false)
      );
    });
    return [...matched].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case "vendor":
          cmp = a.vendor.localeCompare(b.vendor);
          break;
        case "category":
          cmp = a.category.localeCompare(b.category);
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "amount":
          cmp = (a.amountCents ?? 0) - (b.amountCents ?? 0);
          break;
        default:
          cmp = a.entryDate.localeCompare(b.entryDate);
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [entries, kindFilter, statusFilter, categoryFilter, search, sortBy, sortAsc]);
  filteredEntriesRef.current = filteredEntries;

  function toggleSort(
    field: "date" | "vendor" | "category" | "status" | "amount",
  ) {
    if (sortBy === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortBy(field);
      setSortAsc(field === "vendor" || field === "category" || field === "status");
    }
  }

  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedEntryId) ?? null,
    [entries, selectedEntryId],
  );

  const primarySummary = summaries[0] ?? null;
  const remainingCents = primarySummary
    ? (primarySummary.totalBudgetsCents ?? 0) -
      ((primarySummary.totalInvoicesCents ?? 0) +
        (primarySummary.totalReceiptsCents ?? 0))
    : 0;

  const sidebarNode = (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2.5">
        {/* Ledger Views */}
        <div>
          <h2 className="mb-1 px-2 text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
            Ledger
          </h2>
          <div className="space-y-0.5">
            {(
              [
                { id: "all", label: "All Entries", icon: Layers, count: entries.length },
                {
                  id: "invoice",
                  label: "Invoices",
                  icon: FileText,
                  count: entries.filter((e) => e.kind === "invoice").length,
                },
                {
                  id: "receipt",
                  label: "Receipts",
                  icon: Receipt,
                  count: entries.filter((e) => e.kind === "receipt").length,
                },
                {
                  id: "budget",
                  label: "Budgets",
                  icon: Wallet,
                  count: entries.filter((e) => e.kind === "budget").length,
                },
              ] as const
            ).map(({ id, label, icon: Icon, count }) => (
              <button
                key={id}
                type="button"
                aria-pressed={kindFilter === id}
                onClick={() => setKindFilter(id)}
                className={`relative flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  kindFilter === id
                    ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                {kindFilter === id && (
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
                  {count}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Status Filter */}
        <div>
          <h2 className="mb-1 px-2 text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
            Status
          </h2>
          <div className="space-y-0.5">
            {(["all", "pending", "approved", "paid"] as const).map((st) => {
              const count =
                st === "all"
                  ? entries.length
                  : entries.filter((e) => e.status === st).length;
              return (
                <button
                  key={st}
                  type="button"
                  aria-pressed={statusFilter === st}
                  onClick={() => setStatusFilter(st)}
                  className={`relative flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs capitalize transition-colors ${
                    statusFilter === st
                      ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {statusFilter === st && (
                    <span
                      aria-hidden="true"
                      className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r bg-[var(--accent)]"
                    />
                  )}
                  <span className="flex items-center gap-2">
                    {st !== "all" && (
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${statusDotColor(st)}`}
                      />
                    )}
                    <span>{st === "all" ? "All statuses" : st}</span>
                  </span>
                  <span className="mono-num text-[10px] text-[var(--text-muted)]">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Categories */}
        {categoryTotals.length > 0 && (
          <div>
            <div className="mb-1 flex items-center justify-between px-2">
              <h2 className="text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                Categories
              </h2>
              {categoryFilter !== "all" && (
                <button
                  type="button"
                  onClick={() => setCategoryFilter("all")}
                  className="text-[10px] text-[var(--accent-text)] hover:underline"
                >
                  Reset
                </button>
              )}
            </div>
            <div className="space-y-0.5">
              {categoryTotals.map((cat) => (
                <button
                  key={cat.name}
                  type="button"
                  aria-pressed={categoryFilter === cat.name}
                  onClick={() =>
                    setCategoryFilter((prev) =>
                      prev === cat.name ? "all" : cat.name,
                    )
                  }
                  className={`relative flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    categoryFilter === cat.name
                      ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {categoryFilter === cat.name && (
                    <span
                      aria-hidden="true"
                      className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r bg-[var(--accent)]"
                    />
                  )}
                  <span className="flex min-w-0 items-center gap-2">
                    <Tag
                      className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                      strokeWidth={1.5}
                    />
                    <span className="truncate">{cat.name}</span>
                  </span>
                  <span className="mono-num shrink-0 text-[10px] text-[var(--text-muted)]">
                    {formatCurrencyCents(cat.cents, cat.currency)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Finance Folder Control + Unified h-8 Footer */}
      <form
        onSubmit={handleSaveFolder}
        className="border-t border-[var(--border-hairline)] p-2.5"
      >
        <label
          htmlFor="finance-folder"
          className="mb-1 flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase"
        >
          <Folder className="h-3 w-3" strokeWidth={1.5} />
          Source Folder
        </label>
        <div className="flex items-center gap-1">
          <input
            id="finance-folder"
            type="text"
            value={folderInput}
            onChange={(e) => setFolderInput(e.target.value)}
            placeholder="/Finance"
            className="mono-num h-7 min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
          {folderInput.trim() !== financeFolder && (
            <button
              type="submit"
              disabled={savingFolder}
              className="h-7 rounded-md bg-[var(--accent)] px-2 text-[11px] font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-40"
            >
              {savingFolder ? "…" : "Set"}
            </button>
          )}
        </div>
      </form>
      <div className="mono-num flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <span>{filteredEntries.length} shown</span>
        <span>{entries.length} total</span>
      </div>
    </div>
  );

  const inspectorNode = quickChatInspector ? (
    quickChatInspector
  ) : previewItem ? (
    <FilePreviewPane
      item={previewItem}
      expanded={previewExpanded}
      onToggleExpand={() => setPreviewExpanded((prev) => !prev)}
      onClose={() => {
        setPreviewItem(null);
        setPreviewExpanded(false);
      }}
      onRefreshFolder={() => void loadFinanceFolderFiles()}
    />
  ) : selectedEntry ? (
    <div className="flex h-full flex-col bg-[var(--bg-sidebar)]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-3">
        <span className="text-xs font-medium text-[var(--text-primary)]">
          Entry Detail
        </span>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="xs"
            label="Edit entry"
            onClick={() => setDraft(draftFromEntry(selectedEntry))}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            size="xs"
            label="Close inspector"
            onClick={() => {
              setSelectedEntryId(null);
              onSetInspectorOpen(false);
            }}
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3.5">
        <div>
          <p className="text-[11px] text-[var(--text-muted)] capitalize">
            {selectedEntry.kind} · {selectedEntry.category}
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
            {selectedEntry.vendor}
          </p>
          <p className="mono-num mt-2 text-base font-semibold text-[var(--text-primary)]">
            {formatCurrencyCents(
              selectedEntry.amountCents,
              selectedEntry.currency,
            )}
          </p>
        </div>

        <dl className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-hairline)] text-xs">
          <div className="flex items-center justify-between py-2">
            <dt className="text-[var(--text-muted)]">Status</dt>
            <dd className="inline-flex items-center gap-1.5 capitalize text-[var(--text-primary)]">
              <span
                className={`h-1.5 w-1.5 rounded-full ${statusDotColor(selectedEntry.status)}`}
              />
              {selectedEntry.status}
            </dd>
          </div>
          <div className="flex items-center justify-between py-2">
            <dt className="text-[var(--text-muted)]">Entry Date</dt>
            <dd className="mono-num text-[var(--text-primary)]">
              {selectedEntry.entryDate}
            </dd>
          </div>
          <div className="flex items-center justify-between py-2">
            <dt className="text-[var(--text-muted)]">Currency</dt>
            <dd className="mono-num text-[var(--text-primary)]">
              {selectedEntry.currency}
            </dd>
          </div>
          {selectedEntry.description && (
            <div className="py-2">
              <dt className="text-[var(--text-muted)]">Notes</dt>
              <dd className="mt-1 text-[var(--text-secondary)]">
                {selectedEntry.description}
              </dd>
            </div>
          )}
        </dl>

        {selectedEntry.cloudFilePath && (
          <div>
            <p className="mb-1.5 text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
              Linked Document
            </p>
            <button
              type="button"
              disabled={!isNextcloudConnected}
              onClick={() =>
                handlePreviewLinkedFile(selectedEntry.cloudFilePath!)
              }
              className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-2 text-left text-xs hover:bg-[var(--bg-elevated)]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileText
                  className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                  strokeWidth={1.5}
                />
                <span className="mono-num truncate text-[11px] text-[var(--text-primary)]">
                  {selectedEntry.cloudFilePath}
                </span>
              </span>
              <Eye
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                strokeWidth={1.5}
              />
            </button>
          </div>
        )}
      </div>
      <div className="mono-num flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <span className="truncate capitalize">{selectedEntry.kind}</span>
        <span>{selectedEntry.entryDate}</span>
      </div>
    </div>
  ) : (
    <InspectorEmptyPane
      icon={Receipt}
      title="Select a ledger entry"
      description="Inspect transaction details or preview linked Nextcloud PDFs here."
      footerLeft={financeFolder}
      footerRight={`${filteredEntries.length} entries`}
    />
  );

  return (
    <WorkspaceLayout
      moduleId="finance"
      headerLeft={
        <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
          Finance
        </h1>
      }
      headerRight={
        <div className="flex items-center gap-1">
          <div className="relative mr-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
              strokeWidth={1.5}
            />
            <input
              ref={searchRef}
              type="text"
              aria-label="Search ledger"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ledger…"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (search) {
                    e.preventDefault();
                    setSearch("");
                  } else {
                    e.currentTarget.blur();
                  }
                }
              }}
              className="h-7 w-44 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] pr-6 pl-7 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
            {!search && singleKeyEnabled && (
              <Kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2">
                /
              </Kbd>
            )}
          </div>

          <div
            role="toolbar"
            aria-label="Finance actions"
            onKeyDown={handleToolbarKeyDown}
            className="flex items-center gap-1"
          >
          <IconButton
            label={showChart ? "Hide breakdown chart" : "Show breakdown chart"}
            active={showChart}
            onClick={() => setShowChart((s) => !s)}
          >
            <BarChart3 className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>

          <IconButton
            label="Export CSV"
            disabled={!isNextcloudConnected || entries.length === 0}
            onClick={() => void handleExportCsv()}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>

          <IconButton
            label="Refresh ledger"
            onClick={() => {
              void loadLedger();
              void loadFinanceFolderFiles();
            }}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              strokeWidth={1.5}
            />
          </IconButton>

          <IconButton
            label="Add finance entry"
            tone="accent"
            disabled={!isNextcloudConnected}
            onClick={() => {
              setError(null);
              setDraft(emptyDraft());
            }}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
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
      inspectorExpanded={Boolean(previewItem && previewExpanded && !quickChatInspector)}
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

        {/* Compact Horizontal Summary Metrics Strip (single tight grid band, zero ragged wrap dividers) */}
        {primarySummary && (
          <div className="grid shrink-0 grid-cols-2 divide-y divide-[var(--border-hairline)] border-b border-[var(--border-hairline)] bg-[var(--bg-sidebar)] sm:grid-cols-5 sm:divide-x sm:divide-y-0">
            <div className="px-3 py-1.5">
              <p className="text-[11px] font-medium text-[var(--text-muted)]">
                Invoices
              </p>
              <p className="mono-num text-[13px] font-medium text-[var(--text-primary)]">
                {formatCurrencyCents(
                  primarySummary.totalInvoicesCents,
                  primarySummary.currency,
                )}
              </p>
            </div>
            <div className="border-l border-[var(--border-hairline)] px-3 py-1.5 sm:border-l-0">
              <p className="text-[11px] font-medium text-[var(--text-muted)]">
                Receipts
              </p>
              <p className="mono-num text-[13px] font-medium text-[var(--text-primary)]">
                {formatCurrencyCents(
                  primarySummary.totalReceiptsCents,
                  primarySummary.currency,
                )}
              </p>
            </div>
            <div className="px-3 py-1.5">
              <p className="text-[11px] font-medium text-[var(--text-muted)]">
                Budgets
              </p>
              <p className="mono-num text-[13px] font-medium text-[var(--text-primary)]">
                {formatCurrencyCents(
                  primarySummary.totalBudgetsCents,
                  primarySummary.currency,
                )}
              </p>
            </div>
            <div className="border-l border-[var(--border-hairline)] px-3 py-1.5 sm:border-l-0">
              <p className="text-[11px] font-medium text-[var(--text-muted)]">
                Remaining
              </p>
              <p
                className={`mono-num text-[13px] font-medium ${
                  remainingCents < 0
                    ? "text-[var(--status-danger-text)]"
                    : "text-[var(--text-primary)]"
                }`}
              >
                {remainingCents >= 0 ? "+" : ""}
                {formatCurrencyCents(remainingCents, primarySummary.currency)}
              </p>
            </div>
            <div className="col-span-2 px-3 py-1.5 sm:col-span-1">
              <p className="text-[11px] font-medium text-[var(--text-muted)]">
                Pending
              </p>
              <p className="mono-num flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
                {primarySummary.pendingCount > 0 && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" />
                )}
                <span>
                  {primarySummary.pendingCount}{" "}
                  <span className="text-[11px] font-normal text-[var(--text-muted)]">
                    / {primarySummary.entryCount}
                  </span>
                </span>
              </p>
            </div>
          </div>
        )}

        {/* Flat-Styled Category Spend Chart (tokenized for dark & light themes, 1:1 bar & legend buckets) */}
        {showChart &&
          categoryTotals.length > 0 &&
          totalSpendCents > 0 &&
          (() => {
            const chartBuckets =
              categoryTotals.length > 5
                ? [
                    ...categoryTotals.slice(0, 4),
                    {
                      name: "Other",
                      cents: categoryTotals
                        .slice(4)
                        .reduce((acc, c) => acc + c.cents, 0),
                      currency: categoryTotals[0].currency,
                    },
                  ]
                : categoryTotals;
            const bucketSum =
              chartBuckets.reduce((acc, c) => acc + c.cents, 0) || 1;
            const exact = chartBuckets.map((c) => (c.cents / bucketSum) * 100);
            const floors = exact.map((v) => Math.floor(v));
            const rem = 100 - floors.reduce((a, b) => a + b, 0);
            const order = exact
              .map((v, i) => ({ i, frac: v - floors[i] }))
              .sort((a, b) => b.frac - a.frac);
            for (let k = 0; k < rem && k < order.length; k += 1) {
              floors[order[k].i] += 1;
            }
            const chartTokens = [
              "var(--chart-1)",
              "var(--chart-2)",
              "var(--chart-3)",
              "var(--chart-4)",
              "var(--chart-5)",
            ];
            return (
              <div className="shrink-0 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-2">
                <div className="mb-2 flex items-center justify-between text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                  <span>Spend by Category</span>
                  <span className="mono-num">
                    {formatCurrencyCents(
                      totalSpendCents,
                      categoryTotals[0].currency,
                    )}
                  </span>
                </div>
                {/* Flat segmented proportion bar (1:1 synced with largest-remainder legend %) */}
                <svg
                  role="img"
                  aria-label="Category spend breakdown"
                  className="h-2 w-full overflow-hidden rounded-sm bg-[var(--bg-elevated)]"
                  viewBox="0 0 1000 8"
                  preserveAspectRatio="none"
                >
                  {chartBuckets.reduce<{
                    offset: number;
                    nodes: React.ReactNode[];
                  }>(
                    (acc, cat, idx) => {
                      const pct = floors[idx];
                      if (pct <= 0) return acc;
                      const isLast = idx === chartBuckets.length - 1;
                      const width = isLast
                        ? Math.max(0, 1000 - acc.offset)
                        : pct * 10;
                      const fill = chartTokens[idx % chartTokens.length];
                      acc.nodes.push(
                        <rect
                          key={cat.name}
                          x={acc.offset}
                          y={0}
                          width={isLast ? width : Math.max(0, width - 2)}
                          height={8}
                          fill={fill}
                        />,
                      );
                      acc.offset += width;
                      return acc;
                    },
                    { offset: 0, nodes: [] },
                  ).nodes}
                </svg>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  {chartBuckets.map((cat, idx) => {
                    const pct = floors[idx];
                    const isOther = cat.name === "Other";
                    const isActiveFilter = categoryFilter === cat.name;
                    const isDimmed =
                      categoryFilter !== "all" && !isActiveFilter;
                    if (isOther) {
                      return (
                        <span
                          key={cat.name}
                          className="inline-flex items-center gap-1.5 px-1 py-0.5 text-[var(--text-secondary)]"
                        >
                          <span
                            className="h-2 w-2 rounded-[2px]"
                            style={{
                              backgroundColor:
                                chartTokens[idx % chartTokens.length],
                            }}
                          />
                          <span>{cat.name}</span>
                          <span className="mono-num text-[var(--text-muted)]">
                            {pct}%
                          </span>
                        </span>
                      );
                    }
                    return (
                      <button
                        key={cat.name}
                        type="button"
                        aria-pressed={isActiveFilter}
                        onClick={() =>
                          setCategoryFilter((prev) =>
                            prev === cat.name ? "all" : cat.name,
                          )
                        }
                        className={`inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors ${
                          isActiveFilter
                            ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                            : isDimmed
                              ? "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <span
                          className="h-2 w-2 rounded-[2px]"
                          style={{
                            backgroundColor:
                              chartTokens[idx % chartTokens.length],
                          }}
                        />
                        <span>{cat.name}</span>
                        <span className="mono-num text-[var(--text-muted)]">
                          {pct}%
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

        {/* High-Clarity Ledger Table */}
        <div className="min-h-0 flex-1 overflow-auto">
          {!isNextcloudConnected ? (
            <div className="flex h-64 flex-col items-center justify-center p-8 text-center">
              <Landmark
                className="mb-2.5 h-7 w-7 text-[var(--text-muted)]"
                strokeWidth={1.5}
              />
              <p className="text-xs font-medium text-[var(--text-primary)]">
                Sign in to Nextcloud to open Finance
              </p>
              <p className="mt-1 max-w-sm text-[11px] text-[var(--text-muted)]">
                Invoices, receipts, and budgets link directly to documents in{" "}
                <span className="mono-num">{financeFolder}</span>.
              </p>
            </div>
          ) : loading ? (
            <div
              role="status"
              aria-live="polite"
              className="flex h-48 items-center justify-center gap-2 text-xs text-[var(--text-muted)]"
            >
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
              Loading ledger…
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center p-8 text-center">
              <Receipt
                className="mb-2.5 h-7 w-7 text-[var(--text-muted)] opacity-50"
                strokeWidth={1.5}
              />
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                {entries.length === 0
                  ? "No ledger entries yet"
                  : "No entries match your filters"}
              </p>
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-[var(--border-hairline)] bg-[var(--bg-sidebar)] text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                <tr>
                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "date"
                        ? sortAsc
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="h-8 w-24 px-3 font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort("date")}
                      className="inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
                    >
                      Date
                      {sortBy === "date" &&
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
                      sortBy === "vendor"
                        ? sortAsc
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="h-8 px-3 font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort("vendor")}
                      className="inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
                    >
                      Vendor &amp; Details
                      {sortBy === "vendor" &&
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
                      sortBy === "category"
                        ? sortAsc
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="hidden h-8 w-28 px-2.5 font-medium lg:table-cell"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort("category")}
                      className="inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
                    >
                      Category
                      {sortBy === "category" &&
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
                      sortBy === "status"
                        ? sortAsc
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="h-8 w-20 px-2.5 font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort("status")}
                      className="inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
                    >
                      Status
                      {sortBy === "status" &&
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
                      sortBy === "amount"
                        ? sortAsc
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="h-8 w-28 px-3 text-right font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort("amount")}
                      className="ml-auto inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
                    >
                      Amount
                      {sortBy === "amount" &&
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
                  const hasSelectedInFiltered = Boolean(
                    selectedEntryId &&
                      filteredEntries.some((e) => e.id === selectedEntryId),
                  );
                  return filteredEntries.map((entry, idx) => {
                  const isSelected = selectedEntryId === entry.id;
                  const isBudget = entry.kind === "budget";
                  const isTabStop =
                    isSelected || (!hasSelectedInFiltered && idx === 0);
                  return (
                    <tr
                      key={entry.id}
                      data-entry-id={entry.id}
                      tabIndex={isTabStop ? 0 : -1}
                      onClick={() => {
                        setPreviewItem(null);
                        setSelectedEntryId(entry.id);
                        onSetInspectorOpen(true);
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setPreviewItem(null);
                          setSelectedEntryId(entry.id);
                          onSetInspectorOpen(true);
                        }
                      }}
                      aria-current={isSelected ? "true" : undefined}
                      className={`group cursor-pointer transition-colors focus-visible:bg-[var(--bg-hover)]/80 focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)] ${
                        isSelected
                          ? "bg-[var(--accent-soft)]"
                          : "hover:bg-[var(--bg-hover)]/60"
                      }`}
                    >
                      <td className="mono-num relative px-3 py-1.5 whitespace-nowrap text-[11px] text-[var(--text-muted)]">
                        {isSelected && (
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 left-0 w-0.5 bg-[var(--accent)]"
                          />
                        )}
                        {entry.entryDate}
                      </td>
                      <td className="relative max-w-0 px-3 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                            {entry.vendor}
                          </span>
                          {entry.cloudFilePath && (
                            <IconButton
                              size="xs"
                              tabIndex={isTabStop ? 0 : -1}
                              label={`Preview ${entry.cloudFilePath}`}
                              className="!h-4 !w-4"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePreviewLinkedFile(entry.cloudFilePath!);
                              }}
                            >
                              <FileText
                                className="h-3 w-3 text-[var(--text-muted)] group-hover:text-[var(--text-primary)]"
                                strokeWidth={1.5}
                              />
                            </IconButton>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span className="mono-num shrink-0 text-[10px] text-[var(--text-muted)] uppercase">
                            {entry.kind}
                          </span>
                          {entry.description && (
                            <>
                              <span className="text-[10px] text-[var(--text-muted)]">
                                ·
                              </span>
                              <p className="truncate text-[11px] text-[var(--text-muted)]">
                                {entry.description}
                              </p>
                            </>
                          )}
                        </div>
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className={`absolute inset-y-0 right-2 flex items-center gap-0.5 rounded-md bg-[var(--bg-elevated)] px-1 transition-opacity ${
                            confirmDeleteId === entry.id
                              ? "pointer-events-auto opacity-100"
                              : "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                          }`}
                        >
                          {confirmDeleteId !== entry.id && (
                            <IconButton
                              size="xs"
                              tabIndex={isTabStop ? 0 : -1}
                              label="Edit entry"
                              onClick={() => setDraft(draftFromEntry(entry))}
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </IconButton>
                          )}
                          <InlineDeleteConfirm
                            armed={confirmDeleteId === entry.id}
                            tabIndex={isTabStop ? 0 : -1}
                            onArm={() => setConfirmDeleteId(entry.id)}
                            onCancel={() => setConfirmDeleteId(null)}
                            onConfirm={() => void handleDelete(entry.id)}
                            label="Delete entry"
                          />
                        </div>
                      </td>
                      <td className="hidden px-2.5 py-1.5 lg:table-cell">
                        <span className="inline-flex max-w-full truncate rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">
                          {entry.category}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] capitalize">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${statusDotColor(entry.status)}`}
                          />
                          {entry.status}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        <span
                          className={`mono-num text-[13px] font-medium ${
                            isBudget
                              ? "text-[var(--status-positive-text)]"
                              : "text-[var(--text-primary)]"
                          }`}
                        >
                          {isBudget ? "+" : "−"}
                          {formatCurrencyCents(entry.amountCents, entry.currency)}
                        </span>
                      </td>
                    </tr>
                  );
                  });
                })()}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Add / Edit Entry Modal (shared Modal primitive with scrim close, Escape, focus trap & restore) */}
      {draft && (
        <Modal
          ariaLabel={draft.id ? "Edit Finance Entry" : "Add Finance Entry"}
          closeOnScrim={!isDraftDirty}
          onClose={requestCloseDraft}
        >
          <form
            onSubmit={handleSaveEntry}
            className="w-full max-w-lg overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)]"
          >
            <div className="flex h-11 items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-4">
              <h2 className="text-xs font-medium text-[var(--text-primary)]">
                {draft.id ? "Edit Finance Entry" : "Add Finance Entry"}
              </h2>
              {confirmDiscardDraft ? (
                <InlineDeleteConfirm
                  armed
                  onArm={() => setConfirmDiscardDraft(true)}
                  onCancel={() => setConfirmDiscardDraft(false)}
                  onConfirm={() => {
                    setConfirmDiscardDraft(false);
                    setDraft(null);
                  }}
                  label="Discard unsaved finance entry changes"
                  confirmLabel="Discard"
                />
              ) : (
                <IconButton
                  size="xs"
                  label="Close"
                  onClick={requestCloseDraft}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                </IconButton>
              )}
            </div>

            <div className="space-y-3.5 p-4 text-xs">
              {error && (
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <label
                    htmlFor="finance-entry-type"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Type
                  </label>
                  <Select
                    id="finance-entry-type"
                    ariaLabel="Entry type"
                    value={draft.kind}
                    onChange={(val) =>
                      setDraft((prev) =>
                        prev ? { ...prev, kind: val as FinanceEntryKind } : prev,
                      )
                    }
                    options={[
                      { value: "invoice", label: "Invoice" },
                      { value: "receipt", label: "Receipt" },
                      { value: "budget", label: "Budget" },
                    ]}
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="finance-entry-status"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Status
                  </label>
                  <Select
                    id="finance-entry-status"
                    ariaLabel="Entry status"
                    value={draft.status}
                    onChange={(val) =>
                      setDraft((prev) =>
                        prev
                          ? { ...prev, status: val as FinanceEntryStatus }
                          : prev,
                      )
                    }
                    options={[
                      { value: "pending", label: "Pending" },
                      { value: "approved", label: "Approved" },
                      { value: "paid", label: "Paid" },
                    ]}
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="finance-entry-date"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Date
                  </label>
                  <DateInput
                    id="finance-entry-date"
                    required
                    ariaLabel="Entry date"
                    value={draft.entryDate}
                    onChange={(iso) =>
                      setDraft((prev) =>
                        prev ? { ...prev, entryDate: iso } : prev,
                      )
                    }
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label
                    htmlFor="finance-entry-vendor"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Vendor / Title *
                  </label>
                  <input
                    id="finance-entry-vendor"
                    type="text"
                    required
                    value={draft.vendor}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, vendor: e.target.value } : prev,
                      )
                    }
                    placeholder="Toray Composite Materials"
                    className="h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="finance-entry-category"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Category
                  </label>
                  <Combobox
                    id="finance-entry-category"
                    ariaLabel="Category"
                    value={draft.category}
                    onChange={(next) =>
                      setDraft((prev) =>
                        prev ? { ...prev, category: next } : prev,
                      )
                    }
                    suggestions={[
                      ...categoryTotals.map((c) => c.name),
                      "Operations",
                      "Composites",
                      "Machining",
                      "Electronics",
                      "3D Printing",
                      "Infrastructure",
                    ]}
                    placeholder="Composites, Machining, Software…"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1 sm:col-span-2">
                  <label
                    htmlFor="finance-entry-amount"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Amount *
                  </label>
                  <input
                    id="finance-entry-amount"
                    type="text"
                    required
                    value={draft.amountText}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, amountText: e.target.value } : prev,
                      )
                    }
                    placeholder="450.00"
                    className="mono-num h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="finance-entry-currency"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Currency
                  </label>
                  <input
                    id="finance-entry-currency"
                    type="text"
                    required
                    maxLength={3}
                    value={draft.currency}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev
                          ? { ...prev, currency: e.target.value.toUpperCase() }
                          : prev,
                      )
                    }
                    placeholder="EUR"
                    className="mono-num h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] uppercase focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="finance-entry-notes"
                  className="block text-[11px] text-[var(--text-secondary)]"
                >
                  Description / Notes
                </label>
                <input
                  id="finance-entry-notes"
                  type="text"
                  value={draft.description}
                  onChange={(e) =>
                    setDraft((prev) =>
                      prev ? { ...prev, description: e.target.value } : prev,
                    )
                  }
                  placeholder="Optional invoice number or project reference"
                  className="h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="finance-entry-doc"
                  className="block text-[11px] text-[var(--text-secondary)]"
                >
                  Linked Nextcloud Document
                </label>
                {folderFiles.length > 0 && (
                  <Select
                    id="finance-entry-doc"
                    ariaLabel="Linked Nextcloud document"
                    placeholder={`Choose from ${financeFolder}…`}
                    value={
                      folderFiles.some(
                        (f) => f.entry.path === draft.cloudFilePath,
                      )
                        ? draft.cloudFilePath
                        : ""
                    }
                    onChange={(val) => {
                      if (val) {
                        setDraft((prev) =>
                          prev ? { ...prev, cloudFilePath: val } : prev,
                        );
                      }
                    }}
                    options={folderFiles.map((file) => ({
                      value: file.entry.path,
                      label: file.entry.name,
                    }))}
                  />
                )}
                <input
                  id={
                    folderFiles.length === 0
                      ? "finance-entry-doc"
                      : "finance-entry-doc-path"
                  }
                  type="text"
                  aria-label="Linked Nextcloud document path"
                  value={draft.cloudFilePath}
                  onChange={(e) =>
                    setDraft((prev) =>
                      prev ? { ...prev, cloudFilePath: e.target.value } : prev,
                    )
                  }
                  placeholder={`${financeFolder}/invoice-2026-01.pdf`}
                  className="mono-num h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[var(--border-hairline)] px-4 py-3">
              <button
                type="button"
                onClick={requestCloseDraft}
                className="h-8 rounded-md border border-[var(--border-strong)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingEntry}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {savingEntry && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                )}
                Save Entry
              </button>
            </div>
          </form>
        </Modal>
      )}
    </WorkspaceLayout>
  );
}
