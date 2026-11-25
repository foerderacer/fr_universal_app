use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::Utc;
use fr_core::{FrError, Result};
use fr_mod_files::FilesService;
use fr_preview::SharedBackendSlot;
use fr_storage::{CloudPath, FileKind};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::McpServerConfig;
use crate::governance::{
    ApprovalOutcome, McpAuditEntry, McpAuditLog, McpAuditStatus, WriteApprovalGate,
};
use crate::tools::McpToolRegistry;

const MAX_RPC_BODY_BYTES: usize = 4 * 1024 * 1024;
const MCP_PROTOCOL_VERSION: &str = "2025-03-26";
const WRITE_APPROVAL_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone)]
struct ServerState {
    bearer_token: String,
    require_write_approval: Arc<AtomicBool>,
    registry: Arc<McpToolRegistry>,
    storage_slot: SharedBackendSlot,
    audit: Arc<McpAuditLog>,
    approvals: Arc<WriteApprovalGate>,
}

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

/// Built-in local Streamable HTTP MCP Server (`127.0.0.1:<port>/mcp`).
///
/// Enforces:
/// - Loopback-only bind (`127.0.0.1` / `::1`)
/// - Constant-time `Authorization: Bearer <token>` validation
/// - DNS rebinding protection (`Host` and `Origin` header validation)
/// - Interactive write-approval gate + audit logging
pub struct LocalMcpServer {
    addr: SocketAddr,
    require_write_approval: Arc<AtomicBool>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl std::fmt::Debug for LocalMcpServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalMcpServer")
            .field("addr", &self.addr)
            .finish()
    }
}

impl Drop for LocalMcpServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.task.abort();
    }
}

impl LocalMcpServer {
    pub async fn start(
        config: &McpServerConfig,
        bearer_token: String,
        registry: Arc<McpToolRegistry>,
        storage_slot: SharedBackendSlot,
        audit: Arc<McpAuditLog>,
        approvals: Arc<WriteApprovalGate>,
    ) -> Result<Self> {
        config.validate()?;
        if bearer_token.trim().is_empty() {
            return Err(FrError::InvalidConfig(
                "MCP Server requires a non-empty Bearer token".into(),
            ));
        }

        let require_write_approval = Arc::new(AtomicBool::new(config.require_write_approval));
        let state = ServerState {
            bearer_token,
            require_write_approval: require_write_approval.clone(),
            registry,
            storage_slot,
            audit,
            approvals,
        };

        let app = Router::new()
            .route("/mcp", post(handle_mcp_post).delete(handle_mcp_delete))
            .route("/health", get(handle_health))
            .layer(DefaultBodyLimit::max(MAX_RPC_BODY_BYTES))
            .with_state(state);

        let ip: std::net::IpAddr = config.bind_host.parse().map_err(|_| {
            FrError::InvalidConfig(format!("invalid MCP bind host '{}'", config.bind_host))
        })?;
        let bind_addr = SocketAddr::new(ip, config.port);
        let listener = TcpListener::bind(bind_addr).await.map_err(|err| {
            FrError::Other(format!(
                "failed to bind local MCP Server on {bind_addr}: {err}"
            ))
        })?;
        let addr = listener
            .local_addr()
            .map_err(|err| FrError::Other(format!("failed to read MCP listener addr: {err}")))?;

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let server = axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            let _ = server.await;
        });

        Ok(Self {
            addr,
            require_write_approval,
            shutdown_tx: Some(shutdown_tx),
            task,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn endpoint_url(&self) -> String {
        format!("http://{}/mcp", self.addr)
    }

    pub fn set_require_write_approval(&self, require: bool) {
        self.require_write_approval.store(require, Ordering::SeqCst);
    }

    pub fn require_write_approval(&self) -> bool {
        self.require_write_approval.load(Ordering::SeqCst)
    }

    pub fn stop(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.task.abort();
    }
}

fn verify_bearer(headers: &HeaderMap, expected_token: &str) -> bool {
    let Some(raw) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some((scheme, rest)) = raw.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return false;
    }
    let supplied = rest.trim();
    supplied.len() == expected_token.len()
        && bool::from(supplied.as_bytes().ct_eq(expected_token.as_bytes()))
}

fn is_valid_loopback_host(headers: &HeaderMap) -> bool {
    let Some(raw) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let host = if let Some(rest) = raw.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        raw.split(':').next().unwrap_or("")
    };
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

fn is_allowed_origin(headers: &HeaderMap) -> bool {
    let Some(raw) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        // Non-browser MCP clients (CLI, Claude Desktop, Cursor, T3 Code) omit Origin.
        return true;
    };
    let Ok(parsed) = url::Url::parse(raw) else {
        return false;
    };
    match parsed.scheme() {
        "tauri" => parsed.host_str() == Some("localhost"),
        "http" | "https" => matches!(
            parsed.host_str(),
            Some("127.0.0.1" | "localhost" | "::1" | "tauri.localhost")
        ),
        _ => false,
    }
}

fn with_security_headers(mut resp: Response) -> Response {
    let headers = resp.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    resp
}

fn json_rpc_ok(id: Value, result: Value) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    });
    with_security_headers((StatusCode::OK, axum::Json(body)).into_response())
}

fn json_rpc_error(id: Value, code: i64, message: impl Into<String>) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into()
        }
    });
    with_security_headers((StatusCode::OK, axum::Json(body)).into_response())
}

async fn handle_health(headers: HeaderMap) -> Response {
    if !is_valid_loopback_host(&headers) || !is_allowed_origin(&headers) {
        return with_security_headers(StatusCode::FORBIDDEN.into_response());
    }
    with_security_headers(
        (
            StatusCode::OK,
            axum::Json(json!({ "status": "ok", "protocol": MCP_PROTOCOL_VERSION })),
        )
            .into_response(),
    )
}

async fn handle_mcp_delete(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !is_valid_loopback_host(&headers) || !is_allowed_origin(&headers) {
        return with_security_headers(StatusCode::FORBIDDEN.into_response());
    }
    if !verify_bearer(&headers, &state.bearer_token) {
        return unauthorized_response();
    }
    with_security_headers(StatusCode::NO_CONTENT.into_response())
}

fn unauthorized_response() -> Response {
    let mut resp = (
        StatusCode::UNAUTHORIZED,
        axum::Json(json!({ "error": "Unauthorized: valid Bearer token required" })),
    )
        .into_response();
    resp.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Bearer realm=\"fr-universal-app-mcp\""),
    );
    with_security_headers(resp)
}

async fn handle_mcp_post(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if !is_valid_loopback_host(&headers) || !is_allowed_origin(&headers) {
        return with_security_headers(StatusCode::FORBIDDEN.into_response());
    }
    if !verify_bearer(&headers, &state.bearer_token) {
        return unauthorized_response();
    }

    let req: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(err) => {
            return json_rpc_error(Value::Null, -32700, format!("Parse error: {err}"));
        }
    };

    // Notifications omit `id` and expect 202 Accepted with empty body per MCP Streamable HTTP.
    let Some(id) = req.id else {
        return with_security_headers(StatusCode::ACCEPTED.into_response());
    };

    match req.method.as_str() {
        "initialize" => {
            let mut resp = json_rpc_ok(
                id,
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {
                        "tools": { "listChanged": false },
                        "resources": { "subscribe": false, "listChanged": false }
                    },
                    "serverInfo": {
                        "name": "fr-universal-app",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            );
            if let Ok(val) = HeaderValue::from_str(&Uuid::new_v4().to_string()) {
                resp.headers_mut().insert("mcp-session-id", val);
            }
            resp
        }
        "ping" => json_rpc_ok(id, json!({})),
        "tools/list" => json_rpc_ok(
            id,
            json!({ "tools": state.registry.list_mcp_protocol_tools() }),
        ),
        "tools/call" => handle_tool_call(&state, id, req.params).await,
        "resources/list" => handle_resources_list(&state, id).await,
        "resources/read" => handle_resources_read(&state, id, req.params).await,
        other => json_rpc_error(id, -32601, format!("Method not found: {other}")),
    }
}

async fn handle_tool_call(state: &ServerState, id: Value, params: Value) -> Response {
    let Some(tool_name) = params.get("name").and_then(Value::as_str) else {
        return json_rpc_error(id, -32602, "Missing required parameter 'name'");
    };
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let Some(handler) = state.registry.get(tool_name) else {
        return json_rpc_error(id, -32602, format!("Unknown tool: {tool_name}"));
    };

    let started = Instant::now();
    let is_write = handler.is_write();
    let summary = handler.summarize_call(&args);

    if is_write && state.require_write_approval.load(Ordering::SeqCst) {
        match state
            .approvals
            .request_approval(tool_name, summary.clone(), WRITE_APPROVAL_TIMEOUT)
            .await
        {
            ApprovalOutcome::Approved => {}
            ApprovalOutcome::Denied => {
                state.audit.record(McpAuditEntry {
                    id: Uuid::new_v4().to_string(),
                    timestamp: Utc::now(),
                    tool_name: tool_name.to_owned(),
                    summary,
                    is_write,
                    status: McpAuditStatus::Denied,
                    duration_ms: started.elapsed().as_millis() as u32,
                    error: Some("Denied by user".into()),
                });
                return json_rpc_ok(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": "Write operation denied by the desktop user." }],
                        "isError": true
                    }),
                );
            }
            ApprovalOutcome::QueueFull => {
                state.audit.record(McpAuditEntry {
                    id: Uuid::new_v4().to_string(),
                    timestamp: Utc::now(),
                    tool_name: tool_name.to_owned(),
                    summary,
                    is_write,
                    status: McpAuditStatus::Denied,
                    duration_ms: started.elapsed().as_millis() as u32,
                    error: Some("Too many pending write approvals".into()),
                });
                return json_rpc_ok(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": "Too many pending write approvals — resolve existing prompts first." }],
                        "isError": true
                    }),
                );
            }
            ApprovalOutcome::TimedOut => {
                state.audit.record(McpAuditEntry {
                    id: Uuid::new_v4().to_string(),
                    timestamp: Utc::now(),
                    tool_name: tool_name.to_owned(),
                    summary,
                    is_write,
                    status: McpAuditStatus::TimedOut,
                    duration_ms: started.elapsed().as_millis() as u32,
                    error: Some("Approval request timed out".into()),
                });
                return json_rpc_ok(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": "Write approval timed out waiting for user confirmation." }],
                        "isError": true
                    }),
                );
            }
        }
    }

    match handler.call(args).await {
        Ok(value) => {
            let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
            state.audit.record(McpAuditEntry {
                id: Uuid::new_v4().to_string(),
                timestamp: Utc::now(),
                tool_name: tool_name.to_owned(),
                summary,
                is_write,
                status: McpAuditStatus::Allowed,
                duration_ms: started.elapsed().as_millis() as u32,
                error: None,
            });
            json_rpc_ok(
                id,
                json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": false
                }),
            )
        }
        Err(err) => {
            let msg = err.to_string();
            state.audit.record(McpAuditEntry {
                id: Uuid::new_v4().to_string(),
                timestamp: Utc::now(),
                tool_name: tool_name.to_owned(),
                summary,
                is_write,
                status: McpAuditStatus::Failed,
                duration_ms: started.elapsed().as_millis() as u32,
                error: Some(msg.clone()),
            });
            json_rpc_ok(
                id,
                json!({
                    "content": [{ "type": "text", "text": msg }],
                    "isError": true
                }),
            )
        }
    }
}

async fn handle_resources_list(state: &ServerState, id: Value) -> Response {
    let storage = state.storage_slot.read().ok().and_then(|g| g.clone());
    let Some(storage) = storage else {
        return json_rpc_ok(id, json!({ "resources": [] }));
    };
    let service = FilesService::new(storage);
    let items = service
        .search_folder("/", ".md", 2)
        .await
        .unwrap_or_default();
    let resources: Vec<Value> = items
        .into_iter()
        .filter(|i| i.entry.kind == FileKind::File)
        .take(50)
        .map(|i| {
            json!({
                "uri": format!("nextcloud://{}", i.entry.path.as_str()),
                "name": i.entry.name,
                "mimeType": "text/markdown"
            })
        })
        .collect();
    json_rpc_ok(id, json!({ "resources": resources }))
}

async fn handle_resources_read(state: &ServerState, id: Value, params: Value) -> Response {
    let Some(uri) = params.get("uri").and_then(Value::as_str) else {
        return json_rpc_error(id, -32602, "Missing required parameter 'uri'");
    };
    let Some(raw_path) = uri.strip_prefix("nextcloud://") else {
        return json_rpc_error(id, -32602, "Unsupported resource URI scheme");
    };
    let Ok(cloud_path) = CloudPath::parse(raw_path) else {
        return json_rpc_error(id, -32602, "Invalid cloud path in resource URI");
    };
    let storage = state.storage_slot.read().ok().and_then(|g| g.clone());
    let Some(storage) = storage else {
        return json_rpc_error(id, -32002, "Nextcloud is not signed in");
    };
    let service = FilesService::new(storage);
    match service.read_markdown(cloud_path.as_str()).await {
        Ok((path, content, _)) => json_rpc_ok(
            id,
            json!({
                "contents": [{
                    "uri": format!("nextcloud://{}", path.as_str()),
                    "mimeType": "text/markdown",
                    "text": content
                }]
            }),
        ),
        Err(err) => json_rpc_error(id, -32000, err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use fr_storage::{LocalFsBackend, StorageBackend};
    use std::sync::RwLock;
    use tempfile::tempdir;

    use crate::tools::register_files_tools;

    #[tokio::test]
    async fn mcp_server_enforces_auth_dns_rebinding_and_executes_files_tools() {
        let dir = tempdir().expect("tempdir");
        let local = Arc::new(LocalFsBackend::new(dir.path()));
        local
            .write(
                &CloudPath::parse("/handbook.md").unwrap(),
                Bytes::from_static(b"# Team Handbook\nWelcome!"),
                None,
            )
            .await
            .unwrap();

        let slot: SharedBackendSlot = Arc::new(RwLock::new(Some(local)));
        let registry = Arc::new(McpToolRegistry::new());
        register_files_tools(&registry, slot.clone());
        let audit = Arc::new(McpAuditLog::new());
        let approvals = Arc::new(WriteApprovalGate::new());

        let cfg = McpServerConfig {
            enabled: true,
            bind_host: "127.0.0.1".into(),
            port: 0,
            require_write_approval: true,
        };
        let token = "test-secret-token-256bit".to_owned();
        let server = LocalMcpServer::start(
            &cfg,
            token.clone(),
            registry,
            slot,
            audit.clone(),
            approvals.clone(),
        )
        .await
        .unwrap();
        assert!(server.addr().ip().is_loopback());

        let client = reqwest::Client::new();
        let url = server.endpoint_url();

        // 1. Missing Bearer token -> 401
        let unauth = client
            .post(&url)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status(), reqwest::StatusCode::UNAUTHORIZED);

        // 2. Cross-origin browser request -> 403
        let bad_origin = client
            .post(&url)
            .header("Origin", "https://evil.example")
            .bearer_auth(&token)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .send()
            .await
            .unwrap();
        assert_eq!(bad_origin.status(), reqwest::StatusCode::FORBIDDEN);

        // 2b. DNS rebinding Host header -> 403
        let bad_host = client
            .post(&url)
            .header("Host", "rebind.evil.example")
            .bearer_auth(&token)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .send()
            .await
            .unwrap();
        assert_eq!(bad_host.status(), reqwest::StatusCode::FORBIDDEN);

        // 2c. Non-loopback start() must fail before binding
        let non_loopback = LocalMcpServer::start(
            &McpServerConfig {
                enabled: true,
                bind_host: "0.0.0.0".into(),
                port: 0,
                require_write_approval: true,
            },
            token.clone(),
            Arc::new(McpToolRegistry::new()),
            Arc::new(RwLock::new(None)),
            Arc::new(McpAuditLog::new()),
            Arc::new(WriteApprovalGate::new()),
        )
        .await;
        assert!(non_loopback.is_err());

        // 3. Valid initialize + tools/list
        let list_resp: Value = client
            .post(&url)
            .bearer_auth(&token)
            .json(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let tools = list_resp["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "files_list"));
        assert!(tools.iter().any(|t| t["name"] == "files_write_markdown"));
        assert!(tools.iter().any(|t| t["name"] == "files_metadata"));

        // 4. Read-only tool works immediately without approval
        let read_resp: Value = client
            .post(&url)
            .bearer_auth(&token)
            .json(&json!({
                "jsonrpc":"2.0",
                "id":3,
                "method":"tools/call",
                "params": { "name": "files_read_markdown", "arguments": { "path": "/handbook.md" } }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(read_resp["result"]["isError"], json!(false));
        assert!(
            read_resp["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("# Team Handbook")
        );

        // 5. Write tool blocks until user approves
        let client_clone = client.clone();
        let url_clone = url.clone();
        let token_clone = token.clone();
        let write_req = tokio::spawn(async move {
            client_clone
                .post(&url_clone)
                .bearer_auth(&token_clone)
                .json(&json!({
                    "jsonrpc":"2.0",
                    "id":4,
                    "method":"tools/call",
                    "params": {
                        "name": "files_write_markdown",
                        "arguments": { "path": "/notes.md", "content": "# Created via MCP", "create_only": true }
                    }
                }))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        });

        tokio::time::sleep(Duration::from_millis(40)).await;
        let pending = approvals.list_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].tool_name, "files_write_markdown");
        assert!(approvals.resolve(&pending[0].id, true));

        let write_resp = write_req.await.unwrap();
        assert_eq!(write_resp["result"]["isError"], json!(false));
        assert_eq!(audit.list().len(), 2);
    }
}
