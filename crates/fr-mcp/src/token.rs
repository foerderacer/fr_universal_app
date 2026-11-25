use std::collections::HashMap;
use std::sync::Mutex;

use fr_core::{FrError, Result};
use uuid::Uuid;

const KEYRING_SERVICE: &str = "de.foerderacer.fr-universal-app.mcp";
pub const LOCAL_SERVER_TOKEN_KEY: &str = "local-mcp-server-bearer";

/// Generates a cryptographically random Bearer token (two UUID v4 values = 244 random bits,
/// encoded as 64 lowercase hex characters).
pub fn generate_bearer_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Abstract OS-keychain token store for both the built-in MCP Server Bearer token and external
/// MCP server credentials. Never persists secrets to plaintext files.
pub trait McpTokenStore: Send + Sync {
    fn get_token(&self, key: &str) -> Result<Option<String>>;
    fn set_token(&self, key: &str, token: &str) -> Result<()>;
    fn delete_token(&self, key: &str) -> Result<()>;

    fn has_token(&self, key: &str) -> bool {
        self.get_token(key)
            .ok()
            .flatten()
            .is_some_and(|v| !v.is_empty())
    }

    fn get_or_create_server_token(&self) -> Result<String> {
        if let Some(existing) = self.get_token(LOCAL_SERVER_TOKEN_KEY)?
            && !existing.trim().is_empty()
        {
            return Ok(existing);
        }
        let fresh = generate_bearer_token();
        self.set_token(LOCAL_SERVER_TOKEN_KEY, &fresh)?;
        Ok(fresh)
    }

    fn rotate_server_token(&self) -> Result<String> {
        let fresh = generate_bearer_token();
        self.set_token(LOCAL_SERVER_TOKEN_KEY, &fresh)?;
        Ok(fresh)
    }
}

pub fn external_server_token_key(server_id: &str) -> String {
    format!("ext-mcp:{server_id}")
}

/// Production token store backed by Windows Credential Manager / macOS Keychain via `keyring`.
#[derive(Debug, Default)]
pub struct KeyringMcpTokenStore;

impl KeyringMcpTokenStore {
    pub fn new() -> Self {
        Self
    }
}

impl McpTokenStore for KeyringMcpTokenStore {
    fn get_token(&self, key: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|err| FrError::Other(format!("keychain entry error: {err}")))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(FrError::Other(format!(
                "failed to read MCP token from OS keychain: {err}"
            ))),
        }
    }

    fn set_token(&self, key: &str, token: &str) -> Result<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|err| FrError::Other(format!("keychain entry error: {err}")))?;
        entry.set_password(token).map_err(|err| {
            FrError::Other(format!("failed to store MCP token in OS keychain: {err}"))
        })
    }

    fn delete_token(&self, key: &str) -> Result<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|err| FrError::Other(format!("keychain entry error: {err}")))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(FrError::Other(format!(
                "failed to delete MCP token from OS keychain: {err}"
            ))),
        }
    }
}

/// In-memory token store for deterministic unit/integration tests without touching the OS keychain.
#[derive(Default)]
pub struct MemoryMcpTokenStore {
    entries: Mutex<HashMap<String, String>>,
}

impl std::fmt::Debug for MemoryMcpTokenStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryMcpTokenStore")
            .field("entries", &"[REDACTED]")
            .finish()
    }
}

impl MemoryMcpTokenStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl McpTokenStore for MemoryMcpTokenStore {
    fn get_token(&self, key: &str) -> Result<Option<String>> {
        let guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(guard.get(key).cloned())
    }

    fn set_token(&self, key: &str, token: &str) -> Result<()> {
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(key.to_owned(), token.to_owned());
        Ok(())
    }

    fn delete_token(&self, key: &str) -> Result<()> {
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.remove(key);
        Ok(())
    }
}
