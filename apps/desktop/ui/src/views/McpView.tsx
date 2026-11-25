import {
  Check,
  CloudDownload,
  Copy,
  Cpu,
  KeyRound,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  ExternalMcpServer,
  ExternalMcpServerView,
  ExternalMcpTool_Serialize,
  McpAuditEntry_Serialize,
  McpClientConfigSnippetResponse,
  McpServerStatus_Serialize,
  McpToolCallOutput,
  PendingWriteApproval,
  UserFacingError,
  WorkspaceOverview_Serialize,
} from "../bindings/tauri";
import { ErrorBanner } from "../components/ErrorBanner";
import {
  clearMcpAuditLog,
  configureMcpServer,
  deleteExternalMcpServer,
  discoverExternalMcpTools,
  getMcpClientConfigSnippet,
  getMcpServerStatus,
  listExternalMcpServers,
  listMcpAuditLog,
  resolveMcpApproval,
  rotateMcpServerToken,
  syncTeamMcpServers,
  testExternalMcpTool,
  upsertExternalMcpServer,
} from "../lib/mcpClient";
import { toUserFacingError } from "../lib/workspaceClient";

interface McpViewProps {
  isNextcloudConnected: boolean;
  pendingApprovals: PendingWriteApproval[];
  onRefreshApprovals: () => void;
  onOverviewUpdated: (overview: WorkspaceOverview_Serialize) => void;
}

export function McpView({
  isNextcloudConnected,
  pendingApprovals,
  onRefreshApprovals,
  onOverviewUpdated,
}: McpViewProps) {
  const [tab, setTab] = useState<"server" | "client">("server");
  const [status, setStatus] = useState<McpServerStatus_Serialize | null>(null);
  const [auditLog, setAuditLog] = useState<McpAuditEntry_Serialize[]>([]);
  const [portInput, setPortInput] = useState(38420);
  const [requireApproval, setRequireApproval] = useState(true);
  const [savingServer, setSavingServer] = useState(false);
  const [snippet, setSnippet] = useState<McpClientConfigSnippetResponse | null>(
    null,
  );
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [error, setError] = useState<UserFacingError | null>(null);

  // External MCP Client state
  const [externalServers, setExternalServers] = useState<
    ExternalMcpServerView[]
  >([]);
  const [syncingTeam, setSyncingTeam] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newTransport, setNewTransport] = useState<"streamableHttp" | "stdio">(
    "streamableHttp",
  );
  const [newUrl, setNewUrl] = useState("https://");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [newToken, setNewToken] = useState("");

  const [discoveringId, setDiscoveringId] = useState<string | null>(null);
  const [discoveredByServer, setDiscoveredByServer] = useState<
    Record<string, ExternalMcpTool_Serialize[]>
  >({});
  const [testingTool, setTestingTool] = useState<{
    serverId: string;
    tool: ExternalMcpTool_Serialize;
  } | null>(null);
  const [testArgsJson, setTestArgsJson] = useState("{}");
  const [runningTest, setRunningTest] = useState(false);
  const [testOutput, setTestOutput] = useState<McpToolCallOutput | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [st, log, ext] = await Promise.all([
        getMcpServerStatus(),
        listMcpAuditLog(),
        listExternalMcpServers(),
      ]);
      setStatus(st);
      setPortInput(st.config.port);
      setRequireApproval(st.config.requireWriteApproval);
      setAuditLog(log);
      setExternalServers(ext);
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!status?.running) return;
    const timer = window.setInterval(() => {
      void listMcpAuditLog()
        .then(setAuditLog)
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [status?.running]);

  async function handleSaveServerConfig(nextEnabled: boolean) {
    setSavingServer(true);
    setError(null);
    try {
      const res = await configureMcpServer({
        enabled: nextEnabled,
        port: portInput,
        requireWriteApproval: requireApproval,
      });
      setStatus(res.status);
      onOverviewUpdated(res.overview);
      if (!nextEnabled) {
        setSnippet(null);
      }
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setSavingServer(false);
    }
  }

  async function handleCopyClientConfig() {
    setError(null);
    try {
      const data = await getMcpClientConfigSnippet();
      setSnippet(data);
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(data.jsonSnippet);
        setCopiedNotice(true);
        setTimeout(() => setCopiedNotice(false), 2500);
      }
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function handleRotateToken() {
    setError(null);
    try {
      const data = await rotateMcpServerToken();
      setSnippet(data);
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function handleResolveApproval(id: string, allow: boolean) {
    await resolveMcpApproval(id, allow);
    onRefreshApprovals();
    const log = await listMcpAuditLog();
    setAuditLog(log);
  }

  async function handleAddExternalServer(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const id =
      newId.trim() ||
      newName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const server: ExternalMcpServer = {
      id,
      name: newName.trim(),
      enabled: true,
      transport:
        newTransport === "streamableHttp"
          ? { transport: "streamableHttp", url: newUrl.trim() }
          : {
              transport: "stdio",
              command: newCommand.trim(),
              args: newArgs
                .split(/\s+/)
                .map((s) => s.trim())
                .filter(Boolean),
            },
    };
    try {
      const updated = await upsertExternalMcpServer(
        server,
        newToken.trim() ? newToken.trim() : null,
      );
      setExternalServers(updated);
      setShowAddForm(false);
      setNewId("");
      setNewName("");
      setNewUrl("https://");
      setNewCommand("");
      setNewArgs("");
      setNewToken("");
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function handleToggleExternalEnabled(srv: ExternalMcpServerView) {
    setError(null);
    try {
      const updated = await upsertExternalMcpServer(
        {
          id: srv.id,
          name: srv.name,
          enabled: !srv.enabled,
          transport: srv.transport,
        },
        null,
      );
      setExternalServers(updated);
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function handleDeleteExternal(id: string) {
    setError(null);
    try {
      const updated = await deleteExternalMcpServer(id);
      setExternalServers(updated);
      if (testingTool?.serverId === id) {
        setTestingTool(null);
        setTestOutput(null);
      }
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function handleSyncTeam() {
    setSyncingTeam(true);
    setError(null);
    try {
      const updated = await syncTeamMcpServers();
      setExternalServers(updated);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setSyncingTeam(false);
    }
  }

  async function handleDiscoverTools(serverId: string) {
    setDiscoveringId(serverId);
    setError(null);
    try {
      const tools = await discoverExternalMcpTools(serverId);
      setDiscoveredByServer((prev) => ({ ...prev, [serverId]: tools }));
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setDiscoveringId(null);
    }
  }

  async function handleRunToolTest(e: React.FormEvent) {
    e.preventDefault();
    if (!testingTool) return;
    setRunningTest(true);
    setError(null);
    setTestOutput(null);
    try {
      const out = await testExternalMcpTool(
        testingTool.serverId,
        testingTool.tool.name,
        testArgsJson,
      );
      setTestOutput(out);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setRunningTest(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {/* Tab Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900">
          <button
            type="button"
            onClick={() => setTab("server")}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-colors ${
              tab === "server"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            <Cpu className="h-3.5 w-3.5" />
            Built-in MCP Server
            {pendingApprovals.length > 0 && (
              <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {pendingApprovals.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setTab("client")}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-colors ${
              tab === "client"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            <Server className="h-3.5 w-3.5" />
            External MCP Servers ({externalServers.length})
          </button>
        </div>

        <button
          type="button"
          onClick={() => void loadAll()}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {tab === "server" ? (
        <div className="space-y-6">
          {/* Pending Write Approvals */}
          {pendingApprovals.length > 0 && (
            <section className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-5 shadow-xs dark:border-amber-700 dark:bg-amber-950/40">
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
                <ShieldAlert className="h-4 w-4" />
                Waiting for your approval ({pendingApprovals.length})
              </div>
              <div className="mt-3 space-y-2.5">
                {pendingApprovals.map((req) => (
                  <div
                    key={req.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-white p-3.5 dark:border-amber-900/60 dark:bg-slate-900"
                  >
                    <div>
                      <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                        AI wants to run <code>{req.toolName}</code>
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                        {req.summary}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleResolveApproval(req.id, true)}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Allow
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolveApproval(req.id, false)}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300"
                      >
                        <X className="h-3.5 w-3.5" />
                        Deny
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Server Control Card */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                    Local MCP Server
                  </h2>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                      status?.running
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        status?.running ? "bg-emerald-500" : "bg-slate-400"
                      }`}
                    />
                    {status?.running ? "Running" : "Stopped"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Lets local AI assistants (Claude Desktop, Cursor, T3 Code) read and organize your
                  Nextcloud files. Locked strictly to <code>127.0.0.1</code> with an OS Keychain
                  Bearer token.
                </p>
                {status?.endpointUrl && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Endpoint: <code>{status.endpointUrl}</code>
                  </p>
                )}
              </div>

              <button
                type="button"
                disabled={savingServer}
                onClick={() => void handleSaveServerConfig(!status?.running)}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold text-white shadow-xs disabled:opacity-50 ${
                  status?.running
                    ? "bg-rose-600 hover:bg-rose-700"
                    : "bg-blue-600 hover:bg-blue-700"
                }`}
              >
                {savingServer && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {status?.running ? "Stop Server" : "Start MCP Server"}
              </button>
            </div>

            <div className="mt-5 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-2 dark:border-slate-800">
              <div className="space-y-1.5">
                <label
                  htmlFor="mcp-port"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Loopback port (127.0.0.1)
                </label>
                <div className="flex gap-2">
                  <input
                    id="mcp-port"
                    type="number"
                    min={1024}
                    max={65535}
                    value={portInput}
                    onChange={(e) => setPortInput(Number(e.target.value) || 38420)}
                    className="w-32 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    disabled={savingServer}
                    onClick={() =>
                      void handleSaveServerConfig(Boolean(status?.running))
                    }
                    className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Apply
                  </button>
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <input
                  type="checkbox"
                  checked={requireApproval}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setRequireApproval(next);
                    void configureMcpServer({
                      enabled: Boolean(status?.running),
                      port: portInput,
                      requireWriteApproval: next,
                    })
                      .then((res) => {
                        setStatus(res.status);
                        onOverviewUpdated(res.overview);
                      })
                      .catch((err) => setError(toUserFacingError(err)));
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span className="text-xs">
                  <span className="block font-semibold text-slate-900 dark:text-slate-100">
                    Ask before AI modifies files
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    Recommended: prompts you to Allow or Deny writes, folder creation, and renames.
                  </span>
                </span>
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleCopyClientConfig()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {copiedNotice ? (
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedNotice ? "Copied Client Config!" : "Copy Client Config"}
              </button>
              <button
                type="button"
                onClick={() => void handleRotateToken()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <KeyRound className="h-3.5 w-3.5" />
                Rotate Bearer Token
              </button>
            </div>

            {snippet && (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-950 p-4 text-xs text-slate-100 dark:border-slate-800">
                <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
                  <span>
                    Paste into Claude Desktop, Cursor, or T3 Code MCP settings (keep token private):
                  </span>
                  <button
                    type="button"
                    onClick={() => setSnippet(null)}
                    className="text-slate-400 hover:text-white"
                  >
                    Hide
                  </button>
                </div>
                <pre className="overflow-x-auto font-mono leading-relaxed">
                  {snippet.jsonSnippet}
                </pre>
              </div>
            )}
          </section>

          {/* Exposed Tools */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Exposed Workspace Tools ({status?.exposedTools.length ?? 0})
            </h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(status?.exposedTools ?? []).map((tool) => (
                <div
                  key={tool.name}
                  className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
                >
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      {tool.name}
                    </code>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        tool.isWrite
                          ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                          : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                      }`}
                    >
                      {tool.isWrite ? "Write" : "Read-only"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {tool.description}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Audit Log */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Recent AI Activity Log
              </h3>
              {auditLog.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    void clearMcpAuditLog().then(() => setAuditLog([]))
                  }
                  className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                >
                  Clear log
                </button>
              )}
            </div>
            {auditLog.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                No AI tool calls recorded yet. Every call made to your local MCP server appears here.
              </p>
            ) : (
              <div className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
                {auditLog.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs"
                  >
                    <div>
                      <code className="font-semibold text-slate-900 dark:text-slate-100">
                        {entry.toolName}
                      </code>
                      <span className="ml-2 text-slate-600 dark:text-slate-400">
                        {entry.summary}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span
                        className={`rounded-full px-2 py-0.5 font-semibold capitalize ${
                          entry.status === "allowed"
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                            : "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
                        }`}
                      >
                        {entry.status}
                      </span>
                      <span className="text-slate-400">
                        {entry.durationMs} ms ·{" "}
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="space-y-6">
          {/* External MCP Servers Header */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  External MCP Servers (Client)
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Connect external tools (accounting, ERP, Slack, CRM, or local CLI tools) so your
                  Automation Workflows can invoke them securely. Tokens are stored in your OS Keychain.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {isNextcloudConnected && (
                  <button
                    type="button"
                    disabled={syncingTeam}
                    onClick={() => void handleSyncTeam()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    {syncingTeam ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CloudDownload className="h-3.5 w-3.5" />
                    )}
                    Sync from Nextcloud
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowAddForm((s) => !s)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Server
                </button>
              </div>
            </div>

            {showAddForm && (
              <form
                onSubmit={(e) => void handleAddExternalServer(e)}
                className="mt-5 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    type="text"
                    required
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Display name (e.g. Accounting MCP)"
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <select
                    value={newTransport}
                    onChange={(e) =>
                      setNewTransport(
                        e.target.value as "streamableHttp" | "stdio",
                      )
                    }
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <option value="streamableHttp">
                      Remote Streamable HTTP (URL)
                    </option>
                    <option value="stdio">Local Command (stdio)</option>
                  </select>
                </div>

                {newTransport === "streamableHttp" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input
                      type="url"
                      required
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      placeholder="https://mcp.company.example/mcp"
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    />
                    <input
                      type="password"
                      value={newToken}
                      onChange={(e) => setNewToken(e.target.value)}
                      placeholder="Optional Bearer token (saved to OS Keychain)"
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    />
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input
                      type="text"
                      required
                      value={newCommand}
                      onChange={(e) => setNewCommand(e.target.value)}
                      placeholder="Executable (e.g. npx or python)"
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    />
                    <input
                      type="text"
                      value={newArgs}
                      onChange={(e) => setNewArgs(e.target.value)}
                      placeholder="Space-separated arguments (optional)"
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    />
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                  >
                    Save Server
                  </button>
                </div>
              </form>
            )}

            {externalServers.length === 0 ? (
              <p className="mt-5 text-xs text-slate-500 dark:text-slate-400">
                No external MCP servers configured yet. Click &ldquo;Add Server&rdquo; or sync your
                team&apos;s registry from <code>/_FR_App/mcp-servers.json</code>.
              </p>
            ) : (
              <div className="mt-5 space-y-3">
                {externalServers.map((srv) => {
                  const tools = discoveredByServer[srv.id] ?? [];
                  return (
                    <div
                      key={srv.id}
                      className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            {srv.transport.transport === "stdio" ? (
                              <Terminal className="h-4 w-4 text-indigo-500" />
                            ) : (
                              <Server className="h-4 w-4 text-blue-500" />
                            )}
                            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                              {srv.name}
                            </span>
                            {srv.hasToken && (
                              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                                Keychain Token
                              </span>
                            )}
                            {srv.fromTeamSync && (
                              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                                Team Sync
                              </span>
                            )}
                          </div>
                          <p className="mt-1 font-mono text-[11px] text-slate-500">
                            {srv.transport.transport === "streamableHttp"
                              ? srv.transport.url
                              : `${srv.transport.command} ${srv.transport.args.join(" ")}`}
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleToggleExternalEnabled(srv)}
                            className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                              srv.enabled
                                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                                : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                            }`}
                          >
                            {srv.enabled ? "Enabled" : "Disabled"}
                          </button>
                          <button
                            type="button"
                            disabled={!srv.enabled || discoveringId === srv.id}
                            onClick={() => void handleDiscoverTools(srv.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                          >
                            {discoveringId === srv.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Wrench className="h-3.5 w-3.5" />
                            )}
                            Discover Tools
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteExternal(srv.id)}
                            title="Delete server"
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      {tools.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3 dark:border-slate-800">
                          {tools.map((tool) => (
                            <button
                              key={tool.name}
                              type="button"
                              onClick={() => {
                                setTestingTool({ serverId: srv.id, tool });
                                setTestArgsJson("{}");
                                setTestOutput(null);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50/70 px-2.5 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200"
                            >
                              <Play className="h-3 w-3" />
                              {tool.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Interactive Tool Test Drawer */}
          {testingTool && (
            <section className="rounded-2xl border border-blue-200 bg-white p-6 shadow-xs dark:border-blue-900/60 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Test Tool: <code>{testingTool.tool.name}</code>
                  </h3>
                  {testingTool.tool.description && (
                    <p className="mt-0.5 text-xs text-slate-500">
                      {testingTool.tool.description}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setTestingTool(null)}
                  className="text-xs text-slate-400 hover:text-slate-700"
                >
                  Close
                </button>
              </div>

              <form onSubmit={(e) => void handleRunToolTest(e)} className="mt-4 space-y-3">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Arguments (JSON)
                </label>
                <textarea
                  rows={4}
                  value={testArgsJson}
                  onChange={(e) => setTestArgsJson(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 p-3 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                <button
                  type="submit"
                  disabled={runningTest}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {runningTest ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Run Tool
                </button>
              </form>

              {testOutput && (
                <div
                  className={`mt-4 rounded-xl border p-4 text-xs ${
                    testOutput.isError
                      ? "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
                      : "border-emerald-200 bg-slate-950 text-slate-100 dark:border-emerald-900/60"
                  }`}
                >
                  <pre className="max-h-72 overflow-auto font-mono whitespace-pre-wrap">
                    {testOutput.text}
                  </pre>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
