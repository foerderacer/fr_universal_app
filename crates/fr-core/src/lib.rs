//! Shared domain primitives, configuration, error model, event bus, and module contract
//! for FR Universal App.
//!
//! This crate is 100% UI-agnostic and has no Tauri dependencies.

pub mod config;
pub mod error;
pub mod events;
pub mod module;

pub use config::{AppConfig, ConfigStore, default_nextcloud_url};
pub use error::{FrError, Result, UserFacingError};
pub use events::{AppEvent, EventBus};
pub use module::{FrModule, ModuleCapability, ModuleDescriptor, ModuleRegistry, ModuleStatus};
