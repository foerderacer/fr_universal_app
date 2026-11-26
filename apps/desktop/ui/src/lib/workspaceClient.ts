import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  commands,
  type AppUpdateCheckResult_Serialize,
  type LoginPollStatusResponse_Serialize,
  type LoginStartResponse,
  type UpdateSafetyStatus,
  type UpdateSettingsRequest,
  type UserAccountInfo_Serialize,
  type UserFacingError,
  type WorkspaceOverview_Serialize,
} from "../bindings/tauri";

const BROWSER_STORAGE_KEY = "fr_universal_app_preview_config";
export const GITHUB_RELEASES_URL =
  "https://github.com/foerderacer/fr_universal_app/releases";

function createBrowserPreviewOverview(): WorkspaceOverview_Serialize {
  const fallbackConfig = {
    nextcloudUrl: "",
    nextcloudLoginName: null as string | null,
    pinnedFolders: [] as string[],
    cacheLimitMb: 2048,
    mcpServerEnabled: false,
    mcpServerPort: 38420,
    mcpRequireWriteApproval: true,
    financeFolder: "/Finance",
    skippedUpdateVersion: null as string | null,
    lastUpdateCheckAt: null as string | null,
    theme: "system",
  };

  let config = fallbackConfig;
  try {
    const raw = window.localStorage.getItem(BROWSER_STORAGE_KEY);
    if (raw) {
      config = { ...fallbackConfig, ...JSON.parse(raw) };
    }
  } catch {
    // Ignore localStorage failures in preview mode.
  }

  return {
    appVersion: "0.1.0",
    platform: "browser-preview",
    config,
    defaultNextcloudUrl: "",
    connectionStatus: config.nextcloudUrl
      ? { state: "signedOut", serverUrl: config.nextcloudUrl }
      : { state: "notConfigured" },
    accountInfo: null,
    loginPendingUrl: null,
    mcpServer: {
      enabled: config.mcpServerEnabled,
      bindHost: "127.0.0.1",
      port: 38420,
      requireWriteApproval: true,
    },
    startupError: null,
    modules: [
      {
        id: "files",
        name: "Files",
        description:
          "Browse Nextcloud folders, preview media & CAD files, and edit Markdown.",
        icon: "folder",
        version: "0.1.0",
        status: "active",
        capabilities: ["storage", "preview", "mcpServerTools"],
      },
      {
        id: "mcp",
        name: "MCP / AI",
        description:
          "Connect local AI assistants to your workspace and manage external MCP tools.",
        icon: "cpu",
        version: "0.1.0",
        status: "active",
        capabilities: ["mcpServerTools", "mcpClient"],
      },
      {
        id: "finance",
        name: "Finance",
        description:
          "Track invoices, receipts, and budgets linked to Nextcloud documents with CSV export.",
        icon: "wallet",
        version: "0.1.0",
        status: "active",
        capabilities: ["storage", "preview", "mcpServerTools"],
      },
      {
        id: "automation",
        name: "Automations",
        description:
          "Build and run team workflows combining Nextcloud file actions with external MCP tools.",
        icon: "workflow",
        version: "0.1.0",
        status: "active",
        capabilities: ["storage", "workflows", "mcpClient", "mcpServerTools"],
      },
    ],
  };
}

export function toUserFacingError(err: unknown): UserFacingError {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "title" in err &&
    "message" in err
  ) {
    return err as UserFacingError;
  }

  return {
    code: "unexpected",
    title: "Something went wrong",
    message: "The action couldn't be completed right now.",
    recoveryHint: "Try again, or expand technical details for support.",
    technicalDetails: err instanceof Error ? err.message : String(err),
  };
}

export async function loadWorkspaceOverview(): Promise<WorkspaceOverview_Serialize> {
  if (!isTauri()) {
    return createBrowserPreviewOverview();
  }
  return commands.getWorkspaceOverview();
}

export async function saveWorkspaceSettings(
  input: UpdateSettingsRequest,
): Promise<WorkspaceOverview_Serialize> {
  if (!isTauri()) {
    const trimmed = input.nextcloudUrl.trim().replace(/\/+$/, "");
    const normalized =
      trimmed && !trimmed.includes("://") ? `https://${trimmed}` : trimmed;
    const nextConfig = {
      nextcloudUrl: normalized,
      nextcloudLoginName: null,
      pinnedFolders: [],
      cacheLimitMb: Math.max(128, Math.min(32768, input.cacheLimitMb)),
      mcpServerEnabled: input.mcpServerEnabled,
      theme: input.theme,
    };
    window.localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(nextConfig));
    return createBrowserPreviewOverview();
  }
  return commands.updateSettings(input);
}

export async function resetWorkspaceNextcloudUrl(): Promise<WorkspaceOverview_Serialize> {
  if (!isTauri()) {
    window.localStorage.removeItem(BROWSER_STORAGE_KEY);
    return createBrowserPreviewOverview();
  }
  return commands.resetNextcloudUrl();
}

export async function startNextcloudLogin(): Promise<LoginStartResponse> {
  if (!isTauri()) {
    throw {
      code: "browser_preview",
      title: "Desktop app required",
      message: "Sign in with Nextcloud works inside the desktop application.",
      recoveryHint: "Launch FR Universal App via Tauri to sign in.",
      technicalDetails: null,
    } satisfies UserFacingError;
  }
  return commands.startNextcloudLogin();
}

export async function pollNextcloudLogin(): Promise<LoginPollStatusResponse_Serialize> {
  if (!isTauri()) {
    return { completed: false, overview: null };
  }
  return commands.pollNextcloudLogin();
}

export async function cancelNextcloudLogin(): Promise<WorkspaceOverview_Serialize> {
  if (!isTauri()) {
    return createBrowserPreviewOverview();
  }
  return commands.cancelNextcloudLogin();
}

export async function signOutNextcloud(): Promise<WorkspaceOverview_Serialize> {
  if (!isTauri()) {
    return createBrowserPreviewOverview();
  }
  return commands.signOutNextcloud();
}

export async function refreshAccountInfo(): Promise<UserAccountInfo_Serialize | null> {
  if (!isTauri()) {
    return null;
  }
  return commands.refreshAccountInfo();
}

export async function checkForAppUpdate(): Promise<AppUpdateCheckResult_Serialize> {
  if (!isTauri()) {
    return {
      configured: false,
      available: false,
      skipped: false,
      currentVersion: "0.1.0",
      latestVersion: null,
      notes: null,
      releaseUrl: GITHUB_RELEASES_URL,
      lastCheckedAt: null,
      message:
        "Development build — signed automatic updates are only active in official GitHub Releases.",
    };
  }
  return commands.checkForAppUpdate();
}

export async function getUpdateSafetyStatus(): Promise<UpdateSafetyStatus> {
  if (!isTauri()) {
    return {
      safeToRestart: true,
      pendingDraftsCount: 0,
      runningWorkflowsCount: 0,
      warnings: [],
    };
  }
  return commands.getUpdateSafetyStatus();
}

export async function skipAppUpdate(
  version: string,
): Promise<WorkspaceOverview_Serialize> {
  if (!isTauri()) {
    return createBrowserPreviewOverview();
  }
  return commands.skipAppUpdate(version);
}

export async function clearSkippedAppUpdate(): Promise<WorkspaceOverview_Serialize> {
  if (!isTauri()) {
    return createBrowserPreviewOverview();
  }
  return commands.clearSkippedAppUpdate();
}

export async function installAppUpdate(force = false): Promise<void> {
  if (!isTauri()) {
    throw {
      code: "browser_preview",
      title: "Desktop app required",
      message: "Installing updates works inside the desktop application.",
      recoveryHint: null,
      technicalDetails: null,
    } satisfies UserFacingError;
  }
  await commands.installAppUpdate(force);
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes) || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}
