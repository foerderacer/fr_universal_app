use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use specta::Type;
use tempfile::NamedTempFile;

use crate::error::{FrError, Result};

/// Returns the optional build-time default Nextcloud server URL injected via
/// `FR_DEFAULT_NEXTCLOUD_URL` (for organization builds), or an empty string if unset.
pub fn default_nextcloud_url() -> String {
    option_env!("FR_DEFAULT_NEXTCLOUD_URL")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_default()
}

/// Persisted application configuration (never contains secrets or passwords).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// Base URL of the user's Nextcloud instance (e.g. `https://cloud.example.com`).
    pub nextcloud_url: String,
    /// Active Nextcloud username (app password is stored exclusively in the OS keychain).
    #[serde(default)]
    pub nextcloud_login_name: Option<String>,
    /// Pinned favorite folders shown in the Files sidebar (Nextcloud paths like `/Team`).
    #[serde(default)]
    pub pinned_folders: Vec<String>,
    /// Maximum local file cache size in megabytes.
    #[serde(default = "default_cache_limit_mb")]
    pub cache_limit_mb: u32,
    /// Whether the built-in local MCP Server is enabled (always defaults to `false`).
    #[serde(default)]
    pub mcp_server_enabled: bool,
    /// Loopback TCP port for the built-in local MCP Server.
    #[serde(default = "default_mcp_server_port")]
    pub mcp_server_port: u16,
    /// Whether mutating MCP Server tool calls require explicit user approval in the UI.
    #[serde(default = "default_mcp_require_write_approval")]
    pub mcp_require_write_approval: bool,
    /// Nextcloud folder scoped for the Finance module (default `"/Finance"`).
    #[serde(default = "default_finance_folder")]
    pub finance_folder: String,
    /// Optional app version string that the user chose to skip in update prompts.
    #[serde(default)]
    pub skipped_update_version: Option<String>,
    /// RFC 3339 timestamp of the last completed update check.
    #[serde(default)]
    pub last_update_check_at: Option<String>,
    /// Preferred UI color theme (`"system"`, `"light"`, or `"dark"`).
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_cache_limit_mb() -> u32 {
    2048
}

fn default_mcp_server_port() -> u16 {
    38420
}

fn default_mcp_require_write_approval() -> bool {
    true
}

fn default_finance_folder() -> String {
    "/Finance".to_owned()
}

fn default_theme() -> String {
    "system".to_owned()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            nextcloud_url: default_nextcloud_url(),
            nextcloud_login_name: None,
            pinned_folders: Vec::new(),
            cache_limit_mb: default_cache_limit_mb(),
            mcp_server_enabled: false,
            mcp_server_port: default_mcp_server_port(),
            mcp_require_write_approval: default_mcp_require_write_approval(),
            finance_folder: default_finance_folder(),
            skipped_update_version: None,
            last_update_check_at: None,
            theme: default_theme(),
        }
    }
}

/// Handles reading and writing [`AppConfig`] in the OS-appropriate config directory.
#[derive(Debug, Clone)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    /// Creates a [`ConfigStore`] pointing at a specific file path (useful for tests).
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Resolves the default cross-platform config path (Windows AppData / macOS Application Support).
    pub fn default_location() -> Result<Self> {
        let proj_dirs =
            ProjectDirs::from("de", "foerderacer", "FRUniversalApp").ok_or_else(|| {
                FrError::InvalidConfig("unable to resolve OS config directory".into())
            })?;
        Ok(Self {
            path: proj_dirs.config_dir().join("config.json"),
        })
    }

    /// Resolves the default cross-platform cache directory (Windows LocalAppData / macOS Caches).
    pub fn default_cache_dir() -> Result<PathBuf> {
        let proj_dirs = ProjectDirs::from("de", "foerderacer", "FRUniversalApp")
            .ok_or_else(|| FrError::InvalidConfig("unable to resolve OS cache directory".into()))?;
        Ok(proj_dirs.cache_dir().to_path_buf())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Loads config from disk, returning [`AppConfig::default()`] only when the file does not exist.
    pub fn load(&self) -> Result<AppConfig> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(content) => content,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AppConfig::default());
            }
            Err(err) => return Err(FrError::Io(err)),
        };
        let config: AppConfig = serde_json::from_str(&raw)?;
        Ok(config)
    }

    /// Persists config to disk atomically (write to sibling temp file, fsync, atomic persist).
    pub fn save(&self, config: &AppConfig) -> Result<()> {
        let parent = self
            .path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;

        let json = serde_json::to_string_pretty(config)?;
        let mut tmp = NamedTempFile::new_in(parent)?;
        tmp.write_all(json.as_bytes())?;
        tmp.as_file().sync_all()?;
        tmp.persist(&self.path)
            .map_err(|err| FrError::Io(err.error))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_returns_defaults_when_missing() {
        let dir = tempdir().expect("tempdir");
        let store = ConfigStore::from_path(dir.path().join("config.json"));
        let loaded = store.load().expect("load default");
        assert_eq!(loaded, AppConfig::default());
        assert!(!loaded.mcp_server_enabled);
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempdir().expect("tempdir");
        let store = ConfigStore::from_path(dir.path().join("nested").join("config.json"));
        let config = AppConfig {
            nextcloud_url: "https://cloud.example.com".into(),
            nextcloud_login_name: Some("alice".into()),
            pinned_folders: vec!["/Projects".into(), "/Shared".into()],
            cache_limit_mb: 1024,
            mcp_server_enabled: false,
            mcp_server_port: 38420,
            mcp_require_write_approval: true,
            finance_folder: "/Finance".into(),
            skipped_update_version: Some("0.2.0".into()),
            last_update_check_at: Some("2026-11-26T10:00:00Z".into()),
            theme: "dark".into(),
        };

        store.save(&config).expect("save config");
        let loaded = store.load().expect("load saved config");
        assert_eq!(loaded, config);
    }

    #[test]
    fn load_returns_error_on_corrupt_json() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        fs::write(&path, "{ not valid json").expect("write corrupt config");
        let store = ConfigStore::from_path(&path);
        assert!(store.load().is_err());
    }
}
