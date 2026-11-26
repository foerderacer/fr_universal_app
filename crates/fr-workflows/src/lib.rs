//! Declarative automation workflow definitions, SQLite store, runner engine, and Nextcloud sync.
//!
//! Workflows can be synced via Nextcloud (`/_FR_App/workflows/<id>.json`) and combine storage
//! actions (`CopyFile`, `MoveFile`, `CreateFolder`, `WriteMarkdown`) with external MCP tool calls
//! (`CallMcpTool`).
//!
//! Security invariants:
//! - Newly synced or step/trigger-modified team workflows from Nextcloud ALWAYS default to
//!   `enabled: false` until explicitly reviewed and enabled by the local user.
//! - External MCP clients (`trigger_source == "mcp"`) can NEVER run disabled workflows.
//! - An RAII in-flight guard prevents both MCP self-recursion loops and concurrent double-runs.
//! - Every cloud path is validated via [`CloudPath::parse`] (preventing traversal).
//! - Synced workflow files are bounded BEFORE full RAM read (`read_range` up to 256 KiB + 1 byte)
//!   and capped at 50 files per sync; `CopyFile` rejects files larger than 100 MiB before reading.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use chrono::{DateTime, TimeZone, Utc};
use directories::ProjectDirs;
use fr_core::{AppEvent, EventBus, FrError, Result};
use fr_mcp::McpClientManager;
use fr_storage::{CloudPath, Etag, FileKind, StorageBackend};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

pub const TEAM_WORKFLOWS_DIR: &str = "/_FR_App/workflows";
const MAX_WORKFLOW_JSON_BYTES: usize = 256 * 1024;
const MAX_TEAM_SYNC_FILES: usize = 50;
const MAX_STORED_RUNS: i64 = 200;
const MAX_STEPS_PER_WORKFLOW: usize = 25;
const MAX_COPY_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_CONCURRENT_WORKFLOW_RUNS: usize = 3;

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

impl WorkflowStep {
    /// Human-readable one-line summary for approval banners and review dialogs.
    pub fn short_summary(&self) -> String {
        match self {
            Self::CreateFolder { path } => format!("Create folder {path}"),
            Self::CopyFile { from, to } => format!("Copy {from} -> {to}"),
            Self::MoveFile { from, to } => format!("Move {from} -> {to}"),
            Self::WriteMarkdown { path, .. } => format!("Write Markdown {path}"),
            Self::CallMcpTool {
                server_id,
                tool_name,
                ..
            } => format!("Call MCP {server_id}::{tool_name}"),
        }
    }
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
    /// Last known Nextcloud ETag for `/_FR_App/workflows/<id>.json` (used for `If-Match` safety).
    #[serde(default)]
    pub remote_etag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSyncReport {
    pub workflows: Vec<WorkflowDefinition>,
    pub imported_count: u32,
    pub skipped_count: u32,
    pub skipped_notes: Vec<String>,
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
        || wf.id.len() > 64
        || !wf
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(FrError::InvalidInput(
            "Workflow ID must be 1–64 characters using only letters, digits, hyphens, or underscores."
                .into(),
        ));
    }
    if wf.name.trim().is_empty() || wf.name.trim().chars().count() > 160 {
        return Err(FrError::InvalidInput(
            "Workflow name is required and must be 160 characters or fewer.".into(),
        ));
    }
    if wf.description.trim().chars().count() > 1000 {
        return Err(FrError::InvalidInput(
            "Workflow description must be 1,000 characters or fewer.".into(),
        ));
    }
    if wf.steps.is_empty() {
        return Err(FrError::InvalidInput(
            "Workflow must contain at least one step.".into(),
        ));
    }
    if wf.steps.len() > MAX_STEPS_PER_WORKFLOW {
        return Err(FrError::InvalidInput(format!(
            "Workflow cannot have more than {MAX_STEPS_PER_WORKFLOW} steps."
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
                    return Err(FrError::InvalidInput(
                        "MCP tool step requires both a server and a tool name.".into(),
                    ));
                }
                if !arguments_json.trim().is_empty() {
                    let _: serde_json::Value =
                        serde_json::from_str(arguments_json).map_err(|err| {
                            FrError::InvalidInput(format!(
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
            CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf_started
                ON workflow_runs (workflow_id, started_at_ms DESC);
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
        let now = Utc::now().timestamp_millis();
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Preserve previously recorded remote_etag when callers (such as UI edits/toggles)
        // omit or send a stale `None` so subsequent pushes do not trigger false 412 conflicts.
        if wf.remote_etag.is_none()
            && let Some(prev_raw) = conn
                .query_row(
                    "SELECT definition_json FROM workflows WHERE id = ?1",
                    params![wf.id],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(sqlite_err)?
            && let Ok(prev) = serde_json::from_str::<WorkflowDefinition>(&prev_raw)
        {
            wf.remote_etag = prev.remote_etag;
        }
        let json = serde_json::to_string(&wf)?;
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

    /// Returns the most recent persisted start timestamp for `workflow_id` (used to avoid
    /// re-firing `Schedule` workflows immediately on every app restart).
    pub fn last_run_started_at(&self, workflow_id: &str) -> Result<Option<DateTime<Utc>>> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let ms: Option<i64> = conn
            .query_row(
                "SELECT MAX(started_at_ms) FROM workflow_runs WHERE workflow_id = ?1",
                params![workflow_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(sqlite_err)?
            .flatten();
        Ok(ms.and_then(|v| Utc.timestamp_millis_opt(v).single()))
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

/// RAII guard that releases a workflow's in-flight slot even if execution errors or is cancelled.
struct RunSlotGuard {
    in_flight: Arc<Mutex<HashSet<String>>>,
    workflow_id: String,
}

impl Drop for RunSlotGuard {
    fn drop(&mut self) {
        let mut guard = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.remove(&self.workflow_id);
    }
}

/// Executes workflows across [`StorageBackend`] and [`McpClientManager`], manages Nextcloud team
/// sync, and evaluates periodic `Schedule` and `FolderWatch` triggers.
pub struct WorkflowRunner {
    store: WorkflowStore,
    mcp_client: Arc<McpClientManager>,
    events: EventBus,
    last_schedule_run: Mutex<HashMap<String, DateTime<Utc>>>,
    folder_snapshots: Mutex<HashMap<String, Vec<String>>>,
    in_flight: Arc<Mutex<HashSet<String>>>,
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
            in_flight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn store(&self) -> &WorkflowStore {
        &self.store
    }

    fn acquire_run_slot(&self, workflow_id: &str) -> Result<RunSlotGuard> {
        let mut guard = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.contains(workflow_id) {
            return Err(FrError::InvalidInput(format!(
                "Workflow '{workflow_id}' is already running."
            )));
        }
        if guard.len() >= MAX_CONCURRENT_WORKFLOW_RUNS {
            return Err(FrError::InvalidInput(
                "Too many workflows are running at the same time. Please wait for one to finish."
                    .into(),
            ));
        }
        guard.insert(workflow_id.to_owned());
        Ok(RunSlotGuard {
            in_flight: self.in_flight.clone(),
            workflow_id: workflow_id.to_owned(),
        })
    }

    /// Executes a single workflow by ID and persists its run record in SQLite.
    ///
    /// Security: when `trigger_source == "mcp"`, disabled workflows are ALWAYS rejected so
    /// unreviewed team-synced workflows cannot be executed by an AI assistant.
    pub async fn run_workflow(
        &self,
        workflow_id: &str,
        trigger_source: &str,
        storage: &dyn StorageBackend,
    ) -> Result<WorkflowRunRecord> {
        let store = self.store.clone();
        let id_owned = workflow_id.to_owned();
        let wf = tokio::task::spawn_blocking(move || store.get_workflow(&id_owned))
            .await
            .map_err(|err| FrError::Other(err.to_string()))??
            .ok_or_else(|| FrError::NotFound(format!("workflow '{workflow_id}'")))?;

        if trigger_source == "mcp" && !wf.enabled {
            return Err(FrError::InvalidInput(format!(
                "Workflow '{}' is currently disabled. Review and enable it in Automations before running it from an AI assistant.",
                wf.name
            )));
        }
        self.execute_definition(&wf, trigger_source, storage).await
    }

    pub async fn execute_definition(
        &self,
        wf: &WorkflowDefinition,
        trigger_source: &str,
        storage: &dyn StorageBackend,
    ) -> Result<WorkflowRunRecord> {
        validate_workflow(wf)?;
        let _slot = self.acquire_run_slot(&wf.id)?;

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
        let store = self.store.clone();
        let rec_clone = record.clone();
        tokio::task::spawn_blocking(move || store.record_run(&rec_clone))
            .await
            .map_err(|err| FrError::Other(err.to_string()))??;
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
                    let meta = storage.stat(&src).await?;
                    if meta.size > MAX_COPY_FILE_BYTES {
                        return Err(FrError::InvalidInput(format!(
                            "Source file '{}' is larger than the 100 MB workflow copy limit.",
                            src.as_str()
                        )));
                    }
                    let (bytes, _) = storage.read(&src).await?;
                    if bytes.len() as u64 > MAX_COPY_FILE_BYTES {
                        return Err(FrError::InvalidInput(format!(
                            "Source file '{}' exceeded the 100 MB workflow copy limit.",
                            src.as_str()
                        )));
                    }
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
    /// Security:
    /// - Reads at most `MAX_WORKFLOW_JSON_BYTES + 1` bytes via `read_range` BEFORE buffering.
    /// - Never overwrites a local user-owned workflow (`from_team_sync == false`) with the same ID.
    /// - Every newly imported workflow OR existing team workflow whose `steps`/`trigger` changed is
    ///   ALWAYS set to `enabled: false` until the local user reviews and enables it.
    pub async fn sync_from_nextcloud(
        &self,
        storage: &dyn StorageBackend,
    ) -> Result<WorkflowSyncReport> {
        let dir = CloudPath::parse(TEAM_WORKFLOWS_DIR)?;
        let entries = storage.list(&dir).await?;

        let mut imported_count = 0u32;
        let mut skipped_count = 0u32;
        let mut skipped_notes = Vec::new();

        for entry in entries
            .into_iter()
            .filter(|e| e.kind == FileKind::File && e.name.to_ascii_lowercase().ends_with(".json"))
            .take(MAX_TEAM_SYNC_FILES)
        {
            if entry.size as usize > MAX_WORKFLOW_JSON_BYTES {
                skipped_count += 1;
                skipped_notes.push(format!("{}: exceeds 256 KB size limit", entry.name));
                continue;
            }
            // Enforce byte bound BEFORE pulling a potentially huge server body into memory.
            let bytes = match storage
                .read_range(&entry.path, 0, Some(MAX_WORKFLOW_JSON_BYTES as u64))
                .await
            {
                Ok(b) => b,
                Err(_) => {
                    skipped_count += 1;
                    skipped_notes.push(format!("{}: could not be read", entry.name));
                    continue;
                }
            };
            if bytes.len() > MAX_WORKFLOW_JSON_BYTES {
                skipped_count += 1;
                skipped_notes.push(format!("{}: exceeds 256 KB size limit", entry.name));
                continue;
            }
            let mut imported = match serde_json::from_slice::<WorkflowDefinition>(&bytes) {
                Ok(wf) => wf,
                Err(_) => {
                    skipped_count += 1;
                    skipped_notes.push(format!("{}: invalid workflow JSON", entry.name));
                    continue;
                }
            };
            if let Err(err) = validate_workflow(&imported) {
                skipped_count += 1;
                skipped_notes.push(format!("{}: {err}", entry.name));
                continue;
            }

            let store = self.store.clone();
            let id_lookup = imported.id.clone();
            let existing = tokio::task::spawn_blocking(move || store.get_workflow(&id_lookup))
                .await
                .map_err(|err| FrError::Other(err.to_string()))??;

            // Never clobber a local user-created workflow that happens to share the same ID.
            if let Some(ref prev) = existing
                && !prev.from_team_sync
            {
                skipped_count += 1;
                skipped_notes.push(format!(
                    "{}: skipped because a local workflow with ID '{}' already exists",
                    entry.name, imported.id
                ));
                continue;
            }

            imported.from_team_sync = true;
            imported.remote_etag = entry.etag.as_ref().map(|e| e.as_str().to_owned());
            imported.enabled = match existing {
                Some(prev) if prev.steps == imported.steps && prev.trigger == imported.trigger => {
                    prev.enabled
                }
                _ => false,
            };

            let store = self.store.clone();
            tokio::task::spawn_blocking(move || store.upsert_workflow(imported))
                .await
                .map_err(|err| FrError::Other(err.to_string()))??;
            imported_count += 1;
        }

        let store = self.store.clone();
        let workflows = tokio::task::spawn_blocking(move || store.list_workflows())
            .await
            .map_err(|err| FrError::Other(err.to_string()))??;

        Ok(WorkflowSyncReport {
            workflows,
            imported_count,
            skipped_count,
            skipped_notes,
        })
    }

    /// Exports a single workflow definition to Nextcloud (`/_FR_App/workflows/<id>.json`)
    /// using ETag optimistic concurrency (`If-Match`) so a teammate's newer edit is never silently
    /// overwritten.
    pub async fn push_to_nextcloud(
        &self,
        workflow_id: &str,
        storage: &dyn StorageBackend,
    ) -> Result<CloudPath> {
        let store = self.store.clone();
        let id_owned = workflow_id.to_owned();
        let mut wf = tokio::task::spawn_blocking(move || store.get_workflow(&id_owned))
            .await
            .map_err(|err| FrError::Other(err.to_string()))??
            .ok_or_else(|| FrError::NotFound(format!("workflow '{workflow_id}'")))?;

        let app_dir = CloudPath::parse("/_FR_App")?;
        let _ = storage.mkdir(&app_dir).await;
        let wf_dir = CloudPath::parse(TEAM_WORKFLOWS_DIR)?;
        let _ = storage.mkdir(&wf_dir).await;

        let target = wf_dir.join(&format!("{}.json", wf.id))?;
        let expected_etag = match wf.remote_etag.as_deref() {
            Some(raw) if !raw.is_empty() => Some(Etag::new(raw)),
            _ => {
                // If we have never synced/pushed this ID before, ONLY proceed when the remote
                // file is definitively absent (`NotFound`). Propagate transient/auth errors so
                // we never fail open into an unconditional overwrite.
                match storage.stat(&target).await {
                    Ok(remote) => {
                        return Err(FrError::Conflict {
                            path: target.as_str().to_owned(),
                            expected: "none".into(),
                            actual: remote
                                .etag
                                .map(|e| e.as_str().to_owned())
                                .unwrap_or_else(|| "existing".into()),
                        });
                    }
                    Err(FrError::NotFound(_)) => None,
                    Err(other) => return Err(other),
                }
            }
        };

        // Never serialize machine-local `remote_etag` into the shared team JSON.
        let mut export_copy = wf.clone();
        export_copy.remote_etag = None;
        export_copy.enabled = false;
        let json = serde_json::to_vec_pretty(&export_copy)?;

        let new_etag = storage
            .write(&target, Bytes::from(json), expected_etag.as_ref())
            .await?;

        wf.remote_etag = Some(new_etag.as_str().to_owned());
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.upsert_workflow(wf))
            .await
            .map_err(|err| FrError::Other(err.to_string()))??;

        Ok(target)
    }

    /// Evaluates enabled `Schedule` and `FolderWatch` workflows once (intended for periodic ticks).
    pub async fn evaluate_triggers(
        &self,
        storage: &dyn StorageBackend,
    ) -> Result<Vec<WorkflowRunRecord>> {
        let store = self.store.clone();
        let workflows = tokio::task::spawn_blocking(move || store.list_workflows())
            .await
            .map_err(|err| FrError::Other(err.to_string()))??;

        // Prune cached state for deleted workflows so in-memory maps stay bounded.
        let active_ids: HashSet<String> = workflows.iter().map(|w| w.id.clone()).collect();
        {
            let mut sched = self
                .last_schedule_run
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            sched.retain(|id, _| active_ids.contains(id));
        }
        {
            let mut snaps = self
                .folder_snapshots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            snaps.retain(|id, _| active_ids.contains(id));
        }

        let mut triggered_runs = Vec::new();

        for wf in workflows.into_iter().filter(|w| w.enabled) {
            match &wf.trigger {
                WorkflowTrigger::Manual => {}
                WorkflowTrigger::Schedule { interval_minutes } => {
                    let interval =
                        Duration::from_secs(u64::from((*interval_minutes).clamp(1, 1440)) * 60);
                    let mem_last = {
                        let guard = self
                            .last_schedule_run
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        guard.get(&wf.id).copied()
                    };
                    let last_run = match mem_last {
                        Some(dt) => Some(dt),
                        None => {
                            let store = self.store.clone();
                            let wf_id = wf.id.clone();
                            tokio::task::spawn_blocking(move || store.last_run_started_at(&wf_id))
                                .await
                                .ok()
                                .and_then(Result::ok)
                                .flatten()
                        }
                    };
                    let now = Utc::now();
                    let due = match last_run {
                        None => true,
                        Some(prev) => {
                            let elapsed_secs = (now - prev).num_seconds();
                            elapsed_secs < 0 || (elapsed_secs as u64) >= interval.as_secs()
                        }
                    };
                    if due {
                        {
                            let mut guard = self
                                .last_schedule_run
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            guard.insert(wf.id.clone(), now);
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

    fn test_mcp_client(dir: &std::path::Path) -> Arc<McpClientManager> {
        Arc::new(
            McpClientManager::open(
                dir.join("mcp-servers.json"),
                Arc::new(MemoryMcpTokenStore::new()),
                reqwest::Client::new(),
            )
            .unwrap(),
        )
    }

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

        let mcp_client = test_mcp_client(db_dir.path());
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
            enabled: false,
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
            remote_etag: None,
        };
        store.upsert_workflow(wf.clone()).unwrap();

        // MCP trigger MUST reject disabled workflows.
        let mcp_err = runner
            .run_workflow("archive-and-read", "mcp", storage.as_ref())
            .await
            .unwrap_err();
        assert!(matches!(mcp_err, FrError::InvalidInput(_)));

        // Manual run is allowed and executes all 3 steps.
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
    async fn team_sync_disables_new_modified_and_protects_local_workflows() {
        let data_dir = tempdir().unwrap();
        let db_dir = tempdir().unwrap();
        let storage = LocalFsBackend::new(data_dir.path());
        let store = WorkflowStore::open(db_dir.path().join("workflows.sqlite")).unwrap();
        let runner = WorkflowRunner::new(
            store.clone(),
            test_mcp_client(db_dir.path()),
            EventBus::default(),
        );

        // Local user-created workflow must NOT be overwritten by a team file with the same ID.
        store
            .upsert_workflow(WorkflowDefinition {
                id: "local-custom".into(),
                name: "My Local Workflow".into(),
                description: "User owned".into(),
                enabled: true,
                trigger: WorkflowTrigger::Manual,
                steps: vec![WorkflowStep::CreateFolder {
                    path: "/Mine".into(),
                }],
                from_team_sync: false,
                remote_etag: None,
            })
            .unwrap();

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
            remote_etag: None,
        };
        let collision_wf = WorkflowDefinition {
            id: "local-custom".into(),
            name: "Hijack Attempt".into(),
            description: "Should be skipped".into(),
            enabled: true,
            trigger: WorkflowTrigger::Manual,
            steps: vec![WorkflowStep::CreateFolder {
                path: "/Hijack".into(),
            }],
            from_team_sync: true,
            remote_etag: None,
        };
        storage
            .write(
                &CloudPath::parse("/_FR_App/workflows/team-intake.json").unwrap(),
                Bytes::from(serde_json::to_vec(&remote_wf).unwrap()),
                None,
            )
            .await
            .unwrap();
        storage
            .write(
                &CloudPath::parse("/_FR_App/workflows/local-custom.json").unwrap(),
                Bytes::from(serde_json::to_vec(&collision_wf).unwrap()),
                None,
            )
            .await
            .unwrap();
        storage
            .write(
                &CloudPath::parse("/_FR_App/workflows/broken.json").unwrap(),
                Bytes::from_static(b"{not-valid-json"),
                None,
            )
            .await
            .unwrap();

        let report = runner.sync_from_nextcloud(&storage).await.unwrap();
        assert_eq!(report.imported_count, 1);
        assert_eq!(report.skipped_count, 2);
        let synced = report
            .workflows
            .iter()
            .find(|w| w.id == "team-intake")
            .unwrap();
        assert!(
            !synced.enabled,
            "newly synced team workflows must default to disabled"
        );
        let local = report
            .workflows
            .iter()
            .find(|w| w.id == "local-custom")
            .unwrap();
        assert_eq!(local.name, "My Local Workflow");
        assert!(!local.from_team_sync);

        // User explicitly enables the synced workflow locally.
        let mut enabled_locally = synced.clone();
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
        let after = resynced
            .workflows
            .iter()
            .find(|w| w.id == "team-intake")
            .unwrap();
        assert!(
            !after.enabled,
            "team workflow with modified steps must be re-disabled until reviewed"
        );
    }

    #[tokio::test]
    async fn schedule_persists_across_restarts_and_folder_watch_avoids_self_loop() {
        let data_dir = tempdir().unwrap();
        let db_dir = tempdir().unwrap();
        let storage = LocalFsBackend::new(data_dir.path());
        storage
            .mkdir(&CloudPath::parse("/Watched").unwrap())
            .await
            .unwrap();

        let store = WorkflowStore::open(db_dir.path().join("workflows.sqlite")).unwrap();
        store
            .upsert_workflow(WorkflowDefinition {
                id: "daily-job".into(),
                name: "Daily Job".into(),
                description: String::new(),
                enabled: true,
                trigger: WorkflowTrigger::Schedule {
                    interval_minutes: 1440,
                },
                steps: vec![WorkflowStep::CreateFolder {
                    path: "/DailyOut".into(),
                }],
                from_team_sync: false,
                remote_etag: None,
            })
            .unwrap();
        store
            .upsert_workflow(WorkflowDefinition {
                id: "watch-self".into(),
                name: "Watch Self".into(),
                description: String::new(),
                enabled: true,
                trigger: WorkflowTrigger::FolderWatch {
                    path: "/Watched".into(),
                },
                steps: vec![WorkflowStep::WriteMarkdown {
                    path: "/Watched/summary.md".into(),
                    content: "Updated".into(),
                    create_only: false,
                }],
                from_team_sync: false,
                remote_etag: None,
            })
            .unwrap();

        // First runner instance: daily-job fires once; watch-self establishes baseline only.
        let runner1 = WorkflowRunner::new(
            store.clone(),
            test_mcp_client(db_dir.path()),
            EventBus::default(),
        );
        let tick1 = runner1.evaluate_triggers(&storage).await.unwrap();
        assert_eq!(tick1.len(), 1);
        assert_eq!(tick1[0].workflow_id, "daily-job");

        // External file added to /Watched -> watch-self fires AND writes /Watched/summary.md.
        storage
            .write(
                &CloudPath::parse("/Watched/input.txt").unwrap(),
                Bytes::from_static(b"hello"),
                None,
            )
            .await
            .unwrap();
        let tick2 = runner1.evaluate_triggers(&storage).await.unwrap();
        assert_eq!(tick2.len(), 1);
        assert_eq!(tick2[0].workflow_id, "watch-self");

        // Next tick with no new external changes MUST NOT self-trigger on summary.md.
        let tick3 = runner1.evaluate_triggers(&storage).await.unwrap();
        assert!(tick3.is_empty());

        // Simulated app restart (fresh WorkflowRunner against same SQLite store):
        // daily-job MUST NOT re-fire immediately because its last run is persisted!
        let runner2 = WorkflowRunner::new(
            store.clone(),
            test_mcp_client(db_dir.path()),
            EventBus::default(),
        );
        let after_restart = runner2.evaluate_triggers(&storage).await.unwrap();
        assert!(
            after_restart.is_empty(),
            "24h schedule must not re-fire immediately after app restart"
        );
    }

    #[tokio::test]
    async fn push_edit_push_preserves_remote_etag_and_detects_remote_conflict() {
        let data_dir = tempdir().unwrap();
        let db_dir = tempdir().unwrap();
        let storage = LocalFsBackend::new(data_dir.path());
        let store = WorkflowStore::open(db_dir.path().join("workflows.sqlite")).unwrap();
        let runner = WorkflowRunner::new(
            store.clone(),
            test_mcp_client(db_dir.path()),
            EventBus::default(),
        );

        let wf = WorkflowDefinition {
            id: "shared-flow".into(),
            name: "Shared Flow".into(),
            description: "v1".into(),
            enabled: false,
            trigger: WorkflowTrigger::Manual,
            steps: vec![WorkflowStep::CreateFolder {
                path: "/Out".into(),
            }],
            from_team_sync: false,
            remote_etag: None,
        };
        store.upsert_workflow(wf.clone()).unwrap();

        // First push creates /_FR_App/workflows/shared-flow.json and persists remote_etag.
        let pushed_path = runner
            .push_to_nextcloud("shared-flow", &storage)
            .await
            .unwrap();
        assert_eq!(pushed_path.as_str(), "/_FR_App/workflows/shared-flow.json");

        // Simulate UI edit sending stale `remote_etag: None`; store must preserve stored ETag.
        let mut edited = wf.clone();
        edited.description = "v2".into();
        edited.remote_etag = None;
        let saved = store.upsert_workflow(edited).unwrap();
        assert!(saved.remote_etag.is_some());

        // Second push succeeds cleanly using the preserved ETag.
        runner
            .push_to_nextcloud("shared-flow", &storage)
            .await
            .unwrap();

        // Now a teammate modifies the remote file directly -> next push MUST return Conflict.
        storage
            .write(
                &pushed_path,
                Bytes::from_static(b"{\"changed\":true}"),
                None,
            )
            .await
            .unwrap();
        let conflict = runner
            .push_to_nextcloud("shared-flow", &storage)
            .await
            .unwrap_err();
        assert!(matches!(conflict, FrError::Conflict { .. }));
    }
}
