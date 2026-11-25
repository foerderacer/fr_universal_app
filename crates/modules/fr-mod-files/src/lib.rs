//! Files domain module (`FrModule`) providing high-level file browsing and preview metadata
//! over any [`StorageBackend`].

use std::sync::Arc;

use fr_core::{FrModule, ModuleCapability, ModuleDescriptor, ModuleStatus, Result};
use fr_preview::{PreviewKind, classify_preview, is_editable_in_app};
use fr_storage::{CloudPath, FileEntry, FileKind, StorageBackend};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Enriched file/folder item returned by the Files module for UI and MCP consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileItemView {
    pub entry: FileEntry,
    pub preview_kind: Option<PreviewKind>,
    pub editable: bool,
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

/// Pure-Rust service orchestrating file browsing and preview classification.
#[derive(Clone)]
pub struct FilesService {
    storage: Arc<dyn StorageBackend>,
}

impl FilesService {
    pub fn new(storage: Arc<dyn StorageBackend>) -> Self {
        Self { storage }
    }

    pub async fn list_folder(&self, raw_path: &str) -> Result<Vec<FileItemView>> {
        let path = CloudPath::parse(raw_path)?;
        let entries = self.storage.list(&path).await?;
        Ok(entries.into_iter().map(Self::enrich).collect())
    }

    fn enrich(entry: FileEntry) -> FileItemView {
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
    use bytes::Bytes;
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
}
