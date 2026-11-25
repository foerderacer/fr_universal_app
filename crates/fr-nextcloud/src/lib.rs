//! Nextcloud integration layer (Login Flow v2, WebDAV, OCS API).
//!
//! Phase 0 establishes URL normalization, authentication session models, and endpoint helpers.
//! Phase 1 implements live Login Flow v2, OS keychain persistence, and `NextcloudBackend`.

use fr_core::{FrError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use url::Url;

/// Connection state displayed in the desktop shell status bar and Settings view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NextcloudConnectionStatus {
    NotConfigured,
    SignedOut {
        server_url: String,
    },
    Connected {
        server_url: String,
        login_name: String,
    },
}

/// Normalizes and validates a user-entered Nextcloud server URL.
///
/// - Trims whitespace and trailing slashes.
/// - Prepends `https://` when no scheme is supplied (helpful for non-technical users).
/// - Accepts only `https://` and `http://` schemes.
/// - Rejects embedded credentials (`user:pass@`), query strings (`?...`), and fragments (`#...`)
///   so plaintext secrets are never persisted in `config.json` and endpoints stay well-formed.
pub fn normalize_server_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };

    let parsed = Url::parse(&candidate)
        .map_err(|err| FrError::InvalidConfig(format!("invalid Nextcloud URL '{raw}': {err}")))?;

    match parsed.scheme() {
        "https" | "http" => {}
        scheme => {
            return Err(FrError::InvalidConfig(format!(
                "unsupported URL scheme '{scheme}': use https://"
            )));
        }
    }

    if parsed.host_str().is_none() {
        return Err(FrError::InvalidConfig(
            "Nextcloud URL must include a host name".into(),
        ));
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(FrError::InvalidConfig(
            "Nextcloud URL must not include a username or password".into(),
        ));
    }

    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(FrError::InvalidConfig(
            "Nextcloud URL must not include query parameters or fragments".into(),
        ));
    }

    Ok(parsed.as_str().trim_end_matches('/').to_owned())
}

/// Builds the Login Flow v2 initiation endpoint for a normalized server URL.
pub fn login_flow_v2_endpoint(server_url: &str) -> Result<String> {
    let base = normalize_server_url(server_url)?;
    if base.is_empty() {
        return Err(FrError::InvalidConfig(
            "Nextcloud server URL is not configured".into(),
        ));
    }
    Ok(format!("{base}/index.php/login/v2"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_bare_host_and_trailing_slash() {
        assert_eq!(
            normalize_server_url("cloud.example.com/").unwrap(),
            "https://cloud.example.com"
        );
        assert_eq!(
            normalize_server_url("  https://cloud.example.com/nextcloud/  ").unwrap(),
            "https://cloud.example.com/nextcloud"
        );
        assert_eq!(normalize_server_url("   ").unwrap(), "");
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(normalize_server_url("file:///etc/passwd").is_err());
        assert!(normalize_server_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn rejects_embedded_credentials_queries_and_fragments() {
        assert!(normalize_server_url("https://alice:secret@cloud.example.com").is_err());
        assert!(normalize_server_url("https://alice@cloud.example.com").is_err());
        assert!(normalize_server_url("https://cloud.example.com?token=123").is_err());
        assert!(normalize_server_url("https://cloud.example.com#section").is_err());
    }

    #[test]
    fn builds_login_flow_endpoint() {
        assert_eq!(
            login_flow_v2_endpoint("cloud.example.com").unwrap(),
            "https://cloud.example.com/index.php/login/v2"
        );
    }
}
