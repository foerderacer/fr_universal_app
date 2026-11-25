use std::sync::RwLock;

use fr_core::{
    AppConfig, ConfigStore, EventBus, FrModule, ModuleCapability, ModuleDescriptor, ModuleRegistry,
    ModuleStatus,
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
    pub config: RwLock<AppConfig>,
    pub modules: ModuleRegistry,
    pub events: EventBus,
}

impl AppState {
    pub fn initialize() -> Self {
        let config_store = ConfigStore::default_location()
            .unwrap_or_else(|_| ConfigStore::from_path("config.json"));
        let config = config_store.load().unwrap_or_default();

        let mut modules = ModuleRegistry::new();
        modules.register(FilesModule);
        modules.register(FinancePlaceholderModule);
        modules.register(AutomationPlaceholderModule);

        Self {
            config_store,
            config: RwLock::new(config),
            modules,
            events: EventBus::default(),
        }
    }

    pub fn current_config(&self) -> AppConfig {
        self.config
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
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
