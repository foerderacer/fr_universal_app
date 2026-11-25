use chrono::Utc;
use fr_core::{AppConfig, AppEvent, ModuleDescriptor, UserFacingError, default_nextcloud_url};
use fr_mcp::McpServerConfig;
use fr_nextcloud::{NextcloudConnectionStatus, normalize_server_url};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::state::AppState;

/// Initial snapshot loaded by the React workspace shell on startup.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOverview {
    pub app_version: String,
    pub platform: String,
    pub config: AppConfig,
    pub default_nextcloud_url: String,
    pub connection_status: NextcloudConnectionStatus,
    pub mcp_server: McpServerConfig,
    pub modules: Vec<ModuleDescriptor>,
}

/// Partial update payload submitted from the Settings screen.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    pub nextcloud_url: String,
    pub cache_limit_mb: u32,
    pub mcp_server_enabled: bool,
    pub theme: String,
}

#[tauri::command]
#[specta::specta]
pub fn get_workspace_overview(state: State<'_, AppState>) -> WorkspaceOverview {
    WorkspaceOverview {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        platform: std::env::consts::OS.to_owned(),
        config: state.current_config(),
        default_nextcloud_url: default_nextcloud_url(),
        connection_status: state.connection_status(),
        mcp_server: state.mcp_server_config(),
        modules: state.modules.descriptors(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn update_settings(
    state: State<'_, AppState>,
    input: UpdateSettingsRequest,
) -> Result<WorkspaceOverview, UserFacingError> {
    let normalized_url =
        normalize_server_url(&input.nextcloud_url).map_err(UserFacingError::from)?;

    let theme = match input.theme.as_str() {
        "system" | "light" | "dark" => input.theme,
        _ => "system".to_owned(),
    };

    let updated = {
        let mut guard = state.config.write().map_err(|_| UserFacingError {
            code: "state_lock".into(),
            title: "Couldn't save settings".into(),
            message: "The app couldn't access its local settings right now.".into(),
            recovery_hint: Some("Please restart the app and try again.".into()),
            technical_details: Some("RwLock poisoned while updating AppConfig".into()),
        })?;
        guard.nextcloud_url = normalized_url;
        guard.cache_limit_mb = input.cache_limit_mb.clamp(128, 32_768);
        guard.mcp_server_enabled = input.mcp_server_enabled;
        guard.theme = theme;
        guard.clone()
    };

    state
        .config_store
        .save(&updated)
        .map_err(UserFacingError::from)?;

    state.events.publish(AppEvent::ConfigUpdated {
        timestamp: Utc::now(),
    });

    Ok(get_workspace_overview(state))
}

#[tauri::command]
#[specta::specta]
pub fn reset_nextcloud_url(
    state: State<'_, AppState>,
) -> Result<WorkspaceOverview, UserFacingError> {
    let default_url = default_nextcloud_url();
    let updated = {
        let mut guard = state.config.write().map_err(|_| UserFacingError {
            code: "state_lock".into(),
            title: "Couldn't reset server URL".into(),
            message: "The app couldn't access its local settings right now.".into(),
            recovery_hint: Some("Please restart the app and try again.".into()),
            technical_details: Some("RwLock poisoned while resetting Nextcloud URL".into()),
        })?;
        guard.nextcloud_url = default_url;
        guard.clone()
    };

    state
        .config_store
        .save(&updated)
        .map_err(UserFacingError::from)?;

    state.events.publish(AppEvent::ConfigUpdated {
        timestamp: Utc::now(),
    });

    Ok(get_workspace_overview(state))
}
