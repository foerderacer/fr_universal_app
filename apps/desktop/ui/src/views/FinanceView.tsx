import {
  CheckCircle2,
  Download,
  Eye,
  FileText,
  Folder,
  Loader2,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { listFiles } from "../lib/filesClient";
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

function statusBadgeClass(status: FinanceEntryStatus): string {
  switch (status) {
    case "paid":
      return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "approved":
      return "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300";
    default:
      return "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300";
  }
}

export function FinanceView({
  financeFolder,
  isNextcloudConnected,
  onOverviewUpdated,
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

  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [savingEntry, setSavingEntry] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<FileItemView_Serialize | null>(
    null,
  );
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<UserFacingError | null>(null);

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
      // The /Finance folder may not exist yet on Nextcloud — non-fatal.
      setFolderFiles([]);
    }
  }, [financeFolder, isNextcloudConnected]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  useEffect(() => {
    void loadFinanceFolderFiles();
  }, [loadFinanceFolderFiles]);

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
      flashNotice("Finance entry saved.");
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
      flashNotice("Exported CSV spreadsheet.");
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  function handlePreviewLinkedFile(cloudPath: string) {
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

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (kindFilter !== "all" && e.kind !== kindFilter) return false;
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (!q) return true;
      return (
        e.vendor.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        (e.cloudFilePath?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [entries, kindFilter, statusFilter, search]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-5">
        {error && (
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
        )}

        {notice && (
          <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
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

        {/* Nextcloud Finance Folder & Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <form
            onSubmit={handleSaveFolder}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <Folder className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
            <label htmlFor="finance-folder" className="sr-only">
              Nextcloud Finance Folder
            </label>
            <input
              id="finance-folder"
              type="text"
              value={folderInput}
              onChange={(e) => setFolderInput(e.target.value)}
              placeholder="/Finance"
              className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
            <button
              type="submit"
              disabled={savingFolder || folderInput.trim() === financeFolder}
              className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {savingFolder ? "Saving..." : "Set Folder"}
            </button>
          </form>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void loadLedger();
                void loadFinanceFolderFiles();
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>

            <button
              type="button"
              onClick={() => void handleExportCsv()}
              disabled={!isNextcloudConnected || entries.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>

            <button
              type="button"
              disabled={!isNextcloudConnected}
              onClick={() => {
                setError(null);
                setDraft(emptyDraft());
              }}
              title={
                isNextcloudConnected
                  ? "Add a new invoice, receipt, or budget entry"
                  : "Sign in to Nextcloud first so entries are linked to your account"
              }
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-blue-700 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Entry
            </button>
          </div>
        </div>

        {/* Summary KPI Cards */}
        {summaries.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {summaries.map((sum) => (
              <div
                key={sum.currency}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase dark:text-slate-400">
                    <Wallet className="h-3.5 w-3.5 text-blue-500" />
                    {sum.currency} Ledger
                  </span>
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                    {sum.pendingCount} pending
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-[11px] text-slate-400">Invoices</p>
                    <p className="font-semibold text-slate-900 dark:text-slate-100">
                      {formatCurrencyCents(
                        sum.totalInvoicesCents,
                        sum.currency,
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400">Receipts</p>
                    <p className="font-semibold text-slate-900 dark:text-slate-100">
                      {formatCurrencyCents(
                        sum.totalReceiptsCents,
                        sum.currency,
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400">Budgets</p>
                    <p className="font-semibold text-slate-900 dark:text-slate-100">
                      {formatCurrencyCents(sum.totalBudgetsCents, sum.currency)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search vendor, category, description..."
              className="w-full rounded-xl border border-slate-300 bg-white py-2 pr-3 pl-9 text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </div>

          <select
            value={kindFilter}
            onChange={(e) =>
              setKindFilter(e.target.value as FinanceEntryKind | "all")
            }
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="all">All types</option>
            <option value="invoice">Invoices</option>
            <option value="receipt">Receipts</option>
            <option value="budget">Budgets</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as FinanceEntryStatus | "all")
            }
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="paid">Paid</option>
          </select>
        </div>

        {/* Ledger Table */}
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
          {!isNextcloudConnected ? (
            <div className="p-10 text-center">
              <Wallet className="mx-auto h-9 w-9 text-slate-400" />
              <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                Sign in to Nextcloud to open your Finance ledger
              </h3>
              <p className="mx-auto mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">
                Your invoices, receipts, and budgets are scoped per Nextcloud
                account so they stay organized and link cleanly to files in{" "}
                <code>{financeFolder}</code>.
              </p>
            </div>
          ) : loading ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Loading Finance ledger...
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="p-10 text-center">
              <Receipt className="mx-auto h-9 w-9 text-slate-400" />
              <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                {entries.length === 0
                  ? "No Finance entries yet"
                  : "No entries match your filters"}
              </h3>
              <p className="mx-auto mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">
                Record invoices, receipts, and budgets, link them directly to
                Nextcloud PDFs in <code>{financeFolder}</code>, and export clean
                CSV spreadsheets anytime.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold tracking-wider text-slate-500 uppercase dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Vendor &amp; Details</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredEntries.map((entry) => (
                    <tr
                      key={entry.id}
                      className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                    >
                      <td className="px-4 py-3 whitespace-nowrap font-mono text-[11px] text-slate-500">
                        {entry.entryDate}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {entry.vendor}
                          </span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 capitalize dark:bg-slate-800 dark:text-slate-400">
                            {entry.kind}
                          </span>
                        </div>
                        {entry.description && (
                          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                            {entry.description}
                          </p>
                        )}
                        {entry.cloudFilePath && (
                          <button
                            type="button"
                            disabled={!isNextcloudConnected}
                            onClick={() =>
                              handlePreviewLinkedFile(entry.cloudFilePath!)
                            }
                            className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                          >
                            <FileText className="h-3 w-3" />
                            {entry.cloudFilePath}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {entry.category}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold whitespace-nowrap text-slate-900 dark:text-slate-100">
                        {formatCurrencyCents(entry.amountCents, entry.currency)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${statusBadgeClass(entry.status)}`}
                        >
                          {entry.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {entry.cloudFilePath && isNextcloudConnected && (
                            <button
                              type="button"
                              onClick={() =>
                                handlePreviewLinkedFile(entry.cloudFilePath!)
                              }
                              title="Preview linked invoice"
                              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-blue-600 dark:hover:bg-slate-800"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setDraft(draftFromEntry(entry))}
                            title="Edit entry"
                            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {confirmDeleteId === entry.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void handleDelete(entry.id)}
                                className="rounded-lg bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-700"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-700"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(entry.id)}
                              title="Delete entry"
                              className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Side-by-side Linked Document Preview Pane */}
      {previewItem && (
        <div
          className={
            previewExpanded
              ? "fixed inset-4 z-40 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
              : "h-[76vh] w-full shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs lg:w-[440px] dark:border-slate-800 dark:bg-slate-900"
          }
        >
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
        </div>
      )}

      {/* Add / Edit Entry Modal */}
      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-xs">
          <form
            onSubmit={handleSaveEntry}
            className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {draft.id ? "Edit Finance Entry" : "Add Finance Entry"}
              </h2>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              {error && (
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Type
                  </label>
                  <select
                    value={draft.kind}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev
                          ? { ...prev, kind: e.target.value as FinanceEntryKind }
                          : prev,
                      )
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="invoice">Invoice</option>
                    <option value="receipt">Receipt</option>
                    <option value="budget">Budget</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Status
                  </label>
                  <select
                    value={draft.status}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev
                          ? {
                              ...prev,
                              status: e.target.value as FinanceEntryStatus,
                            }
                          : prev,
                      )
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="paid">Paid</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Date
                  </label>
                  <input
                    type="date"
                    required
                    value={draft.entryDate}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, entryDate: e.target.value } : prev,
                      )
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Vendor / Title *
                  </label>
                  <input
                    type="text"
                    required
                    value={draft.vendor}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, vendor: e.target.value } : prev,
                      )
                    }
                    placeholder="Acme Carbon Supplies"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Category
                  </label>
                  <input
                    type="text"
                    value={draft.category}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, category: e.target.value } : prev,
                      )
                    }
                    placeholder="Materials, Travel, Software..."
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1 sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Amount *
                  </label>
                  <input
                    type="text"
                    required
                    value={draft.amountText}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, amountText: e.target.value } : prev,
                      )
                    }
                    placeholder="450.00"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Currency (ISO)
                  </label>
                  <input
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
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-sm uppercase dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Description / Notes
                </label>
                <input
                  type="text"
                  value={draft.description}
                  onChange={(e) =>
                    setDraft((prev) =>
                      prev ? { ...prev, description: e.target.value } : prev,
                    )
                  }
                  placeholder="Optional invoice number or project note"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Linked Nextcloud Document (optional)
                </label>
                {folderFiles.length > 0 && (
                  <select
                    value={
                      folderFiles.some(
                        (f) => f.entry.path === draft.cloudFilePath,
                      )
                        ? draft.cloudFilePath
                        : ""
                    }
                    onChange={(e) => {
                      if (e.target.value) {
                        setDraft((prev) =>
                          prev
                            ? { ...prev, cloudFilePath: e.target.value }
                            : prev,
                        );
                      }
                    }}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="">
                      Choose a file from {financeFolder}...
                    </option>
                    {folderFiles.map((file) => (
                      <option key={file.entry.path} value={file.entry.path}>
                        {file.entry.name} ({file.entry.path})
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="text"
                  value={draft.cloudFilePath}
                  onChange={(e) =>
                    setDraft((prev) =>
                      prev ? { ...prev, cloudFilePath: e.target.value } : prev,
                    )
                  }
                  placeholder={`${financeFolder}/invoice-2026-01.pdf`}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3.5 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingEntry}
                className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {savingEntry ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Save Entry
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
