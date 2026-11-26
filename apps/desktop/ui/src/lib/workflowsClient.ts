import { isTauri } from "@tauri-apps/api/core";
import {
  commands,
  type WorkflowDefinition_Deserialize,
  type WorkflowDefinition_Serialize,
  type WorkflowRunRecord,
  type WorkflowSyncReport_Serialize,
} from "../bindings/tauri";

function requireDesktop(action: string): never {
  throw {
    code: "browser_preview",
    title: "Desktop app required",
    message: `${action} is available inside the FR Universal App desktop window.`,
    recoveryHint: "Launch FR Universal App via Tauri.",
    technicalDetails: null,
  };
}

export async function listWorkflows(): Promise<WorkflowDefinition_Serialize[]> {
  if (!isTauri()) return [];
  return commands.listWorkflows();
}

export async function upsertWorkflow(
  workflow: WorkflowDefinition_Deserialize,
): Promise<WorkflowDefinition_Serialize[]> {
  if (!isTauri()) requireDesktop("Saving workflows");
  return commands.upsertWorkflow(workflow);
}

export async function deleteWorkflow(
  workflowId: string,
): Promise<WorkflowDefinition_Serialize[]> {
  if (!isTauri()) requireDesktop("Deleting workflows");
  return commands.deleteWorkflow(workflowId);
}

export async function runWorkflowNow(
  workflowId: string,
): Promise<WorkflowRunRecord> {
  if (!isTauri()) requireDesktop("Running workflows");
  return commands.runWorkflowNow(workflowId);
}

export async function listWorkflowRuns(
  workflowId: string | null = null,
  limit = 40,
): Promise<WorkflowRunRecord[]> {
  if (!isTauri()) return [];
  return commands.listWorkflowRuns(workflowId, limit);
}

export async function syncWorkflowsFromNextcloud(): Promise<WorkflowSyncReport_Serialize> {
  if (!isTauri()) requireDesktop("Syncing team workflows");
  return commands.syncWorkflowsFromNextcloud();
}

export async function pushWorkflowToNextcloud(
  workflowId: string,
): Promise<string> {
  if (!isTauri()) requireDesktop("Sharing workflows to Nextcloud");
  return commands.pushWorkflowToNextcloud(workflowId);
}
