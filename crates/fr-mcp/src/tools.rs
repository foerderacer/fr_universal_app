use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use fr_core::{FrError, Result};
use fr_mod_files::FilesService;
use fr_preview::{PreviewKind, SharedBackendSlot, classify_preview, extract_solidworks_preview};
use fr_storage::{CloudPath, Etag, FileKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

const MAX_MCP_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MCP_SOLIDWORKS_BYTES: u64 = 128 * 1024 * 1024;

/// Metadata for a tool registered in the built-in local MCP Server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub is_write: bool,
    pub module_id: String,
}

/// Pluggable tool implementation registered by any `FrModule` (`files`, `finance`, `automation`, ...).
#[async_trait]
pub trait McpToolHandler: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn module_id(&self) -> &str;
    fn is_write(&self) -> bool;
    fn input_schema(&self) -> Value;

    /// Returns a concise, secret-free human summary for the audit log & write-approval prompt.
    fn summarize_call(&self, _args: &Value) -> String {
        format!("Call {}", self.name())
    }

    async fn call(&self, args: Value) -> Result<Value>;
}

/// Thread-safe registry of tools exposed by the built-in local MCP Server.
#[derive(Default)]
pub struct McpToolRegistry {
    tools: RwLock<BTreeMap<String, Arc<dyn McpToolHandler>>>,
}

impl std::fmt::Debug for McpToolRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpToolRegistry")
            .field("count", &self.list_info().len())
            .finish()
    }
}

impl McpToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<T: McpToolHandler + 'static>(&self, handler: T) {
        let mut guard = self
            .tools
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(handler.name().to_owned(), Arc::new(handler));
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn McpToolHandler>> {
        let guard = self
            .tools
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.get(name).cloned()
    }

    pub fn list_info(&self) -> Vec<McpToolInfo> {
        let guard = self
            .tools
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .values()
            .map(|h| McpToolInfo {
                name: h.name().to_owned(),
                description: h.description().to_owned(),
                is_write: h.is_write(),
                module_id: h.module_id().to_owned(),
            })
            .collect()
    }

    pub fn list_mcp_protocol_tools(&self) -> Vec<Value> {
        let guard = self
            .tools
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .values()
            .map(|h| {
                json!({
                    "name": h.name(),
                    "description": h.description(),
                    "inputSchema": h.input_schema(),
                    "annotations": {
                        "readOnlyHint": !h.is_write(),
                        "destructiveHint": h.is_write()
                    }
                })
            })
            .collect()
    }
}

fn require_files_service(slot: &SharedBackendSlot) -> Result<FilesService> {
    let storage = slot
        .read()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| FrError::AuthRequired("Nextcloud is not signed in".into()))?;
    Ok(FilesService::new(storage))
}

fn required_string<'a>(args: &'a Value, field: &str) -> Result<&'a str> {
    args.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| FrError::InvalidConfig(format!("missing required string field '{field}'")))
}

/// Registers all Phase 2 `fr-mod-files` tools into `registry`, bound dynamically to `storage_slot`.
pub fn register_files_tools(registry: &McpToolRegistry, storage_slot: SharedBackendSlot) {
    registry.register(FilesListTool(storage_slot.clone()));
    registry.register(FilesSearchTool(storage_slot.clone()));
    registry.register(FilesReadMarkdownTool(storage_slot.clone()));
    registry.register(FilesWriteMarkdownTool(storage_slot.clone()));
    registry.register(FilesMetadataTool(storage_slot.clone()));
    registry.register(FilesMkdirTool(storage_slot.clone()));
    registry.register(FilesMoveTool(storage_slot));
}

struct FilesListTool(SharedBackendSlot);

#[async_trait]
impl McpToolHandler for FilesListTool {
    fn name(&self) -> &str {
        "files_list"
    }
    fn description(&self) -> &str {
        "List files and folders inside a Nextcloud directory."
    }
    fn module_id(&self) -> &str {
        "files"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Cloud folder path (default '/')." }
            }
        })
    }
    fn summarize_call(&self, args: &Value) -> String {
        let path = args.get("path").and_then(Value::as_str).unwrap_or("/");
        format!("List folder {path}")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let path = args.get("path").and_then(Value::as_str).unwrap_or("/");
        let service = require_files_service(&self.0)?;
        let items = service.list_folder(path).await?;
        Ok(serde_json::to_value(items)?)
    }
}

struct FilesSearchTool(SharedBackendSlot);

#[async_trait]
impl McpToolHandler for FilesSearchTool {
    fn name(&self) -> &str {
        "files_search"
    }
    fn description(&self) -> &str {
        "Search Nextcloud files and folders by filename under a directory."
    }
    fn module_id(&self) -> &str {
        "files"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "path": { "type": "string", "description": "Root folder to search (default '/')." },
                "query": { "type": "string", "description": "Case-insensitive filename substring." },
                "max_depth": { "type": "integer", "minimum": 1, "maximum": 4, "default": 3 }
            }
        })
    }
    fn summarize_call(&self, args: &Value) -> String {
        let query = args.get("query").and_then(Value::as_str).unwrap_or("");
        let path = args.get("path").and_then(Value::as_str).unwrap_or("/");
        format!("Search '{query}' in {path}")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let query = required_string(&args, "query")?;
        let path = args.get("path").and_then(Value::as_str).unwrap_or("/");
        let max_depth = args
            .get("max_depth")
            .and_then(Value::as_u64)
            .unwrap_or(3)
            .clamp(1, 4) as usize;
        let service = require_files_service(&self.0)?;
        let matches = service.search_folder(path, query, max_depth).await?;
        Ok(serde_json::to_value(matches)?)
    }
}

struct FilesReadMarkdownTool(SharedBackendSlot);

#[async_trait]
impl McpToolHandler for FilesReadMarkdownTool {
    fn name(&self) -> &str {
        "files_read_markdown"
    }
    fn description(&self) -> &str {
        "Read a UTF-8 Markdown or text file from Nextcloud along with its current ETag."
    }
    fn module_id(&self) -> &str {
        "files"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "description": "Cloud path of the .md or text file." }
            }
        })
    }
    fn summarize_call(&self, args: &Value) -> String {
        let path = args.get("path").and_then(Value::as_str).unwrap_or("?");
        format!("Read {path}")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let raw_path = required_string(&args, "path")?;
        let service = require_files_service(&self.0)?;
        let parsed = CloudPath::parse(raw_path)?;
        let meta = service.storage().stat(&parsed).await?;
        if meta.kind == FileKind::Directory {
            return Err(FrError::InvalidPath("cannot read a folder as text".into()));
        }
        if meta.size > MAX_MCP_READ_BYTES {
            return Err(FrError::Other(
                "file exceeds 2 MB limit for MCP text reading".into(),
            ));
        }
        let (path, content, etag) = service.read_markdown(parsed.as_str()).await?;
        Ok(json!({
            "path": path.as_str(),
            "etag": etag.as_str(),
            "content": content
        }))
    }
}

struct FilesWriteMarkdownTool(SharedBackendSlot);

#[async_trait]
impl McpToolHandler for FilesWriteMarkdownTool {
    fn name(&self) -> &str {
        "files_write_markdown"
    }
    fn description(&self) -> &str {
        "Create or update a Markdown/text file on Nextcloud (supports ETag conflict safety)."
    }
    fn module_id(&self) -> &str {
        "files"
    }
    fn is_write(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["path", "content"],
            "properties": {
                "path": { "type": "string", "description": "Destination cloud path." },
                "content": { "type": "string", "description": "UTF-8 Markdown content." },
                "expected_etag": { "type": "string", "description": "Current file ETag required when updating an existing file (HTTP 412 on conflict)." },
                "create_only": { "type": "boolean", "description": "When true, fails if the file already exists." },
                "force_overwrite": { "type": "boolean", "description": "Explicitly overwrite an existing file without ETag check (defaults to false)." }
            }
        })
    }
    fn summarize_call(&self, args: &Value) -> String {
        let path = args.get("path").and_then(Value::as_str).unwrap_or("?");
        let content = args.get("content").and_then(Value::as_str).unwrap_or("");
        let preview: String = content
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(100)
            .collect();
        let trimmed = preview.trim();
        if trimmed.is_empty() {
            format!("Write {path} ({} bytes)", content.len())
        } else {
            format!("Write {path} ({} bytes): \"{trimmed}\"", content.len())
        }
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let raw_path = required_string(&args, "path")?;
        let content = args.get("content").and_then(Value::as_str).ok_or_else(|| {
            FrError::InvalidConfig("missing required string field 'content'".into())
        })?;
        let create_only = args
            .get("create_only")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let force_overwrite = args
            .get("force_overwrite")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let expected_etag = args
            .get("expected_etag")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(Etag::new);

        let service = require_files_service(&self.0)?;
        let parsed = CloudPath::parse(raw_path)?;
        let etag = if create_only {
            service.create_markdown(parsed.as_str(), content).await?
        } else if expected_etag.is_some() || force_overwrite {
            service
                .write_markdown(parsed.as_str(), content, expected_etag.as_ref())
                .await?
        } else {
            // Never silently overwrite an existing file without an expected_etag or explicit force_overwrite.
            if let Ok(existing) = service.storage().stat(&parsed).await {
                return Err(FrError::Conflict {
                    path: parsed.as_str().to_owned(),
                    expected: "<none — pass expected_etag or force_overwrite: true>".into(),
                    actual: existing
                        .etag
                        .map(|e| e.as_str().to_owned())
                        .unwrap_or_else(|| "<exists>".into()),
                });
            }
            service
                .write_markdown(parsed.as_str(), content, None)
                .await?
        };
        Ok(json!({
            "path": parsed.as_str(),
            "etag": etag.as_str()
        }))
    }
}

struct FilesMetadataTool(SharedBackendSlot);

#[async_trait]
impl McpToolHandler for FilesMetadataTool {
    fn name(&self) -> &str {
        "files_metadata"
    }
    fn description(&self) -> &str {
        "Inspect file metadata, preview classification, and SolidWorks CAD properties."
    }
    fn module_id(&self) -> &str {
        "files"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "description": "Cloud path of the file or folder." }
            }
        })
    }
    fn summarize_call(&self, args: &Value) -> String {
        let path = args.get("path").and_then(Value::as_str).unwrap_or("?");
        format!("Inspect metadata for {path}")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let raw_path = required_string(&args, "path")?;
        let parsed = CloudPath::parse(raw_path)?;
        let service = require_files_service(&self.0)?;
        let entry = service.storage().stat(&parsed).await?;
        let preview_kind = if entry.kind == FileKind::File {
            Some(classify_preview(&entry.name))
        } else {
            None
        };

        let mut solidworks_meta = None;
        if preview_kind == Some(PreviewKind::SolidWorks)
            && entry.size <= MAX_MCP_SOLIDWORKS_BYTES
            && let Ok((bytes, _)) = service.storage().read(&parsed).await
            && let Ok(Ok(sw)) =
                tokio::task::spawn_blocking(move || extract_solidworks_preview(&bytes)).await
        {
            solidworks_meta = Some(json!({
                "metadata": sw.metadata,
                "streamCount": sw.stream_count,
                "hasThumbnail": sw.thumbnail_data_url.is_some()
            }));
        }

        Ok(json!({
            "entry": entry,
            "previewKind": preview_kind,
            "solidworks": solidworks_meta
        }))
    }
}

struct FilesMkdirTool(SharedBackendSlot);

#[async_trait]
impl McpToolHandler for FilesMkdirTool {
    fn name(&self) -> &str {
        "files_mkdir"
    }
    fn description(&self) -> &str {
        "Create a new folder in Nextcloud."
    }
    fn module_id(&self) -> &str {
        "files"
    }
    fn is_write(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "description": "Cloud path of the folder to create." }
            }
        })
    }
    fn summarize_call(&self, args: &Value) -> String {
        let path = args.get("path").and_then(Value::as_str).unwrap_or("?");
        format!("Create folder {path}")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let raw_path = required_string(&args, "path")?;
        let service = require_files_service(&self.0)?;
        service.create_folder(raw_path).await?;
        Ok(json!({ "created": CloudPath::parse(raw_path)?.as_str() }))
    }
}

struct FilesMoveTool(SharedBackendSlot);

#[async_trait]
impl McpToolHandler for FilesMoveTool {
    fn name(&self) -> &str {
        "files_move"
    }
    fn description(&self) -> &str {
        "Rename or move a file or folder in Nextcloud (fails if destination already exists)."
    }
    fn module_id(&self) -> &str {
        "files"
    }
    fn is_write(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["from", "to"],
            "properties": {
                "from": { "type": "string", "description": "Current cloud path." },
                "to": { "type": "string", "description": "New cloud path." }
            }
        })
    }
    fn summarize_call(&self, args: &Value) -> String {
        let from = args.get("from").and_then(Value::as_str).unwrap_or("?");
        let to = args.get("to").and_then(Value::as_str).unwrap_or("?");
        format!("Move {from} -> {to}")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let from = required_string(&args, "from")?;
        let to = required_string(&args, "to")?;
        let service = require_files_service(&self.0)?;
        service.rename_item(from, to).await?;
        Ok(json!({
            "from": CloudPath::parse(from)?.as_str(),
            "to": CloudPath::parse(to)?.as_str()
        }))
    }
}
