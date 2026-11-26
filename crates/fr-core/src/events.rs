use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::broadcast;

/// Domain events broadcast between modules, the desktop shell, and automation triggers.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AppEvent {
    ConfigUpdated {
        timestamp: DateTime<Utc>,
    },
    FileCreated {
        path: String,
        timestamp: DateTime<Utc>,
    },
    FileUpdated {
        path: String,
        etag: String,
        timestamp: DateTime<Utc>,
    },
    FileDeleted {
        path: String,
        timestamp: DateTime<Utc>,
    },
    FileRenamed {
        from: String,
        to: String,
        timestamp: DateTime<Utc>,
    },
    WorkflowCompleted {
        workflow_id: String,
        run_id: String,
        succeeded: bool,
        timestamp: DateTime<Utc>,
    },
    FinanceEntryChanged {
        entry_id: String,
        timestamp: DateTime<Utc>,
    },
    AppUpdateAvailable {
        version: String,
        notes: Option<String>,
        timestamp: DateTime<Utc>,
    },
    AppUpdateProgress {
        #[specta(type = f64)]
        downloaded_bytes: u64,
        #[specta(type = Option<f64>)]
        total_bytes: Option<u64>,
        percent: Option<u8>,
        timestamp: DateTime<Utc>,
    },
}

/// Lightweight in-process broadcast bus for decoupled module communication.
#[derive(Debug, Clone)]
pub struct EventBus {
    sender: broadcast::Sender<AppEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(128)
    }
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    /// Publishes an event to all current subscribers. Returns the number of active receivers.
    pub fn publish(&self, event: AppEvent) -> usize {
        self.sender.send(event).unwrap_or(0)
    }

    /// Subscribes to future events on the bus.
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.sender.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn event_bus_delivers_published_events() {
        let bus = EventBus::default();
        let mut rx = bus.subscribe();

        let delivered = bus.publish(AppEvent::ConfigUpdated {
            timestamp: Utc::now(),
        });
        assert_eq!(delivered, 1);

        let received = rx.recv().await.expect("receive event");
        assert!(matches!(received, AppEvent::ConfigUpdated { .. }));
    }
}
