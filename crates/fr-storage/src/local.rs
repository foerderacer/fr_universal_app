use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use fr_core::{FrError, Result};
use tempfile::NamedTempFile;
use tokio::sync::RwLock;

use crate::backend::StorageBackend;
use crate::path::CloudPath;
use crate::types::{Etag, FileEntry, FileKind};

static ROOT_LOCKS: OnceLock<Mutex<HashMap<String, Arc<RwLock<()>>>>> = OnceLock::new();

fn normalize_lock_key(root: &Path) -> String {
    let abs = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(root))
            .unwrap_or_else(|_| root.to_path_buf())
    };

    // Canonicalize the deepest existing ancestor so non-existent and newly created roots
    // produce the exact same key.
    let mut existing = abs.as_path();
    let mut tail = Vec::new();
    let canonical_base = loop {
        match std::fs::canonicalize(existing) {
            Ok(c) => break c,
            Err(_) => {
                if let Some(name) = existing.file_name() {
                    tail.push(name.to_os_string());
                }
                match existing.parent() {
                    Some(parent) if parent != existing => existing = parent,
                    _ => break abs.clone(),
                }
            }
        }
    };

    #[cfg(windows)]
    let is_verbatim = matches!(
        abs.components().next(),
        Some(std::path::Component::Prefix(p)) if p.kind().is_verbatim()
    );

    let mut full = canonical_base;
    for part in tail.into_iter().rev() {
        #[cfg(windows)]
        {
            if is_verbatim {
                full.push(part);
            } else {
                let text = part.to_string_lossy();
                let trimmed = text.trim_end_matches(['.', ' ']);
                if !trimmed.is_empty() {
                    full.push(trimmed);
                }
            }
        }
        #[cfg(not(windows))]
        {
            full.push(part);
        }
    }

    let raw = full.to_string_lossy().replace('\\', "/");
    let stripped = raw.strip_prefix("//?/").unwrap_or(&raw);
    #[cfg(any(windows, target_os = "macos"))]
    {
        stripped.to_ascii_lowercase()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        stripped.to_owned()
    }
}

fn lock_for_root(root: &Path) -> Arc<RwLock<()>> {
    let key = normalize_lock_key(root);
    let registry = ROOT_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.entry(key)
        .or_insert_with(|| Arc::new(RwLock::new(())))
        .clone()
}

/// Local filesystem implementation of [`StorageBackend`], rooted in a sandbox directory.
/// Used for fast deterministic unit/integration tests and offline development.
///
/// Concurrency & sandbox invariants:
/// - A per-root `Arc<RwLock<()>>` (shared across all instances targeting the same root) is
///   acquired as an owned guard and moved into blocking I/O tasks so concurrent directory
///   mutations, case-insensitive filename aliases, multiple backend instances, and future
///   cancellation cannot bypass containment or ETag checks.
#[derive(Debug, Clone)]
pub struct LocalFsBackend {
    root: PathBuf,
}

impl LocalFsBackend {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn root_lock(&self) -> Arc<RwLock<()>> {
        lock_for_root(&self.root)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn is_symlink_or_reparse(meta: &std::fs::Metadata) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
            meta.file_type().is_symlink()
                || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
        }
        #[cfg(not(windows))]
        {
            meta.file_type().is_symlink()
        }
    }

    /// Resolves `cloud_path` inside `root` while enforcing strict sandbox containment:
    /// - Rejects any symlink or Windows junction/reparse point along the path (including root).
    /// - Verifies every existing ancestor canonicalizes inside canonical `root`.
    /// - When `create_root_if_missing` is true, creates the sandbox root directory on first use.
    fn resolve_contained_sync(
        root: &Path,
        cloud_path: &CloudPath,
        create_root_if_missing: bool,
    ) -> Result<PathBuf> {
        if create_root_if_missing {
            std::fs::create_dir_all(root)?;
        }

        let root_meta = std::fs::symlink_metadata(root).map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                FrError::NotFound(format!("storage root missing: {}", root.display()))
            } else {
                FrError::Io(err)
            }
        })?;
        if Self::is_symlink_or_reparse(&root_meta) {
            return Err(FrError::InvalidPath(
                "storage root cannot be a symlink or junction".into(),
            ));
        }

        let canonical_root = std::fs::canonicalize(root)?;
        let mut current = canonical_root.clone();
        let mut last_existing = canonical_root.clone();
        let mut missing_seen = false;

        for seg in cloud_path.segments() {
            current.push(seg);
            if !missing_seen {
                match std::fs::symlink_metadata(&current) {
                    Ok(meta) => {
                        if Self::is_symlink_or_reparse(&meta) {
                            return Err(FrError::InvalidPath(format!(
                                "symlinks and junctions are not permitted in local storage: {cloud_path}"
                            )));
                        }
                        let canonical_step = std::fs::canonicalize(&current)?;
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

    fn build_entry_sync(cloud_path: CloudPath, fs_path: &Path) -> Result<FileEntry> {
        let meta = std::fs::symlink_metadata(fs_path).map_err(|err| {
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

        let etag = if is_dir {
            None
        } else {
            let data = std::fs::read(fs_path)?;
            Some(Self::compute_etag(&data))
        };

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
}

#[async_trait]
impl StorageBackend for LocalFsBackend {
    async fn list(&self, path: &CloudPath) -> Result<Vec<FileEntry>> {
        let guard = self.root_lock().read_owned().await;
        let root = self.root.clone();
        let path = path.clone();

        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let dir_path = Self::resolve_contained_sync(&root, &path, false)?;
            let read_dir = std::fs::read_dir(&dir_path).map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    FrError::NotFound(path.to_string())
                } else {
                    FrError::Io(err)
                }
            })?;

            let mut entries = Vec::new();
            for entry_res in read_dir {
                let entry = entry_res?;
                let entry_path = entry.path();
                let meta = std::fs::symlink_metadata(&entry_path)?;
                if Self::is_symlink_or_reparse(&meta) {
                    continue;
                }
                let file_name = entry.file_name().to_string_lossy().into_owned();
                let Ok(child_cloud_path) = path.join(&file_name) else {
                    continue;
                };
                entries.push(Self::build_entry_sync(child_cloud_path, &entry_path)?);
            }

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
        })
        .await
        .map_err(|err| FrError::Other(format!("list task failed: {err}")))?
    }

    async fn stat(&self, path: &CloudPath) -> Result<FileEntry> {
        let guard = self.root_lock().read_owned().await;
        let root = self.root.clone();
        let path = path.clone();

        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let fs_path = Self::resolve_contained_sync(&root, &path, false)?;
            Self::build_entry_sync(path, &fs_path)
        })
        .await
        .map_err(|err| FrError::Other(format!("stat task failed: {err}")))?
    }

    async fn read(&self, path: &CloudPath) -> Result<(Bytes, Etag)> {
        let guard = self.root_lock().read_owned().await;
        let root = self.root.clone();
        let path = path.clone();

        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let fs_path = Self::resolve_contained_sync(&root, &path, false)?;
            let data = std::fs::read(&fs_path).map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    FrError::NotFound(path.to_string())
                } else {
                    FrError::Io(err)
                }
            })?;
            let etag = Self::compute_etag(&data);
            Ok((Bytes::from(data), etag))
        })
        .await
        .map_err(|err| FrError::Other(format!("read task failed: {err}")))?
    }

    async fn read_range(&self, path: &CloudPath, start: u64, end: Option<u64>) -> Result<Bytes> {
        let guard = self.root_lock().read_owned().await;
        let root = self.root.clone();
        let path = path.clone();

        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let fs_path = Self::resolve_contained_sync(&root, &path, false)?;
            let mut file = std::fs::File::open(&fs_path).map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    FrError::NotFound(path.to_string())
                } else {
                    FrError::Io(err)
                }
            })?;

            let len = file.metadata()?.len();
            if start >= len {
                return Ok(Bytes::new());
            }

            let inclusive_end = end.unwrap_or(len - 1).min(len - 1);
            if inclusive_end < start {
                return Ok(Bytes::new());
            }

            let to_read = (inclusive_end - start + 1) as usize;
            file.seek(SeekFrom::Start(start))?;
            let mut buf = vec![0_u8; to_read];
            file.read_exact(&mut buf)?;
            Ok(Bytes::from(buf))
        })
        .await
        .map_err(|err| FrError::Other(format!("read_range task failed: {err}")))?
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

        // Hold an owned write guard for the entire blocking check + atomic persist so:
        // - Case-insensitive filename aliases serialize cleanly on Windows/macOS.
        // - Cancelling the future cannot release the lock mid-replacement.
        let guard = self.root_lock().write_owned().await;
        let root = self.root.clone();
        let path = path.clone();
        let expected_etag = expected_etag.cloned();

        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let fs_path = Self::resolve_contained_sync(&root, &path, true)?;

            if let Some(expected) = expected_etag {
                let current = std::fs::read(&fs_path).map_err(|err| {
                    if err.kind() == std::io::ErrorKind::NotFound {
                        FrError::NotFound(path.to_string())
                    } else {
                        FrError::Io(err)
                    }
                })?;
                let actual = Self::compute_etag(&current);
                if actual != expected {
                    return Err(FrError::Conflict {
                        path: path.to_string(),
                        expected: expected.0,
                        actual: actual.0,
                    });
                }
            }

            let parent = fs_path.parent().ok_or_else(|| {
                FrError::InvalidPath("target path has no parent directory".into())
            })?;
            std::fs::create_dir_all(parent)?;

            let new_etag = Self::compute_etag(&data);
            let mut tmp = NamedTempFile::new_in(parent)?;
            tmp.write_all(&data)?;
            tmp.as_file().sync_all()?;
            tmp.persist(&fs_path)
                .map_err(|err| FrError::Io(err.error))?;
            Ok(new_etag)
        })
        .await
        .map_err(|err| FrError::Other(format!("write task failed: {err}")))?
    }

    async fn mkdir(&self, path: &CloudPath) -> Result<()> {
        let guard = self.root_lock().write_owned().await;
        let root = self.root.clone();
        let path = path.clone();

        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let fs_path = Self::resolve_contained_sync(&root, &path, true)?;
            std::fs::create_dir_all(&fs_path)?;
            Ok(())
        })
        .await
        .map_err(|err| FrError::Other(format!("mkdir task failed: {err}")))?
    }

    async fn rename(&self, from: &CloudPath, to: &CloudPath) -> Result<()> {
        if from.is_root() || to.is_root() {
            return Err(FrError::InvalidPath("cannot rename root directory".into()));
        }
        if from == to {
            return Ok(());
        }

        let guard = self.root_lock().write_owned().await;
        let root = self.root.clone();
        let from = from.clone();
        let to = to.clone();

        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let from_fs = Self::resolve_contained_sync(&root, &from, false)?;
            let to_fs = Self::resolve_contained_sync(&root, &to, false)?;
            if let Some(parent) = to_fs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(&from_fs, &to_fs).map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    FrError::NotFound(from.to_string())
                } else {
                    FrError::Io(err)
                }
            })?;
            Ok(())
        })
        .await
        .map_err(|err| FrError::Other(format!("rename task failed: {err}")))?
    }

    async fn delete(&self, path: &CloudPath) -> Result<()> {
        if path.is_root() {
            return Err(FrError::InvalidPath("cannot delete root directory".into()));
        }

        let guard = self.root_lock().write_owned().await;
        let root = self.root.clone();
        let path = path.clone();

        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let fs_path = Self::resolve_contained_sync(&root, &path, false)?;
            let meta = std::fs::symlink_metadata(&fs_path).map_err(|err| {
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
                std::fs::remove_dir_all(&fs_path)?;
            } else {
                std::fs::remove_file(&fs_path)?;
            }
            Ok(())
        })
        .await
        .map_err(|err| FrError::Other(format!("delete task failed: {err}")))?
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
    async fn write_and_mkdir_initialize_missing_root_directory() {
        let parent = tempdir().expect("tempdir");
        let new_root = parent.path().join("fresh-workspace");
        let backend = LocalFsBackend::new(&new_root);

        backend
            .write(
                &CloudPath::parse("/welcome.md").unwrap(),
                Bytes::from_static(b"hi"),
                None,
            )
            .await
            .unwrap();

        let (bytes, _) = backend
            .read(&CloudPath::parse("/welcome.md").unwrap())
            .await
            .unwrap();
        assert_eq!(bytes, Bytes::from_static(b"hi"));
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

    #[tokio::test]
    async fn separate_backend_instances_for_same_root_coordinate_etag_writes() {
        let dir = tempdir().expect("tempdir");
        let b1 = LocalFsBackend::new(dir.path());
        let b2 = LocalFsBackend::new(dir.path());
        let path = CloudPath::parse("/shared-two.md").unwrap();
        let initial_etag = b1
            .write(&path, Bytes::from_static(b"v1"), None)
            .await
            .unwrap();

        let p1 = path.clone();
        let e1 = initial_etag.clone();
        let t1 = tokio::spawn(async move {
            b1.write(&p1, Bytes::from_static(b"inst-1"), Some(&e1))
                .await
        });

        let p2 = path.clone();
        let e2 = initial_etag.clone();
        let t2 = tokio::spawn(async move {
            b2.write(&p2, Bytes::from_static(b"inst-2"), Some(&e2))
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

    #[tokio::test]
    async fn lock_key_matches_before_and_after_root_creation() {
        let parent = tempdir().expect("tempdir");
        #[cfg(windows)]
        let dotted = parent.path().join("dotted.");
        #[cfg(not(windows))]
        let dotted = parent.path().join("fresh");

        let lock_before = lock_for_root(&dotted);
        let backend = LocalFsBackend::new(&dotted);
        backend
            .mkdir(&CloudPath::parse("/sub").unwrap())
            .await
            .unwrap();
        let lock_after = lock_for_root(&dotted);
        assert!(Arc::ptr_eq(&lock_before, &lock_after));

        #[cfg(windows)]
        {
            let lock_plain = lock_for_root(&parent.path().join("dotted"));
            assert!(Arc::ptr_eq(&lock_before, &lock_plain));

            // Verbatim paths (`\\?\...`) preserve trailing dots on Windows.
            let canon_parent = std::fs::canonicalize(parent.path()).unwrap();
            let verbatim_dotted = canon_parent.join("verbatim_dotted.");
            let verbatim_before = lock_for_root(&verbatim_dotted);
            let verbatim_backend = LocalFsBackend::new(&verbatim_dotted);
            verbatim_backend
                .mkdir(&CloudPath::parse("/sub").unwrap())
                .await
                .unwrap();
            let verbatim_after = lock_for_root(&verbatim_dotted);
            assert!(Arc::ptr_eq(&verbatim_before, &verbatim_after));
        }
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
