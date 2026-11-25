use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use fr_core::{FrError, Result};
use tempfile::NamedTempFile;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::sync::Mutex as AsyncMutex;

use crate::backend::StorageBackend;
use crate::path::CloudPath;
use crate::types::{Etag, FileEntry, FileKind};

/// Local filesystem implementation of [`StorageBackend`], rooted in a sandbox directory.
/// Used for fast deterministic unit/integration tests and offline development.
#[derive(Debug, Clone)]
pub struct LocalFsBackend {
    root: PathBuf,
    path_locks: Arc<Mutex<HashMap<CloudPath, Arc<AsyncMutex<()>>>>>,
}

impl LocalFsBackend {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            path_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path_lock(&self, path: &CloudPath) -> Arc<AsyncMutex<()>> {
        let mut map = self
            .path_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.entry(path.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    fn is_symlink_or_reparse(meta: &std::fs::Metadata) -> bool {
        if meta.file_type().is_symlink() {
            return true;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
            if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
                return true;
            }
        }
        false
    }

    /// Resolves `cloud_path` inside `self.root` while enforcing strict sandbox containment:
    /// - Rejects any symlink or Windows junction/reparse point along the path.
    /// - Verifies the canonicalized nearest existing ancestor stays inside canonical `self.root`.
    async fn resolve_contained(&self, cloud_path: &CloudPath) -> Result<PathBuf> {
        let canonical_root = fs::canonicalize(&self.root).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                FrError::NotFound(format!("storage root missing: {}", self.root.display()))
            } else {
                FrError::Io(err)
            }
        })?;

        let mut current = canonical_root.clone();
        let mut last_existing = canonical_root.clone();
        let mut missing_seen = false;

        for seg in cloud_path.segments() {
            current.push(seg);
            if !missing_seen {
                match fs::symlink_metadata(&current).await {
                    Ok(meta) => {
                        if Self::is_symlink_or_reparse(&meta) {
                            return Err(FrError::InvalidPath(format!(
                                "symlinks and junctions are not permitted in local storage: {cloud_path}"
                            )));
                        }
                        let canonical_step = fs::canonicalize(&current).await?;
                        if !canonical_step.starts_with(&canonical_root) {
                            return Err(FrError::InvalidPath(format!(
                                "path escapes storage sandbox: {cloud_path}"
                            )));
                        }
                        last_existing = canonical_step;
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                        missing_seen = true;
                    }
                    Err(err) => return Err(FrError::Io(err)),
                }
            }
        }

        if !last_existing.starts_with(&canonical_root) {
            return Err(FrError::InvalidPath(format!(
                "path escapes storage sandbox: {cloud_path}"
            )));
        }

        Ok(current)
    }

    fn compute_etag(bytes: &[u8]) -> Etag {
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        Etag::new(format!("local-{:016x}-{}", hasher.finish(), bytes.len()))
    }

    async fn metadata_etag(fs_path: &Path, is_dir: bool) -> Result<Option<Etag>> {
        if is_dir {
            return Ok(None);
        }
        let data = fs::read(fs_path).await?;
        Ok(Some(Self::compute_etag(&data)))
    }

    fn guess_mime(path: &Path, is_dir: bool) -> Option<String> {
        if is_dir {
            return None;
        }
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        let mime = match ext.as_str() {
            "md" | "markdown" => "text/markdown",
            "txt" => "text/plain",
            "json" => "application/json",
            "pdf" => "application/pdf",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "dxf" => "image/vnd.dxf",
            "ai" => "application/postscript",
            "eps" => "application/postscript",
            "sldprt" | "sldasm" | "slddrw" => "application/x-solidworks",
            _ => "application/octet-stream",
        };
        Some(mime.to_owned())
    }

    async fn build_entry(&self, cloud_path: CloudPath, fs_path: &Path) -> Result<FileEntry> {
        let meta = fs::symlink_metadata(fs_path).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                FrError::NotFound(cloud_path.to_string())
            } else {
                FrError::Io(err)
            }
        })?;

        if Self::is_symlink_or_reparse(&meta) {
            return Err(FrError::InvalidPath(format!(
                "symlinks and junctions are not permitted in local storage: {cloud_path}"
            )));
        }

        let is_dir = meta.is_dir();
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| DateTime::from_timestamp(d.as_secs() as i64, d.subsec_nanos()));

        let etag = Self::metadata_etag(fs_path, is_dir).await?;
        let name = cloud_path.file_name().unwrap_or("/").to_owned();

        Ok(FileEntry {
            id: cloud_path.as_str().to_owned(),
            name,
            path: cloud_path,
            kind: if is_dir {
                FileKind::Directory
            } else {
                FileKind::File
            },
            size: if is_dir { 0 } else { meta.len() },
            mime_type: Self::guess_mime(fs_path, is_dir),
            etag,
            modified_at: modified_at.map(|dt| dt.with_timezone(&Utc)),
        })
    }

    async fn atomic_write_file(fs_path: PathBuf, data: Bytes) -> Result<()> {
        tokio::task::spawn_blocking(move || -> Result<()> {
            let parent = fs_path.parent().ok_or_else(|| {
                FrError::InvalidPath("target path has no parent directory".into())
            })?;
            std::fs::create_dir_all(parent)?;

            let mut tmp = NamedTempFile::new_in(parent)?;
            tmp.write_all(&data)?;
            tmp.as_file().sync_all()?;
            tmp.persist(&fs_path)
                .map_err(|err| FrError::Io(err.error))?;
            Ok(())
        })
        .await
        .map_err(|err| FrError::Other(format!("atomic write task failed: {err}")))?
    }
}

#[async_trait]
impl StorageBackend for LocalFsBackend {
    async fn list(&self, path: &CloudPath) -> Result<Vec<FileEntry>> {
        let dir_path = self.resolve_contained(path).await?;
        let mut read_dir = fs::read_dir(&dir_path).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                FrError::NotFound(path.to_string())
            } else {
                FrError::Io(err)
            }
        })?;

        let mut entries = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let entry_path = entry.path();
            let meta = fs::symlink_metadata(&entry_path).await?;
            if Self::is_symlink_or_reparse(&meta) {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Ok(child_cloud_path) = path.join(&file_name) else {
                continue;
            };
            let item = self.build_entry(child_cloud_path, &entry_path).await?;
            entries.push(item);
        }

        // Folders first, then alphabetical by lowercase name.
        entries.sort_by(|a, b| {
            let rank = |k: FileKind| match k {
                FileKind::Directory => 0_u8,
                FileKind::File => 1_u8,
            };
            rank(a.kind)
                .cmp(&rank(b.kind))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(entries)
    }

    async fn stat(&self, path: &CloudPath) -> Result<FileEntry> {
        let fs_path = self.resolve_contained(path).await?;
        self.build_entry(path.clone(), &fs_path).await
    }

    async fn read(&self, path: &CloudPath) -> Result<(Bytes, Etag)> {
        let fs_path = self.resolve_contained(path).await?;
        let data = fs::read(&fs_path).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                FrError::NotFound(path.to_string())
            } else {
                FrError::Io(err)
            }
        })?;
        let etag = Self::compute_etag(&data);
        Ok((Bytes::from(data), etag))
    }

    async fn read_range(&self, path: &CloudPath, start: u64, end: Option<u64>) -> Result<Bytes> {
        let fs_path = self.resolve_contained(path).await?;
        let mut file = fs::File::open(&fs_path).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                FrError::NotFound(path.to_string())
            } else {
                FrError::Io(err)
            }
        })?;

        let len = file.metadata().await?.len();
        if start >= len {
            return Ok(Bytes::new());
        }

        let inclusive_end = end.unwrap_or(len - 1).min(len - 1);
        if inclusive_end < start {
            return Ok(Bytes::new());
        }

        let to_read = (inclusive_end - start + 1) as usize;
        file.seek(SeekFrom::Start(start)).await?;
        let mut buf = vec![0_u8; to_read];
        file.read_exact(&mut buf).await?;
        Ok(Bytes::from(buf))
    }

    async fn write(
        &self,
        path: &CloudPath,
        data: Bytes,
        expected_etag: Option<&Etag>,
    ) -> Result<Etag> {
        if path.is_root() {
            return Err(FrError::InvalidPath("cannot write directly to root".into()));
        }

        // Serialize ETag check + atomic replacement per file path.
        let lock = self.path_lock(path);
        let _guard = lock.lock().await;

        let fs_path = self.resolve_contained(path).await?;
        if let Some(expected) = expected_etag {
            let current = fs::read(&fs_path).await.map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    FrError::NotFound(path.to_string())
                } else {
                    FrError::Io(err)
                }
            })?;
            let actual = Self::compute_etag(&current);
            if actual != *expected {
                return Err(FrError::Conflict {
                    path: path.to_string(),
                    expected: expected.0.clone(),
                    actual: actual.0,
                });
            }
        }

        let new_etag = Self::compute_etag(&data);
        Self::atomic_write_file(fs_path, data).await?;
        Ok(new_etag)
    }

    async fn mkdir(&self, path: &CloudPath) -> Result<()> {
        if path.is_root() {
            return Ok(());
        }
        let fs_path = self.resolve_contained(path).await?;
        fs::create_dir_all(&fs_path).await?;
        Ok(())
    }

    async fn rename(&self, from: &CloudPath, to: &CloudPath) -> Result<()> {
        if from.is_root() || to.is_root() {
            return Err(FrError::InvalidPath("cannot rename root directory".into()));
        }
        if from == to {
            return Ok(());
        }

        // Acquire locks in canonical order to prevent deadlocks on concurrent swaps.
        let (first_path, second_path) = if from < to { (from, to) } else { (to, from) };
        let first_lock = self.path_lock(first_path);
        let second_lock = self.path_lock(second_path);
        let _g1 = first_lock.lock().await;
        let _g2 = second_lock.lock().await;

        let from_fs = self.resolve_contained(from).await?;
        let to_fs = self.resolve_contained(to).await?;
        if let Some(parent) = to_fs.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::rename(&from_fs, &to_fs).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                FrError::NotFound(from.to_string())
            } else {
                FrError::Io(err)
            }
        })?;
        Ok(())
    }

    async fn delete(&self, path: &CloudPath) -> Result<()> {
        if path.is_root() {
            return Err(FrError::InvalidPath("cannot delete root directory".into()));
        }
        let lock = self.path_lock(path);
        let _guard = lock.lock().await;

        let fs_path = self.resolve_contained(path).await?;
        let meta = fs::symlink_metadata(&fs_path).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                FrError::NotFound(path.to_string())
            } else {
                FrError::Io(err)
            }
        })?;

        if Self::is_symlink_or_reparse(&meta) {
            return Err(FrError::InvalidPath(format!(
                "refusing to follow symlink during delete: {path}"
            )));
        }

        if meta.is_dir() {
            fs::remove_dir_all(&fs_path).await?;
        } else {
            fs::remove_file(&fs_path).await?;
        }
        Ok(())
    }

    async fn thumbnail(&self, _file_id: &str, _width: u32, _height: u32) -> Result<Option<Bytes>> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn local_fs_crud_and_etag_conflict_detection() {
        let dir = tempdir().expect("tempdir");
        let backend = LocalFsBackend::new(dir.path());

        let docs_dir = CloudPath::parse("/Docs").unwrap();
        backend.mkdir(&docs_dir).await.unwrap();

        let note_path = CloudPath::parse("/Docs/hello.md").unwrap();
        let etag1 = backend
            .write(&note_path, Bytes::from_static(b"# Hello World"), None)
            .await
            .unwrap();

        let (content, read_etag) = backend.read(&note_path).await.unwrap();
        assert_eq!(content, Bytes::from_static(b"# Hello World"));
        assert_eq!(read_etag, etag1);

        // Range read returns exact slice.
        let slice = backend.read_range(&note_path, 2, Some(6)).await.unwrap();
        assert_eq!(slice, Bytes::from_static(b"Hello"));

        // Matching ETag succeeds.
        let etag2 = backend
            .write(
                &note_path,
                Bytes::from_static(b"# Hello Updated"),
                Some(&etag1),
            )
            .await
            .unwrap();
        assert_ne!(etag1, etag2);

        // Stale ETag fails with Conflict.
        let conflict = backend
            .write(&note_path, Bytes::from_static(b"# Stale"), Some(&etag1))
            .await;
        assert!(matches!(conflict, Err(FrError::Conflict { .. })));

        // Directory listing returns Docs first.
        let root_items = backend.list(&CloudPath::root()).await.unwrap();
        assert_eq!(root_items.len(), 1);
        assert_eq!(root_items[0].name, "Docs");
        assert_eq!(root_items[0].kind, FileKind::Directory);

        // Rename & delete.
        let moved = CloudPath::parse("/Docs/renamed.md").unwrap();
        backend.rename(&note_path, &moved).await.unwrap();
        assert!(matches!(
            backend.stat(&note_path).await,
            Err(FrError::NotFound(_))
        ));
        backend.delete(&moved).await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_etag_writes_allow_only_one_winner() {
        let dir = tempdir().expect("tempdir");
        let backend = Arc::new(LocalFsBackend::new(dir.path()));
        let path = CloudPath::parse("/shared.md").unwrap();
        let initial_etag = backend
            .write(&path, Bytes::from_static(b"v1"), None)
            .await
            .unwrap();

        let b1 = backend.clone();
        let p1 = path.clone();
        let e1 = initial_etag.clone();
        let t1 = tokio::spawn(async move {
            b1.write(&p1, Bytes::from_static(b"writer-A"), Some(&e1))
                .await
        });

        let b2 = backend.clone();
        let p2 = path.clone();
        let e2 = initial_etag.clone();
        let t2 = tokio::spawn(async move {
            b2.write(&p2, Bytes::from_static(b"writer-B"), Some(&e2))
                .await
        });

        let (r1, r2) = tokio::join!(t1, t2);
        let results = [r1.unwrap(), r2.unwrap()];
        let ok_count = results.iter().filter(|r| r.is_ok()).count();
        let conflict_count = results
            .iter()
            .filter(|r| matches!(r, Err(FrError::Conflict { .. })))
            .count();

        assert_eq!(ok_count, 1);
        assert_eq!(conflict_count, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let sandbox = tempdir().expect("sandbox");
        let outside = tempdir().expect("outside");
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "top-secret").unwrap();
        symlink(&secret, sandbox.path().join("link.txt")).unwrap();

        let backend = LocalFsBackend::new(sandbox.path());
        let res = backend.read(&CloudPath::parse("/link.txt").unwrap()).await;
        assert!(matches!(res, Err(FrError::InvalidPath(_))));
    }
}
