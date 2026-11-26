//! Declarative automation workflow definitions, SQLite store, runner engine, and Nextcloud sync.
//!
//! Workflows can be synced via Nextcloud (`/_FR_App/workflows/<id>.json`) and combine storage
//! actions (`CopyFile`, `MoveFile`, `CreateFolder`, `WriteMarkdown`) with external MCP tool calls
//! (`CallMcpTool`).
//!
//! Security invariants:
//! - Newly synced or step-modified team workflows from Nextcloud ALWAYS default to `enabled: false`
//!   until explicitly reviewed and enabled by the local user.
//! - Every cloud path is validated via [`CloudPath::parse`] (preventing traversal).
//! - Synced workflow files are capped at 256 KiB and bounded to 50 files per sync.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use fr_core::{AppEvent, EventBus, FrError, Result};
use fr_mcp::McpClientManager;
use fr_storage::{CloudPath, FileKind, StorageBackend};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

pub const TEAM_WORKFLOWS_DIR: &str = "/_FR_App/workflows";
const MAX_WORKFLOW_JSON_BYTES: usize = 256 * 1024;
const MAX_TEAM_SYNC_FILES: usize = 50;
const MAX_STORED_RUNS: i64 = 200;
const MAX_STEPS_PER_WORKFLOW: usize = 25;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkflowTrigger {
    Manual,
    FolderWatch {
        path: String,
    },
    Schedule {
        /// Polling interval in minutes (clamped to 1..=1440).
        interval_minutes: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkflowStep {
    CreateFolder {
        path: String,
    },
    CopyFile {
        from: String,
        to: String,
    },
    MoveFile {
        from: String,
        to: String,
    },
    WriteMarkdown {
        path: String,
        content: String,
        #[serde(default)]
        create_only: bool,
    },
    CallMcpTool {
        server_id: String,
        tool_name: String,
        #[serde(default = "default_empty_json_object")]
        arguments_json: String,
    },
}

fn default_empty_json_object() -> String {
    "{}".to_owned()
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
    #[serde(default)]
    pub from_team_sync: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepLog {
    pub step_index: u32,
    pub label: String,
    pub succeeded: bool,
    pub output: String,
    pub duration_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunRecord {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub trigger_source: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    pub succeeded: bool,
    pub step_logs: Vec<WorkflowStepLog>,
}

fn sqlite_err(err: rusqlite::Error) -> FrError {
    FrError::Other(format!("workflow database error: {err}"))
}

pub fn validate_workflow(wf: &WorkflowDefinition) -> Result<()> {
    if wf.id.trim().is_empty()
        || !wf
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(FrError::InvalidConfig(
            "Workflow ID must contain only letters, digits, hyphens, or underscores".into(),
        ));
    }
    if wf.name.trim().is_empty() {
        return Err(FrError::InvalidConfig("Workflow name is required".into()));
    }
    if wf.steps.is_empty() {
        return Err(FrError::InvalidConfig(
            "Workflow must contain at least one step".into(),
        ));
    }
    if wf.steps.len() > MAX_STEPS_PER_WORKFLOW {
        return Err(FrError::InvalidConfig(format!(
            "Workflow cannot have more than {MAX_STEPS_PER_WORKFLOW} steps"
        )));
    }
    if let WorkflowTrigger::FolderWatch { ref path } = wf.trigger {
        CloudPath::parse(path)?;
    }
    for step in &wf.steps {
        match step {
            WorkflowStep::CreateFolder { path } => {
                CloudPath::parse(path)?;
            }
            WorkflowStep::CopyFile { from, to } | WorkflowStep::MoveFile { from, to } => {
                CloudPath::parse(from)?;
                CloudPath::parse(to)?;
            }
            WorkflowStep::WriteMarkdown { path, .. } => {
                CloudPath::parse(path)?;
            }
            WorkflowStep::CallMcpTool {
                server_id,
                tool_name,
                arguments_json,
            } => {
                if server_id.trim().is_empty() || tool_name.trim().is_empty() {
                    return Err(FrError::InvalidConfig(
                        "MCP tool step requires both server_id and tool_name".into(),
                    ));
                }
                if !arguments_json.trim().is_empty() {
                    let _: serde_json::Value =
                        serde_json::from_str(arguments_json).map_err(|err| {
                            FrError::InvalidConfig(format!(
                                "MCP tool step arguments must be valid JSON: {err}"
                            ))
                        })?;
                }
            }
        }
    }
    Ok(())
}

/// SQLite-backed store for declarative workflow definitions and run history.
#[derive(Clone)]
pub struct WorkflowStore {
    conn: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for WorkflowStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkflowStore").finish()
    }
}

impl WorkflowStore {
    pub fn default_db_path() -> Result<PathBuf> {
        let proj = ProjectDirs::from("de", "foerderacer", "FRUniversalApp")
            .ok_or_else(|| FrError::InvalidConfig("unable to resolve OS data directory".into()))?;
        Ok(proj.data_local_dir().join("workflows.sqlite"))
    }

    pub fn open(db_path: impl Into<PathBuf>) -> Result<Self> {
        let path = db_path.into();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path).map_err(sqlite_err)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS workflows (
                id TEXT PRIMARY KEY,
                definition_json TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workflow_runs (
                run_id TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                record_json TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_workflow_runs_started
                ON workflow_runs (started_at_ms DESC);
            ",
        )
        .map_err(sqlite_err)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn list_workflows(&self) -> Result<Vec<WorkflowDefinition>> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut stmt = conn
            .prepare("SELECT definition_json FROM workflows ORDER BY id ASC")
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for row in rows {
            let raw = row.map_err(sqlite_err)?;
            if let Ok(def) = serde_json::from_str::<WorkflowDefinition>(&raw) {
                out.push(def);
            }
        }
        Ok(out)
    }

    pub fn get_workflow(&self, id: &str) -> Result<Option<WorkflowDefinition>> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let raw: Option<String> = conn
            .query_row(
                "SELECT definition_json FROM workflows WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(sqlite_err)?;
        match raw {
            Some(s) => Ok(Some(serde_json::from_str(&s)?)),
            None => Ok(None),
        }
    }

    pub fn upsert_workflow(&self, mut wf: WorkflowDefinition) -> Result<WorkflowDefinition> {
        wf.name = wf.name.trim().to_owned();
        wf.description = wf.description.trim().to_owned();
        validate_workflow(&wf)?;
        let json = serde_json::to_string(&wf)?;
        let now = Utc::now().timestamp_millis();
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.execute(
            "INSERT INTO workflows (id, definition_json, updated_at_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
               definition_json = excluded.definition_json,
               updated_at_ms = excluded.updated_at_ms",
            params![wf.id, json, now],
        )
        .map_err(sqlite_err)?;
        Ok(wf)
    }

    pub fn delete_workflow(&self, id: &str) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.execute("DELETE FROM workflows WHERE id = ?1", params![id])
            .map_err(sqlite_err)?;
        Ok(())
    }

    pub fn record_run(&self, record: &WorkflowRunRecord) -> Result<()> {
        let json = serde_json::to_string(record)?;
        let started_ms = record.started_at.timestamp_millis();
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.execute(
            "INSERT INTO workflow_runs (run_id, workflow_id, record_json, started_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![record.run_id, record.workflow_id, json, started_ms],
        )
        .map_err(sqlite_err)?;
        // Prune oldest runs beyond MAX_STORED_RUNS.
        let _ = conn.execute(
            "DELETE FROM workflow_runs WHERE run_id NOT IN (
                SELECT run_id FROM workflow_runs ORDER BY started_at_ms DESC LIMIT ?1
            )",
            params![MAX_STORED_RUNS],
        );
        Ok(())
    }

    pub fn list_runs(
        &self,
        workflow_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<WorkflowRunRecord>> {
        let capped = (limit.clamp(1, 200)) as i64;
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut out = Vec::new();
        if let Some(wf_id) = workflow_id {
            let mut stmt = conn
                .prepare(
                    "SELECT record_json FROM workflow_runs
                     WHERE workflow_id = ?1
                     ORDER BY started_at_ms DESC LIMIT ?2",
                )
                .map_err(sqlite_err)?;
            let rows = stmt
                .query_map(params![wf_id, capped], |r| r.get::<_, String>(0))
                .map_err(sqlite_err)?;
            for row in rows {
                if let Ok(rec) =
                    serde_json::from_str::<WorkflowRunRecord>(&row.map_err(sqlite_err)?)
                {
                    out.push(rec);
                }
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT record_json FROM workflow_runs
                     ORDER BY started_at_ms DESC LIMIT ?1",
                )
                .map_err(sqlite_err)?;
            let rows = stmt
                .query_map(params![capped], |r| r.get::<_, String>(0))
                .map_err(sqlite_err)?;
            for row in rows {
                if let Ok(rec) =
                    serde_json::from_str::<WorkflowRunRecord>(&row.map_err(sqlite_err)?)
                {
                    out.push(rec);
                }
            }
        }
        Ok(out)
    }
}

/// Executes workflows across [`StorageBackend`] and [`McpClientManager`], manages Nextcloud team
/// sync, and evaluates periodic `Schedule` and `FolderWatch` triggers.
pub struct WorkflowRunner {
    store: WorkflowStore,
    mcp_client: Arc<McpClientManager>,
    events: EventBus,
    last_schedule_run: Mutex<HashMap<String, Instant>>,
    folder_snapshots: Mutex<HashMap<String, Vec<String>>>,
}

impl std::fmt::Debug for WorkflowRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkflowRunner").finish()
    }
}

impl WorkflowRunner {
    pub fn new(store: WorkflowStore, mcp_client: Arc<McpClientManager>, events: EventBus) -> Self {
        Self {
            store,
            mcp_client,
            events,
            last_schedule_run: Mutex::new(HashMap::new()),
            folder_snapshots: Mutex::new(HashMap::new()),
        }
    }

    pub fn store(&self) -> &WorkflowStore {
        &self.store
    }

    /// Executes a single workflow by ID and persists its run record in SQLite.
    pub async fn run_workflow(
        &self,
        workflow_id: &str,
        trigger_source: &str,
        storage: &dyn StorageBackend,
    ) -> Result<WorkflowRunRecord> {
        let wf = self
            .store
            .get_workflow(workflow_id)?
            .ok_or_else(|| FrError::NotFound(format!("workflow '{workflow_id}'")))?;
        self.execute_definition(&wf, trigger_source, storage).await
    }

    pub async fn execute_definition(
        &self,
        wf: &WorkflowDefinition,
        trigger_source: &str,
        storage: &dyn StorageBackend,
    ) -> Result<WorkflowRunRecord> {
        validate_workflow(wf)?;
        let run_id = Uuid::new_v4().to_string();
        let started_at = Utc::now();
        let mut step_logs = Vec::with_capacity(wf.steps.len());
        let mut all_ok = true;

        for (idx, step) in wf.steps.iter().enumerate() {
            let step_start = Instant::now();
            let (label, res) = self.execute_step(step, storage).await;
            let duration_ms = step_start.elapsed().as_millis() as u32;
            match res {
                Ok(output) => {
                    step_logs.push(WorkflowStepLog {
                        step_index: idx as u32,
                        label,
                        succeeded: true,
                        output,
                        duration_ms,
                    });
                }
                Err(err) => {
                    all_ok = false;
                    step_logs.push(WorkflowStepLog {
                        step_index: idx as u32,
                        label,
                        succeeded: false,
                        output: err.to_string(),
                        duration_ms,
                    });
                    break;
                }
            }
        }

        let finished_at = Utc::now();
        let record = WorkflowRunRecord {
            run_id: run_id.clone(),
            workflow_id: wf.id.clone(),
            workflow_name: wf.name.clone(),
            trigger_source: trigger_source.to_owned(),
            started_at,
            finished_at,
            succeeded: all_ok,
            step_logs,
        };
        self.store.record_run(&record)?;
        self.events.publish(AppEvent::WorkflowCompleted {
            workflow_id: wf.id.clone(),
            run_id,
            succeeded: all_ok,
            timestamp: finished_at,
        });
        Ok(record)
    }

    async fn execute_step(
        &self,
        step: &WorkflowStep,
        storage: &dyn StorageBackend,
    ) -> (String, Result<String>) {
        match step {
            WorkflowStep::CreateFolder { path } => {
                let label = format!("Create folder {path}");
                let res = async {
                    let parsed = CloudPath::parse(path)?;
                    storage.mkdir(&parsed).await?;
                    Ok(format!("Created folder {}", parsed.as_str()))
                }
                .await;
                (label, res)
            }
            WorkflowStep::CopyFile { from, to } => {
                let label = format!("Copy {from} -> {to}");
                let res = async {
                    let src = CloudPath::parse(from)?;
                    let dst = CloudPath::parse(to)?;
                    let (bytes, _) = storage.read(&src).await?;
                    let etag = storage.write(&dst, bytes, None).await?;
                    Ok(format!(
                        "Copied to {} (ETag {})",
                        dst.as_str(),
                        etag.as_str()
                    ))
                }
                .await;
                (label, res)
            }
            WorkflowStep::MoveFile { from, to } => {
                let label = format!("Move {from} -> {to}");
                let res = async {
                    let src = CloudPath::parse(from)?;
                    let dst = CloudPath::parse(to)?;
                    storage.rename(&src, &dst).await?;
                    Ok(format!("Moved to {}", dst.as_str()))
                }
                .await;
                (label, res)
            }
            WorkflowStep::WriteMarkdown {
                path,
                content,
                create_only,
            } => {
                let label = format!("Write Markdown {path}");
                let res = async {
                    let dst = CloudPath::parse(path)?;
                    if *create_only && storage.stat(&dst).await.is_ok() {
                        return Err(FrError::AlreadyExists(dst.as_str().to_owned()));
                    }
                    let etag = storage
                        .write(&dst, Bytes::from(content.as_bytes().to_vec()), None)
                        .await?;
                    Ok(format!("Wrote {} (ETag {})", dst.as_str(), etag.as_str()))
                }
                .await;
                (label, res)
            }
            WorkflowStep::CallMcpTool {
                server_id,
                tool_name,
                arguments_json,
            } => {
                let label = format!("Call MCP {server_id}::{tool_name}");
                let res = async {
                    let args: serde_json::Value = if arguments_json.trim().is_empty() {
                        serde_json::json!({})
                    } else {
                        serde_json::from_str(arguments_json)?
                    };
                    let out = self
                        .mcp_client
                        .call_tool(server_id, tool_name, args)
                        .await?;
                    if out.is_error {
                        return Err(FrError::Other(out.text));
                    }
                    Ok(out.text)
                }
                .await;
                (label, res)
            }
        }
    }

    /// Syncs shared team workflow JSON files from `/_FR_App/workflows/` in Nextcloud.
    ///
    /// Security: every newly imported workflow OR existing workflow whose `steps` changed is
    /// ALWAYS set to `enabled: false` until the local user reviews and enables it.
    pub async fn sync_from_nextcloud(
        &self,
        storage: &dyn StorageBackend,
    ) -> Result<Vec<WorkflowDefinition>> {
        let dir = CloudPath::parse(TEAM_WORKFLOWS_DIR)?;
        let entries = storage.list(&dir).await?;

        for entry in entries
            .into_iter()
            .filter(|e| e.kind == FileKind::File && e.name.to_ascii_lowercase().ends_with(".json"))
            .take(MAX_TEAM_SYNC_FILES)
        {
            if entry.size as usize > MAX_WORKFLOW_JSON_BYTES {
                continue;
            }
            let Ok((bytes, _)) = storage.read(&entry.path).await else {
                continue;
            };
            if bytes.len() > MAX_WORKFLOW_JSON_BYTES {
                continue;
            }
            let Ok(mut imported) = serde_json::from_slice::<WorkflowDefinition>(&bytes) else {
                continue;
            };
            if validate_workflow(&imported).is_err() {
                continue;
            }

            let existing = self.store.get_workflow(&imported.id)?;
            imported.from_team_sync = true;
            imported.enabled = match existing {
                Some(prev) if prev.steps == imported.steps && prev.trigger == imported.trigger => {
                    prev.enabled
                }
                _ => false,
            };
            let _ = self.store.upsert_workflow(imported);
        }

        self.store.list_workflows()
    }

    /// Exports a single workflow definition to Nextcloud (`/_FR_App/workflows/<id>.json`).
    pub async fn push_to_nextcloud(
        &self,
        workflow_id: &str,
        storage: &dyn StorageBackend,
    ) -> Result<CloudPath> {
        let wf = self
            .store
            .get_workflow(workflow_id)?
            .ok_or_else(|| FrError::NotFound(format!("workflow '{workflow_id}'")))?;
        let app_dir = CloudPath::parse("/_FR_App")?;
        let _ = storage.mkdir(&app_dir).await;
        let wf_dir = CloudPath::parse(TEAM_WORKFLOWS_DIR)?;
        let _ = storage.mkdir(&wf_dir).await;

        let target = wf_dir.join(&format!("{}.json", wf.id))?;
        let json = serde_json::to_vec_pretty(&wf)?;
        storage.write(&target, Bytes::from(json), None).await?;
        Ok(target)
    }

    /// Evaluates enabled `Schedule` and `FolderWatch` workflows once (intended for periodic ticks).
    pub async fn evaluate_triggers(
        &self,
        storage: &dyn StorageBackend,
    ) -> Result<Vec<WorkflowRunRecord>> {
        let workflows = self.store.list_workflows()?;
        let mut triggered_runs = Vec::new();

        for wf in workflows.into_iter().filter(|w| w.enabled) {
            match &wf.trigger {
                WorkflowTrigger::Manual => {}
                WorkflowTrigger::Schedule { interval_minutes } => {
                    let interval =
                        Duration::from_secs(u64::from((*interval_minutes).clamp(1, 1440)) * 60);
                    let due = {
                        let guard = self
                            .last_schedule_run
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        guard
                            .get(&wf.id)
                            .is_none_or(|last| last.elapsed() >= interval)
                    };
                    if due {
                        {
                            let mut guard = self
                                .last_schedule_run
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            guard.insert(wf.id.clone(), Instant::now());
                        }
                        if let Ok(rec) = self.execute_definition(&wf, "schedule", storage).await {
                            triggered_runs.push(rec);
                        }
                    }
                }
                WorkflowTrigger::FolderWatch { path } => {
                    let Ok(parsed) = CloudPath::parse(path) else {
                        continue;
                    };
                    let Ok(entries) = storage.list(&parsed).await else {
                        continue;
                    };
                    let mut fingerprint: Vec<String> = entries
                        .into_iter()
                        .map(|e| {
                            format!(
                                "{}:{}",
                                e.path.as_str(),
                                e.etag.map(|et| et.as_str().to_owned()).unwrap_or_default()
                            )
                        })
                        .collect();
                    fingerprint.sort();

                    let changed = {
                        let mut guard = self
                            .folder_snapshots
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        match guard.insert(wf.id.clone(), fingerprint.clone()) {
                            None => false, // Establish initial baseline without firing immediately.
                            Some(prev) => prev != fingerprint,
                        }
                    };
                    if changed
                        && let Ok(rec) = self.execute_definition(&wf, "folderWatch", storage).await
                    {
                        triggered_runs.push(rec);
                        // Refresh snapshot after execution so a workflow writing into its own
                        // watched folder does not immediately re-trigger on the next tick.
                        if let Ok(post_entries) = storage.list(&parsed).await {
                            let mut post_fp: Vec<String> = post_entries
                                .into_iter()
                                .map(|e| {
                                    format!(
                                        "{}:{}",
                                        e.path.as_str(),
                                        e.etag.map(|et| et.as_str().to_owned()).unwrap_or_default()
                                    )
                                })
                                .collect();
                            post_fp.sort();
                            let mut guard = self
                                .folder_snapshots
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            guard.insert(wf.id.clone(), post_fp);
                        }
                    }
                }
            }
        }

        Ok(triggered_runs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fr_mcp::{
        ExternalMcpServer, ExternalMcpTransport, LocalMcpServer, McpAuditLog, McpServerConfig,
        McpToolRegistry, MemoryMcpTokenStore, WriteApprovalGate, register_files_tools,
    };
    use fr_preview::SharedBackendSlot;
    use fr_storage::LocalFsBackend;
    use std::sync::RwLock;
    use tempfile::tempdir;

    #[tokio::test]
    async fn workflow_runs_storage_and_mcp_tool_steps_and_records_history() {
        let data_dir = tempdir().unwrap();
        let db_dir = tempdir().unwrap();
        let storage = Arc::new(LocalFsBackend::new(data_dir.path()));
        storage
            .write(
                &CloudPath::parse("/source.md").unwrap(),
                Bytes::from_static(b"# Source Doc"),
                None,
            )
            .await
            .unwrap();

        // Start a loopback MCP server so CallMcpTool runs end-to-end.
        let slot: SharedBackendSlot = Arc::new(RwLock::new(Some(storage.clone())));
        let registry = Arc::new(McpToolRegistry::new());
        register_files_tools(&registry, slot.clone());
        let token = "wf-mcp-token".to_owned();
        let mcp_srv = LocalMcpServer::start(
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

        let mcp_client = Arc::new(
            McpClientManager::open(
                db_dir.path().join("mcp-servers.json"),
                Arc::new(MemoryMcpTokenStore::new()),
                reqwest::Client::new(),
            )
            .unwrap(),
        );
        mcp_client
            .upsert_server(
                ExternalMcpServer {
                    id: "local-mcp".into(),
                    name: "Local".into(),
                    enabled: true,
                    transport: ExternalMcpTransport::StreamableHttp {
                        url: mcp_srv.endpoint_url(),
                    },
                },
                Some(token),
            )
            .unwrap();

        let store = WorkflowStore::open(db_dir.path().join("workflows.sqlite")).unwrap();
        let runner = WorkflowRunner::new(store.clone(), mcp_client, EventBus::default());

        let wf = WorkflowDefinition {
            id: "archive-and-read".into(),
            name: "Archive & Inspect".into(),
            description: "Creates archive folder, copies doc, calls MCP tool.".into(),
            enabled: true,
            trigger: WorkflowTrigger::Manual,
            steps: vec![
                WorkflowStep::CreateFolder {
                    path: "/Archive".into(),
                },
                WorkflowStep::CopyFile {
                    from: "/source.md".into(),
                    to: "/Archive/source.md".into(),
                },
                WorkflowStep::CallMcpTool {
                    server_id: "local-mcp".into(),
                    tool_name: "files_read_markdown".into(),
                    arguments_json: r#"{"path":"/Archive/source.md"}"#.into(),
                },
            ],
            from_team_sync: false,
        };
        store.upsert_workflow(wf).unwrap();

        let run = runner
            .run_workflow("archive-and-read", "manual", storage.as_ref())
            .await
            .unwrap();
        assert!(run.succeeded);
        assert_eq!(run.step_logs.len(), 3);
        assert!(run.step_logs[2].output.contains("# Source Doc"));

        let runs = store.list_runs(Some("archive-and-read"), 10).unwrap();
        assert_eq!(runs.len(), 1);
    }

    #[tokio::test]
    async fn team_sync_disables_new_and_modified_workflows() {
        let data_dir = tempdir().unwrap();
        let db_dir = tempdir().unwrap();
        let storage = LocalFsBackend::new(data_dir.path());
        let mcp_client = Arc::new(
            McpClientManager::open(
                db_dir.path().join("mcp-servers.json"),
                Arc::new(MemoryMcpTokenStore::new()),
                reqwest::Client::new(),
            )
            .unwrap(),
        );
        let store = WorkflowStore::open(db_dir.path().join("workflows.sqlite")).unwrap();
        let runner = WorkflowRunner::new(store.clone(), mcp_client, EventBus::default());

        let remote_wf = WorkflowDefinition {
            id: "team-intake".into(),
            name: "Team Intake".into(),
            description: "Synced from Nextcloud".into(),
            enabled: true, // Remote claims enabled=true, must be forced false locally!
            trigger: WorkflowTrigger::Manual,
            steps: vec![WorkflowStep::CreateFolder {
                path: "/Intake".into(),
            }],
            from_team_sync: true,
        };
        storage
            .write(
                &CloudPath::parse("/_FR_App/workflows/team-intake.json").unwrap(),
                Bytes::from(serde_json::to_vec(&remote_wf).unwrap()),
                None,
            )
            .await
            .unwrap();

        let synced = runner.sync_from_nextcloud(&storage).await.unwrap();
        assert_eq!(synced.len(), 1);
        assert!(
            !synced[0].enabled,
            "newly synced team workflows must default to disabled"
        );

        // User explicitly enables it locally.
        let mut enabled_locally = synced[0].clone();
        enabled_locally.enabled = true;
        store.upsert_workflow(enabled_locally).unwrap();

        // Remote team file changes its steps — re-sync MUST force it disabled again.
        let mut modified_remote = remote_wf.clone();
        modified_remote.steps.push(WorkflowStep::WriteMarkdown {
            path: "/Intake/readme.md".into(),
            content: "Modified step".into(),
            create_only: false,
        });
        storage
            .write(
                &CloudPath::parse("/_FR_App/workflows/team-intake.json").unwrap(),
                Bytes::from(serde_json::to_vec(&modified_remote).unwrap()),
                None,
            )
            .await
            .unwrap();

        let resynced = runner.sync_from_nextcloud(&storage).await.unwrap();
        assert!(
            !resynced[0].enabled,
            "team workflow with modified steps must be re-disabled until reviewed"
        );
    }
}
