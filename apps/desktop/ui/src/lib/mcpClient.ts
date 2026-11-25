import { isTauri } from "@tauri-apps/api/core";
import {
  commands,
  type ConfigureMcpServerRequest,
  type ConfigureMcpServerResponse_Serialize,
  type ExternalMcpServer,
  type ExternalMcpServerView,
  type ExternalMcpTool_Serialize,
  type McpAuditEntry_Serialize,
  type McpClientConfigSnippetResponse,
  type McpServerStatus_Serialize,
  type McpToolCallOutput,
  type PendingWriteApproval,
} from "../bindings/tauri";

function requireDesktop(action: string): never {
  throw {
    code: "browser_preview",
    title: "Desktop app required",
    message: `${action} is available inside the FR Universal App desktop window.`,
    recoveryHint: "Launch via `npm run tauri -- dev`.",
    technicalDetails: null,
  };
}

export async function getMcpServerStatus(): Promise<McpServerStatus_Serialize> {
  if (!isTauri()) {
    return {
      running: false,
      endpointUrl: null,
      config: {
        enabled: false,
        bindHost: "127.0.0.1",
        port: 38420,
        requireWriteApproval: true,
      },
      exposedTools: [],
      pendingApprovals: 0,
    };
  }
  return commands.getMcpServerStatus();
}

export async function configureMcpServer(
  input: ConfigureMcpServerRequest,
): Promise<ConfigureMcpServerResponse_Serialize> {
  if (!isTauri()) requireDesktop("Configuring the local MCP Server");
  return commands.configureMcpServer(input);
}

export async function getMcpClientConfigSnippet(): Promise<McpClientConfigSnippetResponse> {
  if (!isTauri()) requireDesktop("Viewing the MCP client configuration");
  return commands.getMcpClientConfigSnippet();
}

export async function rotateMcpServerToken(): Promise<McpClientConfigSnippetResponse> {
  if (!isTauri()) requireDesktop("Rotating the MCP Bearer token");
  return commands.rotateMcpServerToken();
}

export async function listMcpAuditLog(): Promise<McpAuditEntry_Serialize[]> {
  if (!isTauri()) return [];
  return commands.listMcpAuditLog();
}

export async function clearMcpAuditLog(): Promise<void> {
  if (!isTauri()) return;
  await commands.clearMcpAuditLog();
}

export async function listPendingMcpApprovals(): Promise<PendingWriteApproval[]> {
  if (!isTauri()) return [];
  return commands.listPendingMcpApprovals();
}

export async function resolveMcpApproval(
  approvalId: string,
  allow: boolean,
): Promise<boolean> {
  if (!isTauri()) return false;
  return commands.resolveMcpApproval(approvalId, allow);
}

export async function listExternalMcpServers(): Promise<ExternalMcpServerView[]> {
  if (!isTauri()) return [];
  return commands.listExternalMcpServers();
}

export async function upsertExternalMcpServer(
  server: ExternalMcpServer,
  bearerToken: string | null,
): Promise<ExternalMcpServerView[]> {
  if (!isTauri()) requireDesktop("Saving external MCP servers");
  return commands.upsertExternalMcpServer(server, bearerToken);
}

export async function deleteExternalMcpServer(
  serverId: string,
): Promise<ExternalMcpServerView[]> {
  if (!isTauri()) requireDesktop("Removing external MCP servers");
  return commands.deleteExternalMcpServer(serverId);
}

export async function syncTeamMcpServers(): Promise<ExternalMcpServerView[]> {
  if (!isTauri()) requireDesktop("Syncing team MCP servers");
  return commands.syncTeamMcpServers();
}

export async function discoverExternalMcpTools(
  serverId: string,
): Promise<ExternalMcpTool_Serialize[]> {
  if (!isTauri()) requireDesktop("Discovering external MCP tools");
  return commands.discoverExternalMcpTools(serverId);
}

export async function testExternalMcpTool(
  serverId: string,
  toolName: string,
  argumentsJson: string,
): Promise<McpToolCallOutput> {
  if (!isTauri()) requireDesktop("Calling external MCP tools");
  return commands.testExternalMcpTool(serverId, toolName, argumentsJson);
}
