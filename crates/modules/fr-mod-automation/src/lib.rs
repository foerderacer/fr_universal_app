//! Automation Workflows domain module (`FrModule`) exposing workflow definitions & execution
//! to both the desktop UI and the built-in local MCP Server.

use std::sync::Arc;

use async_trait::async_trait;
use fr_core::{FrError, FrModule, ModuleCapability, ModuleDescriptor, ModuleStatus, Result};
use fr_mcp::{McpToolHandler, McpToolRegistry};
use fr_preview::SharedBackendSlot;
use fr_workflows::WorkflowRunner;
use serde_json::{Value, json};

/// Pluggable Automation Workflows module descriptor registered in [`fr_core::ModuleRegistry`].
#[derive(Debug, Default)]
pub struct AutomationModule;

impl FrModule for AutomationModule {
    fn descriptor(&self) -> ModuleDescriptor {
        ModuleDescriptor {
            id: "automation".into(),
            name: "Automations".into(),
            description:
                "Build and run team workflows combining Nextcloud file actions with external MCP tools."
                    .into(),
            icon: "workflow".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            status: ModuleStatus::Active,
            capabilities: vec![
                ModuleCapability::Storage,
                ModuleCapability::Workflows,
                ModuleCapability::McpClient,
                ModuleCapability::McpServerTools,
            ],
        }
    }
}

/// Registers `automation_*` tools in the built-in local MCP Server.
pub fn register_automation_tools(
    registry: &McpToolRegistry,
    runner: Arc<WorkflowRunner>,
    storage_slot: SharedBackendSlot,
) {
    registry.register(AutomationListTool(runner.clone()));
    registry.register(AutomationRunTool(runner, storage_slot));
}

struct AutomationListTool(Arc<WorkflowRunner>);

#[async_trait]
impl McpToolHandler for AutomationListTool {
    fn name(&self) -> &str {
        "automation_list_workflows"
    }
    fn description(&self) -> &str {
        "List configured workspace automation workflows and their triggers."
    }
    fn module_id(&self) -> &str {
        "automation"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    fn summarize_audit(&self, _args: &Value) -> String {
        "List automation workflows".into()
    }
    async fn call(&self, _args: Value) -> Result<Value> {
        let list = self.0.store().list_workflows()?;
        Ok(serde_json::to_value(list)?)
    }
}

struct AutomationRunTool(Arc<WorkflowRunner>, SharedBackendSlot);

#[async_trait]
impl McpToolHandler for AutomationRunTool {
    fn name(&self) -> &str {
        "automation_run_workflow"
    }
    fn description(&self) -> &str {
        "Run a configured automation workflow by its ID (requires user approval when enabled)."
    }
    fn module_id(&self) -> &str {
        "automation"
    }
    fn is_write(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["workflow_id"],
            "properties": {
                "workflow_id": { "type": "string", "description": "ID of the workflow to run." }
            }
        })
    }
    fn summarize_audit(&self, _args: &Value) -> String {
        "Run automation workflow".into()
    }
    fn summarize_approval(&self, args: &Value) -> String {
        let id = args
            .get("workflow_id")
            .and_then(Value::as_str)
            .unwrap_or("?");
        format!("Run automation workflow '{id}'")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let id = args
            .get("workflow_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                FrError::InvalidConfig("missing required string field 'workflow_id'".into())
            })?;
        let storage = self
            .1
            .read()
            .ok()
            .and_then(|g| g.clone())
            .ok_or_else(|| FrError::AuthRequired("Nextcloud is not signed in".into()))?;
        let record = self.0.run_workflow(id, "mcp", storage.as_ref()).await?;
        Ok(serde_json::to_value(record)?)
    }
}
