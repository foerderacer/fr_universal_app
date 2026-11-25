use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use fr_core::{FrError, Result};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{ensure_same_origin, login_flow_v2_endpoint, normalize_server_url};

const KEYRING_SERVICE: &str = "de.foerderacer.fr-universal-app.nextcloud";

/// Authenticated Nextcloud app-password credentials.
/// Implements a redacted [`fmt::Debug`] so secrets never leak into logs or error reports.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextcloudCredentials {
    pub server_url: String,
    pub login_name: String,
    pub app_password: String,
}

impl fmt::Debug for NextcloudCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NextcloudCredentials")
            .field("server_url", &self.server_url)
            .field("login_name", &self.login_name)
            .field("app_password", &"[REDACTED]")
            .finish()
    }
}

/// Active Login Flow v2 session waiting for the user to approve access in their browser.
#[derive(Clone, PartialEq, Eq)]
pub struct LoginFlowSession {
    pub server_url: String,
    pub login_url: String,
    pub poll_endpoint: String,
    pub poll_token: String,
}

impl fmt::Debug for LoginFlowSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoginFlowSession")
            .field("server_url", &self.server_url)
            .field("login_url", &self.login_url)
            .field("poll_endpoint", &self.poll_endpoint)
            .field("poll_token", &"[REDACTED]")
            .finish()
    }
}

/// Outcome of a single Login Flow v2 poll request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginPollResult {
    Pending,
    Completed(NextcloudCredentials),
}

#[derive(Deserialize)]
struct LoginV2InitResponse {
    poll: LoginV2PollInfo,
    login: String,
}

#[derive(Deserialize)]
struct LoginV2PollInfo {
    token: String,
    endpoint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginV2CredentialsResponse {
    server: String,
    login_name: String,
    app_password: String,
}

/// Initiates Nextcloud Login Flow v2 (`POST <server>/index.php/login/v2`).
///
/// Validates that both the returned browser `login` URL and `poll.endpoint` match the exact
/// origin of `server_url` to prevent SSRF or credential phishing redirects.
pub async fn initiate_login_flow(
    client: &reqwest::Client,
    server_url: &str,
) -> Result<LoginFlowSession> {
    let normalized_server = normalize_server_url(server_url)?;
    let endpoint = login_flow_v2_endpoint(&normalized_server)?;
    let expected_base = Url::parse(&normalized_server)
        .map_err(|err| FrError::InvalidConfig(format!("invalid server URL: {err}")))?;

    let resp = client.post(&endpoint).send().await.map_err(|err| {
        FrError::Network(format!("could not reach Nextcloud login endpoint: {err}"))
    })?;

    if !resp.status().is_success() {
        return Err(FrError::Network(format!(
            "Nextcloud Login Flow v2 initiation returned HTTP {}",
            resp.status().as_u16()
        )));
    }

    let body: LoginV2InitResponse = resp
        .json()
        .await
        .map_err(|err| FrError::Network(format!("invalid Login Flow v2 response: {err}")))?;

    if body.poll.token.trim().is_empty() {
        return Err(FrError::Network(
            "Nextcloud returned an empty Login Flow v2 poll token".into(),
        ));
    }

    let safe_login = ensure_same_origin(&expected_base, &body.login)?;
    let safe_poll = ensure_same_origin(&expected_base, &body.poll.endpoint)?;

    Ok(LoginFlowSession {
        server_url: normalized_server,
        login_url: safe_login.to_string(),
        poll_endpoint: safe_poll.to_string(),
        poll_token: body.poll.token,
    })
}

/// Polls Nextcloud once to see if the user has granted access in the browser.
///
/// - HTTP `404` → [`LoginPollResult::Pending`]
/// - HTTP `200` → [`LoginPollResult::Completed`] (after validating returned server origin)
pub async fn poll_login_flow(
    client: &reqwest::Client,
    session: &LoginFlowSession,
) -> Result<LoginPollResult> {
    let expected_base = Url::parse(&session.server_url)
        .map_err(|err| FrError::InvalidConfig(format!("invalid server URL: {err}")))?;

    let resp = client
        .post(&session.poll_endpoint)
        .form(&[("token", session.poll_token.as_str())])
        .send()
        .await
        .map_err(|err| FrError::Network(format!("Nextcloud login poll failed: {err}")))?;

    if resp.status() == StatusCode::NOT_FOUND {
        return Ok(LoginPollResult::Pending);
    }

    if !resp.status().is_success() {
        return Err(FrError::Network(format!(
            "Nextcloud login poll returned unexpected HTTP {}",
            resp.status().as_u16()
        )));
    }

    let creds: LoginV2CredentialsResponse = resp
        .json()
        .await
        .map_err(|err| FrError::Network(format!("invalid login credentials payload: {err}")))?;

    let normalized_returned = normalize_server_url(&creds.server)?;
    ensure_same_origin(&expected_base, &normalized_returned)?;

    if creds.login_name.trim().is_empty() || creds.app_password.trim().is_empty() {
        return Err(FrError::Network(
            "Nextcloud returned incomplete credentials".into(),
        ));
    }

    Ok(LoginPollResult::Completed(NextcloudCredentials {
        server_url: normalized_returned,
        login_name: creds.login_name,
        app_password: creds.app_password,
    }))
}

/// Persistence contract for Nextcloud app passwords (OS Keychain in production, in-memory in tests).
pub trait CredentialStore: Send + Sync {
    fn save(&self, creds: &NextcloudCredentials) -> Result<()>;
    fn load(&self, server_url: &str, login_name: &str) -> Result<Option<NextcloudCredentials>>;
    fn delete(&self, server_url: &str, login_name: &str) -> Result<()>;
}

fn account_key(server_url: &str, login_name: &str) -> String {
    format!("{login_name}@{server_url}")
}

/// Stores Nextcloud app passwords exclusively in Windows Credential Manager / macOS Keychain.
#[derive(Debug, Default, Clone)]
pub struct KeyringCredentialStore;

impl KeyringCredentialStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(server_url: &str, login_name: &str) -> Result<keyring::Entry> {
        let normalized = normalize_server_url(server_url)?;
        keyring::Entry::new(KEYRING_SERVICE, &account_key(&normalized, login_name))
            .map_err(|err| FrError::Other(format!("failed to access OS credential store: {err}")))
    }
}

impl CredentialStore for KeyringCredentialStore {
    fn save(&self, creds: &NextcloudCredentials) -> Result<()> {
        let entry = Self::entry(&creds.server_url, &creds.login_name)?;
        entry.set_password(&creds.app_password).map_err(|err| {
            FrError::Other(format!("failed to save credential to OS keychain: {err}"))
        })
    }

    fn load(&self, server_url: &str, login_name: &str) -> Result<Option<NextcloudCredentials>> {
        let normalized = normalize_server_url(server_url)?;
        let entry = Self::entry(&normalized, login_name)?;
        match entry.get_password() {
            Ok(app_password) => Ok(Some(NextcloudCredentials {
                server_url: normalized,
                login_name: login_name.to_owned(),
                app_password,
            })),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(FrError::Other(format!(
                "failed to read credential from OS keychain: {err}"
            ))),
        }
    }

    fn delete(&self, server_url: &str, login_name: &str) -> Result<()> {
        let normalized = normalize_server_url(server_url)?;
        let entry = Self::entry(&normalized, login_name)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(FrError::Other(format!(
                "failed to remove credential from OS keychain: {err}"
            ))),
        }
    }
}

/// Deterministic in-memory credential store for unit tests.
#[derive(Debug, Default)]
pub struct InMemoryCredentialStore {
    items: Mutex<HashMap<String, NextcloudCredentials>>,
}

impl CredentialStore for InMemoryCredentialStore {
    fn save(&self, creds: &NextcloudCredentials) -> Result<()> {
        let normalized = normalize_server_url(&creds.server_url)?;
        let key = account_key(&normalized, &creds.login_name);
        let mut map = self
            .items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.insert(
            key,
            NextcloudCredentials {
                server_url: normalized,
                login_name: creds.login_name.clone(),
                app_password: creds.app_password.clone(),
            },
        );
        Ok(())
    }

    fn load(&self, server_url: &str, login_name: &str) -> Result<Option<NextcloudCredentials>> {
        let normalized = normalize_server_url(server_url)?;
        let key = account_key(&normalized, login_name);
        let map = self
            .items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(map.get(&key).cloned())
    }

    fn delete(&self, server_url: &str, login_name: &str) -> Result<()> {
        let normalized = normalize_server_url(server_url)?;
        let key = account_key(&normalized, login_name);
        let mut map = self
            .items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.remove(&key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_http_client;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn debug_redacts_secrets() {
        let creds = NextcloudCredentials {
            server_url: "https://cloud.example.com".into(),
            login_name: "alice".into(),
            app_password: "super-secret-password".into(),
        };
        let rendered = format!("{creds:?}");
        assert!(!rendered.contains("super-secret-password"));
        assert!(rendered.contains("REDACTED"));
    }

    #[tokio::test]
    async fn login_flow_v2_happy_path_and_pending() {
        let server = MockServer::start().await;
        let uri = server.uri();

        Mock::given(method("POST"))
            .and(path("/index.php/login/v2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "poll": {
                    "token": "poll-token-123",
                    "endpoint": format!("{uri}/login/v2/poll")
                },
                "login": format!("{uri}/login/v2/flow/abc")
            })))
            .mount(&server)
            .await;

        let client = build_http_client().unwrap();
        let session = initiate_login_flow(&client, &uri).await.unwrap();
        assert_eq!(session.login_url, format!("{uri}/login/v2/flow/abc"));

        // First poll returns 404 (pending).
        Mock::given(method("POST"))
            .and(path("/login/v2/poll"))
            .and(body_string_contains("token=poll-token-123"))
            .respond_with(ResponseTemplate::new(404))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        let pending = poll_login_flow(&client, &session).await.unwrap();
        assert_eq!(pending, LoginPollResult::Pending);

        // Second poll returns 200 with credentials.
        Mock::given(method("POST"))
            .and(path("/login/v2/poll"))
            .and(body_string_contains("token=poll-token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "server": uri,
                "loginName": "alice",
                "appPassword": "app-password-xyz"
            })))
            .mount(&server)
            .await;

        let completed = poll_login_flow(&client, &session).await.unwrap();
        match completed {
            LoginPollResult::Completed(creds) => {
                assert_eq!(creds.login_name, "alice");
                assert_eq!(creds.app_password, "app-password-xyz");
            }
            LoginPollResult::Pending => panic!("expected completed login"),
        }
    }

    #[tokio::test]
    async fn login_flow_rejects_cross_origin_redirect_or_poll_endpoint() {
        let server = MockServer::start().await;
        let uri = server.uri();

        Mock::given(method("POST"))
            .and(path("/index.php/login/v2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "poll": {
                    "token": "tok",
                    "endpoint": "https://evil.example.com/steal"
                },
                "login": format!("{uri}/login/v2/flow/abc")
            })))
            .mount(&server)
            .await;

        let client = build_http_client().unwrap();
        let err = initiate_login_flow(&client, &uri).await.unwrap_err();
        assert!(matches!(err, FrError::Network(_)));
    }
}
