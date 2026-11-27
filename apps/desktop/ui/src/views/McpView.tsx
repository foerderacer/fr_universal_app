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
import { WorkspaceLayout } from "../components/shell/WorkspaceLayout";
import { InlineDeleteConfirm } from "../components/ui/InlineDeleteConfirm";
import { Select } from "../components/ui/Select";
import { Switch } from "../components/ui/Switch";
import { IconButton } from "../components/ui/Tooltip";
import { formatIsoDateTime } from "../lib/dateFormat";
import { QUICK_CHAT_SHORTCUT } from "../lib/platform";
import {
  areSingleKeyShortcutsEnabled,
  handleToolbarKeyDown,
  hasActiveOverlay,
  isEditableTarget,
} from "../lib/shortcuts";
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
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  quickChatInspector?: React.ReactNode;
  onToggleInspector?: () => void;
  banners?: React.ReactNode;
}

function tokenizeCommandArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

function formatAuditStatus(status: McpAuditEntry_Serialize["status"]): string {
  switch (status) {
    case "allowed":
      return "Allowed";
    case "denied":
      return "Denied";
    case "timedOut":
      return "Timed out";
    case "failed":
      return "Failed";
  }
}

export function McpView({
  isNextcloudConnected,
  pendingApprovals,
  onRefreshApprovals,
  onOverviewUpdated,
  sidebarOpen,
  onToggleSidebar,
  quickChatInspector,
  onToggleInspector,
  banners,
}: McpViewProps) {
  const [tab, setTab] = useState<"server" | "client">("server");
  const [status, setStatus] = useState<McpServerStatus_Serialize | null>(null);
  const [auditLog, setAuditLog] = useState<McpAuditEntry_Serialize[]>([]);
  const [portInput, setPortInput] = useState("38420");
  const [requireApproval, setRequireApproval] = useState(true);
  const [confirmDisableApproval, setConfirmDisableApproval] = useState(false);
  const [confirmStopServer, setConfirmStopServer] = useState(false);
  const [confirmRotateToken, setConfirmRotateToken] = useState(false);
  const [confirmClearAudit, setConfirmClearAudit] = useState(false);
  const [armedApprovalId, setArmedApprovalId] = useState<string | null>(null);
  const [confirmEnableStdio, setConfirmEnableStdio] =
    useState<ExternalMcpServerView | null>(null);
  const [confirmDeleteServerId, setConfirmDeleteServerId] = useState<
    string | null
  >(null);
  const [savingServer, setSavingServer] = useState(false);
  const [snippet, setSnippet] = useState<McpClientConfigSnippetResponse | null>(
    null,
  );
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [error, setError] = useState<UserFacingError | null>(null);

  const [externalServers, setExternalServers] = useState<
    ExternalMcpServerView[]
  >([]);
  const [syncingTeam, setSyncingTeam] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
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
      setPortInput(String(st.config.port));
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
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!areSingleKeyShortcutsEnabled()) return;
      if (hasActiveOverlay() || isEditableTarget(e.target)) return;
      if (e.key === "1") {
        e.preventDefault();
        setTab("server");
      } else if (e.key === "2") {
        e.preventDefault();
        setTab("client");
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        void loadAll();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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

  function parsePort(): number {
    return Math.max(
      1024,
      Math.min(
        65535,
        Math.round(Number(portInput)) || status?.config.port || 38420,
      ),
    );
  }

  async function handleSaveServerConfig(nextEnabled: boolean) {
    setSavingServer(true);
    setError(null);
    const parsedPort = parsePort();
    setPortInput(String(parsedPort));
    try {
      const res = await configureMcpServer({
        enabled: nextEnabled,
        port: parsedPort,
        requireWriteApproval: requireApproval,
      });
      setStatus(res.status);
      onOverviewUpdated(res.overview);
      if (!nextEnabled) setSnippet(null);
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
    const baseSlug = newName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const existingIds = new Set(externalServers.map((s) => s.id));
    const id =
      baseSlug && !existingIds.has(baseSlug)
        ? baseSlug
        : `${baseSlug || "mcp-server"}-${Date.now().toString(36)}`;
    const server: ExternalMcpServer = {
      id,
      name: newName.trim(),
      enabled: newTransport === "streamableHttp",
      transport:
        newTransport === "streamableHttp"
          ? { transport: "streamableHttp", url: newUrl.trim() }
          : {
              transport: "stdio",
              command: newCommand.trim(),
              args: tokenizeCommandArgs(newArgs),
            },
    };
    try {
      const updated = await upsertExternalMcpServer(
        server,
        newToken.trim() ? newToken.trim() : null,
      );
      setExternalServers(updated);
      setShowAddForm(false);
      setNewName("");
      setNewUrl("https://");
      setNewCommand("");
      setNewArgs("");
      setNewToken("");
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function applyToggleExternalEnabled(srv: ExternalMcpServerView) {
    setError(null);
    setConfirmEnableStdio(null);
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

  function handleToggleExternalEnabled(srv: ExternalMcpServerView) {
    if (!srv.enabled && srv.transport.transport === "stdio") {
      setConfirmEnableStdio(srv);
      return;
    }
    void applyToggleExternalEnabled(srv);
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

  const sidebarNode = (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2.5">
        <h2 className="mb-1 px-2 text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
          Dual MCP
        </h2>
        <nav aria-label="Dual MCP" className="space-y-0.5">
          <button
            type="button"
            aria-current={tab === "server" ? "page" : undefined}
            onClick={() => setTab("server")}
            className={`relative flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
              tab === "server"
                ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            {tab === "server" && (
              <span
                aria-hidden="true"
                className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r bg-[var(--accent)]"
              />
            )}
            <span className="flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
              Built-in Server
            </span>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status?.running
                  ? "bg-[var(--status-positive)]"
                  : "bg-[var(--text-muted)]"
              }`}
            />
          </button>
          <button
            type="button"
            aria-current={tab === "client" ? "page" : undefined}
            onClick={() => setTab("client")}
            className={`relative flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
              tab === "client"
                ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            {tab === "client" && (
              <span
                aria-hidden="true"
                className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r bg-[var(--accent)]"
              />
            )}
            <span className="flex items-center gap-2">
              <Server className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
              External Clients
            </span>
            <span className="mono-num text-[11px] text-[var(--text-muted)]">
              {externalServers.length}
            </span>
          </button>
        </nav>
      </div>
      <div className="mono-num flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <span>{status?.running ? "127.0.0.1" : "Stopped"}</span>
        <span>{externalServers.length} clients</span>
      </div>
    </div>
  );

  return (
    <WorkspaceLayout
      moduleId="mcp"
      headerLeft={
        <div className="flex items-center gap-2">
          <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
            MCP / AI
          </h1>
          <span className="mono-num rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
            {tab === "server" ? "127.0.0.1" : `${externalServers.length} servers`}
          </span>
        </div>
      }
      headerRight={
        <div
          role="toolbar"
          aria-label="MCP actions"
          onKeyDown={handleToolbarKeyDown}
          className="flex items-center gap-1"
        >
          {tab === "client" && isNextcloudConnected && (
            <IconButton
              label="Sync team MCP servers"
              disabled={syncingTeam}
              onClick={() => void handleSyncTeam()}
            >
              {syncingTeam ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <CloudDownload className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
            </IconButton>
          )}
          {tab === "client" && (
            <IconButton
              label="Add external MCP server"
              tone="accent"
              onClick={() => setShowAddForm((s) => !s)}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
            </IconButton>
          )}
          <IconButton label="Refresh" shortcut="R" onClick={() => void loadAll()}>
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      }
      sidebar={sidebarNode}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={onToggleSidebar}
      inspector={quickChatInspector}
      inspectorOpen={Boolean(quickChatInspector)}
      onToggleInspector={onToggleInspector}
      inspectorLabel={quickChatInspector ? "Quick chat" : "Details inspector"}
      inspectorToggleLabel={quickChatInspector ? "Close quick chat" : undefined}
      inspectorToggleShortcut={quickChatInspector ? QUICK_CHAT_SHORTCUT : undefined}
      canvasMode="document"
      banners={banners}
    >
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {tab === "server" ? (
            <>
              {pendingApprovals.length > 0 && (
                <section className="rounded-md border border-[var(--status-warning)]/45 bg-[var(--status-warning-soft)] p-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                    <ShieldAlert
                      className="h-4 w-4 text-[var(--status-warning-text)]"
                      strokeWidth={1.5}
                    />
                    Pending write approvals ({pendingApprovals.length})
                  </div>
                  <div className="mt-3 space-y-2">
                    {pendingApprovals.map((req) => (
                      <div
                        key={req.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-xs"
                      >
                        <div>
                          <p className="font-medium text-[var(--text-primary)]">
                            <code className="mono-num">{req.toolName}</code>
                          </p>
                          <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                            {req.summary}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <InlineDeleteConfirm
                            armed={armedApprovalId === req.id}
                            onArm={() => setArmedApprovalId(req.id)}
                            onCancel={() => setArmedApprovalId(null)}
                            onConfirm={() => {
                              setArmedApprovalId(null);
                              void handleResolveApproval(req.id, true);
                            }}
                            label={`Allow AI write request ${req.toolName}`}
                            triggerLabel="Allow"
                            confirmLabel="Allow write"
                            tone="positive"
                            triggerIcon={
                              <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                            }
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setArmedApprovalId(null);
                              void handleResolveApproval(req.id, false);
                            }}
                            className="inline-flex h-7 items-center gap-1 rounded border border-[var(--status-danger)] px-2.5 text-xs text-[var(--status-danger-text)] hover:bg-[var(--status-danger-soft)]"
                          >
                            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                            Deny
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xs font-medium text-[var(--text-primary)]">
                        Local MCP Server
                      </h2>
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            status?.running
                              ? "bg-[var(--status-positive)]"
                              : "bg-[var(--text-muted)]"
                          }`}
                        />
                        {status?.running ? "Running" : "Stopped"}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                      Bound to <code className="mono-num">127.0.0.1</code> with an OS
                      Keychain Bearer token.
                    </p>
                    {status?.endpointUrl && (
                      <p className="mono-num mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-[var(--status-positive-text)]">
                        <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
                        {status.endpointUrl}
                      </p>
                    )}
                  </div>

                  {status?.running ? (
                    <InlineDeleteConfirm
                      armed={confirmStopServer}
                      onArm={() => setConfirmStopServer(true)}
                      onCancel={() => setConfirmStopServer(false)}
                      onConfirm={() => {
                        setConfirmStopServer(false);
                        void handleSaveServerConfig(false);
                      }}
                      label="Stop local MCP server"
                      triggerLabel="Stop Server"
                      confirmLabel="Stop"
                      disabled={savingServer}
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={savingServer}
                      onClick={() => void handleSaveServerConfig(true)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                    >
                      {savingServer && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                      )}
                      Start Server
                    </button>
                  )}
                </div>

                <div className="mt-4 grid gap-3 border-t border-[var(--border-hairline)] pt-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label
                      htmlFor="mcp-port"
                      className="block text-[11px] text-[var(--text-secondary)]"
                    >
                      Loopback Port
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="mcp-port"
                        type="number"
                        min={1024}
                        max={65535}
                        value={portInput}
                        onChange={(e) => setPortInput(e.target.value)}
                        onBlur={() => {
                          const parsed = Number(portInput);
                          if (!Number.isFinite(parsed) || parsed < 1024) {
                            setPortInput(String(status?.config.port ?? 38420));
                          } else if (parsed > 65535) {
                            setPortInput("65535");
                          } else {
                            setPortInput(String(Math.round(parsed)));
                          }
                        }}
                        className="mono-num h-8 w-28 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={savingServer}
                        onClick={() =>
                          void handleSaveServerConfig(Boolean(status?.running))
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-strong)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                        Apply
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 text-xs">
                    <span>
                      <span className="block font-medium text-[var(--text-primary)]">
                        Require write approval
                      </span>
                      <span className="text-[11px] text-[var(--text-muted)]">
                        Prompt before AI writes or renames files.
                      </span>
                    </span>
                    <Switch
                      ariaLabel="Require write approval"
                      checked={requireApproval}
                      onChange={(next) => {
                        if (!next) {
                          setConfirmDisableApproval(true);
                          return;
                        }
                        setConfirmDisableApproval(false);
                        setRequireApproval(true);
                        void configureMcpServer({
                          enabled: Boolean(status?.running),
                          port: parsePort(),
                          requireWriteApproval: true,
                        })
                          .then((res) => {
                            setStatus(res.status);
                            onOverviewUpdated(res.overview);
                          })
                          .catch((err) => setError(toUserFacingError(err)));
                      }}
                    />
                  </div>
                </div>

                {confirmDisableApproval && (
                  <div
                    role="alert"
                    className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] px-3 py-2 text-xs text-[var(--text-primary)]"
                  >
                    <span>Allow connected AI clients to modify files without prompts?</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDisableApproval(false);
                          setRequireApproval(false);
                          void configureMcpServer({
                            enabled: Boolean(status?.running),
                            port: parsePort(),
                            requireWriteApproval: false,
                          })
                            .then((res) => {
                              setStatus(res.status);
                              onOverviewUpdated(res.overview);
                            })
                            .catch((err) => setError(toUserFacingError(err)));
                        }}
                        className="rounded bg-[var(--status-warning)] px-2.5 py-1 text-[11px] font-medium text-[var(--status-warning-fg)]"
                      >
                        Disable prompts
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDisableApproval(false)}
                        className="rounded border border-[var(--border-strong)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
                      >
                        Keep enabled
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-3.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyClientConfig()}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  >
                    {copiedNotice ? (
                      <Check
                        className="h-3.5 w-3.5 text-[var(--status-positive-text)]"
                        strokeWidth={1.5}
                      />
                    ) : (
                      <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                    )}
                    <span role="status" aria-live="polite">
                      {copiedNotice ? "Copied" : "Copy Client Config"}
                    </span>
                  </button>
                  <InlineDeleteConfirm
                    armed={confirmRotateToken}
                    onArm={() => setConfirmRotateToken(true)}
                    onCancel={() => setConfirmRotateToken(false)}
                    onConfirm={() => {
                      setConfirmRotateToken(false);
                      void handleRotateToken();
                    }}
                    label="Rotate MCP Bearer token"
                    triggerLabel="Rotate Token"
                    confirmLabel="Rotate"
                    triggerIcon={<KeyRound className="h-3.5 w-3.5" strokeWidth={1.5} />}
                  />
                </div>

                {snippet && (
                  <div className="mt-3 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-app)] p-3 text-xs">
                    <div className="mb-1.5 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                      <span>MCP client JSON snippet</span>
                      <button
                        type="button"
                        onClick={() => setSnippet(null)}
                        className="hover:text-[var(--text-primary)]"
                      >
                        Hide
                      </button>
                    </div>
                    <pre className="mono-num overflow-x-auto text-[11px] leading-relaxed text-[var(--text-primary)]">
                      {snippet.jsonSnippet}
                    </pre>
                  </div>
                )}
              </section>

              <section className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-4">
                <h3 className="text-xs font-medium text-[var(--text-primary)]">
                  Exposed Tools ({status?.exposedTools.length ?? 0})
                </h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {(status?.exposedTools ?? []).map((tool) => (
                    <div
                      key={tool.name}
                      className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <code className="mono-num text-[11px] font-medium text-[var(--text-primary)]">
                          {tool.name}
                        </code>
                        <span
                          className={`text-[10px] font-medium ${
                            tool.isWrite
                              ? "text-[var(--status-warning-text)]"
                              : "text-[var(--status-positive-text)]"
                          }`}
                        >
                          {tool.isWrite ? "Write" : "Read"}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                        {tool.description}
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium text-[var(--text-primary)]">
                    Activity Log
                  </h3>
                  {auditLog.length > 0 && (
                    <InlineDeleteConfirm
                      armed={confirmClearAudit}
                      onArm={() => setConfirmClearAudit(true)}
                      onCancel={() => setConfirmClearAudit(false)}
                      onConfirm={() => {
                        setConfirmClearAudit(false);
                        void clearMcpAuditLog().then(() => setAuditLog([]));
                      }}
                      label="Clear activity log"
                      confirmLabel="Clear log"
                    />
                  )}
                </div>
                {auditLog.length === 0 ? (
                  <p className="mt-2.5 text-[11px] text-[var(--text-muted)]">
                    No AI tool calls recorded yet.
                  </p>
                ) : (
                  <div className="mt-2.5 divide-y divide-[var(--border-subtle)]">
                    {auditLog.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
                      >
                        <div>
                          <code className="mono-num font-medium text-[var(--text-primary)]">
                            {entry.toolName}
                          </code>
                          <span className="ml-2 text-[var(--text-secondary)]">
                            {entry.summary}
                          </span>
                          {entry.error && (
                            <p className="mt-0.5 text-[11px] text-[var(--status-danger-text)]">
                              {entry.error}
                            </p>
                          )}
                        </div>
                        <div className="mono-num flex items-center gap-2 text-[11px]">
                          <span
                            className={
                              entry.status === "allowed"
                                ? "text-[var(--status-positive-text)]"
                                : "text-[var(--status-danger-text)]"
                            }
                          >
                            {formatAuditStatus(entry.status)}
                          </span>
                          <span className="text-[var(--text-muted)]">
                            {entry.durationMs}ms ·{" "}
                            {formatIsoDateTime(entry.timestamp)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : (
            <section className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xs font-medium text-[var(--text-primary)]">
                    External MCP Servers
                  </h2>
                  <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                    Connect remote or local MCP tools for Automation Workflows.
                  </p>
                </div>
              </div>

              {showAddForm && (
                <form
                  onSubmit={(e) => void handleAddExternalServer(e)}
                  className="mt-4 space-y-2.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
                >
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <input
                      type="text"
                      required
                      aria-label="External MCP server display name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Display name"
                      className="h-8 rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                    />
                    <Select
                      ariaLabel="MCP transport"
                      value={newTransport}
                      onChange={(val) =>
                        setNewTransport(val as "streamableHttp" | "stdio")
                      }
                      options={[
                        { value: "streamableHttp", label: "Streamable HTTP (URL)" },
                        { value: "stdio", label: "Local Command (stdio)" },
                      ]}
                    />
                  </div>
                  {newTransport === "streamableHttp" ? (
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      <input
                        type="url"
                        required
                        aria-label="External MCP server URL"
                        value={newUrl}
                        onChange={(e) => setNewUrl(e.target.value)}
                        placeholder="https://mcp.example.com/mcp"
                        className="mono-num h-8 rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                      />
                      <input
                        type="password"
                        aria-label="Optional Bearer token"
                        value={newToken}
                        onChange={(e) => setNewToken(e.target.value)}
                        placeholder="Optional Bearer token"
                        className="h-8 rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                      />
                    </div>
                  ) : (
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      <input
                        type="text"
                        required
                        aria-label="Local command executable"
                        value={newCommand}
                        onChange={(e) => setNewCommand(e.target.value)}
                        placeholder="Executable (e.g. npx)"
                        className="mono-num h-8 rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                      />
                      <input
                        type="text"
                        aria-label="Command arguments"
                        value={newArgs}
                        onChange={(e) => setNewArgs(e.target.value)}
                        placeholder="Arguments (optional)"
                        className="mono-num h-8 rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                      />
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddForm(false)}
                      className="h-7 rounded-md px-2.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="h-7 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
                    >
                      Save
                    </button>
                  </div>
                </form>
              )}

              {confirmEnableStdio &&
                confirmEnableStdio.transport.transport === "stdio" && (
                  <div
                    role="alert"
                    className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] px-3 py-2 text-xs text-[var(--text-primary)]"
                  >
                    <span>
                      Enable local command{" "}
                      <code className="mono-num">
                        {confirmEnableStdio.transport.command}
                      </code>
                      ?
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          void applyToggleExternalEnabled(confirmEnableStdio)
                        }
                        className="rounded bg-[var(--status-warning)] px-2.5 py-1 text-[11px] font-medium text-[var(--status-warning-fg)]"
                      >
                        Enable
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmEnableStdio(null)}
                        className="rounded border border-[var(--border-strong)] px-2.5 py-1 text-[11px]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

              {externalServers.length === 0 ? (
                <p className="mt-4 text-xs text-[var(--text-muted)]">
                  No external MCP servers configured yet.
                </p>
              ) : (
                <div className="mt-4 divide-y divide-[var(--border-subtle)] rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
                  {externalServers.map((srv) => {
                    const tools = discoveredByServer[srv.id] ?? [];
                    return (
                      <div key={srv.id} className="p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              {srv.transport.transport === "stdio" ? (
                                <Terminal
                                  className="h-3.5 w-3.5 text-[var(--text-muted)]"
                                  strokeWidth={1.5}
                                />
                              ) : (
                                <Server
                                  className="h-3.5 w-3.5 text-[var(--text-muted)]"
                                  strokeWidth={1.5}
                                />
                              )}
                              <span className="text-xs font-medium text-[var(--text-primary)]">
                                {srv.name}
                              </span>
                            </div>
                            <p className="mono-num mt-0.5 text-[11px] text-[var(--text-muted)]">
                              {srv.transport.transport === "streamableHttp"
                                ? srv.transport.url
                                : `${srv.transport.command} ${srv.transport.args.join(" ")}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Switch
                              checked={srv.enabled}
                              onChange={() => handleToggleExternalEnabled(srv)}
                              ariaLabel={`Enable ${srv.name}`}
                            />
                            <IconButton
                              size="xs"
                              label="Discover tools"
                              disabled={!srv.enabled || discoveringId === srv.id}
                              onClick={() => void handleDiscoverTools(srv.id)}
                            >
                              {discoveringId === srv.id ? (
                                <Loader2
                                  className="h-3.5 w-3.5 animate-spin"
                                  strokeWidth={1.5}
                                />
                              ) : (
                                <Wrench className="h-3.5 w-3.5" strokeWidth={1.5} />
                              )}
                            </IconButton>
                            <InlineDeleteConfirm
                              armed={confirmDeleteServerId === srv.id}
                              onArm={() => setConfirmDeleteServerId(srv.id)}
                              onCancel={() => setConfirmDeleteServerId(null)}
                              onConfirm={() => {
                                setConfirmDeleteServerId(null);
                                void handleDeleteExternal(srv.id);
                              }}
                              label="Delete server"
                            />
                          </div>
                        </div>

                        {tools.length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-[var(--border-subtle)] pt-2.5">
                            {tools.map((tool) => (
                              <button
                                key={tool.name}
                                type="button"
                                onClick={() => {
                                  setTestingTool({ serverId: srv.id, tool });
                                  setTestArgsJson("{}");
                                  setTestOutput(null);
                                }}
                                className="mono-num inline-flex items-center gap-1 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] hover:border-[var(--accent)]"
                              >
                                <Play className="h-2.5 w-2.5" strokeWidth={1.5} />
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

              {testingTool && (
                <div className="mt-4 rounded-md border border-[var(--accent-border)] bg-[var(--bg-surface)] p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="mono-num text-xs font-medium text-[var(--text-primary)]">
                      {testingTool.tool.name}
                    </span>
                    <IconButton
                      size="xs"
                      label="Close tester"
                      onClick={() => setTestingTool(null)}
                    >
                      <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </IconButton>
                  </div>
                  <form
                    onSubmit={(e) => void handleRunToolTest(e)}
                    className="mt-2.5 space-y-2"
                  >
                    <textarea
                      rows={3}
                      aria-label="MCP tool arguments JSON"
                      value={testArgsJson}
                      onChange={(e) => setTestArgsJson(e.target.value)}
                      className="mono-num w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-app)] p-2 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={runningTest}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                    >
                      {runningTest ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                      ) : (
                        <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
                      )}
                      Run
                    </button>
                  </form>
                  {testOutput && (
                    <pre className="mono-num mt-3 max-h-60 overflow-auto rounded border border-[var(--border-hairline)] bg-[var(--bg-app)] p-2.5 text-[11px] whitespace-pre-wrap text-[var(--text-primary)]">
                      {testOutput.text}
                    </pre>
                  )}
                </div>
              )}
            </section>
          )}
    </WorkspaceLayout>
  );
}
