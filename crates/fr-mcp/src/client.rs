use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use directories::ProjectDirs;
use fr_core::{FrError, Result};
use fr_storage::{CloudPath, StorageBackend};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tempfile::NamedTempFile;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use url::Url;

use crate::token::{McpTokenStore, external_server_token_key};
use crate::{ExternalMcpServer, ExternalMcpTransport};

const MCP_CLIENT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STDIO_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEAM_SYNC_BYTES: u64 = 1024 * 1024;
pub const TEAM_MCP_SERVERS_CLOUD_PATH: &str = "/_FR_App/mcp-servers.json";

/// UI-safe projection of an [`ExternalMcpServer`] (never includes raw secrets; only `has_token`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpServerView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: ExternalMcpTransport,
    pub has_token: bool,
    pub from_team_sync: bool,
}

/// Discovered tool advertised by an external MCP server via `tools/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema_json: String,
}

/// Output returned from calling an external MCP server tool via `tools/call`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallOutput {
    pub server_id: String,
    pub tool_name: String,
    pub is_error: bool,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRegistry {
    servers: Vec<StoredServerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredServerRecord {
    id: String,
    name: String,
    enabled: bool,
    transport: ExternalMcpTransport,
    #[serde(default)]
    from_team_sync: bool,
}

/// Builds a ready-to-paste MCP client configuration snippet for Claude Desktop / Cursor / T3 Code.
pub fn build_client_config_snippet(endpoint_url: &str, bearer_token: &str) -> String {
    let snippet = json!({
        "mcpServers": {
            "fr-universal-app": {
                "url": endpoint_url,
                "headers": {
                    "Authorization": format!("Bearer {bearer_token}")
                }
            }
        }
    });
    serde_json::to_string_pretty(&snippet).unwrap_or_else(|_| "{}".into())
}

fn is_loopback_host(host: &str) -> bool {
    let trimmed = host.trim_matches(|c| c == '[' || c == ']');
    if trimmed.eq_ignore_ascii_case("localhost") {
        return true;
    }
    trimmed
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

fn is_forbidden_ssrf_host(host: &str) -> bool {
    let trimmed = host.trim_matches(|c| c == '[' || c == ']');
    let Ok(ip) = trimmed.parse::<std::net::IpAddr>() else {
        return false;
    };
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_unspecified() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => {
            if let Some(mapped_v4) = v6.to_ipv4_mapped() {
                return mapped_v4.is_unspecified() || mapped_v4.is_link_local();
            }
            v6.is_unspecified() || ((v6.segments()[0] & 0xffc0) == 0xfe80)
        }
    }
}

fn validate_server(server: &ExternalMcpServer) -> Result<()> {
    if server.id.trim().is_empty()
        || !server
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(FrError::InvalidConfig(
            "MCP server ID must contain only letters, digits, hyphens, or underscores".into(),
        ));
    }
    if server.name.trim().is_empty() {
        return Err(FrError::InvalidConfig("MCP server name is required".into()));
    }
    match &server.transport {
        ExternalMcpTransport::Stdio { command, .. } => {
            if command.trim().is_empty() {
                return Err(FrError::InvalidConfig(
                    "Stdio MCP server requires a command executable".into(),
                ));
            }
        }
        ExternalMcpTransport::StreamableHttp { url } => {
            let parsed = Url::parse(url.trim()).map_err(|err| {
                FrError::InvalidConfig(format!("invalid MCP server URL '{url}': {err}"))
            })?;
            let host = parsed.host_str().ok_or_else(|| {
                FrError::InvalidConfig("MCP server URL must include a hostname".into())
            })?;
            if is_forbidden_ssrf_host(host) {
                return Err(FrError::InvalidConfig(
                    "MCP server URL cannot target link-local or unspecified IP addresses".into(),
                ));
            }
            match parsed.scheme() {
                "https" => {}
                "http" if is_loopback_host(host) => {}
                "http" => {
                    return Err(FrError::InvalidConfig(
                        "Remote MCP servers must use https:// so Bearer tokens are never sent in cleartext (http:// is allowed only for localhost/127.0.0.1)".into(),
                    ));
                }
                _ => {
                    return Err(FrError::InvalidConfig(
                        "MCP server URL must start with https:// (or http:// for localhost)".into(),
                    ));
                }
            }
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err(FrError::InvalidConfig(
                    "MCP server URL must not contain embedded credentials; store tokens in OS Keychain"
                        .into(),
                ));
            }
        }
    }
    Ok(())
}

/// Manages external MCP server configurations, OS Keychain tokens, Nextcloud team registry sync,
/// and live `tools/list` + `tools/call` invocations over `StreamableHttp` and `Stdio`.
pub struct McpClientManager {
    store_path: PathBuf,
    token_store: Arc<dyn McpTokenStore>,
    http_client: reqwest::Client,
    records: Mutex<Vec<StoredServerRecord>>,
}

impl std::fmt::Debug for McpClientManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClientManager")
            .field("store_path", &self.store_path)
            .finish()
    }
}

impl McpClientManager {
    pub fn default_store_path() -> Result<PathBuf> {
        let proj = ProjectDirs::from("de", "foerderacer", "FRUniversalApp").ok_or_else(|| {
            FrError::InvalidConfig("unable to resolve OS config directory".into())
        })?;
        Ok(proj.config_dir().join("mcp-servers.json"))
    }

    pub fn open(
        store_path: impl Into<PathBuf>,
        token_store: Arc<dyn McpTokenStore>,
        http_client: reqwest::Client,
    ) -> Result<Self> {
        let store_path = store_path.into();
        let records = match std::fs::read_to_string(&store_path) {
            Ok(raw) => serde_json::from_str::<PersistedRegistry>(&raw)?.servers,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => return Err(FrError::Io(err)),
        };
        Ok(Self {
            store_path,
            token_store,
            http_client,
            records: Mutex::new(records),
        })
    }

    fn persist_locked(&self, records: &[StoredServerRecord]) -> Result<()> {
        let parent = self
            .store_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        let json = serde_json::to_string_pretty(&PersistedRegistry {
            servers: records.to_vec(),
        })?;
        let mut tmp = NamedTempFile::new_in(parent)?;
        tmp.write_all(json.as_bytes())?;
        tmp.as_file().sync_all()?;
        tmp.persist(&self.store_path)
            .map_err(|err| FrError::Io(err.error))?;
        Ok(())
    }

    pub fn list_servers(&self) -> Vec<ExternalMcpServerView> {
        let snapshot = {
            let guard = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.clone()
        };
        snapshot
            .into_iter()
            .map(|r| {
                let has_token = self
                    .token_store
                    .has_token(&external_server_token_key(&r.id));
                ExternalMcpServerView {
                    id: r.id,
                    name: r.name,
                    enabled: r.enabled,
                    transport: r.transport,
                    has_token,
                    from_team_sync: r.from_team_sync,
                }
            })
            .collect()
    }

    pub fn upsert_server(
        &self,
        server: ExternalMcpServer,
        bearer_token: Option<String>,
    ) -> Result<Vec<ExternalMcpServerView>> {
        validate_server(&server)?;
        let server_id = server.id.clone();

        // Persist non-secret registry entry BEFORE writing to OS Keychain so persist failures
        // never leave orphaned credentials behind.
        {
            let mut guard = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut candidate = guard.clone();
            let next = StoredServerRecord {
                id: server.id.clone(),
                name: server.name.trim().to_owned(),
                enabled: server.enabled,
                transport: server.transport,
                from_team_sync: false,
            };
            if let Some(pos) = candidate.iter().position(|r| r.id == server.id) {
                candidate[pos] = next;
            } else {
                candidate.push(next);
            }
            self.persist_locked(&candidate)?;
            *guard = candidate;
        }

        if let Some(tok) = bearer_token {
            let key = external_server_token_key(&server_id);
            if tok.trim().is_empty() {
                self.token_store.delete_token(&key)?;
            } else {
                self.token_store.set_token(&key, tok.trim())?;
            }
        }

        Ok(self.list_servers())
    }

    pub fn delete_server(&self, server_id: &str) -> Result<Vec<ExternalMcpServerView>> {
        self.token_store
            .delete_token(&external_server_token_key(server_id))?;
        {
            let mut guard = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut candidate = guard.clone();
            candidate.retain(|r| r.id != server_id);
            self.persist_locked(&candidate)?;
            *guard = candidate;
        }
        Ok(self.list_servers())
    }

    /// Imports shared team MCP server definitions from Nextcloud (`/_FR_App/mcp-servers.json`).
    ///
    /// Security invariants:
    /// - Every newly imported server (both `Stdio` and `StreamableHttp`) defaults to `enabled: false`
    ///   until explicitly reviewed and enabled by the local user.
    /// - If team sync changes the `transport` (URL or command) of an existing server, it is forced
    ///   `enabled: false` AND its stored OS Keychain Bearer token is cleared to prevent token
    ///   exfiltration to a repointed URL.
    pub async fn sync_from_nextcloud(
        &self,
        storage: &dyn StorageBackend,
    ) -> Result<Vec<ExternalMcpServerView>> {
        let path = CloudPath::parse(TEAM_MCP_SERVERS_CLOUD_PATH)?;
        let meta = storage.stat(&path).await?;
        if meta.size > MAX_TEAM_SYNC_BYTES {
            return Err(FrError::InvalidConfig(
                "Team MCP server registry exceeds 1 MB safety limit".into(),
            ));
        }
        let (bytes, _) = storage.read(&path).await?;
        if bytes.len() as u64 > MAX_TEAM_SYNC_BYTES {
            return Err(FrError::InvalidConfig(
                "Team MCP server registry exceeds 1 MB safety limit".into(),
            ));
        }
        let imported: Vec<ExternalMcpServer> = serde_json::from_slice(&bytes)?;

        // Compute candidate & clear repointed tokens BEFORE persisting the repointed URL so a
        // keychain deletion failure can never leave an old token attached to a new URL.
        let (candidate, tokens_to_clear) = {
            let guard = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut candidate = guard.clone();
            let mut tokens_to_clear: Vec<String> = Vec::new();
            for server in imported {
                if validate_server(&server).is_err() {
                    continue;
                }
                if let Some(existing) = candidate.iter_mut().find(|r| r.id == server.id) {
                    let transport_changed = existing.transport != server.transport;
                    if transport_changed {
                        tokens_to_clear.push(server.id.clone());
                        existing.enabled = false;
                    }
                    existing.name = server.name.trim().to_owned();
                    existing.transport = server.transport;
                    existing.from_team_sync = true;
                } else {
                    candidate.push(StoredServerRecord {
                        id: server.id,
                        name: server.name.trim().to_owned(),
                        enabled: false,
                        transport: server.transport,
                        from_team_sync: true,
                    });
                }
            }
            (candidate, tokens_to_clear)
        };

        for id in tokens_to_clear {
            self.token_store
                .delete_token(&external_server_token_key(&id))?;
        }

        {
            let mut guard = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.persist_locked(&candidate)?;
            *guard = candidate;
        }

        Ok(self.list_servers())
    }

    fn get_enabled_record(&self, server_id: &str) -> Result<StoredServerRecord> {
        let guard = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let rec = guard
            .iter()
            .find(|r| r.id == server_id)
            .cloned()
            .ok_or_else(|| FrError::NotFound(format!("MCP server '{server_id}'")))?;
        if !rec.enabled {
            return Err(FrError::InvalidConfig(format!(
                "MCP server '{}' is disabled — enable it first before connecting",
                rec.name
            )));
        }
        Ok(rec)
    }

    pub async fn discover_tools(&self, server_id: &str) -> Result<Vec<ExternalMcpTool>> {
        let rec = self.get_enabled_record(server_id)?;
        let result = self.rpc_call(&rec, "tools/list", json!({})).await?;

        let raw_tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        Ok(raw_tools
            .into_iter()
            .filter_map(|t| {
                let name = t.get("name")?.as_str()?.to_owned();
                let description = t
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let schema = t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
                Some(ExternalMcpTool {
                    name,
                    description,
                    input_schema_json: serde_json::to_string_pretty(&schema)
                        .unwrap_or_else(|_| "{}".into()),
                })
            })
            .collect())
    }

    pub async fn call_tool(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: Value,
    ) -> Result<McpToolCallOutput> {
        let rec = self.get_enabled_record(server_id)?;
        let result = self
            .rpc_call(
                &rec,
                "tools/call",
                json!({
                    "name": tool_name,
                    "arguments": arguments
                }),
            )
            .await?;

        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let text = if let Some(items) = result.get("content").and_then(Value::as_array) {
            items
                .iter()
                .filter_map(|c| c.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string())
        };

        Ok(McpToolCallOutput {
            server_id: rec.id,
            tool_name: tool_name.to_owned(),
            is_error,
            text,
        })
    }

    async fn rpc_call(
        &self,
        rec: &StoredServerRecord,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        // Re-validate transport at connect time so pre-existing records cannot bypass HTTPS/SSRF rules.
        validate_server(&ExternalMcpServer {
            id: rec.id.clone(),
            name: rec.name.clone(),
            enabled: rec.enabled,
            transport: rec.transport.clone(),
        })?;
        match &rec.transport {
            ExternalMcpTransport::StreamableHttp { url } => {
                let token = self
                    .token_store
                    .get_token(&external_server_token_key(&rec.id))?;
                self.call_http(url, token.as_deref(), method, params).await
            }
            ExternalMcpTransport::Stdio { command, args } => {
                self.call_stdio(command, args, method, params).await
            }
        }
    }

    async fn call_http(
        &self,
        url: &str,
        token: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let init_req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "fr-universal-app", "version": env!("CARGO_PKG_VERSION") }
            }
        });

        let mut init_builder = self
            .http_client
            .post(url)
            .timeout(MCP_CLIENT_TIMEOUT)
            .header("Accept", "application/json, text/event-stream")
            .json(&init_req);
        if let Some(tok) = token {
            init_builder = init_builder.bearer_auth(tok);
        }
        let init_resp = init_builder
            .send()
            .await
            .map_err(|err| FrError::Network(format!("MCP server unreachable: {err}")))?;
        if init_resp.status().as_u16() == 401 || init_resp.status().as_u16() == 403 {
            return Err(FrError::AuthRequired(
                "External MCP server rejected the configured Bearer token".into(),
            ));
        }
        if !init_resp.status().is_success() {
            return Err(FrError::Network(format!(
                "External MCP initialize failed with HTTP {}",
                init_resp.status().as_u16()
            )));
        }
        let session_id = init_resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(ToOwned::to_owned);

        // Send notifications/initialized (best-effort per MCP spec).
        let mut notif = self
            .http_client
            .post(url)
            .timeout(MCP_CLIENT_TIMEOUT)
            .json(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        if let Some(tok) = token {
            notif = notif.bearer_auth(tok);
        }
        if let Some(ref sid) = session_id {
            notif = notif.header("Mcp-Session-Id", sid);
        }
        let _ = notif.send().await;

        let mut call_builder = self
            .http_client
            .post(url)
            .timeout(MCP_CLIENT_TIMEOUT)
            .header("Accept", "application/json, text/event-stream")
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": method,
                "params": params
            }));
        if let Some(tok) = token {
            call_builder = call_builder.bearer_auth(tok);
        }
        if let Some(ref sid) = session_id {
            call_builder = call_builder.header("Mcp-Session-Id", sid);
        }
        let resp = call_builder
            .send()
            .await
            .map_err(|err| FrError::Network(format!("MCP call failed: {err}")))?;
        if !resp.status().is_success() {
            return Err(FrError::Network(format!(
                "External MCP '{method}' failed with HTTP {}",
                resp.status().as_u16()
            )));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let raw_bytes = read_bounded_http_body(resp, MAX_HTTP_RESPONSE_BYTES).await?;
        let raw = String::from_utf8_lossy(&raw_bytes);

        let rpc_val =
            parse_http_or_sse_json_rpc(&raw, content_type.contains("text/event-stream"), 2)?;
        extract_json_rpc_result(rpc_val)
    }

    async fn call_stdio(
        &self,
        command: &str,
        args: &[String],
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let resolved = resolve_stdio_command(command);
        let mut child = Command::new(&resolved)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| {
                FrError::Other(format!(
                    "failed to start stdio MCP process '{command}': {err}"
                ))
            })?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| FrError::Other("failed to open stdio MCP stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| FrError::Other("failed to open stdio MCP stdout".into()))?;
        let mut reader = BufReader::new(stdout);

        let exchange = async {
            let init_line = serde_json::to_string(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": { "name": "fr-universal-app", "version": env!("CARGO_PKG_VERSION") }
                }
            }))?;
            stdin.write_all(init_line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;

            let _ = read_json_rpc_line(&mut reader, 1).await?;

            let notif_line = serde_json::to_string(
                &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            )?;
            stdin.write_all(notif_line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;

            let req_line = serde_json::to_string(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": method,
                "params": params
            }))?;
            stdin.write_all(req_line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;

            read_json_rpc_line(&mut reader, 2).await
        };

        let result = tokio::time::timeout(MCP_CLIENT_TIMEOUT, exchange)
            .await
            .map_err(|_| FrError::Network("stdio MCP server timed out".into()))?;
        let _ = child.kill().await;
        extract_json_rpc_result(result?)
    }
}

async fn read_bounded_http_body(mut resp: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>> {
    if let Some(len) = resp.content_length()
        && len as usize > max_bytes
    {
        return Err(FrError::Other(
            "External MCP server response exceeded 8 MB safety limit".into(),
        ));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|err| FrError::Network(format!("failed reading MCP response: {err}")))?
    {
        if buf.len().saturating_add(chunk.len()) > max_bytes {
            return Err(FrError::Other(
                "External MCP server response exceeded 8 MB safety limit".into(),
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// Resolves bare command names on Windows against `PATH` + `PATHEXT` so launchers such as `npx`
/// (`npx.cmd`) work identically to macOS without requiring a shell wrapper.
fn resolve_stdio_command(command: &str) -> String {
    #[cfg(windows)]
    {
        let p = Path::new(command);
        if p.extension().is_none() && !p.is_absolute() && !command.contains(['\\', '/']) {
            let pathext =
                std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
            let exts: Vec<&str> = pathext.split(';').filter(|e| !e.is_empty()).collect();
            if let Some(path_env) = std::env::var_os("PATH") {
                for dir in std::env::split_paths(&path_env) {
                    for ext in &exts {
                        let candidate = dir.join(format!("{command}{ext}"));
                        if candidate.is_file() {
                            return candidate.to_string_lossy().into_owned();
                        }
                    }
                }
            }
        }
    }
    command.to_owned()
}

async fn read_json_rpc_line(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    expected_id: i64,
) -> Result<Value> {
    loop {
        let mut buf = Vec::new();
        let mut total = 0usize;
        loop {
            let n = reader.read_until(b'\n', &mut buf).await?;
            if n == 0 {
                return Err(FrError::Other(
                    "stdio MCP server closed stdout before replying".into(),
                ));
            }
            total += n;
            if total > MAX_STDIO_LINE_BYTES {
                return Err(FrError::Other(
                    "stdio MCP server response exceeded 2 MB limit".into(),
                ));
            }
            if buf.ends_with(b"\n") {
                break;
            }
        }
        let line = String::from_utf8_lossy(&buf);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<Value>(trimmed)
            && val.get("id").and_then(Value::as_i64) == Some(expected_id)
        {
            return Ok(val);
        }
    }
}

fn parse_http_or_sse_json_rpc(raw: &str, is_sse: bool, expected_id: i64) -> Result<Value> {
    if !is_sse {
        return serde_json::from_str(raw)
            .map_err(|err| FrError::Other(format!("invalid JSON-RPC response: {err}")));
    }
    let mut fallback: Option<Value> = None;
    for line in raw.lines() {
        if let Some(payload) = line.strip_prefix("data:") {
            let trimmed = payload.trim();
            if trimmed.is_empty() || trimmed == "[DONE]" {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                if val.get("id").and_then(Value::as_i64) == Some(expected_id) {
                    return Ok(val);
                }
                fallback = Some(val);
            }
        }
    }
    fallback.ok_or_else(|| FrError::Other("SSE response contained no JSON-RPC data event".into()))
}

fn extract_json_rpc_result(rpc: Value) -> Result<Value> {
    if let Some(err) = rpc.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP JSON-RPC error");
        return Err(FrError::Other(msg.to_owned()));
    }
    rpc.get("result")
        .cloned()
        .ok_or_else(|| FrError::Other("MCP JSON-RPC response missing 'result' field".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use fr_preview::SharedBackendSlot;
    use fr_storage::LocalFsBackend;
    use std::sync::RwLock;
    use tempfile::tempdir;

    use crate::McpServerConfig;
    use crate::governance::{McpAuditLog, WriteApprovalGate};
    use crate::server::LocalMcpServer;
    use crate::token::MemoryMcpTokenStore;
    use crate::tools::{McpToolRegistry, register_files_tools};

    #[tokio::test]
    async fn mcp_client_discovers_and_calls_streamable_http_server() {
        let data_dir = tempdir().expect("data");
        let cfg_dir = tempdir().expect("cfg");
        let local = Arc::new(LocalFsBackend::new(data_dir.path()));
        local
            .write(
                &CloudPath::parse("/readme.md").unwrap(),
                Bytes::from_static(b"# Hello MCP Client"),
                None,
            )
            .await
            .unwrap();

        let slot: SharedBackendSlot = Arc::new(RwLock::new(Some(local.clone())));
        let registry = Arc::new(McpToolRegistry::new());
        register_files_tools(&registry, slot.clone());

        let token = "client-e2e-token-123".to_owned();
        let server = LocalMcpServer::start(
            &McpServerConfig {
                enabled: true,
                bind_host: "127.0.0.1".into(),
                port: 0,
                require_write_approval: false,
            },
            token.clone(),
            registry,
            slot,
            Arc::new(McpAuditLog::new()),
            Arc::new(WriteApprovalGate::new()),
        )
        .await
        .unwrap();

        let token_store = Arc::new(MemoryMcpTokenStore::new());
        let client_mgr = McpClientManager::open(
            cfg_dir.path().join("mcp-servers.json"),
            token_store,
            reqwest::Client::new(),
        )
        .unwrap();

        let servers = client_mgr
            .upsert_server(
                ExternalMcpServer {
                    id: "local-loopback".into(),
                    name: "Local FR Loopback".into(),
                    enabled: true,
                    transport: ExternalMcpTransport::StreamableHttp {
                        url: server.endpoint_url(),
                    },
                },
                Some(token),
            )
            .unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers[0].has_token);

        let tools = client_mgr.discover_tools("local-loopback").await.unwrap();
        assert!(tools.iter().any(|t| t.name == "files_read_markdown"));

        let output = client_mgr
            .call_tool(
                "local-loopback",
                "files_read_markdown",
                json!({ "path": "/readme.md" }),
            )
            .await
            .unwrap();
        assert!(!output.is_error);
        assert!(output.text.contains("# Hello MCP Client"));
    }

    #[tokio::test]
    async fn team_sync_disables_newly_imported_stdio_servers_by_default() {
        let data_dir = tempdir().expect("data");
        let cfg_dir = tempdir().expect("cfg");
        let local = LocalFsBackend::new(data_dir.path());
        let team_json = serde_json::to_vec(&vec![
            ExternalMcpServer {
                id: "team-http".into(),
                name: "Team ERP".into(),
                enabled: true,
                transport: ExternalMcpTransport::StreamableHttp {
                    url: "https://mcp.example.com/mcp".into(),
                },
            },
            ExternalMcpServer {
                id: "team-stdio".into(),
                name: "Untrusted Local Binary".into(),
                enabled: true,
                transport: ExternalMcpTransport::Stdio {
                    command: "evil-bin".into(),
                    args: vec![],
                },
            },
        ])
        .unwrap();
        local
            .write(
                &CloudPath::parse(TEAM_MCP_SERVERS_CLOUD_PATH).unwrap(),
                Bytes::from(team_json),
                None,
            )
            .await
            .unwrap();

        let token_store = Arc::new(MemoryMcpTokenStore::new());
        let mgr = McpClientManager::open(
            cfg_dir.path().join("mcp-servers.json"),
            token_store.clone(),
            reqwest::Client::new(),
        )
        .unwrap();

        let synced = mgr.sync_from_nextcloud(&local).await.unwrap();
        let http = synced.iter().find(|s| s.id == "team-http").unwrap();
        let stdio = synced.iter().find(|s| s.id == "team-stdio").unwrap();
        assert!(
            !http.enabled,
            "newly synced HTTP servers must default to disabled"
        );
        assert!(
            !stdio.enabled,
            "synced stdio servers MUST default to disabled"
        );

        // Enable team-http with a Bearer token, then simulate a malicious URL repoint in Nextcloud.
        mgr.upsert_server(
            ExternalMcpServer {
                id: "team-http".into(),
                name: "Team ERP".into(),
                enabled: true,
                transport: ExternalMcpTransport::StreamableHttp {
                    url: "https://mcp.example.com/mcp".into(),
                },
            },
            Some("secret-erp-token".into()),
        )
        .unwrap();
        assert!(token_store.has_token(&external_server_token_key("team-http")));

        let repointed_json = serde_json::to_vec(&vec![ExternalMcpServer {
            id: "team-http".into(),
            name: "Team ERP".into(),
            enabled: true,
            transport: ExternalMcpTransport::StreamableHttp {
                url: "https://attacker.example/mcp".into(),
            },
        }])
        .unwrap();
        local
            .write(
                &CloudPath::parse(TEAM_MCP_SERVERS_CLOUD_PATH).unwrap(),
                Bytes::from(repointed_json),
                None,
            )
            .await
            .unwrap();

        let after_repoint = mgr.sync_from_nextcloud(&local).await.unwrap();
        let repointed = after_repoint.iter().find(|s| s.id == "team-http").unwrap();
        assert!(
            !repointed.enabled,
            "URL change on team sync must disable server"
        );
        assert!(
            !repointed.has_token,
            "URL change on team sync must clear stored token"
        );
    }

    #[test]
    fn rejects_remote_cleartext_http_and_link_local_ssrf() {
        assert!(
            validate_server(&ExternalMcpServer {
                id: "remote-http".into(),
                name: "Cleartext".into(),
                enabled: true,
                transport: ExternalMcpTransport::StreamableHttp {
                    url: "http://mcp.company.example/mcp".into(),
                },
            })
            .is_err()
        );
        assert!(
            validate_server(&ExternalMcpServer {
                id: "metadata".into(),
                name: "Cloud Meta".into(),
                enabled: true,
                transport: ExternalMcpTransport::StreamableHttp {
                    url: "https://169.254.169.254/latest".into(),
                },
            })
            .is_err()
        );
        assert!(
            validate_server(&ExternalMcpServer {
                id: "local-dev".into(),
                name: "Localhost".into(),
                enabled: true,
                transport: ExternalMcpTransport::StreamableHttp {
                    url: "http://127.0.0.1:38420/mcp".into(),
                },
            })
            .is_ok()
        );
    }
}
