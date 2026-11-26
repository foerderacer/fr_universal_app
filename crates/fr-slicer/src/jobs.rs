//! Slice job state machine (`queued` / `running` / `completed` / `failed` / `cancelled`)
//! with cooperative cancellation and in-memory G-code retention for SD-card download or
//! Nextcloud upload via `StorageBackend`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use chrono::Utc;
use fr_core::{FrError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::watch;

use crate::profiles::{QualityPreset, RigidityPreset};

const MAX_RETAINED_JOBS: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SliceJobState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SliceJobRecord {
    pub id: String,
    pub output_file_name: String,
    pub material_name: String,
    pub rigidity: RigidityPreset,
    pub quality: QualityPreset,
    pub state: SliceJobState,
    pub percent: u8,
    pub stage: String,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub estimated_time: Option<String>,
    pub filament_grams: Option<f64>,
    pub filament_mm: Option<f64>,
    pub gcode_size_bytes: Option<u32>,
    pub cloud_saved_path: Option<String>,
    pub error_message: Option<String>,
    pub technical_log: Option<String>,
}

struct StoredJob {
    record: SliceJobRecord,
    cancel_tx: Option<watch::Sender<bool>>,
    gcode: Option<Bytes>,
}

/// Thread-safe registry for active and recent slice jobs.
#[derive(Clone, Default)]
pub struct SliceJobManager {
    inner: Arc<Mutex<JobStoreInner>>,
}

#[derive(Default)]
struct JobStoreInner {
    order: VecDeque<String>,
    jobs: HashMap<String, StoredJob>,
}

impl SliceJobManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a new job in `Queued` state and returns its record plus cancellation receiver.
    pub fn create_job(
        &self,
        output_file_name: String,
        material_name: String,
        rigidity: RigidityPreset,
        quality: QualityPreset,
    ) -> (SliceJobRecord, watch::Receiver<bool>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let record = SliceJobRecord {
            id: id.clone(),
            output_file_name,
            material_name,
            rigidity,
            quality,
            state: SliceJobState::Queued,
            percent: 0,
            stage: "Queued for slicing...".into(),
            created_at: Utc::now().to_rfc3339(),
            finished_at: None,
            estimated_time: None,
            filament_grams: None,
            filament_mm: None,
            gcode_size_bytes: None,
            cloud_saved_path: None,
            error_message: None,
            technical_log: None,
        };

        if let Ok(mut guard) = self.inner.lock() {
            guard.order.push_front(id.clone());
            guard.jobs.insert(
                id,
                StoredJob {
                    record: record.clone(),
                    cancel_tx: Some(cancel_tx),
                    gcode: None,
                },
            );
            while guard.order.len() > MAX_RETAINED_JOBS {
                // Never evict an active (Queued/Running) job so its cancel handle & completion record stay intact.
                let evict_idx = guard.order.iter().rposition(|id| {
                    guard.jobs.get(id).is_none_or(|j| {
                        !matches!(
                            j.record.state,
                            SliceJobState::Queued | SliceJobState::Running
                        )
                    })
                });
                let Some(idx) = evict_idx else {
                    break;
                };
                if let Some(oldest) = guard.order.remove(idx) {
                    guard.jobs.remove(&oldest);
                }
            }
        }
        (record, cancel_rx)
    }

    pub fn update_progress(&self, job_id: &str, percent: u8, stage: String) {
        if let Ok(mut guard) = self.inner.lock()
            && let Some(job) = guard.jobs.get_mut(job_id)
            && matches!(
                job.record.state,
                SliceJobState::Queued | SliceJobState::Running
            )
        {
            job.record.state = SliceJobState::Running;
            job.record.percent = percent;
            job.record.stage = stage;
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mark_completed(
        &self,
        job_id: &str,
        gcode: Bytes,
        estimated_time: Option<String>,
        filament_grams: Option<f64>,
        filament_mm: Option<f64>,
        cloud_saved_path: Option<String>,
        technical_log: String,
    ) -> Option<SliceJobRecord> {
        let mut guard = self.inner.lock().ok()?;
        let job = guard.jobs.get_mut(job_id)?;
        job.record.state = SliceJobState::Completed;
        job.record.percent = 100;
        job.record.stage = "G-code ready for Prusa MK3S".into();
        job.record.finished_at = Some(Utc::now().to_rfc3339());
        job.record.estimated_time = estimated_time;
        job.record.filament_grams = filament_grams;
        job.record.filament_mm = filament_mm;
        job.record.gcode_size_bytes = Some(u32::try_from(gcode.len()).unwrap_or(u32::MAX));
        job.record.cloud_saved_path = cloud_saved_path;
        job.record.technical_log = if technical_log.trim().is_empty() {
            None
        } else {
            Some(technical_log)
        };
        job.cancel_tx = None;
        job.gcode = Some(gcode);
        Some(job.record.clone())
    }

    pub fn mark_failed(
        &self,
        job_id: &str,
        friendly_error: String,
        technical_log: Option<String>,
    ) -> Option<SliceJobRecord> {
        let mut guard = self.inner.lock().ok()?;
        let job = guard.jobs.get_mut(job_id)?;
        job.record.state = SliceJobState::Failed;
        job.record.stage = "Slicing failed".into();
        job.record.finished_at = Some(Utc::now().to_rfc3339());
        job.record.error_message = Some(friendly_error);
        job.record.technical_log = technical_log;
        job.cancel_tx = None;
        Some(job.record.clone())
    }

    pub fn mark_cancelled(&self, job_id: &str) -> Option<SliceJobRecord> {
        let mut guard = self.inner.lock().ok()?;
        let job = guard.jobs.get_mut(job_id)?;
        job.record.state = SliceJobState::Cancelled;
        job.record.stage = "Cancelled".into();
        job.record.finished_at = Some(Utc::now().to_rfc3339());
        job.cancel_tx = None;
        Some(job.record.clone())
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<SliceJobRecord> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| FrError::Other("slice job lock poisoned".into()))?;
        let job = guard
            .jobs
            .get_mut(job_id)
            .ok_or_else(|| FrError::NotFound(format!("Slice job '{job_id}' was not found.")))?;
        if let Some(tx) = job.cancel_tx.take() {
            let _ = tx.send(true);
        }
        if matches!(
            job.record.state,
            SliceJobState::Queued | SliceJobState::Running
        ) {
            job.record.state = SliceJobState::Cancelled;
            job.record.stage = "Cancelling...".into();
            job.record.finished_at = Some(Utc::now().to_rfc3339());
        }
        Ok(job.record.clone())
    }

    pub fn set_cloud_saved_path(&self, job_id: &str, cloud_path: String) -> Option<SliceJobRecord> {
        let mut guard = self.inner.lock().ok()?;
        let job = guard.jobs.get_mut(job_id)?;
        job.record.cloud_saved_path = Some(cloud_path);
        Some(job.record.clone())
    }

    pub fn get_job(&self, job_id: &str) -> Option<SliceJobRecord> {
        self.inner
            .lock()
            .ok()?
            .jobs
            .get(job_id)
            .map(|j| j.record.clone())
    }

    pub fn get_gcode(&self, job_id: &str) -> Option<(String, Bytes)> {
        let guard = self.inner.lock().ok()?;
        let job = guard.jobs.get(job_id)?;
        let bytes = job.gcode.clone()?;
        Some((job.record.output_file_name.clone(), bytes))
    }

    pub fn list_jobs(&self) -> Vec<SliceJobRecord> {
        let Ok(guard) = self.inner.lock() else {
            return Vec::new();
        };
        guard
            .order
            .iter()
            .filter_map(|id| guard.jobs.get(id).map(|j| j.record.clone()))
            .collect()
    }

    pub fn active_job_count(&self) -> u32 {
        let Ok(guard) = self.inner.lock() else {
            return 0;
        };
        guard
            .jobs
            .values()
            .filter(|j| {
                matches!(
                    j.record.state,
                    SliceJobState::Queued | SliceJobState::Running
                )
            })
            .count() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_manager_tracks_lifecycle_cancellation_and_never_evicts_running_jobs() {
        let mgr = SliceJobManager::new();
        let (running, mut cancel_rx) = mgr.create_job(
            "first.gcode".into(),
            "PLA".into(),
            RigidityPreset::Medium,
            QualityPreset::Standard,
        );
        mgr.update_progress(&running.id, 30, "Slicing...".into());
        assert_eq!(mgr.active_job_count(), 1);

        for i in 0..15 {
            let (j, _) = mgr.create_job(
                format!("part_{i}.gcode"),
                "PLA".into(),
                RigidityPreset::Low,
                QualityPreset::Fast,
            );
            mgr.mark_completed(
                &j.id,
                Bytes::from_static(b"G28 W\n"),
                Some("10m".into()),
                Some(5.0),
                Some(1500.0),
                None,
                String::new(),
            );
        }
        assert!(mgr.get_job(&running.id).is_some());
        assert_eq!(mgr.active_job_count(), 1);

        let cancelled = mgr.cancel_job(&running.id).unwrap();
        assert_eq!(cancelled.state, SliceJobState::Cancelled);
        assert!(*cancel_rx.borrow_and_update());
        assert_eq!(mgr.active_job_count(), 0);
    }
}
