use std::sync::{Arc, Mutex, RwLock};

use fr_core::{AppConfig, ConfigStore, EventBus, ModuleRegistry, UserFacingError};
use fr_mcp::{
    KeyringMcpTokenStore, LocalMcpServer, McpAuditLog, McpClientManager, McpModule,
    McpServerConfig, McpServerStatus, McpTokenStore, McpToolRegistry, WriteApprovalGate,
    register_files_tools,
};
use fr_mod_automation::{AutomationModule, register_automation_tools};
use fr_mod_files::FilesModule;
use fr_mod_finance::{FinanceLedger, FinanceModule, register_finance_tools};
use fr_mod_talk::{TalkModule, register_talk_tools};
use fr_nextcloud::{
    CredentialStore, KeyringCredentialStore, LoginFlowSession, NextcloudBackend,
    NextcloudConnectionStatus, NextcloudCredentials, UserAccountInfo, build_http_client,
};
use fr_preview::MediaProxyServer;
use fr_storage::{CacheStore, CachedStorage, StorageBackend};
use fr_talk::{TalkCacheStore, TalkCapabilities, TalkClient};
use fr_workflows::{WorkflowRunner, WorkflowStore};

/// Shared application state managed by Tauri.
pub struct AppState {
    pub config_store: ConfigStore,
    pub config: Mutex<AppConfig>,
    pub startup_error: Mutex<Option<UserFacingError>>,
    pub credential_store: Arc<dyn CredentialStore>,
    pub http_client: reqwest::Client,
    pub cache: Option<CacheStore>,
    pub active_credentials: Arc<Mutex<Option<NextcloudCredentials>>>,
    /// Shared storage backend slot read by IPC commands, `MediaProxyServer`, MCP, and Workflows.
    pub storage: Arc<RwLock<Option<Arc<dyn StorageBackend>>>>,
    pub media_proxy: Mutex<Option<Arc<MediaProxyServer>>>,
    pub active_login: Mutex<Option<LoginFlowSession>>,
    pub account_info: Mutex<Option<UserAccountInfo>>,
    pub mcp_token_store: Arc<dyn McpTokenStore>,
    pub mcp_registry: Arc<McpToolRegistry>,
    pub mcp_audit: Arc<McpAuditLog>,
    pub mcp_approvals: Arc<WriteApprovalGate>,
    pub mcp_server: tokio::sync::Mutex<Option<LocalMcpServer>>,
    pub mcp_client: Arc<McpClientManager>,
    pub workflow_runner: Arc<WorkflowRunner>,
    pub finance_ledger: Arc<FinanceLedger>,
    pub talk_cache: Arc<TalkCacheStore>,
    pub talk_capabilities: Mutex<Option<TalkCapabilities>>,
    pub talk_poll_handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
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
        modules.register(TalkModule);
        modules.register(FinanceModule);
        modules.register(AutomationModule);
        modules.register(McpModule);

        let events = EventBus::default();
        let active_credentials = Arc::new(Mutex::new(None::<NextcloudCredentials>));
        let storage: Arc<RwLock<Option<Arc<dyn StorageBackend>>>> = Arc::new(RwLock::new(None));
        let mcp_token_store: Arc<dyn McpTokenStore> = Arc::new(KeyringMcpTokenStore::new());
        let mcp_registry = Arc::new(McpToolRegistry::new());
        register_files_tools(&mcp_registry, storage.clone());
        let mcp_audit = Arc::new(McpAuditLog::new());
        let mcp_approvals = Arc::new(WriteApprovalGate::new());

        let mcp_store_path = McpClientManager::default_store_path()
            .unwrap_or_else(|_| std::path::PathBuf::from("mcp-servers.json"));
        let mcp_client = match McpClientManager::open(
            &mcp_store_path,
            mcp_token_store.clone(),
            http_client.clone(),
        ) {
            Ok(client) => Arc::new(client),
            Err(err) => {
                if startup_error.is_none() {
                    startup_error = Some(UserFacingError {
                        code: "mcp_registry_load_error".into(),
                        title: "External MCP server list couldn't be read".into(),
                        message: "We started with a temporary empty MCP server list without overwriting your existing file.".into(),
                        recovery_hint: Some("Check or repair mcp-servers.json, or re-add servers in MCP / AI.".into()),
                        technical_details: Some(format!("{err} (path: {})", mcp_store_path.display())),
                    });
                }
                Arc::new(
                    McpClientManager::open(
                        std::env::temp_dir().join("fr-universal-app-mcp-servers-fallback.json"),
                        mcp_token_store.clone(),
                        http_client.clone(),
                    )
                    .expect("fallback MCP registry"),
                )
            }
        };

        let workflow_db = WorkflowStore::default_db_path()
            .unwrap_or_else(|_| std::env::temp_dir().join("fr-universal-app-workflows.sqlite"));
        let workflow_store = match WorkflowStore::open(&workflow_db) {
            Ok(store) => store,
            Err(err) => {
                tracing::warn!("Falling back to temp workflow store: {err}");
                if startup_error.is_none() {
                    startup_error = Some(UserFacingError {
                        code: "workflow_db_load_error".into(),
                        title: "Workflow database couldn't be opened".into(),
                        message: "We started with a temporary workflow store without overwriting your existing database file.".into(),
                        recovery_hint: Some("Check permissions or disk space in your app data folder, then restart FR Universal App.".into()),
                        technical_details: Some(format!("{err} (path: {})", workflow_db.display())),
                    });
                }
                WorkflowStore::open(
                    std::env::temp_dir().join("fr-universal-app-workflows-fallback.sqlite"),
                )
                .expect("fallback workflow store")
            }
        };
        let workflow_runner = Arc::new(WorkflowRunner::new(
            workflow_store,
            mcp_client.clone(),
            events.clone(),
        ));
        register_automation_tools(&mcp_registry, workflow_runner.clone(), storage.clone());

        let finance_db = FinanceLedger::default_db_path()
            .unwrap_or_else(|_| std::env::temp_dir().join("fr-universal-app-finance.sqlite"));
        let finance_ledger = Arc::new(match FinanceLedger::open(&finance_db) {
            Ok(ledger) => ledger,
            Err(err) => {
                tracing::warn!("Falling back to temp finance ledger: {err}");
                if startup_error.is_none() {
                    startup_error = Some(UserFacingError {
                        code: "finance_db_load_error".into(),
                        title: "Finance ledger couldn't be opened".into(),
                        message: "We started with a temporary Finance ledger without overwriting your existing database file.".into(),
                        recovery_hint: Some("Check permissions or disk space in your app data folder, then restart FR Universal App.".into()),
                        technical_details: Some(format!("{err} (path: {})", finance_db.display())),
                    });
                }
                FinanceLedger::open(
                    std::env::temp_dir().join("fr-universal-app-finance-fallback.sqlite"),
                )
                .expect("fallback finance ledger")
            }
        });
        let creds_for_finance = active_credentials.clone();
        register_finance_tools(
            &mcp_registry,
            finance_ledger.clone(),
            Arc::new(move || {
                creds_for_finance.lock().ok().and_then(|g| {
                    g.as_ref()
                        .map(|c| format!("{}|{}", c.server_url, c.login_name))
                })
            }),
        );

        let talk_db = TalkCacheStore::default_db_path()
            .unwrap_or_else(|_| std::env::temp_dir().join("fr-universal-app-talk.sqlite"));
        let talk_cache = Arc::new(match TalkCacheStore::open(&talk_db) {
            Ok(store) => store,
            Err(err) => {
                tracing::warn!("Falling back to temp Talk cache: {err}");
                if startup_error.is_none() {
                    startup_error = Some(UserFacingError {
                        code: "talk_db_load_error".into(),
                        title: "Talk chat cache couldn't be opened".into(),
                        message: "We started with a temporary chat cache without overwriting your existing database file.".into(),
                        recovery_hint: Some("Check permissions or disk space in your app data folder, then restart FR Universal App.".into()),
                        technical_details: Some(format!("{err} (path: {})", talk_db.display())),
                    });
                }
                TalkCacheStore::open(
                    std::env::temp_dir().join("fr-universal-app-talk-fallback.sqlite"),
                )
                .expect("fallback Talk cache")
            }
        });
        let creds_for_talk = active_credentials.clone();
        register_talk_tools(
            &mcp_registry,
            http_client.clone(),
            Arc::new(move || creds_for_talk.lock().ok().and_then(|g| g.clone())),
        );

        let state = Self {
            config_store,
            config: Mutex::new(config.clone()),
            startup_error: Mutex::new(startup_error),
            credential_store,
            http_client,
            cache,
            active_credentials,
            storage,
            media_proxy: Mutex::new(None),
            active_login: Mutex::new(None),
            account_info: Mutex::new(None),
            mcp_token_store,
            mcp_registry,
            mcp_audit,
            mcp_approvals,
            mcp_server: tokio::sync::Mutex::new(None),
            mcp_client,
            workflow_runner,
            finance_ledger,
            talk_cache,
            talk_capabilities: Mutex::new(None),
            talk_poll_handle: Mutex::new(None),
            modules,
            events,
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

    pub fn active_account_scope(&self) -> String {
        if let Ok(guard) = self.active_credentials.lock()
            && let Some(ref creds) = *guard
        {
            return format!("{}|{}", creds.server_url, creds.login_name);
        }
        let cfg = self.current_config();
        format!(
            "{}|{}",
            cfg.nextcloud_url,
            cfg.nextcloud_login_name.unwrap_or_default()
        )
    }

    pub fn require_active_account_scope(&self) -> fr_core::Result<String> {
        if let Ok(guard) = self.active_credentials.lock()
            && let Some(ref creds) = *guard
        {
            return Ok(format!("{}|{}", creds.server_url, creds.login_name));
        }
        Err(fr_core::FrError::AuthRequired(
            "Please sign in to Nextcloud to continue.".into(),
        ))
    }

    pub fn talk_client(&self) -> fr_core::Result<TalkClient> {
        let creds = self
            .active_credentials
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .ok_or_else(|| {
                fr_core::FrError::AuthRequired("Please sign in to Nextcloud to use Talk.".into())
            })?;
        Ok(TalkClient::new(self.http_client.clone(), creds))
    }

    pub fn stop_talk_polling(&self) {
        if let Ok(mut guard) = self.talk_poll_handle.lock()
            && let Some(handle) = guard.take()
        {
            handle.abort();
        }
    }

    pub fn activate_session(&self, creds: NextcloudCredentials) -> fr_core::Result<()> {
        let prev_account_scope = self.active_credentials.lock().ok().and_then(|guard| {
            guard.as_ref().and_then(|prev| {
                if prev.server_url != creds.server_url || prev.login_name != creds.login_name {
                    Some(format!(
                        "{}|{}",
                        prev.server_url.trim_end_matches('/'),
                        prev.login_name
                    ))
                } else {
                    None
                }
            })
        });
        if let Some(prev_scope) = prev_account_scope {
            self.stop_talk_polling();
            if let Ok(mut guard) = self.talk_capabilities.lock() {
                *guard = None;
            }
            let _ = self.talk_cache.clear_account_cache(&prev_scope);
            if let Some(ref cache) = self.cache {
                let _ = cache.clear_cached_data();
            }
        }

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
        self.stop_talk_polling();
        if let Ok(mut guard) = self.talk_capabilities.lock() {
            *guard = None;
        }
        let prev_scope = self.active_credentials.lock().ok().and_then(|g| {
            g.as_ref()
                .map(|c| format!("{}|{}", c.server_url, c.login_name))
        });
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
        if wipe_cache {
            if let Some(ref cache) = self.cache {
                let _ = cache.clear_cached_data();
            }
            if let Some(scope) = prev_scope {
                let _ = self.talk_cache.clear_account_cache(&scope);
            }
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
            port: cfg.mcp_server_port,
            require_write_approval: cfg.mcp_require_write_approval,
            ..McpServerConfig::default()
        }
    }

    pub async fn mcp_server_status(&self) -> McpServerStatus {
        let cfg = self.mcp_server_config();
        let guard = self.mcp_server.lock().await;
        let endpoint_url = guard.as_ref().map(LocalMcpServer::endpoint_url);
        McpServerStatus {
            running: guard.is_some(),
            endpoint_url,
            config: cfg,
            exposed_tools: self.mcp_registry.list_info(),
            pending_approvals: self.mcp_approvals.pending_count(),
        }
    }

    /// Reconciles the running [`LocalMcpServer`] with the persisted [`AppConfig`].
    pub async fn sync_mcp_server_runtime(
        &self,
        force_restart: bool,
    ) -> fr_core::Result<McpServerStatus> {
        let cfg = self.mcp_server_config();
        let mut guard = self.mcp_server.lock().await;

        if !cfg.enabled {
            if let Some(running) = guard.take() {
                self.mcp_approvals.deny_all();
                running.stop();
            }
            return Ok(McpServerStatus {
                running: false,
                endpoint_url: None,
                config: cfg,
                exposed_tools: self.mcp_registry.list_info(),
                pending_approvals: self.mcp_approvals.pending_count(),
            });
        }

        let needs_restart = force_restart
            || match guard.as_ref() {
                None => true,
                Some(running) => running.addr().port() != cfg.port,
            };

        if needs_restart {
            if let Some(old) = guard.take() {
                self.mcp_approvals.deny_all();
                old.stop();
            }
            let token = self.mcp_token_store.get_or_create_server_token()?;
            let started = LocalMcpServer::start(
                &cfg,
                token,
                self.mcp_registry.clone(),
                self.storage.clone(),
                self.mcp_audit.clone(),
                self.mcp_approvals.clone(),
            )
            .await?;
            *guard = Some(started);
        } else if let Some(running) = guard.as_ref() {
            running.set_require_write_approval(cfg.require_write_approval);
        }

        let endpoint_url = guard.as_ref().map(LocalMcpServer::endpoint_url);
        Ok(McpServerStatus {
            running: guard.is_some(),
            endpoint_url,
            config: cfg,
            exposed_tools: self.mcp_registry.list_info(),
            pending_approvals: self.mcp_approvals.pending_count(),
        })
    }
}
