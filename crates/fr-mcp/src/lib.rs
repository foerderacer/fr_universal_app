//! Dual MCP (Model Context Protocol) subsystem:
//! - Built-in local MCP Server (Streamable HTTP JSON-RPC 2.0 on `127.0.0.1`, exposing FR modules
//!   to external AI clients with Bearer auth, write-approval prompts, and audit logging).
//! - Built-in MCP Client (`StreamableHttp` + `Stdio` transports, OS Keychain tokens, Nextcloud
//!   team server sync, tool discovery, and execution for Automation Workflows & UI testing).
//!
//! Security defaults (per `AGENTS.md`):
//! - MCP Server binds strictly to `127.0.0.1` (loopback only).
//! - Disabled by default until explicitly enabled by the user.
//! - Mutating tools require explicit UI confirmation by default (`require_write_approval = true`).

pub mod client;
pub mod governance;
pub mod server;
pub mod token;
pub mod tools;

use std::net::{IpAddr, Ipv4Addr};

use fr_core::{FrError, FrModule, ModuleCapability, ModuleDescriptor, ModuleStatus, Result};
use serde::{Deserialize, Serialize};
use specta::Type;

pub use client::{
    ExternalMcpServerView, ExternalMcpTool, McpClientManager, McpToolCallOutput,
    TEAM_MCP_SERVERS_CLOUD_PATH, build_client_config_snippet,
};
pub use governance::{
    ApprovalOutcome, McpAuditEntry, McpAuditLog, McpAuditStatus, PendingWriteApproval,
    WriteApprovalGate,
};
pub use server::LocalMcpServer;
pub use token::{
    KeyringMcpTokenStore, LOCAL_SERVER_TOKEN_KEY, McpTokenStore, MemoryMcpTokenStore,
    external_server_token_key, generate_bearer_token,
};
pub use tools::{McpToolHandler, McpToolInfo, McpToolRegistry, register_files_tools};

pub const DEFAULT_MCP_BIND_HOST: &str = "127.0.0.1";
pub const DEFAULT_MCP_PORT: u16 = 38420;

/// Configuration for the built-in local MCP Server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub enabled: bool,
    pub bind_host: String,
    pub port: u16,
    pub require_write_approval: bool,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind_host: DEFAULT_MCP_BIND_HOST.to_owned(),
            port: DEFAULT_MCP_PORT,
            require_write_approval: true,
        }
    }
}

impl McpServerConfig {
    /// Validates security invariants (must bind strictly to a loopback address).
    pub fn validate(&self) -> Result<()> {
        let addr: IpAddr = self.bind_host.parse().map_err(|_| {
            FrError::InvalidConfig(format!("invalid MCP bind host '{}'", self.bind_host))
        })?;
        if !addr.is_loopback() || addr == IpAddr::V4(Ipv4Addr::UNSPECIFIED) {
            return Err(FrError::InvalidConfig(
                "MCP Server must bind strictly to a loopback address (e.g. 127.0.0.1)".into(),
            ));
        }
        Ok(())
    }
}

/// Live runtime status of the built-in local MCP Server returned to the desktop UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub running: bool,
    pub endpoint_url: Option<String>,
    pub config: McpServerConfig,
    pub exposed_tools: Vec<McpToolInfo>,
    pub pending_approvals: u32,
}

/// Transport configuration for an external MCP server connected via the MCP Client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "transport",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExternalMcpTransport {
    Stdio { command: String, args: Vec<String> },
    StreamableHttp { url: String },
}

/// Metadata for an external MCP server registered in the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpServer {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: ExternalMcpTransport,
}

/// Pluggable MCP / AI module descriptor registered in the host [`fr_core::ModuleRegistry`].
#[derive(Debug, Default)]
pub struct McpModule;

impl FrModule for McpModule {
    fn descriptor(&self) -> ModuleDescriptor {
        ModuleDescriptor {
            id: "mcp".into(),
            name: "MCP / AI".into(),
            description:
                "Connect local AI assistants to your workspace and manage external MCP tools."
                    .into(),
            icon: "cpu".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            status: ModuleStatus::Active,
            capabilities: vec![
                ModuleCapability::McpServerTools,
                ModuleCapability::McpClient,
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_mcp_server_is_disabled_and_loopback() {
        let cfg = McpServerConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.bind_host, "127.0.0.1");
        assert!(cfg.require_write_approval);
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn rejects_non_loopback_bind_host() {
        let cfg = McpServerConfig {
            bind_host: "0.0.0.0".into(),
            ..McpServerConfig::default()
        };
        assert!(cfg.validate().is_err());
    }
}
