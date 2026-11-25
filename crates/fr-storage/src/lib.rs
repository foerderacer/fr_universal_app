//! Storage abstraction (`StorageBackend`), normalized cloud paths, file metadata types,
//! and a local filesystem implementation (`LocalFsBackend`) for testing and offline development.

pub mod backend;
pub mod local;
pub mod path;
pub mod types;

pub use backend::StorageBackend;
pub use local::LocalFsBackend;
pub use path::CloudPath;
pub use types::{Etag, FileEntry, FileKind};
