import {
  Blocks,
  Box,
  Cloud,
  CloudOff,
  Cpu,
  Folder,
  Landmark,
  MessageSquare,
  MessageSquareText,
  Settings,
  Workflow,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ModuleDescriptor,
  NextcloudConnectionStatus,
} from "../../bindings/tauri";
import { ALT_KEY, QUICK_CHAT_SHORTCUT } from "../../lib/platform";
import { handleVerticalToolbarKeyDown } from "../../lib/shortcuts";
import { Tooltip } from "../ui/Tooltip";

export type ActiveNavItem = string | "settings";

interface ModuleRailProps {
  modules: ModuleDescriptor[];
  activeId: ActiveNavItem;
  connectionStatus: NextcloudConnectionStatus;
  mcpEnabled: boolean;
  pendingMcpApprovals: number;
  quickChatOpen: boolean;
  onSelect: (id: ActiveNavItem) => void;
  onToggleQuickChat: () => void;
}

const PRIMARY_ORDER = ["files", "finance", "slicer", "talk"] as const;

const MODULE_META: Record<
  string,
  { label: string; shortcut?: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }
> = {
  files: { label: "Files", shortcut: `${ALT_KEY}1`, icon: Folder },
  finance: { label: "Finance", shortcut: `${ALT_KEY}2`, icon: Landmark },
  slicer: { label: "3D Printing", shortcut: `${ALT_KEY}3`, icon: Box },
  talk: { label: "Chat", shortcut: `${ALT_KEY}4`, icon: MessageSquare },
  automation: { label: "Automations", shortcut: `${ALT_KEY}5`, icon: Workflow },
  mcp: { label: "MCP / AI", shortcut: `${ALT_KEY}6`, icon: Cpu },
};

function getModuleIcon(mod: ModuleDescriptor) {
  const mapped = MODULE_META[mod.id];
  if (mapped) return mapped.icon;
  switch (mod.icon) {
    case "folder":
      return Folder;
    case "wallet":
      return Landmark;
    case "printer":
      return Box;
    case "message":
      return MessageSquare;
    case "workflow":
      return Workflow;
    case "cpu":
      return Cpu;
    default:
      return Blocks;
  }
}

export function ModuleRail({
  modules,
  activeId,
  connectionStatus,
  mcpEnabled,
  pendingMcpApprovals,
  quickChatOpen,
  onSelect,
  onToggleQuickChat,
}: ModuleRailProps) {
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const statusPopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!statusPopoverOpen) return;
    statusPopoverRef.current
      ?.querySelector<HTMLButtonElement>('[role="dialog"] button')
      ?.focus();
    const onDown = (e: MouseEvent) => {
      if (
        statusPopoverRef.current &&
        !statusPopoverRef.current.contains(e.target as Node)
      ) {
        setStatusPopoverOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setStatusPopoverOpen(false);
        statusPopoverRef.current?.querySelector("button")?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [statusPopoverOpen]);

  const byId = new Map(modules.map((m) => [m.id, m]));
  const primaryModules = PRIMARY_ORDER.map((id) => byId.get(id)).filter(
    (m): m is ModuleDescriptor => Boolean(m),
  );
  const secondaryModules = modules.filter(
    (m) => !(PRIMARY_ORDER as readonly string[]).includes(m.id),
  );

  const connectionLabel =
    connectionStatus.state === "connected"
      ? `Connected · ${connectionStatus.loginName}`
      : connectionStatus.state === "signedOut"
        ? "Nextcloud signed out · Open Settings"
        : "Configure Nextcloud server";

  return (
    <aside
      aria-label="Workspace modules"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement | null)?.closest('[role="dialog"]')) return;
        handleVerticalToolbarKeyDown(e);
      }}
      className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-[var(--border-hairline)] bg-[var(--bg-app)] py-2 select-none"
    >
      <div className="flex flex-col items-center gap-1.5">
        {/* Monogram mark */}
        <Tooltip label="FR Universal Workspace" side="right">
          <button
            type="button"
            onClick={() => onSelect("files")}
            aria-label="FR Universal Workspace"
            className="mono-num mb-1.5 flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[10px] font-semibold tracking-tight text-[var(--text-primary)] transition-colors hover:border-[var(--accent-border)]"
          >
            FR
          </button>
        </Tooltip>

        {/* Primary 4 modules */}
        <nav
          className="flex flex-col items-center gap-1"
          aria-label="Primary modules"
        >
          {primaryModules.map((mod) => {
            const Icon = getModuleIcon(mod);
            const meta = MODULE_META[mod.id];
            const isActive = activeId === mod.id;
            return (
              <Tooltip
                key={mod.id}
                label={meta?.label ?? mod.name}
                shortcut={meta?.shortcut}
                side="right"
              >
                <button
                  type="button"
                  onClick={() => onSelect(mod.id)}
                  aria-label={meta?.label ?? mod.name}
                  aria-current={isActive ? "page" : undefined}
                  className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-1 focus-visible:outline-[var(--accent)] ${
                    isActive
                      ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {isActive && (
                    <span className="absolute top-1.5 bottom-1.5 -left-2 w-[2px] rounded-r bg-[var(--accent)]" />
                  )}
                  <Icon className="h-4 w-4" strokeWidth={1.5} />
                </button>
              </Tooltip>
            );
          })}
        </nav>

        {secondaryModules.length > 0 && (
          <>
            <div className="my-1.5 h-px w-5 bg-[var(--border-hairline)]" />
            <nav
              className="flex flex-col items-center gap-1"
              aria-label="Utility modules"
            >
              {secondaryModules.map((mod) => {
                const Icon = getModuleIcon(mod);
                const meta = MODULE_META[mod.id];
                const isActive = activeId === mod.id;
                const showMcpDot = mod.id === "mcp" && mcpEnabled;
                const showBadge =
                  mod.id === "mcp" && pendingMcpApprovals > 0;
                return (
                  <Tooltip
                    key={mod.id}
                    label={
                      mod.id === "mcp"
                        ? `${meta?.label ?? mod.name} (${mcpEnabled ? "Running" : "Off"})`
                        : (meta?.label ?? mod.name)
                    }
                    shortcut={meta?.shortcut}
                    side="right"
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(mod.id)}
                      aria-label={meta?.label ?? mod.name}
                      aria-current={isActive ? "page" : undefined}
                      className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-1 focus-visible:outline-[var(--accent)] ${
                        isActive
                          ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                          : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {isActive && (
                        <span className="absolute top-1.5 bottom-1.5 -left-2 w-[2px] rounded-r bg-[var(--accent)]" />
                      )}
                      <Icon className="h-4 w-4" strokeWidth={1.5} />
                      {showBadge ? (
                        <span className="mono-num absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--status-warning)] px-1 text-[11px] leading-none font-semibold text-[var(--status-warning-fg)]">
                          {pendingMcpApprovals}
                        </span>
                      ) : showMcpDot ? (
                        <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[var(--status-positive)]" />
                      ) : null}
                    </button>
                  </Tooltip>
                );
              })}
            </nav>
          </>
        )}
      </div>

      {/* Bottom Utility Controls */}
      <div className="flex flex-col items-center gap-1">
        {activeId !== "talk" && (
          <Tooltip
            label={quickChatOpen ? "Close quick chat" : "Quick chat drawer"}
            shortcut={QUICK_CHAT_SHORTCUT}
            side="right"
          >
            <button
              type="button"
              onClick={onToggleQuickChat}
              aria-label="Toggle quick chat drawer"
              aria-pressed={quickChatOpen}
              className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                quickChatOpen
                  ? "border border-[var(--border-strong)] bg-[var(--bg-active)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              }`}
            >
              {quickChatOpen && (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 bottom-1.5 -left-2 w-[2px] rounded-r bg-[var(--accent)]"
                />
              )}
              <MessageSquareText className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </Tooltip>
        )}

        <div ref={statusPopoverRef} className="relative">
          <Tooltip label={connectionLabel} side="right">
            <button
              type="button"
              onClick={() => setStatusPopoverOpen((v) => !v)}
              aria-label={connectionLabel}
              aria-haspopup="dialog"
              aria-expanded={statusPopoverOpen}
              className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                statusPopoverOpen
                  ? "border border-[var(--border-strong)] bg-[var(--bg-active)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              }`}
            >
              {connectionStatus.state === "connected" ? (
                <>
                  <Cloud className="h-4 w-4" strokeWidth={1.5} />
                  <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[var(--status-positive)]" />
                </>
              ) : connectionStatus.state === "signedOut" ? (
                <>
                  <CloudOff className="h-4 w-4" strokeWidth={1.5} />
                  <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[var(--status-warning)]" />
                </>
              ) : (
                <CloudOff className="h-4 w-4" strokeWidth={1.5} />
              )}
            </button>
          </Tooltip>

          {statusPopoverOpen && (
            <div
              role="dialog"
              aria-label="Nextcloud connection status"
              className="absolute bottom-0 left-11 z-50 w-56 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-2.5 text-left text-xs"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    connectionStatus.state === "connected"
                      ? "bg-[var(--status-positive)]"
                      : connectionStatus.state === "signedOut"
                        ? "bg-[var(--status-warning)]"
                        : "bg-[var(--text-muted)]"
                  }`}
                />
                <span className="font-medium text-[var(--text-primary)]">
                  {connectionStatus.state === "connected"
                    ? "Nextcloud Connected"
                    : connectionStatus.state === "signedOut"
                      ? "Signed Out"
                      : "Server Not Configured"}
                </span>
              </div>
              {connectionStatus.state === "connected" && (
                <p className="mono-num mt-1 truncate text-[11px] text-[var(--text-muted)]">
                  {connectionStatus.loginName}
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  setStatusPopoverOpen(false);
                  onSelect("settings");
                }}
                className="mt-2.5 flex h-7 w-full items-center justify-center gap-1.5 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <Settings className="h-3 w-3" strokeWidth={1.5} />
                Manage connection
              </button>
            </div>
          )}
        </div>

        <Tooltip label="Settings" shortcut={`${ALT_KEY},`} side="right">
          <button
            type="button"
            onClick={() => onSelect("settings")}
            aria-label="Settings"
            aria-current={activeId === "settings" ? "page" : undefined}
            className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)] ${
              activeId === "settings"
                ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            {activeId === "settings" && (
              <span className="absolute top-1.5 bottom-1.5 -left-2 w-[2px] rounded-r bg-[var(--accent)]" />
            )}
            <Settings className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}
