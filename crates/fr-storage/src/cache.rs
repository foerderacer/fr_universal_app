use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bytes::Bytes;
use chrono::Utc;
use fr_core::{FrError, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tempfile::NamedTempFile;

use crate::backend::StorageBackend;
use crate::path::CloudPath;
use crate::types::{Etag, FileEntry};

/// Local unsaved Markdown draft stored in SQLite so edits survive crashes or offline periods.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDraft {
    pub path: CloudPath,
    pub content: String,
    pub base_etag: Option<Etag>,
    pub updated_at_ms: f64,
}

/// SQLite-backed metadata cache, LRU blob store, thumbnail cache, and local Markdown draft store.
#[derive(Clone)]
pub struct CacheStore {
    root: PathBuf,
    blobs_dir: PathBuf,
    conn: Arc<Mutex<Connection>>,
    max_bytes: Arc<Mutex<u64>>,
}

impl std::fmt::Debug for CacheStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CacheStore")
            .field("root", &self.root)
            .finish()
    }
}

fn sqlite_err(err: rusqlite::Error) -> FrError {
    FrError::Other(format!("cache database error: {err}"))
}

fn hash_key(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

impl CacheStore {
    /// Opens (or initializes) a SQLite cache database and blob directory inside `root`.
    pub fn open(root: impl Into<PathBuf>, max_limit_mb: u32) -> Result<Self> {
        let root = root.into();
        let blobs_dir = root.join("blobs");
        std::fs::create_dir_all(&blobs_dir)?;

        let db_path = root.join("cache.sqlite");
        let conn = Connection::open(&db_path).map_err(sqlite_err)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS cached_dirs (
                path TEXT PRIMARY KEY,
                entries_json TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cached_blobs (
                cache_key TEXT PRIMARY KEY,
                cloud_path TEXT NOT NULL,
                etag TEXT NOT NULL,
                file_name TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                last_accessed_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS markdown_drafts (
                cloud_path TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                base_etag TEXT,
                updated_at_ms INTEGER NOT NULL
            );
            ",
        )
        .map_err(sqlite_err)?;

        let max_bytes = u64::from(max_limit_mb.max(16)) * 1024 * 1024;
        let store = Self {
            root,
            blobs_dir,
            conn: Arc::new(Mutex::new(conn)),
            max_bytes: Arc::new(Mutex::new(max_bytes)),
        };
        let _ = store.sweep_orphaned_blobs();
        Ok(store)
    }

    fn sweep_orphaned_blobs(&self) -> Result<()> {
        let referenced: std::collections::HashSet<String> = {
            let conn = self
                .conn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut stmt = conn
                .prepare("SELECT file_name FROM cached_blobs")
                .map_err(sqlite_err)?;
            let rows = stmt.query_map([], |row| row.get(0)).map_err(sqlite_err)?;
            let mut set = std::collections::HashSet::new();
            for row in rows {
                set.insert(row.map_err(sqlite_err)?);
            }
            set
        };

        if let Ok(entries) = std::fs::read_dir(&self.blobs_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !referenced.contains(&name) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Updates the maximum LRU cache size in megabytes and runs eviction if needed.
    pub fn set_limit_mb(&self, limit_mb: u32) -> Result<()> {
        let limit_bytes = u64::from(limit_mb.max(16)) * 1024 * 1024;
        {
            let mut guard = self
                .max_bytes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = limit_bytes;
        }
        self.evict_if_needed()
    }

    /// Updates the maximum LRU cache size in exact bytes (primarily for deterministic tests).
    pub fn set_limit_bytes(&self, limit_bytes: u64) -> Result<()> {
        {
            let mut guard = self
                .max_bytes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = limit_bytes;
        }
        self.evict_if_needed()
    }

    pub fn put_dir_listing(&self, path: &CloudPath, entries: &[FileEntry]) -> Result<()> {
        let json = serde_json::to_string(entries)?;
        let now = Utc::now().timestamp_millis();
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.execute(
            "INSERT INTO cached_dirs (path, entries_json, updated_at_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET entries_json = excluded.entries_json, updated_at_ms = excluded.updated_at_ms",
            params![path.as_str(), json, now],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    pub fn get_dir_listing(&self, path: &CloudPath) -> Result<Option<Vec<FileEntry>>> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let raw: Option<String> = conn
            .query_row(
                "SELECT entries_json FROM cached_dirs WHERE path = ?1",
                params![path.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(sqlite_err)?;

        match raw {
            Some(json) => Ok(Some(serde_json::from_str(&json)?)),
            None => Ok(None),
        }
    }

    pub fn invalidate_dir(&self, path: &CloudPath) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.execute(
            "DELETE FROM cached_dirs WHERE path = ?1",
            params![path.as_str()],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    pub fn put_blob(&self, cloud_path: &CloudPath, etag: &Etag, data: &[u8]) -> Result<()> {
        let limit = *self
            .max_bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if (data.len() as u64) > limit {
            return Ok(());
        }

        let cache_key = hash_key(&format!("blob:{}:{}", cloud_path.as_str(), etag.as_str()));
        let file_name = format!("{cache_key}.blob");
        let target = self.blobs_dir.join(&file_name);

        let mut tmp = NamedTempFile::new_in(&self.blobs_dir)?;
        tmp.write_all(data)?;
        tmp.as_file().sync_all()?;
        tmp.persist(&target).map_err(|err| FrError::Io(err.error))?;

        let now = Utc::now().timestamp_millis();
        {
            let conn = self
                .conn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            conn.execute(
                "INSERT INTO cached_blobs (cache_key, cloud_path, etag, file_name, size_bytes, last_accessed_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(cache_key) DO UPDATE SET
                   size_bytes = excluded.size_bytes,
                   last_accessed_ms = excluded.last_accessed_ms",
                params![
                    cache_key,
                    cloud_path.as_str(),
                    etag.as_str(),
                    file_name,
                    data.len() as i64,
                    now
                ],
            )
            .map_err(sqlite_err)?;
        }

        self.evict_if_needed()
    }

    pub fn get_blob(&self, cloud_path: &CloudPath, etag: &Etag) -> Result<Option<Bytes>> {
        let cache_key = hash_key(&format!("blob:{}:{}", cloud_path.as_str(), etag.as_str()));
        let file_name: Option<String> = {
            let conn = self
                .conn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            conn.query_row(
                "SELECT file_name FROM cached_blobs WHERE cache_key = ?1",
                params![cache_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(sqlite_err)?
        };

        let Some(file_name) = file_name else {
            return Ok(None);
        };

        let blob_path = self.blobs_dir.join(&file_name);
        let data = match std::fs::read(&blob_path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let conn = self
                    .conn
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let _ = conn.execute(
                    "DELETE FROM cached_blobs WHERE cache_key = ?1",
                    params![cache_key],
                );
                return Ok(None);
            }
            Err(err) => return Err(FrError::Io(err)),
        };

        let now = Utc::now().timestamp_millis();
        {
            let conn = self
                .conn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = conn.execute(
                "UPDATE cached_blobs SET last_accessed_ms = ?1 WHERE cache_key = ?2",
                params![now, cache_key],
            );
        }

        Ok(Some(Bytes::from(data)))
    }

    pub fn put_thumbnail(&self, file_id: &str, width: u32, height: u32, data: &[u8]) -> Result<()> {
        let synthetic_path =
            CloudPath::parse(&format!("/_thumbs/{file_id}")).unwrap_or_else(|_| CloudPath::root());
        let synthetic_etag = Etag::new(format!("thumb-{width}x{height}-{file_id}"));
        self.put_blob(&synthetic_path, &synthetic_etag, data)
    }

    pub fn get_thumbnail(&self, file_id: &str, width: u32, height: u32) -> Result<Option<Bytes>> {
        let synthetic_path =
            CloudPath::parse(&format!("/_thumbs/{file_id}")).unwrap_or_else(|_| CloudPath::root());
        let synthetic_etag = Etag::new(format!("thumb-{width}x{height}-{file_id}"));
        self.get_blob(&synthetic_path, &synthetic_etag)
    }

    pub fn invalidate_path_blobs(&self, cloud_path: &CloudPath) -> Result<()> {
        let files: Vec<String> = {
            let conn = self
                .conn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut stmt = conn
                .prepare("SELECT file_name FROM cached_blobs WHERE cloud_path = ?1")
                .map_err(sqlite_err)?;
            let rows = stmt
                .query_map(params![cloud_path.as_str()], |row| row.get(0))
                .map_err(sqlite_err)?;
            let mut list = Vec::new();
            for row in rows {
                list.push(row.map_err(sqlite_err)?);
            }
            conn.execute(
                "DELETE FROM cached_blobs WHERE cloud_path = ?1",
                params![cloud_path.as_str()],
            )
            .map_err(sqlite_err)?;
            list
        };

        for file_name in files {
            let _ = std::fs::remove_file(self.blobs_dir.join(file_name));
        }
        Ok(())
    }

    pub fn save_markdown_draft(
        &self,
        path: &CloudPath,
        content: &str,
        base_etag: Option<&Etag>,
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.execute(
            "INSERT INTO markdown_drafts (cloud_path, content, base_etag, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(cloud_path) DO UPDATE SET
               content = excluded.content,
               base_etag = excluded.base_etag,
               updated_at_ms = excluded.updated_at_ms",
            params![path.as_str(), content, base_etag.map(Etag::as_str), now],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    pub fn get_markdown_draft(&self, path: &CloudPath) -> Result<Option<MarkdownDraft>> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let row: Option<(String, Option<String>, i64)> = conn
            .query_row(
                "SELECT content, base_etag, updated_at_ms FROM markdown_drafts WHERE cloud_path = ?1",
                params![path.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(sqlite_err)?;

        Ok(
            row.map(|(content, base_etag, updated_at_ms)| MarkdownDraft {
                path: path.clone(),
                content,
                base_etag: base_etag.map(Etag::new),
                updated_at_ms: updated_at_ms as f64,
            }),
        )
    }

    pub fn delete_markdown_draft(&self, path: &CloudPath) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.execute(
            "DELETE FROM markdown_drafts WHERE cloud_path = ?1",
            params![path.as_str()],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// Clears all cached directory listings, blobs, thumbnails, and drafts (e.g. on sign-out).
    fn wipe_blobs_dir(&self) {
        if let Ok(entries) = std::fs::read_dir(&self.blobs_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    /// Clears cached directory listings, blobs, and thumbnails (including any orphaned files
    /// in `blobs_dir`) while preserving unsaved local `markdown_drafts` so user edits are never
    /// silently lost on sign-out or server change.
    pub fn clear_cached_data(&self) -> Result<()> {
        {
            let conn = self
                .conn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            conn.execute_batch("DELETE FROM cached_dirs; DELETE FROM cached_blobs; VACUUM;")
                .map_err(sqlite_err)?;
        }
        self.wipe_blobs_dir();
        Ok(())
    }

    /// Clears all cached directory listings, blobs, thumbnails, and drafts.
    pub fn clear_all(&self) -> Result<()> {
        {
            let conn = self
                .conn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            conn.execute_batch(
                "DELETE FROM cached_dirs; DELETE FROM cached_blobs; DELETE FROM markdown_drafts; VACUUM;",
            )
            .map_err(sqlite_err)?;
        }
        self.wipe_blobs_dir();
        Ok(())
    }

    fn evict_if_needed(&self) -> Result<()> {
        let limit = *self
            .max_bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let to_delete: Vec<(String, String)> = {
            let conn = self
                .conn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let total: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(size_bytes), 0) FROM cached_blobs",
                    [],
                    |row| row.get(0),
                )
                .map_err(sqlite_err)?;

            if (total as u64) <= limit {
                return Ok(());
            }

            let mut remaining = total as u64;
            let mut stmt = conn
                .prepare(
                    "SELECT cache_key, file_name, size_bytes FROM cached_blobs ORDER BY last_accessed_ms ASC",
                )
                .map_err(sqlite_err)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(sqlite_err)?;

            let mut victims = Vec::new();
            for row in rows {
                if remaining <= limit {
                    break;
                }
                let (key, file_name, size) = row.map_err(sqlite_err)?;
                remaining = remaining.saturating_sub(size.max(0) as u64);
                victims.push((key, file_name));
            }

            for (key, _) in &victims {
                conn.execute(
                    "DELETE FROM cached_blobs WHERE cache_key = ?1",
                    params![key],
                )
                .map_err(sqlite_err)?;
            }

            victims
        };

        for (_, file_name) in to_delete {
            let _ = std::fs::remove_file(self.blobs_dir.join(file_name));
        }
        Ok(())
    }
}

/// Caching decorator wrapping any [`StorageBackend`] with SQLite metadata & LRU blob caching.
pub struct CachedStorage<B: StorageBackend> {
    inner: Arc<B>,
    cache: CacheStore,
}

impl<B: StorageBackend> CachedStorage<B> {
    pub fn new(inner: Arc<B>, cache: CacheStore) -> Self {
        Self { inner, cache }
    }

    pub fn cache(&self) -> &CacheStore {
        &self.cache
    }

    pub fn inner(&self) -> &Arc<B> {
        &self.inner
    }
}

#[async_trait]
impl<B: StorageBackend + 'static> StorageBackend for CachedStorage<B> {
    async fn list(&self, path: &CloudPath) -> Result<Vec<FileEntry>> {
        match self.inner.list(path).await {
            Ok(entries) => {
                let cache = self.cache.clone();
                let path_clone = path.clone();
                let entries_clone = entries.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    cache.put_dir_listing(&path_clone, &entries_clone)
                })
                .await;
                Ok(entries)
            }
            Err(FrError::Network(net_err)) => {
                let cache = self.cache.clone();
                let path_clone = path.clone();
                let cached =
                    tokio::task::spawn_blocking(move || cache.get_dir_listing(&path_clone))
                        .await
                        .map_err(|err| FrError::Other(err.to_string()))??;
                if let Some(entries) = cached {
                    Ok(entries)
                } else {
                    Err(FrError::Network(net_err))
                }
            }
            Err(err) => Err(err),
        }
    }

    async fn stat(&self, path: &CloudPath) -> Result<FileEntry> {
        self.inner.stat(path).await
    }

    async fn read(&self, path: &CloudPath) -> Result<(Bytes, Etag)> {
        // Check remote metadata for current ETag first if available, or fetch directly.
        if let Ok(entry) = self.inner.stat(path).await
            && let Some(ref remote_etag) = entry.etag
        {
            let cache = self.cache.clone();
            let path_clone = path.clone();
            let etag_clone = remote_etag.clone();
            if let Ok(Ok(Some(hit))) =
                tokio::task::spawn_blocking(move || cache.get_blob(&path_clone, &etag_clone)).await
            {
                return Ok((hit, remote_etag.clone()));
            }
        }

        let (bytes, etag) = self.inner.read(path).await?;
        let cache = self.cache.clone();
        let path_clone = path.clone();
        let etag_clone = etag.clone();
        let bytes_clone = bytes.clone();
        let _ = tokio::task::spawn_blocking(move || {
            cache.put_blob(&path_clone, &etag_clone, &bytes_clone)
        })
        .await;
        Ok((bytes, etag))
    }

    async fn read_range(&self, path: &CloudPath, start: u64, end: Option<u64>) -> Result<Bytes> {
        self.inner.read_range(path, start, end).await
    }

    async fn write(
        &self,
        path: &CloudPath,
        data: Bytes,
        expected_etag: Option<&Etag>,
    ) -> Result<Etag> {
        let new_etag = self.inner.write(path, data.clone(), expected_etag).await?;
        let cache = self.cache.clone();
        let path_clone = path.clone();
        let parent = path.parent();
        let etag_clone = new_etag.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = cache.invalidate_path_blobs(&path_clone);
            let _ = cache.put_blob(&path_clone, &etag_clone, &data);
            if let Some(p) = parent {
                let _ = cache.invalidate_dir(&p);
            }
        })
        .await;
        Ok(new_etag)
    }

    async fn mkdir(&self, path: &CloudPath) -> Result<()> {
        self.inner.mkdir(path).await?;
        if let Some(parent) = path.parent() {
            let cache = self.cache.clone();
            let _ = tokio::task::spawn_blocking(move || cache.invalidate_dir(&parent)).await;
        }
        Ok(())
    }

    async fn rename(&self, from: &CloudPath, to: &CloudPath) -> Result<()> {
        self.inner.rename(from, to).await?;
        let cache = self.cache.clone();
        let from_clone = from.clone();
        let to_clone = to.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = cache.invalidate_path_blobs(&from_clone);
            let _ = cache.invalidate_path_blobs(&to_clone);
            if let Some(p) = from_clone.parent() {
                let _ = cache.invalidate_dir(&p);
            }
            if let Some(p) = to_clone.parent() {
                let _ = cache.invalidate_dir(&p);
            }
        })
        .await;
        Ok(())
    }

    async fn delete(&self, path: &CloudPath) -> Result<()> {
        self.inner.delete(path).await?;
        let cache = self.cache.clone();
        let path_clone = path.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = cache.invalidate_path_blobs(&path_clone);
            let _ = cache.invalidate_dir(&path_clone);
            if let Some(p) = path_clone.parent() {
                let _ = cache.invalidate_dir(&p);
            }
        })
        .await;
        Ok(())
    }

    async fn thumbnail(&self, file_id: &str, width: u32, height: u32) -> Result<Option<Bytes>> {
        let cache = self.cache.clone();
        let id_owned = file_id.to_owned();
        if let Ok(Ok(Some(hit))) =
            tokio::task::spawn_blocking(move || cache.get_thumbnail(&id_owned, width, height)).await
        {
            return Ok(Some(hit));
        }

        let fetched = self.inner.thumbnail(file_id, width, height).await?;
        if let Some(ref bytes) = fetched {
            let cache = self.cache.clone();
            let id_owned = file_id.to_owned();
            let bytes_clone = bytes.clone();
            let _ = tokio::task::spawn_blocking(move || {
                cache.put_thumbnail(&id_owned, width, height, &bytes_clone)
            })
            .await;
        }
        Ok(fetched)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::LocalFsBackend;
    use tempfile::tempdir;

    #[test]
    fn lru_eviction_respects_byte_limit() {
        let dir = tempdir().expect("tempdir");
        let cache = CacheStore::open(dir.path(), 16).unwrap();
        cache.set_limit_bytes(10).unwrap();

        let p1 = CloudPath::parse("/a.bin").unwrap();
        let p2 = CloudPath::parse("/b.bin").unwrap();
        let e1 = Etag::new("e1");
        let e2 = Etag::new("e2");

        cache.put_blob(&p1, &e1, b"123456").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.put_blob(&p2, &e2, b"abcdef").unwrap();

        // Total 12 bytes > 10 byte limit → older blob p1 should be evicted.
        assert!(cache.get_blob(&p1, &e1).unwrap().is_none());
        assert_eq!(
            cache.get_blob(&p2, &e2).unwrap(),
            Some(Bytes::from_static(b"abcdef"))
        );
    }

    #[test]
    fn markdown_drafts_round_trip_and_clear() {
        let dir = tempdir().expect("tempdir");
        let cache = CacheStore::open(dir.path(), 64).unwrap();
        let path = CloudPath::parse("/Docs/spec.md").unwrap();
        let etag = Etag::new("v1");

        cache
            .save_markdown_draft(&path, "# Draft", Some(&etag))
            .unwrap();
        let draft = cache.get_markdown_draft(&path).unwrap().expect("draft");
        assert_eq!(draft.content, "# Draft");
        assert_eq!(draft.base_etag, Some(etag));

        cache.delete_markdown_draft(&path).unwrap();
        assert!(cache.get_markdown_draft(&path).unwrap().is_none());
    }

    #[test]
    fn clear_cached_data_sweeps_orphans_and_preserves_drafts() {
        let dir = tempdir().expect("tempdir");
        let cache = CacheStore::open(dir.path(), 64).unwrap();
        let path = CloudPath::parse("/Docs/notes.md").unwrap();

        cache
            .save_markdown_draft(&path, "# Unsaved edits", None)
            .unwrap();
        cache.put_blob(&path, &Etag::new("e1"), b"cached").unwrap();

        let orphan = dir.path().join("blobs").join("orphan.blob");
        std::fs::write(&orphan, b"stale secret").unwrap();

        cache.clear_cached_data().unwrap();

        assert!(!orphan.exists());
        assert!(cache.get_blob(&path, &Etag::new("e1")).unwrap().is_none());
        let draft = cache
            .get_markdown_draft(&path)
            .unwrap()
            .expect("draft must survive cache clear");
        assert_eq!(draft.content, "# Unsaved edits");
    }

    #[tokio::test]
    async fn cached_storage_caches_reads_and_invalidates_on_write() {
        let data_dir = tempdir().expect("data");
        let cache_dir = tempdir().expect("cache");
        let local = Arc::new(LocalFsBackend::new(data_dir.path()));
        let cache = CacheStore::open(cache_dir.path(), 64).unwrap();
        let cached = CachedStorage::new(local, cache.clone());

        let path = CloudPath::parse("/notes.md").unwrap();
        let etag1 = cached
            .write(&path, Bytes::from_static(b"hello"), None)
            .await
            .unwrap();

        assert_eq!(
            cache.get_blob(&path, &etag1).unwrap(),
            Some(Bytes::from_static(b"hello"))
        );

        let (bytes, etag_read) = cached.read(&path).await.unwrap();
        assert_eq!(bytes, Bytes::from_static(b"hello"));
        assert_eq!(etag_read, etag1);

        let etag2 = cached
            .write(&path, Bytes::from_static(b"updated"), Some(&etag1))
            .await
            .unwrap();
        assert!(cache.get_blob(&path, &etag1).unwrap().is_none());
        assert_eq!(
            cache.get_blob(&path, &etag2).unwrap(),
            Some(Bytes::from_static(b"updated"))
        );
    }
}
