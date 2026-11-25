//! Files domain module (`FrModule`) providing high-level file browsing, CRUD, Markdown editing
//! with ETag conflict protection, and unified preview extraction over any [`StorageBackend`].

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use chrono::Utc;
use fr_core::{FrError, FrModule, ModuleCapability, ModuleDescriptor, ModuleStatus, Result};
use fr_preview::{
    ImageDimensions, PreviewKind, SolidWorksPreview, classify_preview, extract_solidworks_preview,
    inspect_image_dimensions, is_editable_in_app, needs_png_transcode,
};
use fr_storage::{CloudPath, Etag, FileEntry, FileKind, MarkdownDraft, StorageBackend};
use serde::{Deserialize, Serialize};
use specta::Type;

const MAX_INLINE_TEXT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOLIDWORKS_BYTES: usize = 128 * 1024 * 1024;

/// Enriched file/folder item returned by the Files module for UI and MCP consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileItemView {
    pub entry: FileEntry,
    pub preview_kind: Option<PreviewKind>,
    pub editable: bool,
}

/// Markdown document opened for WYSIWYG / raw editing, including any unsaved local draft.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDocument {
    pub path: CloudPath,
    pub name: String,
    pub content: String,
    pub etag: Etag,
    pub draft: Option<MarkdownDraft>,
}

/// Unified preview payload dispatched by [`FilesService::build_preview`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FilePreviewPayload {
    pub entry: FileEntry,
    pub preview_kind: PreviewKind,
    pub media_url: Option<String>,
    pub text_content: Option<String>,
    pub image_dimensions: Option<ImageDimensions>,
    pub solidworks: Option<SolidWorksPreview>,
    pub thumbnail_data_url: Option<String>,
    pub note: Option<String>,
}

/// Pluggable Files module descriptor registered in the host [`fr_core::ModuleRegistry`].
#[derive(Debug, Default)]
pub struct FilesModule;

impl FrModule for FilesModule {
    fn descriptor(&self) -> ModuleDescriptor {
        ModuleDescriptor {
            id: "files".into(),
            name: "Files".into(),
            description: "Browse Nextcloud folders, preview media & CAD files, and edit Markdown."
                .into(),
            icon: "folder".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            status: ModuleStatus::Active,
            capabilities: vec![
                ModuleCapability::Storage,
                ModuleCapability::Preview,
                ModuleCapability::McpServerTools,
            ],
        }
    }
}

/// Pure-Rust service orchestrating file browsing, CRUD, Markdown editing, and preview extraction.
#[derive(Clone)]
pub struct FilesService {
    storage: Arc<dyn StorageBackend>,
}

impl FilesService {
    pub fn new(storage: Arc<dyn StorageBackend>) -> Self {
        Self { storage }
    }

    pub fn storage(&self) -> &Arc<dyn StorageBackend> {
        &self.storage
    }

    pub async fn list_folder(&self, raw_path: &str) -> Result<Vec<FileItemView>> {
        let path = CloudPath::parse(raw_path)?;
        let entries = self.storage.list(&path).await?;
        Ok(entries.into_iter().map(Self::enrich).collect())
    }

    pub async fn search_folder(
        &self,
        raw_path: &str,
        query: &str,
        max_depth: usize,
    ) -> Result<Vec<FileItemView>> {
        let root = CloudPath::parse(raw_path)?;
        let needle = query.trim().to_ascii_lowercase();
        if needle.is_empty() {
            return self.list_folder(root.as_str()).await;
        }

        let mut matches = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back((root, 0usize));

        while let Some((dir, depth)) = queue.pop_front() {
            let Ok(entries) = self.storage.list(&dir).await else {
                continue;
            };
            for entry in entries {
                let is_dir = entry.kind == FileKind::Directory;
                let entry_path = entry.path.clone();
                if entry.name.to_ascii_lowercase().contains(&needle) {
                    matches.push(Self::enrich(entry));
                }
                if is_dir && depth < max_depth && matches.len() < 200 {
                    queue.push_back((entry_path, depth + 1));
                }
            }
            if matches.len() >= 200 {
                break;
            }
        }

        Ok(matches)
    }

    pub async fn create_folder(&self, raw_path: &str) -> Result<()> {
        let path = CloudPath::parse(raw_path)?;
        self.storage.mkdir(&path).await
    }

    pub async fn rename_item(&self, raw_from: &str, raw_to: &str) -> Result<()> {
        let from = CloudPath::parse(raw_from)?;
        let to = CloudPath::parse(raw_to)?;
        self.storage.rename(&from, &to).await
    }

    pub async fn delete_item(&self, raw_path: &str) -> Result<()> {
        let path = CloudPath::parse(raw_path)?;
        self.storage.delete(&path).await
    }

    pub async fn upload_bytes(&self, raw_path: &str, data: Bytes) -> Result<Etag> {
        let path = CloudPath::parse(raw_path)?;
        self.storage.write(&path, data, None).await
    }

    pub async fn read_markdown(&self, raw_path: &str) -> Result<(CloudPath, String, Etag)> {
        let path = CloudPath::parse(raw_path)?;
        let (bytes, etag) = self.storage.read(&path).await?;
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| FrError::Other("file is not valid UTF-8 text".into()))?;
        Ok((path, text, etag))
    }

    pub async fn write_markdown(
        &self,
        raw_path: &str,
        content: &str,
        expected_etag: Option<&Etag>,
    ) -> Result<Etag> {
        let path = CloudPath::parse(raw_path)?;
        self.storage
            .write(
                &path,
                Bytes::from(content.as_bytes().to_vec()),
                expected_etag,
            )
            .await
    }

    /// Writes `content` to a timestamped sibling conflict copy (e.g. `spec (copy 2026-11-25 143022).md`).
    pub async fn save_markdown_as_copy(
        &self,
        original_raw_path: &str,
        content: &str,
    ) -> Result<(CloudPath, Etag)> {
        let original = CloudPath::parse(original_raw_path)?;
        let file_name = original
            .file_name()
            .ok_or_else(|| FrError::InvalidPath("cannot copy root path".into()))?;
        let (stem, ext) = match file_name.rsplit_once('.') {
            Some((s, e)) => (s, format!(".{e}")),
            None => (file_name, ".md".to_owned()),
        };
        let stamp = Utc::now().format("%Y-%m-%d %H%M%S");
        let copy_name = format!("{stem} (copy {stamp}){ext}");
        let parent = original.parent().unwrap_or_else(CloudPath::root);
        let copy_path = parent.join(&copy_name)?;
        let etag = self
            .storage
            .write(&copy_path, Bytes::from(content.as_bytes().to_vec()), None)
            .await?;
        Ok((copy_path, etag))
    }

    pub async fn fetch_thumbnail_data_url(
        &self,
        file_id: &str,
        width: u32,
        height: u32,
    ) -> Result<Option<String>> {
        let Some(bytes) = self.storage.thumbnail(file_id, width, height).await? else {
            return Ok(None);
        };
        let mime = if bytes.starts_with(&[137, 80, 78, 71]) {
            "image/png"
        } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            "image/jpeg"
        } else if bytes.starts_with(b"RIFF") {
            "image/webp"
        } else {
            "image/png"
        };
        Ok(Some(format!("data:{mime};base64,{}", BASE64.encode(bytes))))
    }

    /// Builds a complete preview payload for any file, using `media_url_builder` for streamed
    /// formats (video, PDF, AI, images, 3D CAD).
    pub async fn build_preview<F>(
        &self,
        raw_path: &str,
        media_url_builder: F,
    ) -> Result<FilePreviewPayload>
    where
        F: Fn(&CloudPath, bool) -> Option<String>,
    {
        let path = CloudPath::parse(raw_path)?;
        let entry = self.storage.stat(&path).await?;
        if entry.kind == FileKind::Directory {
            return Err(FrError::InvalidPath("cannot preview a folder".into()));
        }

        let kind = classify_preview(&entry.name);
        let mut payload = FilePreviewPayload {
            entry: entry.clone(),
            preview_kind: kind,
            media_url: None,
            text_content: None,
            image_dimensions: None,
            solidworks: None,
            thumbnail_data_url: None,
            note: None,
        };

        match kind {
            PreviewKind::Image => {
                let transcode = needs_png_transcode(&entry.name);
                payload.media_url = media_url_builder(&path, transcode);
                if entry.size > 0
                    && entry.size <= 32 * 1024 * 1024
                    && let Ok((bytes, _)) = self.storage.read(&path).await
                {
                    payload.image_dimensions = inspect_image_dimensions(&bytes);
                }
            }
            PreviewKind::Video | PreviewKind::Pdf | PreviewKind::VectorAi | PreviewKind::Cad3d => {
                payload.media_url = media_url_builder(&path, false);
                if kind == PreviewKind::Video
                    && Path::new(&entry.name)
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| e.eq_ignore_ascii_case("mkv"))
                {
                    payload.note = Some(
                        "MKV files may require an external media player if your OS WebView lacks the codec."
                            .into(),
                    );
                }
            }
            PreviewKind::VectorSvg
            | PreviewKind::VectorDxf
            | PreviewKind::PlainText
            | PreviewKind::Markdown => {
                if entry.size as usize > MAX_INLINE_TEXT_BYTES {
                    payload.note = Some(
                        "File is larger than 2 MB — open it in a native app to view the full contents."
                            .into(),
                    );
                } else {
                    let (bytes, _) = self.storage.read(&path).await?;
                    payload.text_content = Some(String::from_utf8_lossy(&bytes).into_owned());
                }
            }
            PreviewKind::SolidWorks => {
                if entry.size as usize > MAX_SOLIDWORKS_BYTES {
                    payload.note = Some(
                        "SolidWorks file exceeds 128 MB preview cap — open in SolidWorks / eDrawings."
                            .into(),
                    );
                } else {
                    let (bytes, _) = self.storage.read(&path).await?;
                    match extract_solidworks_preview(&bytes) {
                        Ok(sw) => payload.solidworks = Some(sw),
                        Err(err) => {
                            payload.note = Some(format!(
                                "Couldn't extract embedded SolidWorks preview ({err}). Open in SolidWorks / eDrawings instead."
                            ));
                        }
                    }
                }
            }
            PreviewKind::VectorEps | PreviewKind::Unsupported => {
                if let Ok(Some(thumb)) = self.fetch_thumbnail_data_url(&entry.id, 600, 600).await {
                    payload.thumbnail_data_url = Some(thumb);
                }
                payload.media_url = media_url_builder(&path, false);
            }
        }

        Ok(payload)
    }

    pub fn enrich(entry: FileEntry) -> FileItemView {
        match entry.kind {
            FileKind::Directory => FileItemView {
                entry,
                preview_kind: None,
                editable: false,
            },
            FileKind::File => {
                let kind = classify_preview(&entry.name);
                let editable = is_editable_in_app(kind);
                FileItemView {
                    entry,
                    preview_kind: Some(kind),
                    editable,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fr_storage::LocalFsBackend;
    use tempfile::tempdir;

    #[tokio::test]
    async fn lists_files_with_preview_classification() {
        let dir = tempdir().expect("tempdir");
        let backend = Arc::new(LocalFsBackend::new(dir.path()));
        backend
            .write(
                &CloudPath::parse("/handbook.md").unwrap(),
                Bytes::from_static(b"# Team Handbook"),
                None,
            )
            .await
            .unwrap();
        backend
            .write(
                &CloudPath::parse("/chassis.sldprt").unwrap(),
                Bytes::from_static(b"binary"),
                None,
            )
            .await
            .unwrap();

        let service = FilesService::new(backend);
        let items = service.list_folder("/").await.unwrap();
        assert_eq!(items.len(), 2);

        let cad = items
            .iter()
            .find(|i| i.entry.name == "chassis.sldprt")
            .unwrap();
        assert_eq!(cad.preview_kind, Some(PreviewKind::SolidWorks));
        assert!(!cad.editable);

        let md = items
            .iter()
            .find(|i| i.entry.name == "handbook.md")
            .unwrap();
        assert_eq!(md.preview_kind, Some(PreviewKind::Markdown));
        assert!(md.editable);
    }

    #[tokio::test]
    async fn markdown_save_copy_and_search_work() {
        let dir = tempdir().expect("tempdir");
        let backend = Arc::new(LocalFsBackend::new(dir.path()));
        let service = FilesService::new(backend);

        service.create_folder("/Docs").await.unwrap();
        let etag = service
            .write_markdown("/Docs/guide.md", "# Original", None)
            .await
            .unwrap();

        let (copy_path, _) = service
            .save_markdown_as_copy("/Docs/guide.md", "# Conflict Copy")
            .await
            .unwrap();
        assert!(copy_path.as_str().starts_with("/Docs/guide (copy "));
        assert!(copy_path.as_str().ends_with(").md"));

        // Stale ETag write fails with Conflict.
        let _ = service
            .write_markdown("/Docs/guide.md", "# v2", Some(&etag))
            .await
            .unwrap();
        let conflict = service
            .write_markdown("/Docs/guide.md", "# stale", Some(&etag))
            .await;
        assert!(matches!(conflict, Err(FrError::Conflict { .. })));

        // Search finds both guide files.
        let found = service.search_folder("/", "guide", 2).await.unwrap();
        assert_eq!(found.len(), 2);
    }
}
