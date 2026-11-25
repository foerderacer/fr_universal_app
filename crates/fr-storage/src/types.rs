use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::path::CloudPath;

/// Opaque entity tag used for optimistic concurrency (`If-Match` / HTTP 412 conflict detection).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct Etag(pub String);

impl Etag {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Distinguishes directories from regular files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Directory,
    File,
}

/// Normalized metadata for a file or folder returned by any [`crate::StorageBackend`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub path: CloudPath,
    pub kind: FileKind,
    pub size: u64,
    pub mime_type: Option<String>,
    pub etag: Option<Etag>,
    pub modified_at: Option<DateTime<Utc>>,
}
