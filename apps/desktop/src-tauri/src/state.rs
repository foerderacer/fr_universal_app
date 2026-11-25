use std::sync::{Arc, Mutex, RwLock};

use fr_core::{
    AppConfig, ConfigStore, EventBus, FrModule, ModuleCapability, ModuleDescriptor, ModuleRegistry,
    ModuleStatus, UserFacingError,
};
use fr_mcp::McpServerConfig;
use fr_mod_files::FilesModule;
use fr_nextcloud::{
    CredentialStore, KeyringCredentialStore, LoginFlowSession, NextcloudBackend,
    NextcloudConnectionStatus, NextcloudCredentials, UserAccountInfo, build_http_client,
};
use fr_preview::MediaProxyServer;
use fr_storage::{CacheStore, CachedStorage, StorageBackend};

/// Placeholder descriptors for upcoming modules shown transparently in the Workspace Shell.
struct FinancePlaceholderModule;
impl FrModule for FinancePlaceholderModule {
    fn descriptor(&self) -> ModuleDescriptor {
        ModuleDescriptor {
            id: "finance".into(),
            name: "Finance".into(),
            description: "Track budgets, invoices, and team expenses synced with Nextcloud.".into(),
            icon: "wallet".into(),
            version: "0.1.0".into(),
            status: ModuleStatus::Planned,
            capabilities: vec![ModuleCapability::Storage, ModuleCapability::McpServerTools],
        }
    }
}

struct AutomationPlaceholderModule;
impl FrModule for AutomationPlaceholderModule {
    fn descriptor(&self) -> ModuleDescriptor {
        ModuleDescriptor {
            id: "automation".into(),
            name: "Automations".into(),
            description: "Run team workflows across Nextcloud folders and connected MCP tools."
                .into(),
            icon: "workflow".into(),
            version: "0.1.0".into(),
            status: ModuleStatus::Planned,
            capabilities: vec![
                ModuleCapability::Storage,
                ModuleCapability::Workflows,
                ModuleCapability::McpClient,
            ],
        }
    }
}

/// Shared application state managed by Tauri.
pub struct AppState {
    pub config_store: ConfigStore,
    pub config: Mutex<AppConfig>,
    pub startup_error: Mutex<Option<UserFacingError>>,
    pub credential_store: Arc<dyn CredentialStore>,
    pub http_client: reqwest::Client,
    pub cache: Option<CacheStore>,
    pub active_credentials: Mutex<Option<NextcloudCredentials>>,
    /// Shared storage backend slot read by both IPC commands and the local `MediaProxyServer`.
    pub storage: Arc<RwLock<Option<Arc<dyn StorageBackend>>>>,
    pub media_proxy: Mutex<Option<Arc<MediaProxyServer>>>,
    pub active_login: Mutex<Option<LoginFlowSession>>,
    pub account_info: Mutex<Option<UserAccountInfo>>,
    pub modules: ModuleRegistry,
    pub events: EventBus,
}

impl AppState {
    pub fn initialize() -> Self {
        let mut startup_error = None;
        let config_store = match ConfigStore::default_location() {
            Ok(store) => store,
            Err(err) => {
                startup_error = Some(UserFacingError {
                    code: "config_location_error".into(),
                    title: "Couldn't open your settings folder".into(),
                    message: "Default settings are active temporarily. Saving settings will use a local fallback.".into(),
                    recovery_hint: Some("Review and save your settings to recreate the config file.".into()),
                    technical_details: Some(err.to_string()),
                });
                ConfigStore::from_path("config.json")
            }
        };

        let config = match config_store.load() {
            Ok(cfg) => cfg,
            Err(err) => {
                startup_error = Some(UserFacingError {
                    code: "config_load_error".into(),
                    title: "Your saved settings couldn't be read".into(),
                    message: "We loaded safe defaults so the app could start, without overwriting your existing config file.".into(),
                    recovery_hint: Some("Open Settings and click Save Settings to replace the corrupted file, or inspect the file on disk.".into()),
                    technical_details: Some(format!(
                        "{} (path: {})",
                        err,
                        config_store.path().display()
                    )),
                });
                AppConfig::default()
            }
        };

        let cache = ConfigStore::default_cache_dir()
            .and_then(|dir| CacheStore::open(dir, config.cache_limit_mb))
            .ok();

        let http_client =
            build_http_client().expect("failed to build hardened Nextcloud HTTP client");
        let credential_store: Arc<dyn CredentialStore> = Arc::new(KeyringCredentialStore::new());

        let mut modules = ModuleRegistry::new();
        modules.register(FilesModule);
        modules.register(FinancePlaceholderModule);
        modules.register(AutomationPlaceholderModule);

        let state = Self {
            config_store,
            config: Mutex::new(config.clone()),
            startup_error: Mutex::new(startup_error),
            credential_store,
            http_client,
            cache,
            active_credentials: Mutex::new(None),
            storage: Arc::new(RwLock::new(None)),
            media_proxy: Mutex::new(None),
            active_login: Mutex::new(None),
            account_info: Mutex::new(None),
            modules,
            events: EventBus::default(),
        };

        // Silently restore previous Nextcloud session from OS Keychain if present.
        if !config.nextcloud_url.trim().is_empty()
            && let Some(ref login_name) = config.nextcloud_login_name
            && let Ok(Some(creds)) = state
                .credential_store
                .load(&config.nextcloud_url, login_name)
        {
            let _ = state.activate_session(creds);
        }

        state
    }

    pub fn set_media_proxy(&self, proxy: Arc<MediaProxyServer>) {
        if let Ok(mut guard) = self.media_proxy.lock() {
            *guard = Some(proxy);
        }
    }

    pub fn current_media_proxy(&self) -> Option<Arc<MediaProxyServer>> {
        self.media_proxy.lock().ok().and_then(|guard| guard.clone())
    }

    pub fn current_storage(&self) -> Option<Arc<dyn StorageBackend>> {
        self.storage.read().ok().and_then(|guard| guard.clone())
    }

    pub fn activate_session(&self, creds: NextcloudCredentials) -> fr_core::Result<()> {
        let nc = NextcloudBackend::with_client(self.http_client.clone(), creds.clone())?;
        let backend: Arc<dyn StorageBackend> = match &self.cache {
            Some(cache) => Arc::new(CachedStorage::new(Arc::new(nc), cache.clone())),
            None => Arc::new(nc),
        };

        if let Ok(mut guard) = self.storage.write() {
            *guard = Some(backend);
        }
        if let Ok(mut guard) = self.active_credentials.lock() {
            *guard = Some(creds);
        }
        Ok(())
    }

    pub fn clear_active_session(&self, wipe_cache: bool) {
        if let Ok(mut guard) = self.storage.write() {
            *guard = None;
        }
        if let Ok(mut guard) = self.active_credentials.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = self.active_login.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = self.account_info.lock() {
            *guard = None;
        }
        if wipe_cache && let Some(ref cache) = self.cache {
            let _ = cache.clear_cached_data();
        }
    }

    pub fn current_config(&self) -> AppConfig {
        self.config
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn current_startup_error(&self) -> Option<UserFacingError> {
        self.startup_error
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub fn clear_startup_error(&self) {
        if let Ok(mut guard) = self.startup_error.lock() {
            *guard = None;
        }
    }

    pub fn current_account_info(&self) -> Option<UserAccountInfo> {
        self.account_info
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub fn login_pending_url(&self) -> Option<String> {
        self.active_login
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|s| s.login_url.clone()))
    }

    pub fn connection_status(&self) -> NextcloudConnectionStatus {
        if let Ok(guard) = self.active_credentials.lock()
            && let Some(ref creds) = *guard
        {
            return NextcloudConnectionStatus::Connected {
                server_url: creds.server_url.clone(),
                login_name: creds.login_name.clone(),
            };
        }

        let cfg = self.current_config();
        if cfg.nextcloud_url.trim().is_empty() {
            NextcloudConnectionStatus::NotConfigured
        } else {
            NextcloudConnectionStatus::SignedOut {
                server_url: cfg.nextcloud_url,
            }
        }
    }

    pub fn mcp_server_config(&self) -> McpServerConfig {
        let cfg = self.current_config();
        McpServerConfig {
            enabled: cfg.mcp_server_enabled,
            ..McpServerConfig::default()
        }
    }
}
