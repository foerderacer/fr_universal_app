import { isTauri } from "@tauri-apps/api/core";
import {
  commands,
  type UpdateSettingsRequest,
  type UserFacingError,
  type WorkspaceOverview_Serialize,
} from "../bindings/tauri";

const BROWSER_STORAGE_KEY = "fr_universal_app_preview_config";

function createBrowserPreviewOverview(): WorkspaceOverview_Serialize {
  const fallbackConfig = {
    nextcloudUrl: "",
    pinnedFolders: [],
    cacheLimitMb: 2048,
    mcpServerEnabled: false,
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
        id: "finance",
        name: "Finance",
        description:
          "Track budgets, invoices, and team expenses synced with Nextcloud.",
        icon: "wallet",
        version: "0.1.0",
        status: "planned",
        capabilities: ["storage", "mcpServerTools"],
      },
      {
        id: "automation",
        name: "Automations",
        description:
          "Run team workflows across Nextcloud folders and connected MCP tools.",
        icon: "workflow",
        version: "0.1.0",
        status: "planned",
        capabilities: ["storage", "workflows", "mcpClient"],
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
