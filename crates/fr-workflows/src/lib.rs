//! Declarative automation workflow definitions and runner engine.
//!
//! Workflows can be synced via Nextcloud (`/_FR_App/workflows/`) and combine storage actions
//! with external MCP tool calls.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkflowTrigger {
    Manual,
    FolderWatch { path: String },
    Schedule { cron: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkflowStep {
    CallMcpTool {
        server_id: String,
        tool_name: String,
    },
    CopyFile {
        from: String,
        to: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub trigger: WorkflowTrigger,
    pub steps: Vec<WorkflowStep>,
}
