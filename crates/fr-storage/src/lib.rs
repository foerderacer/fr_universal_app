//! Storage abstraction (`StorageBackend`), normalized cloud paths, file metadata types,
//! local filesystem implementation (`LocalFsBackend`), and SQLite-backed LRU cache (`CachedStorage`).

pub mod backend;
pub mod cache;
pub mod local;
pub mod path;
pub mod types;

pub use backend::StorageBackend;
pub use cache::{CacheStore, CachedStorage, MarkdownDraft};
pub use local::LocalFsBackend;
pub use path::CloudPath;
pub use types::{Etag, FileEntry, FileKind};
