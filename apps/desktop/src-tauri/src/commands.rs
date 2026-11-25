use chrono::Utc;
use fr_core::{AppConfig, AppEvent, ModuleDescriptor, UserFacingError, default_nextcloud_url};
use fr_mcp::McpServerConfig;
use fr_nextcloud::{
    LoginPollResult, NextcloudConnectionStatus, UserAccountInfo, fetch_user_account_info,
    initiate_login_flow, normalize_server_url, poll_login_flow,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

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
    pub account_info: Option<UserAccountInfo>,
    pub login_pending_url: Option<String>,
    pub mcp_server: McpServerConfig,
    pub modules: Vec<ModuleDescriptor>,
    pub startup_error: Option<UserFacingError>,
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

/// Returned when Nextcloud Login Flow v2 has been initiated and opened in the browser.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartResponse {
    pub server_url: String,
    pub login_url: String,
    pub browser_opened: bool,
}

/// Returned on each Login Flow v2 poll tick.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoginPollStatusResponse {
    pub completed: bool,
    pub overview: Option<WorkspaceOverview>,
}

fn lock_error(detail: &str) -> UserFacingError {
    UserFacingError {
        code: "state_lock".into(),
        title: "Couldn't update workspace state".into(),
        message: "The app couldn't access its local state right now.".into(),
        recovery_hint: Some("Please restart the app and try again.".into()),
        technical_details: Some(detail.to_owned()),
    }
}

fn build_overview(state: &AppState) -> WorkspaceOverview {
    WorkspaceOverview {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        platform: std::env::consts::OS.to_owned(),
        config: state.current_config(),
        default_nextcloud_url: default_nextcloud_url(),
        connection_status: state.connection_status(),
        account_info: state.current_account_info(),
        login_pending_url: state.login_pending_url(),
        mcp_server: state.mcp_server_config(),
        modules: state.modules.descriptors(),
        startup_error: state.current_startup_error(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_workspace_overview(state: State<'_, AppState>) -> WorkspaceOverview {
    build_overview(&state)
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

    let (server_changed, prev_server_and_user, new_cache_limit) = {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while updating AppConfig"))?;

        let server_changed = guard.nextcloud_url != normalized_url;
        let prev_server_and_user = if server_changed {
            guard
                .nextcloud_login_name
                .clone()
                .map(|user| (guard.nextcloud_url.clone(), user))
        } else {
            None
        };
        let mut candidate = guard.clone();
        candidate.nextcloud_url = normalized_url;
        if server_changed {
            candidate.nextcloud_login_name = None;
        }
        candidate.cache_limit_mb = input.cache_limit_mb.clamp(128, 32_768);
        candidate.mcp_server_enabled = input.mcp_server_enabled;
        candidate.theme = theme;

        // Persist atomically to disk BEFORE committing in-memory state so disk and memory stay consistent.
        state
            .config_store
            .save(&candidate)
            .map_err(UserFacingError::from)?;

        let limit = candidate.cache_limit_mb;
        *guard = candidate;
        (server_changed, prev_server_and_user, limit)
    };

    if server_changed {
        if let Some((prev_url, prev_user)) = prev_server_and_user
            && !prev_url.trim().is_empty()
        {
            let _ = state.credential_store.delete(&prev_url, &prev_user);
        }
        state.clear_active_session(true);
    }
    if let Some(ref cache) = state.cache {
        let _ = cache.set_limit_mb(new_cache_limit);
    }

    state.clear_startup_error();
    state.events.publish(AppEvent::ConfigUpdated {
        timestamp: Utc::now(),
    });

    Ok(build_overview(&state))
}

#[tauri::command]
#[specta::specta]
pub fn reset_nextcloud_url(
    state: State<'_, AppState>,
) -> Result<WorkspaceOverview, UserFacingError> {
    let default_url =
        normalize_server_url(&default_nextcloud_url()).map_err(UserFacingError::from)?;

    let (server_changed, prev_server_and_user) = {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while resetting Nextcloud URL"))?;

        let server_changed = guard.nextcloud_url != default_url;
        let prev_server_and_user = if server_changed {
            guard
                .nextcloud_login_name
                .clone()
                .map(|user| (guard.nextcloud_url.clone(), user))
        } else {
            None
        };
        let mut candidate = guard.clone();
        candidate.nextcloud_url = default_url;
        if server_changed {
            candidate.nextcloud_login_name = None;
        }

        state
            .config_store
            .save(&candidate)
            .map_err(UserFacingError::from)?;

        *guard = candidate;
        (server_changed, prev_server_and_user)
    };

    if server_changed {
        if let Some((prev_url, prev_user)) = prev_server_and_user
            && !prev_url.trim().is_empty()
        {
            let _ = state.credential_store.delete(&prev_url, &prev_user);
        }
        state.clear_active_session(true);
    }

    state.clear_startup_error();
    state.events.publish(AppEvent::ConfigUpdated {
        timestamp: Utc::now(),
    });

    Ok(build_overview(&state))
}

#[tauri::command]
#[specta::specta]
pub async fn start_nextcloud_login(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<LoginStartResponse, UserFacingError> {
    let server_url = state.current_config().nextcloud_url;
    let session = initiate_login_flow(&state.http_client, &server_url)
        .await
        .map_err(UserFacingError::from)?;

    let login_url = session.login_url.clone();
    let normalized_server = session.server_url.clone();

    {
        let mut guard = state
            .active_login
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while storing LoginFlowSession"))?;
        *guard = Some(session);
    }

    let browser_opened = app.opener().open_url(&login_url, None::<&str>).is_ok();

    Ok(LoginStartResponse {
        server_url: normalized_server,
        login_url,
        browser_opened,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn poll_nextcloud_login(
    state: State<'_, AppState>,
) -> Result<LoginPollStatusResponse, UserFacingError> {
    let session = {
        let guard = state
            .active_login
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while reading LoginFlowSession"))?;
        guard.clone()
    };

    let Some(session) = session else {
        return Ok(LoginPollStatusResponse {
            completed: false,
            overview: None,
        });
    };

    match poll_login_flow(&state.http_client, &session)
        .await
        .map_err(UserFacingError::from)?
    {
        LoginPollResult::Pending => Ok(LoginPollStatusResponse {
            completed: false,
            overview: None,
        }),
        LoginPollResult::Completed(creds) => {
            // Guard against stale poll completions if the user cancelled or changed servers
            // while the HTTP poll request was in flight.
            let still_active = {
                let guard = state
                    .active_login
                    .lock()
                    .map_err(|_| lock_error("Mutex poisoned while verifying LoginFlowSession"))?;
                guard.as_ref().is_some_and(|active| {
                    active.poll_token == session.poll_token
                        && active.server_url == session.server_url
                })
            };
            if !still_active || state.current_config().nextcloud_url != session.server_url {
                return Ok(LoginPollStatusResponse {
                    completed: false,
                    overview: None,
                });
            }

            // 1. Persist secret exclusively in OS Keychain BEFORE updating config or session state.
            state
                .credential_store
                .save(&creds)
                .map_err(UserFacingError::from)?;

            // 2. Persist non-secret identity (`server_url` + `login_name`) atomically on disk.
            {
                let mut guard = state
                    .config
                    .lock()
                    .map_err(|_| lock_error("Mutex poisoned while saving Nextcloud account"))?;
                let mut candidate = guard.clone();
                candidate.nextcloud_url = creds.server_url.clone();
                candidate.nextcloud_login_name = Some(creds.login_name.clone());
                state
                    .config_store
                    .save(&candidate)
                    .map_err(UserFacingError::from)?;
                *guard = candidate;
            }

            // 3. Activate authenticated storage backend & clear pending login.
            state
                .activate_session(creds.clone())
                .map_err(UserFacingError::from)?;
            if let Ok(mut guard) = state.active_login.lock() {
                *guard = None;
            }

            // 4. Best-effort fetch user display name and quota via OCS.
            if let Ok(info) = fetch_user_account_info(&state.http_client, &creds).await
                && let Ok(mut guard) = state.account_info.lock()
            {
                *guard = Some(info);
            }

            state.events.publish(AppEvent::ConfigUpdated {
                timestamp: Utc::now(),
            });

            Ok(LoginPollStatusResponse {
                completed: true,
                overview: Some(build_overview(&state)),
            })
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn cancel_nextcloud_login(state: State<'_, AppState>) -> WorkspaceOverview {
    if let Ok(mut guard) = state.active_login.lock() {
        *guard = None;
    }
    build_overview(&state)
}

#[tauri::command]
#[specta::specta]
pub fn sign_out_nextcloud(
    state: State<'_, AppState>,
) -> Result<WorkspaceOverview, UserFacingError> {
    let (server_url, login_name) = {
        let cfg = state.current_config();
        (cfg.nextcloud_url, cfg.nextcloud_login_name)
    };

    if let Some(ref user) = login_name
        && !server_url.trim().is_empty()
    {
        state
            .credential_store
            .delete(&server_url, user)
            .map_err(UserFacingError::from)?;
    }

    {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while signing out"))?;
        let mut candidate = guard.clone();
        candidate.nextcloud_login_name = None;
        state
            .config_store
            .save(&candidate)
            .map_err(UserFacingError::from)?;
        *guard = candidate;
    }

    state.clear_active_session(true);
    state.events.publish(AppEvent::ConfigUpdated {
        timestamp: Utc::now(),
    });

    Ok(build_overview(&state))
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_account_info(
    state: State<'_, AppState>,
) -> Result<Option<UserAccountInfo>, UserFacingError> {
    let creds = {
        let guard = state
            .active_credentials
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while reading active credentials"))?;
        guard.clone()
    };

    let Some(creds) = creds else {
        return Ok(None);
    };

    let info = fetch_user_account_info(&state.http_client, &creds)
        .await
        .map_err(UserFacingError::from)?;

    if let Ok(mut guard) = state.account_info.lock() {
        *guard = Some(info.clone());
    }

    Ok(Some(info))
}
