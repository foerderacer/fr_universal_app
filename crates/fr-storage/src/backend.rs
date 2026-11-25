use async_trait::async_trait;
use bytes::Bytes;
use fr_core::Result;

use crate::path::CloudPath;
use crate::types::{Etag, FileEntry};

/// Universal storage contract implemented by Nextcloud WebDAV (production) and
/// `LocalFsBackend` (tests / local offline workspace).
#[async_trait]
pub trait StorageBackend: Send + Sync {
    async fn list(&self, path: &CloudPath) -> Result<Vec<FileEntry>>;
    async fn stat(&self, path: &CloudPath) -> Result<FileEntry>;
    async fn read(&self, path: &CloudPath) -> Result<(Bytes, Etag)>;
    async fn read_range(&self, path: &CloudPath, start: u64, end: Option<u64>) -> Result<Bytes>;
    async fn write(
        &self,
        path: &CloudPath,
        data: Bytes,
        expected_etag: Option<&Etag>,
    ) -> Result<Etag>;
    async fn mkdir(&self, path: &CloudPath) -> Result<()>;
    async fn rename(&self, from: &CloudPath, to: &CloudPath) -> Result<()>;
    async fn delete(&self, path: &CloudPath) -> Result<()>;
    async fn thumbnail(&self, file_id: &str, width: u32, height: u32) -> Result<Option<Bytes>>;
}
