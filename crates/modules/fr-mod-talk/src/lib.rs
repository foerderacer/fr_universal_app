//! Nextcloud Talk domain module (`FrModule`) exposing team chat & file-reference messaging
//! to the desktop workspace shell and built-in local MCP Server.

use std::sync::Arc;

use async_trait::async_trait;
use fr_core::{FrError, FrModule, ModuleCapability, ModuleDescriptor, ModuleStatus, Result};
use fr_mcp::{McpToolHandler, McpToolRegistry};
use fr_nextcloud::NextcloudCredentials;
use fr_talk::TalkClient;
use serde_json::{Value, json};

/// Pluggable Nextcloud Talk module descriptor registered in [`fr_core::ModuleRegistry`].
#[derive(Debug, Default)]
pub struct TalkModule;

impl FrModule for TalkModule {
    fn descriptor(&self) -> ModuleDescriptor {
        ModuleDescriptor {
            id: "talk".into(),
            name: "Talk".into(),
            description: "Team group chat via Nextcloud Talk with zero-copy cloud file references."
                .into(),
            icon: "message".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            status: ModuleStatus::Active,
            capabilities: vec![
                ModuleCapability::Chat,
                ModuleCapability::Storage,
                ModuleCapability::Preview,
                ModuleCapability::McpServerTools,
            ],
        }
    }
}

/// Callback returning the active Nextcloud credentials for Talk MCP tool calls.
pub type CredentialsProvider = Arc<dyn Fn() -> Option<NextcloudCredentials> + Send + Sync>;

/// Registers `talk_*` tools in the built-in local MCP Server.
pub fn register_talk_tools(
    registry: &McpToolRegistry,
    http: reqwest::Client,
    creds_provider: CredentialsProvider,
) {
    registry.register(TalkListRoomsTool(http.clone(), creds_provider.clone()));
    registry.register(TalkGetMessagesTool(http.clone(), creds_provider.clone()));
    registry.register(TalkSendMessageTool(http, creds_provider));
}

fn require_client(http: &reqwest::Client, provider: &CredentialsProvider) -> Result<TalkClient> {
    let creds =
        provider().ok_or_else(|| FrError::AuthRequired("Nextcloud is not signed in".into()))?;
    Ok(TalkClient::new(http.clone(), creds))
}

struct TalkListRoomsTool(reqwest::Client, CredentialsProvider);

#[async_trait]
impl McpToolHandler for TalkListRoomsTool {
    fn name(&self) -> &str {
        "talk_list_rooms"
    }
    fn description(&self) -> &str {
        "List Nextcloud Talk conversations the signed-in user belongs to."
    }
    fn module_id(&self) -> &str {
        "talk"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    fn summarize_audit(&self, _args: &Value) -> String {
        "List Talk conversations".into()
    }
    async fn call(&self, _args: Value) -> Result<Value> {
        let client = require_client(&self.0, &self.1)?;
        let page = client.list_rooms(None).await?;
        Ok(serde_json::to_value(page.rooms)?)
    }
}

struct TalkGetMessagesTool(reqwest::Client, CredentialsProvider);

#[async_trait]
impl McpToolHandler for TalkGetMessagesTool {
    fn name(&self) -> &str {
        "talk_get_messages"
    }
    fn description(&self) -> &str {
        "Read recent messages from a Nextcloud Talk conversation by room token."
    }
    fn module_id(&self) -> &str {
        "talk"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["token"],
            "properties": {
                "token": { "type": "string", "description": "Talk conversation token." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 30 }
            }
        })
    }
    fn summarize_audit(&self, _args: &Value) -> String {
        "Read Talk messages".into()
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let token = args
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| FrError::InvalidInput("Missing required field 'token'.".into()))?;
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(30)
            .clamp(1, 100);
        let client = require_client(&self.0, &self.1)?;
        let page = client.fetch_messages(token, false, None, limit, 10).await?;
        Ok(serde_json::to_value(page.messages)?)
    }
}

struct TalkSendMessageTool(reqwest::Client, CredentialsProvider);

#[async_trait]
impl McpToolHandler for TalkSendMessageTool {
    fn name(&self) -> &str {
        "talk_send_message"
    }
    fn description(&self) -> &str {
        "Send a chat message to a Nextcloud Talk conversation (requires user approval)."
    }
    fn module_id(&self) -> &str {
        "talk"
    }
    fn is_write(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["token", "message"],
            "properties": {
                "token": { "type": "string", "description": "Talk conversation token." },
                "message": { "type": "string", "maxLength": 32000 },
                "reply_to": { "type": "integer", "description": "Optional parent message ID to reply to." }
            }
        })
    }
    fn summarize_audit(&self, _args: &Value) -> String {
        "Send Talk chat message".into()
    }
    fn summarize_approval(&self, args: &Value) -> String {
        let token = args.get("token").and_then(Value::as_str).unwrap_or("?");
        let preview: String = args
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(80)
            .collect();
        format!("Send Talk message to room '{token}': \"{preview}\"")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let token = args
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| FrError::InvalidInput("Missing required field 'token'.".into()))?;
        let message = args
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(|| FrError::InvalidInput("Missing required field 'message'.".into()))?;
        let reply_to = args.get("reply_to").and_then(Value::as_i64);
        let client = require_client(&self.0, &self.1)?;
        let sent = client.send_message(token, message, reply_to, None).await?;
        Ok(serde_json::to_value(sent)?)
    }
}
