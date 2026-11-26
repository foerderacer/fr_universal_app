use serde::{Deserialize, Serialize};
use specta::Type;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, FrError>;

/// Structured backend error type used across all pure-Rust crates.
#[derive(Debug, Error)]
pub enum FrError {
    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("already exists: {0}")]
    AlreadyExists(String),

    #[error("conflict on {path}: remote version changed (expected {expected}, actual {actual})")]
    Conflict {
        path: String,
        expected: String,
        actual: String,
    },

    #[error("invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("authentication required: {0}")]
    AuthRequired(String),

    #[error("permission denied: {0}")]
    PermissionDenied(String),

    #[error("network error: {0}")]
    Network(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("{0}")]
    Other(String),
}

/// Non-technical, user-friendly error payload returned across the IPC boundary.
/// Technical details are optional and intended only for an expandable details panel or logs.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserFacingError {
    pub code: String,
    pub title: String,
    pub message: String,
    pub recovery_hint: Option<String>,
    pub technical_details: Option<String>,
}

impl From<FrError> for UserFacingError {
    fn from(err: FrError) -> Self {
        match &err {
            FrError::InvalidPath(_) => Self {
                code: "invalid_path".into(),
                title: "Invalid folder or file path".into(),
                message: "That file location couldn't be read because the path is invalid.".into(),
                recovery_hint: Some("Check the folder path and try again.".into()),
                technical_details: Some(err.to_string()),
            },
            FrError::NotFound(_) => Self {
                code: "not_found".into(),
                title: "Item not found".into(),
                message: "The requested file or folder could not be found.".into(),
                recovery_hint: Some(
                    "Refresh the folder list — someone else may have moved or deleted it.".into(),
                ),
                technical_details: Some(err.to_string()),
            },
            FrError::AlreadyExists(_) => Self {
                code: "already_exists".into(),
                title: "Name already in use".into(),
                message: "A file or folder with that name already exists here.".into(),
                recovery_hint: Some("Choose a different name and try again.".into()),
                technical_details: Some(err.to_string()),
            },
            FrError::Conflict { .. } => Self {
                code: "conflict".into(),
                title: "File changed on server".into(),
                message:
                    "Someone else saved a newer version of this file while you were editing it."
                        .into(),
                recovery_hint: Some(
                    "Reload the latest version or save your changes as a separate copy.".into(),
                ),
                technical_details: Some(err.to_string()),
            },
            FrError::InvalidConfig(_) => Self {
                code: "invalid_config".into(),
                title: "Settings need attention".into(),
                message: "One of your workspace settings isn't valid yet.".into(),
                recovery_hint: Some("Check the value in Settings and try saving again.".into()),
                technical_details: Some(err.to_string()),
            },
            FrError::InvalidInput(msg) => Self {
                code: "invalid_input".into(),
                title: "Please check your input".into(),
                message: msg.clone(),
                recovery_hint: Some("Adjust the fields and try again.".into()),
                technical_details: None,
            },
            FrError::AuthRequired(_) => Self {
                code: "auth_required".into(),
                title: "Sign in required".into(),
                message: "Please sign in to your Nextcloud account to continue.".into(),
                recovery_hint: Some(
                    "Click Sign in with Nextcloud in the sidebar or Settings.".into(),
                ),
                technical_details: Some(err.to_string()),
            },
            FrError::PermissionDenied(msg) => Self {
                code: "permission_denied".into(),
                title: "Permission required".into(),
                message: msg.clone(),
                recovery_hint: Some(
                    "Contact your Nextcloud workspace administrator if you need access.".into(),
                ),
                technical_details: None,
            },
            FrError::Network(_) => Self {
                code: "network".into(),
                title: "Couldn't reach Nextcloud".into(),
                message: "Check your internet connection or server address and try again.".into(),
                recovery_hint: Some("Verify your Nextcloud server URL in Settings.".into()),
                technical_details: Some(err.to_string()),
            },
            FrError::Io(_) | FrError::Serialization(_) | FrError::Other(_) => Self {
                code: "unexpected".into(),
                title: "Something went wrong".into(),
                message: "The action couldn't be completed right now.".into(),
                recovery_hint: Some("Try again, or expand technical details for support.".into()),
                technical_details: Some(err.to_string()),
            },
        }
    }
}
