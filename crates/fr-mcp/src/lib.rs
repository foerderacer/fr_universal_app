//! Dual MCP (Model Context Protocol) subsystem:
//! - Built-in local MCP Server (exposes FR modules to external AI clients).
//! - Built-in MCP Client (lets automation workflows and modules call external MCP servers).
//!
//! Security defaults (per `AGENTS.md`):
//! - MCP Server binds strictly to `127.0.0.1` (loopback only).
//! - Disabled by default until explicitly enabled by the user.

use std::net::{IpAddr, Ipv4Addr};

use fr_core::{FrError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;

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
