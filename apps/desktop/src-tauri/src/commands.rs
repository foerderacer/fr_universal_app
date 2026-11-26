use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use chrono::Utc;
use fr_core::{
    AppConfig, AppEvent, ConfigStore, FrError, ModuleDescriptor, UserFacingError,
    default_nextcloud_url,
};
use fr_mcp::{
    ExternalMcpServer, ExternalMcpServerView, ExternalMcpTool, McpAuditEntry, McpServerConfig,
    McpServerStatus, McpToolCallOutput, PendingWriteApproval, build_client_config_snippet,
};
use fr_mod_files::{FileItemView, FilePreviewPayload, FilesService, MarkdownDocument};
use fr_mod_finance::{FinanceCurrencySummary, FinanceEntry, UpsertFinanceEntryRequest};
use fr_nextcloud::{
    LoginPollResult, NextcloudConnectionStatus, UserAccountInfo, fetch_user_account_info,
    initiate_login_flow, normalize_server_url, poll_login_flow,
};
use fr_storage::{CloudPath, Etag};
use fr_workflows::{WorkflowDefinition, WorkflowRunRecord, WorkflowSyncReport};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

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

/// Result of saving a Markdown document to Nextcloud.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveMarkdownResponse {
    pub path: CloudPath,
    pub etag: Etag,
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

fn require_files_service(state: &AppState) -> Result<FilesService, UserFacingError> {
    let storage = state.current_storage().ok_or_else(|| {
        UserFacingError::from(FrError::AuthRequired(
            "Sign in to Nextcloud before browsing files".into(),
        ))
    })?;
    Ok(FilesService::new(storage))
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
pub async fn update_settings(
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
            candidate.pinned_folders.clear();
        }
        candidate.cache_limit_mb = input.cache_limit_mb.clamp(128, 32_768);
        candidate.mcp_server_enabled = input.mcp_server_enabled;
        candidate.theme = theme;

        // Persist atomically before updating in-memory state so disk and RAM never diverge on error.
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

    if let Err(err) = state.sync_mcp_server_runtime(false).await {
        tracing::warn!("MCP server sync error after settings save: {err}");
        // Revert only the MCP enabled flag so disk & runtime stay consistent.
        if let Ok(mut guard) = state.config.lock() {
            let mut reverted = guard.clone();
            reverted.mcp_server_enabled = false;
            let _ = state.config_store.save(&reverted);
            *guard = reverted;
        }
        return Err(mcp_error_to_user_facing(err));
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
            candidate.pinned_folders.clear();
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

            // 1. Persist secret in OS Keychain first (never plaintext).
            state
                .credential_store
                .save(&creds)
                .map_err(UserFacingError::from)?;

            // 2. Persist non-secret account pointer in config.json.
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

            // 3. Activate live WebDAV + SQLite cached storage session.
            state
                .activate_session(creds.clone())
                .map_err(UserFacingError::from)?;
            if let Ok(mut guard) = state.active_login.lock() {
                *guard = None;
            }

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

// ---------------------------------------------------------------------------
// Phase 1B: File Explorer, Previewer & Markdown Editor commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn list_files(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<FileItemView>, UserFacingError> {
    let service = require_files_service(&state)?;
    service
        .list_folder(&path)
        .await
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn search_files(
    state: State<'_, AppState>,
    path: String,
    query: String,
) -> Result<Vec<FileItemView>, UserFacingError> {
    let service = require_files_service(&state)?;
    service
        .search_folder(&path, &query, 3)
        .await
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn create_folder(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), UserFacingError> {
    let service = require_files_service(&state)?;
    service
        .create_folder(&path)
        .await
        .map_err(UserFacingError::from)?;
    state.events.publish(AppEvent::FileCreated {
        path,
        timestamp: Utc::now(),
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn rename_file(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), UserFacingError> {
    let service = require_files_service(&state)?;
    service
        .rename_item(&from, &to)
        .await
        .map_err(UserFacingError::from)?;
    state.events.publish(AppEvent::FileRenamed {
        from,
        to,
        timestamp: Utc::now(),
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_file(state: State<'_, AppState>, path: String) -> Result<(), UserFacingError> {
    let service = require_files_service(&state)?;
    service
        .delete_item(&path)
        .await
        .map_err(UserFacingError::from)?;
    state.events.publish(AppEvent::FileDeleted {
        path,
        timestamp: Utc::now(),
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn upload_file_base64(
    state: State<'_, AppState>,
    path: String,
    data_base64: String,
    overwrite: bool,
) -> Result<Etag, UserFacingError> {
    let service = require_files_service(&state)?;
    let raw = BASE64.decode(data_base64.as_bytes()).map_err(|err| {
        UserFacingError::from(FrError::Other(format!("invalid upload payload: {err}")))
    })?;
    let etag = service
        .upload_bytes(&path, Bytes::from(raw), overwrite)
        .await
        .map_err(UserFacingError::from)?;
    state.events.publish(AppEvent::FileCreated {
        path,
        timestamp: Utc::now(),
    });
    Ok(etag)
}

#[tauri::command]
#[specta::specta]
pub fn toggle_pin_folder(
    state: State<'_, AppState>,
    folder_path: String,
) -> Result<WorkspaceOverview, UserFacingError> {
    let parsed = CloudPath::parse(&folder_path).map_err(UserFacingError::from)?;
    let normalized = parsed.as_str().to_owned();

    {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while toggling pinned folder"))?;
        let mut candidate = guard.clone();
        if let Some(pos) = candidate
            .pinned_folders
            .iter()
            .position(|p| p == &normalized)
        {
            candidate.pinned_folders.remove(pos);
        } else {
            candidate.pinned_folders.push(normalized);
        }
        state
            .config_store
            .save(&candidate)
            .map_err(UserFacingError::from)?;
        *guard = candidate;
    }

    Ok(build_overview(&state))
}

#[tauri::command]
#[specta::specta]
pub async fn create_markdown_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<SaveMarkdownResponse, UserFacingError> {
    let service = require_files_service(&state)?;
    let cloud_path = CloudPath::parse(&path).map_err(UserFacingError::from)?;
    let etag = service
        .create_markdown(cloud_path.as_str(), &content)
        .await
        .map_err(UserFacingError::from)?;
    state.events.publish(AppEvent::FileCreated {
        path: cloud_path.as_str().to_owned(),
        timestamp: Utc::now(),
    });
    Ok(SaveMarkdownResponse {
        path: cloud_path,
        etag,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn read_markdown_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<MarkdownDocument, UserFacingError> {
    let service = require_files_service(&state)?;
    let (cloud_path, content, etag) = service
        .read_markdown(&path)
        .await
        .map_err(UserFacingError::from)?;

    let account_scope = state.active_account_scope();
    let draft = if let Some(ref cache) = state.cache {
        let cache = cache.clone();
        let p = cloud_path.clone();
        tokio::task::spawn_blocking(move || cache.get_markdown_draft(&account_scope, &p))
            .await
            .ok()
            .and_then(|res| res.ok())
            .flatten()
    } else {
        None
    };

    let name = cloud_path.file_name().unwrap_or("document.md").to_owned();
    Ok(MarkdownDocument {
        path: cloud_path,
        name,
        content,
        etag,
        draft,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn save_markdown_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected_etag: Option<Etag>,
    force_overwrite: bool,
) -> Result<SaveMarkdownResponse, UserFacingError> {
    let service = require_files_service(&state)?;
    let cloud_path = CloudPath::parse(&path).map_err(UserFacingError::from)?;
    let etag_arg = if force_overwrite {
        None
    } else {
        expected_etag.as_ref()
    };

    let new_etag = service
        .write_markdown(cloud_path.as_str(), &content, etag_arg)
        .await
        .map_err(UserFacingError::from)?;

    if let Some(ref cache) = state.cache {
        let cache = cache.clone();
        let account_scope = state.active_account_scope();
        let p = cloud_path.clone();
        let _ =
            tokio::task::spawn_blocking(move || cache.delete_markdown_draft(&account_scope, &p))
                .await;
    }

    state.events.publish(AppEvent::FileUpdated {
        path: cloud_path.as_str().to_owned(),
        etag: new_etag.as_str().to_owned(),
        timestamp: Utc::now(),
    });

    Ok(SaveMarkdownResponse {
        path: cloud_path,
        etag: new_etag,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn save_markdown_copy(
    state: State<'_, AppState>,
    original_path: String,
    content: String,
) -> Result<SaveMarkdownResponse, UserFacingError> {
    let service = require_files_service(&state)?;
    let (copy_path, etag) = service
        .save_markdown_as_copy(&original_path, &content)
        .await
        .map_err(UserFacingError::from)?;

    if let Some(ref cache) = state.cache
        && let Ok(orig) = CloudPath::parse(&original_path)
    {
        let cache = cache.clone();
        let account_scope = state.active_account_scope();
        let _ =
            tokio::task::spawn_blocking(move || cache.delete_markdown_draft(&account_scope, &orig))
                .await;
    }

    state.events.publish(AppEvent::FileCreated {
        path: copy_path.as_str().to_owned(),
        timestamp: Utc::now(),
    });

    Ok(SaveMarkdownResponse {
        path: copy_path,
        etag,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn save_markdown_draft(
    state: State<'_, AppState>,
    path: String,
    content: String,
    base_etag: Option<Etag>,
) -> Result<(), UserFacingError> {
    let cloud_path = CloudPath::parse(&path).map_err(UserFacingError::from)?;
    let Some(ref cache) = state.cache else {
        return Ok(());
    };
    let cache = cache.clone();
    let account_scope = state.active_account_scope();
    tokio::task::spawn_blocking(move || {
        cache.save_markdown_draft(&account_scope, &cloud_path, &content, base_etag.as_ref())
    })
    .await
    .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
    .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn discard_markdown_draft(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), UserFacingError> {
    let cloud_path = CloudPath::parse(&path).map_err(UserFacingError::from)?;
    let Some(ref cache) = state.cache else {
        return Ok(());
    };
    let cache = cache.clone();
    let account_scope = state.active_account_scope();
    tokio::task::spawn_blocking(move || cache.delete_markdown_draft(&account_scope, &cloud_path))
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn get_file_preview(
    state: State<'_, AppState>,
    path: String,
) -> Result<FilePreviewPayload, UserFacingError> {
    let service = require_files_service(&state)?;
    let proxy = state.current_media_proxy();
    service
        .build_preview(&path, move |cloud_path, transcode_png| {
            proxy
                .as_ref()
                .map(|p| p.media_url(cloud_path, transcode_png))
        })
        .await
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn get_file_thumbnail(
    state: State<'_, AppState>,
    file_id: String,
    width: u32,
    height: u32,
) -> Result<Option<String>, UserFacingError> {
    let service = require_files_service(&state)?;
    service
        .fetch_thumbnail_data_url(&file_id, width.clamp(32, 1024), height.clamp(32, 1024))
        .await
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub fn get_media_proxy_url(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<String>, UserFacingError> {
    let cloud_path = CloudPath::parse(&path).map_err(UserFacingError::from)?;
    let transcode = fr_preview::needs_png_transcode(cloud_path.file_name().unwrap_or_default());
    Ok(state
        .current_media_proxy()
        .map(|proxy| proxy.media_url(&cloud_path, transcode)))
}

const MAX_NATIVE_OPEN_BYTES: u64 = 256 * 1024 * 1024;
const MAX_OPENED_FILE_DIRS: usize = 20;

fn is_dangerous_executable_name(file_name: &str) -> bool {
    let ext = std::path::Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    matches!(
        ext.as_deref(),
        Some(
            "exe"
                | "bat"
                | "cmd"
                | "com"
                | "msi"
                | "msp"
                | "ps1"
                | "psm1"
                | "vbs"
                | "vbe"
                | "js"
                | "jse"
                | "wsf"
                | "wsh"
                | "scr"
                | "pif"
                | "hta"
                | "jar"
                | "app"
                | "command"
                | "sh"
                | "dmg"
                | "pkg"
                | "lnk"
                | "reg"
        )
    )
}

fn sanitize_native_open_filename(raw: &str) -> fr_core::Result<String> {
    let replaced: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect();
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(FrError::InvalidPath(
            "invalid file name for native open".into(),
        ));
    }

    let stem_upper = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let is_windows_reserved = matches!(
        stem_upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if is_windows_reserved {
        Ok(format!("_{trimmed}"))
    } else {
        Ok(trimmed.to_owned())
    }
}

fn prune_old_opened_dirs(parent: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_dir() {
                return None;
            }
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, e.path()))
        })
        .collect();
    if dirs.len() <= MAX_OPENED_FILE_DIRS {
        return;
    }
    dirs.sort_by_key(|a| std::cmp::Reverse(a.0));
    for (_, stale) in dirs.into_iter().skip(MAX_OPENED_FILE_DIRS) {
        let _ = std::fs::remove_dir_all(stale);
    }
}

#[tauri::command]
#[specta::specta]
pub async fn open_file_in_native_app(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    allow_executable: bool,
) -> Result<String, UserFacingError> {
    let service = require_files_service(&state)?;
    let cloud_path = CloudPath::parse(&path).map_err(UserFacingError::from)?;
    let file_name = cloud_path
        .file_name()
        .ok_or_else(|| {
            UserFacingError::from(FrError::InvalidPath("cannot open root folder".into()))
        })?
        .to_owned();

    if !allow_executable && is_dangerous_executable_name(&file_name) {
        return Err(UserFacingError {
            code: "executable_blocked".into(),
            title: "Executable or script file".into(),
            message: format!(
                "\"{file_name}\" is a program or script from Nextcloud. Opening it could run code on your computer."
            ),
            recovery_hint: Some(
                "Only proceed if you trust the teammate who uploaded this file.".into(),
            ),
            technical_details: None,
        });
    }

    let safe_file_name =
        sanitize_native_open_filename(&file_name).map_err(UserFacingError::from)?;

    let meta = service
        .storage()
        .stat(&cloud_path)
        .await
        .map_err(UserFacingError::from)?;
    if meta.size > MAX_NATIVE_OPEN_BYTES {
        return Err(UserFacingError {
            code: "file_too_large".into(),
            title: "File is too large for quick open".into(),
            message: "This file is larger than 256 MB. Download it directly from Nextcloud in your browser to open it.".into(),
            recovery_hint: None,
            technical_details: Some(format!("size={} bytes", meta.size)),
        });
    }

    let (bytes, etag) = service
        .storage()
        .read(&cloud_path)
        .await
        .map_err(UserFacingError::from)?;

    let safe_etag: String = etag
        .as_str()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect();

    let opened_root: PathBuf = ConfigStore::default_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("opened-files");
    let base_dir = opened_root.join(if safe_etag.is_empty() {
        "latest"
    } else {
        safe_etag.as_str()
    });

    let target_path = base_dir.join(&safe_file_name);
    let target_clone = target_path.clone();
    tokio::task::spawn_blocking(move || -> fr_core::Result<()> {
        std::fs::create_dir_all(&base_dir)?;
        std::fs::write(&target_clone, &bytes)?;
        prune_old_opened_dirs(&opened_root);
        Ok(())
    })
    .await
    .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
    .map_err(UserFacingError::from)?;

    let path_str = target_path.to_string_lossy().into_owned();
    app.opener()
        .open_path(&path_str, None::<&str>)
        .map_err(|err| {
            UserFacingError::from(FrError::Other(format!(
                "failed to launch default app for '{safe_file_name}': {err}"
            )))
        })?;

    Ok(path_str)
}

// ---------------------------------------------------------------------------
// Phase 2: Dual MCP Server & External MCP Client commands
// ---------------------------------------------------------------------------

/// Maps MCP-specific `FrError` values into accurate, non-technical MCP messages (never blaming Nextcloud).
fn mcp_error_to_user_facing(err: FrError) -> UserFacingError {
    match &err {
        FrError::AuthRequired(_) => UserFacingError {
            code: "mcp_auth_failed".into(),
            title: "External MCP authentication failed".into(),
            message: "The external MCP server rejected the configured Bearer token.".into(),
            recovery_hint: Some(
                "Update the server's Bearer token in MCP / AI and try again.".into(),
            ),
            technical_details: Some(err.to_string()),
        },
        FrError::Network(_) => UserFacingError {
            code: "mcp_network_error".into(),
            title: "Couldn't reach the external MCP server".into(),
            message: "The MCP server did not respond or couldn't be reached.".into(),
            recovery_hint: Some(
                "Check the server URL or command in MCP / AI and confirm the server is running."
                    .into(),
            ),
            technical_details: Some(err.to_string()),
        },
        FrError::InvalidConfig(msg) => UserFacingError {
            code: "mcp_invalid_config".into(),
            title: "Invalid MCP setting".into(),
            message: msg.clone(),
            recovery_hint: Some("Check the values entered in MCP / AI and try again.".into()),
            technical_details: Some(err.to_string()),
        },
        FrError::Other(msg) if msg.contains("failed to bind local MCP Server") => UserFacingError {
            code: "mcp_port_in_use".into(),
            title: "Local MCP port is already in use".into(),
            message: "Another app is already using that local port on this computer.".into(),
            recovery_hint: Some(
                "Pick a different port between 1024 and 65535 (e.g. 38421) and click Apply."
                    .into(),
            ),
            technical_details: Some(err.to_string()),
        },
        FrError::Other(msg) if msg.contains("failed to start stdio MCP process") => {
            UserFacingError {
                code: "mcp_stdio_spawn_failed".into(),
                title: "Couldn't launch local MCP command".into(),
                message: "The configured program couldn't be found or started on this computer."
                    .into(),
                recovery_hint: Some(
                    "Check that the executable is installed and on your PATH, or enter its full path."
                        .into(),
                ),
                technical_details: Some(err.to_string()),
            }
        }
        _ => UserFacingError::from(err),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMcpServerRequest {
    pub enabled: bool,
    pub port: u16,
    pub require_write_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMcpServerResponse {
    pub status: McpServerStatus,
    pub overview: WorkspaceOverview,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpClientConfigSnippetResponse {
    pub endpoint_url: String,
    pub json_snippet: String,
}

#[tauri::command]
#[specta::specta]
pub async fn get_mcp_server_status(
    state: State<'_, AppState>,
) -> Result<McpServerStatus, UserFacingError> {
    Ok(state.mcp_server_status().await)
}

#[tauri::command]
#[specta::specta]
pub async fn configure_mcp_server(
    state: State<'_, AppState>,
    input: ConfigureMcpServerRequest,
) -> Result<ConfigureMcpServerResponse, UserFacingError> {
    if input.port < 1024 {
        return Err(mcp_error_to_user_facing(FrError::InvalidConfig(
            "Choose a local port between 1024 and 65535.".into(),
        )));
    }

    let previous = state.current_config();
    {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while saving MCP server settings"))?;
        let mut candidate = guard.clone();
        candidate.mcp_server_enabled = input.enabled;
        candidate.mcp_server_port = input.port;
        candidate.mcp_require_write_approval = input.require_write_approval;
        state
            .config_store
            .save(&candidate)
            .map_err(mcp_error_to_user_facing)?;
        *guard = candidate;
    }

    let status = match state.sync_mcp_server_runtime(false).await {
        Ok(s) => s,
        Err(err) => {
            // Roll back config AND restore previous runtime so config and live state never drift.
            if let Ok(mut guard) = state.config.lock() {
                let _ = state.config_store.save(&previous);
                *guard = previous;
            }
            let _ = state.sync_mcp_server_runtime(false).await;
            return Err(mcp_error_to_user_facing(err));
        }
    };

    state.events.publish(AppEvent::ConfigUpdated {
        timestamp: Utc::now(),
    });

    Ok(ConfigureMcpServerResponse {
        status,
        overview: build_overview(&state),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_mcp_client_config_snippet(
    state: State<'_, AppState>,
) -> Result<McpClientConfigSnippetResponse, UserFacingError> {
    let status = state.mcp_server_status().await;
    let endpoint_url = status.endpoint_url.unwrap_or_else(|| {
        let addr = status
            .config
            .bind_host
            .parse::<std::net::IpAddr>()
            .map(|ip| std::net::SocketAddr::new(ip, status.config.port).to_string())
            .unwrap_or_else(|_| format!("{}:{}", status.config.bind_host, status.config.port));
        format!("http://{addr}/mcp")
    });
    let token_store = state.mcp_token_store.clone();
    let token = tokio::task::spawn_blocking(move || token_store.get_or_create_server_token())
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(mcp_error_to_user_facing)?;
    let json_snippet = build_client_config_snippet(&endpoint_url, &token);
    Ok(McpClientConfigSnippetResponse {
        endpoint_url,
        json_snippet,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn rotate_mcp_server_token(
    state: State<'_, AppState>,
) -> Result<McpClientConfigSnippetResponse, UserFacingError> {
    let token_store = state.mcp_token_store.clone();
    let token = tokio::task::spawn_blocking(move || token_store.rotate_server_token())
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(mcp_error_to_user_facing)?;
    let status = state
        .sync_mcp_server_runtime(true)
        .await
        .map_err(mcp_error_to_user_facing)?;
    let endpoint_url = status.endpoint_url.unwrap_or_else(|| {
        let addr = status
            .config
            .bind_host
            .parse::<std::net::IpAddr>()
            .map(|ip| std::net::SocketAddr::new(ip, status.config.port).to_string())
            .unwrap_or_else(|_| format!("{}:{}", status.config.bind_host, status.config.port));
        format!("http://{addr}/mcp")
    });
    let json_snippet = build_client_config_snippet(&endpoint_url, &token);
    Ok(McpClientConfigSnippetResponse {
        endpoint_url,
        json_snippet,
    })
}

#[tauri::command]
#[specta::specta]
pub fn list_mcp_audit_log(state: State<'_, AppState>) -> Vec<McpAuditEntry> {
    state.mcp_audit.list()
}

#[tauri::command]
#[specta::specta]
pub fn clear_mcp_audit_log(state: State<'_, AppState>) {
    state.mcp_audit.clear();
}

#[tauri::command]
#[specta::specta]
pub fn list_pending_mcp_approvals(state: State<'_, AppState>) -> Vec<PendingWriteApproval> {
    state.mcp_approvals.list_pending()
}

#[tauri::command]
#[specta::specta]
pub fn resolve_mcp_approval(state: State<'_, AppState>, approval_id: String, allow: bool) -> bool {
    state.mcp_approvals.resolve(&approval_id, allow)
}

#[tauri::command]
#[specta::specta]
pub async fn list_external_mcp_servers(
    state: State<'_, AppState>,
) -> Result<Vec<ExternalMcpServerView>, UserFacingError> {
    let client = state.mcp_client.clone();
    tokio::task::spawn_blocking(move || client.list_servers())
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_external_mcp_server(
    state: State<'_, AppState>,
    server: ExternalMcpServer,
    bearer_token: Option<String>,
) -> Result<Vec<ExternalMcpServerView>, UserFacingError> {
    let client = state.mcp_client.clone();
    tokio::task::spawn_blocking(move || client.upsert_server(server, bearer_token))
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(mcp_error_to_user_facing)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_external_mcp_server(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<Vec<ExternalMcpServerView>, UserFacingError> {
    let client = state.mcp_client.clone();
    tokio::task::spawn_blocking(move || client.delete_server(&server_id))
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(mcp_error_to_user_facing)
}

#[tauri::command]
#[specta::specta]
pub async fn sync_team_mcp_servers(
    state: State<'_, AppState>,
) -> Result<Vec<ExternalMcpServerView>, UserFacingError> {
    let service = require_files_service(&state)?;
    state
        .mcp_client
        .sync_from_nextcloud(service.storage().as_ref())
        .await
        .map_err(|err| match err {
            FrError::NotFound(_) => UserFacingError {
                code: "team_mcp_registry_missing".into(),
                title: "No shared team MCP registry found".into(),
                message: "Your Nextcloud workspace doesn't have a /_FR_App/mcp-servers.json file yet.".into(),
                recovery_hint: Some("Ask your team admin to create /_FR_App/mcp-servers.json, or add servers manually.".into()),
                technical_details: None,
            },
            FrError::Serialization(ref se) => UserFacingError {
                code: "team_mcp_registry_invalid".into(),
                title: "Shared MCP registry couldn't be read".into(),
                message: "The team file /_FR_App/mcp-servers.json is not valid JSON.".into(),
                recovery_hint: Some("Fix the JSON syntax in Nextcloud and try syncing again.".into()),
                technical_details: Some(se.to_string()),
            },
            other => UserFacingError::from(other),
        })
}

#[tauri::command]
#[specta::specta]
pub async fn discover_external_mcp_tools(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<Vec<ExternalMcpTool>, UserFacingError> {
    state
        .mcp_client
        .discover_tools(&server_id)
        .await
        .map_err(mcp_error_to_user_facing)
}

#[tauri::command]
#[specta::specta]
pub async fn test_external_mcp_tool(
    state: State<'_, AppState>,
    server_id: String,
    tool_name: String,
    arguments_json: String,
) -> Result<McpToolCallOutput, UserFacingError> {
    let args: serde_json::Value = if arguments_json.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&arguments_json).map_err(|err| {
            mcp_error_to_user_facing(FrError::InvalidConfig(format!(
                "Tool arguments must be valid JSON: {err}"
            )))
        })?
    };
    state
        .mcp_client
        .call_tool(&server_id, &tool_name, args)
        .await
        .map_err(mcp_error_to_user_facing)
}

// ---------------------------------------------------------------------------
// Phase 3: Automation Workflows & Finance Ledger commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn list_workflows(
    state: State<'_, AppState>,
) -> Result<Vec<WorkflowDefinition>, UserFacingError> {
    let store = state.workflow_runner.store().clone();
    tokio::task::spawn_blocking(move || store.list_workflows())
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_workflow(
    state: State<'_, AppState>,
    workflow: WorkflowDefinition,
) -> Result<Vec<WorkflowDefinition>, UserFacingError> {
    let store = state.workflow_runner.store().clone();
    tokio::task::spawn_blocking(move || {
        store.upsert_workflow(workflow)?;
        store.list_workflows()
    })
    .await
    .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
    .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_workflow(
    state: State<'_, AppState>,
    workflow_id: String,
) -> Result<Vec<WorkflowDefinition>, UserFacingError> {
    let store = state.workflow_runner.store().clone();
    tokio::task::spawn_blocking(move || {
        store.delete_workflow(&workflow_id)?;
        store.list_workflows()
    })
    .await
    .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
    .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn run_workflow_now(
    state: State<'_, AppState>,
    workflow_id: String,
) -> Result<WorkflowRunRecord, UserFacingError> {
    let service = require_files_service(&state)?;
    state
        .workflow_runner
        .run_workflow(&workflow_id, "manual", service.storage().as_ref())
        .await
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn list_workflow_runs(
    state: State<'_, AppState>,
    workflow_id: Option<String>,
    limit: u32,
) -> Result<Vec<WorkflowRunRecord>, UserFacingError> {
    let store = state.workflow_runner.store().clone();
    tokio::task::spawn_blocking(move || store.list_runs(workflow_id.as_deref(), limit as usize))
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn sync_workflows_from_nextcloud(
    state: State<'_, AppState>,
) -> Result<WorkflowSyncReport, UserFacingError> {
    let service = require_files_service(&state)?;
    state
        .workflow_runner
        .sync_from_nextcloud(service.storage().as_ref())
        .await
        .map_err(|err| match err {
            FrError::NotFound(_) => UserFacingError {
                code: "team_workflows_missing".into(),
                title: "No shared team workflows folder found".into(),
                message: "Your Nextcloud workspace doesn't have a /_FR_App/workflows/ folder yet."
                    .into(),
                recovery_hint: Some(
                    "Click Share to Nextcloud on any workflow to create the shared folder automatically."
                        .into(),
                ),
                technical_details: None,
            },
            other => UserFacingError::from(other),
        })
}

#[tauri::command]
#[specta::specta]
pub async fn push_workflow_to_nextcloud(
    state: State<'_, AppState>,
    workflow_id: String,
) -> Result<String, UserFacingError> {
    let service = require_files_service(&state)?;
    let path = state
        .workflow_runner
        .push_to_nextcloud(&workflow_id, service.storage().as_ref())
        .await
        .map_err(|err| match err {
            FrError::Conflict { .. } => UserFacingError {
                code: "workflow_conflict".into(),
                title: "A teammate updated this workflow on Nextcloud".into(),
                message:
                    "Another version of this workflow already exists in /_FR_App/workflows/."
                        .into(),
                recovery_hint: Some(
                    "Click Sync from Nextcloud first to pull the latest version before sharing changes."
                        .into(),
                ),
                technical_details: Some(err.to_string()),
            },
            other => UserFacingError::from(other),
        })?;
    Ok(path.as_str().to_owned())
}

#[tauri::command]
#[specta::specta]
pub async fn list_finance_entries(
    state: State<'_, AppState>,
) -> Result<Vec<FinanceEntry>, UserFacingError> {
    let ledger = state.finance_ledger.clone();
    let scope = state
        .require_active_account_scope()
        .map_err(UserFacingError::from)?;
    tokio::task::spawn_blocking(move || ledger.list_entries(&scope))
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_finance_entry(
    state: State<'_, AppState>,
    input: UpsertFinanceEntryRequest,
) -> Result<FinanceEntry, UserFacingError> {
    let ledger = state.finance_ledger.clone();
    let scope = state
        .require_active_account_scope()
        .map_err(UserFacingError::from)?;
    let entry = tokio::task::spawn_blocking(move || ledger.upsert_entry(&scope, input))
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(UserFacingError::from)?;
    state.events.publish(AppEvent::FinanceEntryChanged {
        entry_id: entry.id.clone(),
        timestamp: Utc::now(),
    });
    Ok(entry)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_finance_entry(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<(), UserFacingError> {
    let ledger = state.finance_ledger.clone();
    let scope = state
        .require_active_account_scope()
        .map_err(UserFacingError::from)?;
    let id_clone = entry_id.clone();
    tokio::task::spawn_blocking(move || ledger.delete_entry(&scope, &id_clone))
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(UserFacingError::from)?;
    state.events.publish(AppEvent::FinanceEntryChanged {
        entry_id,
        timestamp: Utc::now(),
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_finance_summary(
    state: State<'_, AppState>,
) -> Result<Vec<FinanceCurrencySummary>, UserFacingError> {
    let ledger = state.finance_ledger.clone();
    let scope = state
        .require_active_account_scope()
        .map_err(UserFacingError::from)?;
    tokio::task::spawn_blocking(move || ledger.summarize(&scope))
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn export_finance_csv(state: State<'_, AppState>) -> Result<String, UserFacingError> {
    let ledger = state.finance_ledger.clone();
    let scope = state
        .require_active_account_scope()
        .map_err(UserFacingError::from)?;
    tokio::task::spawn_blocking(move || ledger.export_csv(&scope))
        .await
        .map_err(|err| UserFacingError::from(FrError::Other(err.to_string())))?
        .map_err(UserFacingError::from)
}

#[tauri::command]
#[specta::specta]
pub fn set_finance_folder(
    state: State<'_, AppState>,
    folder_path: String,
) -> Result<WorkspaceOverview, UserFacingError> {
    let parsed = CloudPath::parse(&folder_path).map_err(UserFacingError::from)?;
    {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while saving finance folder"))?;
        let mut candidate = guard.clone();
        candidate.finance_folder = parsed.as_str().to_owned();
        state
            .config_store
            .save(&candidate)
            .map_err(UserFacingError::from)?;
        *guard = candidate;
    }
    state.events.publish(AppEvent::ConfigUpdated {
        timestamp: Utc::now(),
    });
    Ok(build_overview(&state))
}

// ---------------------------------------------------------------------------
// Phase 4: Signed Auto-Updater commands (Plan 08)
// ---------------------------------------------------------------------------

const DEFAULT_UPDATER_ENDPOINT: &str =
    "https://github.com/foerderacer/fr_universal_app/releases/latest/download/latest.json";
const DEFAULT_RELEASES_PAGE_URL: &str = "https://github.com/foerderacer/fr_universal_app/releases";
const UPDATER_CHECK_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub configured: bool,
    pub available: bool,
    pub skipped: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub release_url: String,
    pub last_checked_at: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSafetyStatus {
    pub safe_to_restart: bool,
    pub pending_drafts_count: u32,
    pub running_workflows_count: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
}

/// Parses one or more comma-separated updater endpoint URLs, enforcing strict `https://`.
pub(crate) fn parse_updater_endpoints(
    raw: Option<&str>,
) -> Result<Vec<tauri::Url>, UserFacingError> {
    let source = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_UPDATER_ENDPOINT);
    let mut urls = Vec::new();
    for piece in source.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let parsed = tauri::Url::parse(piece).map_err(|err| UserFacingError {
            code: "updater_invalid_endpoint".into(),
            title: "Updater configuration error".into(),
            message: "The built-in update server address is invalid.".into(),
            recovery_hint: None,
            technical_details: Some(err.to_string()),
        })?;
        if parsed.scheme() != "https" {
            return Err(UserFacingError {
                code: "updater_invalid_endpoint".into(),
                title: "Updater configuration error".into(),
                message: "The built-in update server address must use HTTPS.".into(),
                recovery_hint: None,
                technical_details: Some(piece.to_owned()),
            });
        }
        urls.push(parsed);
    }
    if urls.is_empty() {
        return Err(UserFacingError {
            code: "updater_invalid_endpoint".into(),
            title: "Updater configuration error".into(),
            message: "No valid HTTPS update endpoints are configured.".into(),
            recovery_hint: None,
            technical_details: None,
        });
    }
    Ok(urls)
}

/// Determines whether `available_version` should be offered to the user given an optional skipped version.
pub(crate) fn should_offer_update(available_version: &str, skipped_version: Option<&str>) -> bool {
    let normalized = available_version.trim().trim_start_matches('v');
    match skipped_version.map(|s| s.trim().trim_start_matches('v')) {
        Some(skipped) if !skipped.is_empty() => skipped != normalized,
        _ => true,
    }
}

/// Evaluates whether it is safe to run the installer and restart without risking unsaved edits.
pub(crate) fn evaluate_pre_restart_safety(
    pending_drafts_count: u32,
    running_workflows_count: u32,
) -> UpdateSafetyStatus {
    let mut warnings = Vec::new();
    if pending_drafts_count > 0 {
        warnings.push(format!(
            "You have {pending_drafts_count} unsaved Markdown draft{} stored locally. Save or discard before restarting.",
            if pending_drafts_count == 1 { "" } else { "s" }
        ));
    }
    if running_workflows_count > 0 {
        warnings.push(format!(
            "{running_workflows_count} automation workflow{} currently running and will be interrupted by a restart.",
            if running_workflows_count == 1 { " is" } else { "s are" }
        ));
    }
    UpdateSafetyStatus {
        safe_to_restart: warnings.is_empty(),
        pending_drafts_count,
        running_workflows_count,
        warnings,
    }
}

fn release_url_for_version(version: Option<&str>) -> String {
    match version
        .map(|v| v.trim().trim_start_matches('v'))
        .filter(|v| !v.is_empty())
    {
        Some(v) => format!("{DEFAULT_RELEASES_PAGE_URL}/tag/v{v}"),
        None => DEFAULT_RELEASES_PAGE_URL.to_owned(),
    }
}

fn build_configured_updater(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Option<Result<tauri_plugin_updater::Updater, UserFacingError>> {
    let pubkey = option_env!("FR_UPDATER_PUBKEY")
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let urls = match parse_updater_endpoints(option_env!("FR_UPDATER_ENDPOINT")) {
        Ok(u) => u,
        Err(err) => return Some(Err(err)),
    };
    let cache_for_exit = state.cache.clone();
    let built = app
        .updater_builder()
        .pubkey(pubkey)
        .timeout(std::time::Duration::from_secs(UPDATER_CHECK_TIMEOUT_SECS))
        .on_before_exit(move || {
            // Last-chance SQLite WAL checkpoint before Windows NSIS exits the process.
            if let Some(ref cache) = cache_for_exit {
                cache.flush_wal();
            }
        })
        .endpoints(urls)
        .and_then(|b| b.build())
        .map_err(|err| UserFacingError {
            code: "updater_init_failed".into(),
            title: "Couldn't initialize updater".into(),
            message: "Automatic update checking isn't available in this build.".into(),
            recovery_hint: Some(
                "You can still download new versions manually from GitHub Releases.".into(),
            ),
            technical_details: Some(err.to_string()),
        });
    Some(built)
}

async fn record_last_update_check(state: &AppState) -> String {
    let now = Utc::now().to_rfc3339();
    let candidate = {
        let Ok(mut guard) = state.config.lock() else {
            return now;
        };
        guard.last_update_check_at = Some(now.clone());
        guard.clone()
    };
    let store = state.config_store.clone();
    let _ = tokio::task::spawn_blocking(move || store.save(&candidate)).await;
    now
}

/// Shared update-check implementation called by both manual Settings checks and the 6h background loop.
pub(crate) async fn perform_update_check(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<AppUpdateCheckResult, UserFacingError> {
    let current_version = env!("CARGO_PKG_VERSION").to_owned();
    let cfg = state.current_config();
    let Some(updater_res) = build_configured_updater(app, state) else {
        return Ok(AppUpdateCheckResult {
            configured: false,
            available: false,
            skipped: false,
            current_version,
            latest_version: None,
            notes: None,
            release_url: DEFAULT_RELEASES_PAGE_URL.to_owned(),
            last_checked_at: cfg.last_update_check_at,
            message: "Automatic updates aren't enabled in this build (no updater signing key embedded). Check GitHub Releases manually for newer installers.".into(),
        });
    };
    let updater = updater_res?;
    match updater.check().await {
        Ok(Some(update)) => {
            let checked_at = record_last_update_check(state).await;
            let skipped = !should_offer_update(&update.version, cfg.skipped_update_version.as_deref());
            let release_url = release_url_for_version(Some(&update.version));
            Ok(AppUpdateCheckResult {
                configured: true,
                available: true,
                skipped,
                current_version,
                latest_version: Some(update.version.clone()),
                notes: update.body.clone(),
                release_url,
                last_checked_at: Some(checked_at),
                message: if skipped {
                    format!("Version {} is available (currently skipped).", update.version)
                } else {
                    format!("A new version ({}) of FR Universal App is ready.", update.version)
                },
            })
        }
        Ok(None) => {
            let checked_at = record_last_update_check(state).await;
            Ok(AppUpdateCheckResult {
                configured: true,
                available: false,
                skipped: false,
                current_version: current_version.clone(),
                latest_version: Some(current_version),
                notes: None,
                release_url: DEFAULT_RELEASES_PAGE_URL.to_owned(),
                last_checked_at: Some(checked_at),
                message: "You're running the latest version of FR Universal App.".into(),
            })
        }
        Err(err) => Err(UserFacingError {
            code: "updater_check_failed".into(),
            title: "Couldn't check for updates".into(),
            message: "We couldn't reach GitHub Releases right now.".into(),
            recovery_hint: Some(
                "Check your internet connection, try again later, or download the latest installer from GitHub Releases."
                    .into(),
            ),
            technical_details: Some(err.to_string()),
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn check_for_app_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<AppUpdateCheckResult, UserFacingError> {
    perform_update_check(&app, &state).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_update_safety_status(
    state: State<'_, AppState>,
) -> Result<UpdateSafetyStatus, UserFacingError> {
    let running_workflows = state.workflow_runner.active_run_count();
    let cache = state.cache.clone();
    let scope = state.active_account_scope();
    let pending_drafts = tokio::task::spawn_blocking(move || {
        cache
            .as_ref()
            .and_then(|c| c.count_markdown_drafts(Some(&scope)).ok())
            .unwrap_or(0)
    })
    .await
    .unwrap_or(0);
    Ok(evaluate_pre_restart_safety(
        pending_drafts,
        running_workflows,
    ))
}

#[tauri::command]
#[specta::specta]
pub fn skip_app_update(
    state: State<'_, AppState>,
    version: String,
) -> Result<WorkspaceOverview, UserFacingError> {
    let cleaned = version.trim().trim_start_matches('v').to_owned();
    if cleaned.is_empty() || cleaned.len() > 64 {
        return Err(UserFacingError::from(FrError::InvalidInput(
            "Invalid version to skip.".into(),
        )));
    }
    {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while saving skipped update version"))?;
        let mut candidate = guard.clone();
        candidate.skipped_update_version = Some(cleaned);
        state
            .config_store
            .save(&candidate)
            .map_err(UserFacingError::from)?;
        *guard = candidate;
    }
    Ok(build_overview(&state))
}

#[tauri::command]
#[specta::specta]
pub fn clear_skipped_app_update(
    state: State<'_, AppState>,
) -> Result<WorkspaceOverview, UserFacingError> {
    {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| lock_error("Mutex poisoned while clearing skipped update version"))?;
        let mut candidate = guard.clone();
        candidate.skipped_update_version = None;
        state
            .config_store
            .save(&candidate)
            .map_err(UserFacingError::from)?;
        *guard = candidate;
    }
    Ok(build_overview(&state))
}

#[tauri::command]
#[specta::specta]
pub async fn install_app_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    force: bool,
) -> Result<(), UserFacingError> {
    let Some(updater_res) = build_configured_updater(&app, &state) else {
        return Err(UserFacingError {
            code: "updater_not_configured".into(),
            title: "Auto-updates not enabled in this build".into(),
            message: "Download official releases from GitHub Releases to receive signed updates."
                .into(),
            recovery_hint: None,
            technical_details: None,
        });
    };

    // Pre-restart safety gate MUST run BEFORE download_and_install because on Windows
    // the NSIS installer automatically terminates the running process during install (H7).
    if !force {
        let running_workflows = state.workflow_runner.active_run_count();
        let cache = state.cache.clone();
        let scope = state.active_account_scope();
        let pending_drafts = tokio::task::spawn_blocking(move || {
            cache
                .as_ref()
                .and_then(|c| c.count_markdown_drafts(Some(&scope)).ok())
                .unwrap_or(0)
        })
        .await
        .unwrap_or(0);
        let safety = evaluate_pre_restart_safety(pending_drafts, running_workflows);
        if !safety.safe_to_restart {
            return Err(UserFacingError {
                code: "update_unsafe_to_restart".into(),
                title: "Save your work before installing".into(),
                message: safety.warnings.join(" "),
                recovery_hint: Some(
                    "Save your open drafts or wait for active workflows to finish, or confirm you want to continue anyway."
                        .into(),
                ),
                technical_details: None,
            });
        }
    }

    if let Some(ref cache) = state.cache {
        let cache_clone = cache.clone();
        let _ = tokio::task::spawn_blocking(move || cache_clone.flush_wal()).await;
    }

    let updater = updater_res?;
    let Some(update) = updater.check().await.map_err(|err| UserFacingError {
        code: "updater_check_failed".into(),
        title: "Couldn't download update".into(),
        message: "We couldn't reach GitHub Releases right now.".into(),
        recovery_hint: Some(
            "Try again in a moment, or download the latest installer from GitHub Releases.".into(),
        ),
        technical_details: Some(err.to_string()),
    })?
    else {
        return Ok(());
    };

    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let last_emit = std::sync::Arc::new(std::sync::Mutex::new((
        Option::<u8>::None,
        std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(1))
            .unwrap_or_else(std::time::Instant::now),
    )));
    let app_for_progress = app.clone();
    let downloaded_for_cb = downloaded.clone();
    let last_emit_for_cb = last_emit.clone();
    let app_for_done = app.clone();

    update
        .download_and_install(
            move |chunk_len, content_length| {
                let prev = downloaded_for_cb
                    .fetch_add(chunk_len as u64, std::sync::atomic::Ordering::Relaxed);
                let total_so_far = prev.saturating_add(chunk_len as u64);
                let percent = content_length
                    .and_then(|total| total_so_far.saturating_mul(100).checked_div(total))
                    .map(|pct| pct.min(100) as u8);

                // Throttle IPC progress events to avoid saturating the WebView on large installers.
                let should_emit = if let Ok(mut guard) = last_emit_for_cb.lock() {
                    let pct_changed = percent.is_some() && percent != guard.0;
                    let interval_elapsed =
                        guard.1.elapsed() >= std::time::Duration::from_millis(100);
                    if pct_changed || interval_elapsed {
                        guard.0 = percent;
                        guard.1 = std::time::Instant::now();
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };

                if should_emit {
                    let payload = UpdateProgressEvent {
                        downloaded_bytes: total_so_far,
                        total_bytes: content_length,
                        percent,
                    };
                    let _ = app_for_progress.emit("app://update-progress", &payload);
                }
            },
            move || {
                let final_bytes = downloaded.load(std::sync::atomic::Ordering::Relaxed);
                let _ = app_for_done.emit(
                    "app://update-progress",
                    &UpdateProgressEvent {
                        downloaded_bytes: final_bytes,
                        total_bytes: Some(final_bytes),
                        percent: Some(100),
                    },
                );
            },
        )
        .await
        .map_err(|err| UserFacingError {
            code: "updater_install_failed".into(),
            title: "Update installation failed".into(),
            message: "The signed update couldn't be installed right now.".into(),
            recovery_hint: Some(
                "Try again or download the latest installer from GitHub Releases.".into(),
            ),
            technical_details: Some(err.to_string()),
        })?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_windows_reserved_and_trailing_dot_names() {
        assert_eq!(
            sanitize_native_open_filename("CON.txt").unwrap(),
            "_CON.txt"
        );
        assert_eq!(sanitize_native_open_filename("nul").unwrap(), "_nul");
        assert_eq!(
            sanitize_native_open_filename("report.pdf. ").unwrap(),
            "report.pdf"
        );
        assert_eq!(
            sanitize_native_open_filename("a:b*c?.png").unwrap(),
            "a_b_c_.png"
        );
        assert!(sanitize_native_open_filename("...").is_err());
        assert!(sanitize_native_open_filename("   ").is_err());
    }

    #[test]
    fn detects_executable_and_script_extensions() {
        assert!(is_dangerous_executable_name("installer.exe"));
        assert!(is_dangerous_executable_name("script.PS1"));
        assert!(is_dangerous_executable_name("run.command"));
        assert!(!is_dangerous_executable_name("bracket.sldprt"));
        assert!(!is_dangerous_executable_name("drawing.pdf"));
    }

    #[test]
    fn updater_endpoints_enforce_https_and_support_fallbacks() {
        let default_urls = parse_updater_endpoints(None).unwrap();
        assert_eq!(default_urls.len(), 1);
        assert_eq!(default_urls[0].scheme(), "https");

        let multi = parse_updater_endpoints(Some(
            "https://github.com/a/b/latest.json, https://mirror.example.com/latest.json",
        ))
        .unwrap();
        assert_eq!(multi.len(), 2);

        assert!(parse_updater_endpoints(Some("http://insecure.example.com/latest.json")).is_err());
        assert!(parse_updater_endpoints(Some("file:///tmp/latest.json")).is_err());
    }

    #[test]
    fn skip_version_logic_suppresses_matching_and_offers_newer() {
        assert!(should_offer_update("0.2.0", None));
        assert!(!should_offer_update("0.2.0", Some("0.2.0")));
        assert!(!should_offer_update("v0.2.0", Some("0.2.0")));
        assert!(should_offer_update("0.2.1", Some("0.2.0")));
    }

    #[test]
    fn pre_restart_safety_gate_flags_drafts_and_active_workflows() {
        let clean = evaluate_pre_restart_safety(0, 0);
        assert!(clean.safe_to_restart);
        assert!(clean.warnings.is_empty());

        let dirty = evaluate_pre_restart_safety(2, 1);
        assert!(!dirty.safe_to_restart);
        assert_eq!(dirty.warnings.len(), 2);
    }

    #[test]
    fn parses_expected_latest_json_manifest_shape() {
        let sample = r#"{
            "version": "0.2.0",
            "notes": "Bug fixes and improvements",
            "pub_date": "2026-11-26T10:00:00Z",
            "platforms": {
                "windows-x86_64": {
                    "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
                    "url": "https://github.com/foerderacer/fr_universal_app/releases/download/v0.2.0/FR.Universal.App_0.2.0_x64-setup.exe"
                },
                "darwin-aarch64": {
                    "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
                    "url": "https://github.com/foerderacer/fr_universal_app/releases/download/v0.2.0/FR.Universal.App_universal.app.tar.gz"
                }
            }
        }"#;
        let parsed: serde_json::Value = serde_json::from_str(sample).unwrap();
        assert_eq!(parsed["version"].as_str(), Some("0.2.0"));
        assert!(
            parsed["platforms"]["windows-x86_64"]["url"]
                .as_str()
                .unwrap()
                .ends_with("-setup.exe")
        );
        assert!(parsed["platforms"]["darwin-aarch64"]["signature"].is_string());
    }
}
