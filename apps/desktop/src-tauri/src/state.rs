use std::sync::Mutex;

use fr_core::{
    AppConfig, ConfigStore, EventBus, FrModule, ModuleCapability, ModuleDescriptor, ModuleRegistry,
    ModuleStatus, UserFacingError,
};
use fr_mcp::McpServerConfig;
use fr_mod_files::FilesModule;
use fr_nextcloud::NextcloudConnectionStatus;

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

        let mut modules = ModuleRegistry::new();
        modules.register(FilesModule);
        modules.register(FinancePlaceholderModule);
        modules.register(AutomationPlaceholderModule);

        Self {
            config_store,
            config: Mutex::new(config),
            startup_error: Mutex::new(startup_error),
            modules,
            events: EventBus::default(),
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

    pub fn connection_status(&self) -> NextcloudConnectionStatus {
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
