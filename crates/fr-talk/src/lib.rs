//! Pure-Rust Nextcloud Talk chat client, typed models, and account-scoped SQLite cache/drafts.
//!
//! Scope (per Plan 06):
//! - Chat only (calls / WebRTC are out of scope).
//! - Pure file-ID references (`POST /chat/{token}/share`, `objectType: "file"`) with zero copies
//!   and no automatic share-granting (Nextcloud access control remains authoritative).
//! - New file uploads land once in the capabilities-configured Talk attachments folder via
//!   [`fr_storage::StorageBackend`].

pub mod cache;
pub mod client;
pub mod models;

pub use cache::TalkCacheStore;
pub use client::{TalkClient, validate_room_token};
pub use models::{
    CreateTalkRoomRequest, SendTalkMessageRequest, TalkCapabilities, TalkFileReference,
    TalkMessage, TalkMessagesPage, TalkParentMessage, TalkRoom, TalkRoomType, TalkRoomsPage,
};
