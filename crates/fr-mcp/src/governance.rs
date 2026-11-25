use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::oneshot;
use uuid::Uuid;

const MAX_AUDIT_ENTRIES: usize = 200;

/// Outcome of a single MCP Server tool invocation recorded in the local audit log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpAuditStatus {
    Allowed,
    Denied,
    TimedOut,
    Failed,
}

/// Concise audit log record shown in the desktop UI (never stores file contents or secrets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpAuditEntry {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub tool_name: String,
    pub summary: String,
    pub is_write: bool,
    pub status: McpAuditStatus,
    pub duration_ms: u32,
    pub error: Option<String>,
}

/// Thread-safe bounded ring buffer storing recent MCP Server tool calls.
#[derive(Debug, Default)]
pub struct McpAuditLog {
    entries: Mutex<VecDeque<McpAuditEntry>>,
}

impl McpAuditLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, entry: McpAuditEntry) {
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.len() >= MAX_AUDIT_ENTRIES {
            guard.pop_back();
        }
        guard.push_front(entry);
    }

    pub fn list(&self) -> Vec<McpAuditEntry> {
        let guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.iter().cloned().collect()
    }

    pub fn clear(&self) {
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.clear();
    }
}

/// A mutating MCP tool call awaiting explicit Allow/Deny confirmation from the desktop user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingWriteApproval {
    pub id: String,
    pub tool_name: String,
    pub summary: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Approved,
    Denied,
    TimedOut,
}

struct PendingEntry {
    info: PendingWriteApproval,
    responder: oneshot::Sender<bool>,
}

/// Interactive write-approval gate bridging incoming MCP Server HTTP calls to the desktop UI.
#[derive(Default)]
pub struct WriteApprovalGate {
    pending: Mutex<HashMap<String, PendingEntry>>,
}

impl std::fmt::Debug for WriteApprovalGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriteApprovalGate")
            .field("pending_count", &self.pending_count())
            .finish()
    }
}

impl WriteApprovalGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pending_count(&self) -> u32 {
        let guard = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.len() as u32
    }

    pub fn list_pending(&self) -> Vec<PendingWriteApproval> {
        let guard = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut items: Vec<_> = guard.values().map(|e| e.info.clone()).collect();
        items.sort_by_key(|item| item.created_at);
        items
    }

    /// Suspends the calling MCP tool request until the user resolves it or `timeout` elapses.
    pub async fn request_approval(
        &self,
        tool_name: &str,
        summary: String,
        timeout: Duration,
    ) -> ApprovalOutcome {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let info = PendingWriteApproval {
            id: id.clone(),
            tool_name: tool_name.to_owned(),
            summary,
            created_at: Utc::now(),
        };

        {
            let mut guard = self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.insert(
                id.clone(),
                PendingEntry {
                    info,
                    responder: tx,
                },
            );
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(true)) => ApprovalOutcome::Approved,
            Ok(Ok(false)) | Ok(Err(_)) => ApprovalOutcome::Denied,
            Err(_) => {
                let mut guard = self
                    .pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.remove(&id);
                ApprovalOutcome::TimedOut
            }
        }
    }

    /// Resolves a pending write approval from the desktop UI. Returns `true` if the ID was found.
    pub fn resolve(&self, id: &str, allow: bool) -> bool {
        let entry = {
            let mut guard = self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.remove(id)
        };
        if let Some(entry) = entry {
            let _ = entry.responder.send(allow);
            true
        } else {
            false
        }
    }

    /// Denies all pending approvals (e.g. when stopping the MCP server).
    pub fn deny_all(&self) {
        let drained: Vec<PendingEntry> = {
            let mut guard = self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.drain().map(|(_, v)| v).collect()
        };
        for entry in drained {
            let _ = entry.responder.send(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn approval_gate_supports_allow_deny_and_timeout() {
        let gate = Arc::new(WriteApprovalGate::new());

        // Allow flow
        let g1 = gate.clone();
        let waiter = tokio::spawn(async move {
            g1.request_approval(
                "files_write_markdown",
                "Write /Docs/plan.md".into(),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let pending = gate.list_pending();
        assert_eq!(pending.len(), 1);
        assert!(gate.resolve(&pending[0].id, true));
        assert_eq!(waiter.await.unwrap(), ApprovalOutcome::Approved);

        // Deny flow
        let g2 = gate.clone();
        let waiter2 = tokio::spawn(async move {
            g2.request_approval(
                "files_move",
                "Move /a.md -> /b.md".into(),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let pending2 = gate.list_pending();
        assert_eq!(pending2.len(), 1);
        assert!(gate.resolve(&pending2[0].id, false));
        assert_eq!(waiter2.await.unwrap(), ApprovalOutcome::Denied);

        // Timeout flow
        let outcome = gate
            .request_approval(
                "files_mkdir",
                "Create /Temp".into(),
                Duration::from_millis(30),
            )
            .await;
        assert_eq!(outcome, ApprovalOutcome::TimedOut);
        assert_eq!(gate.pending_count(), 0);
    }
}
