use fr_core::{FrError, Result};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::auth::NextcloudCredentials;

/// Account profile and storage quota fetched from Nextcloud OCS `/ocs/v2.php/cloud/user`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserAccountInfo {
    pub id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub quota_used_bytes: f64,
    pub quota_total_bytes: Option<f64>,
    pub quota_relative: Option<f64>,
}

#[derive(Deserialize)]
struct OcsEnvelope {
    ocs: OcsBody,
}

#[derive(Deserialize)]
struct OcsBody {
    data: OcsUserData,
}

#[derive(Deserialize)]
struct OcsUserData {
    id: String,
    #[serde(rename = "display-name")]
    display_name: Option<String>,
    displayname: Option<String>,
    email: Option<String>,
    quota: Option<OcsQuota>,
}

#[derive(Deserialize)]
struct OcsQuota {
    used: Option<f64>,
    total: Option<f64>,
    relative: Option<f64>,
}

/// Fetches display name, email, and storage quota for the authenticated Nextcloud account.
pub async fn fetch_user_account_info(
    client: &reqwest::Client,
    creds: &NextcloudCredentials,
) -> Result<UserAccountInfo> {
    let url = format!("{}/ocs/v2.php/cloud/user?format=json", creds.server_url);
    let resp = client
        .get(&url)
        .header("OCS-APIRequest", "true")
        .basic_auth(&creds.login_name, Some(&creds.app_password))
        .send()
        .await
        .map_err(|err| FrError::Network(format!("failed to fetch Nextcloud user info: {err}")))?;

    match resp.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err(FrError::AuthRequired(
                "Nextcloud rejected the saved app password".into(),
            ));
        }
        status if !status.is_success() => {
            return Err(FrError::Network(format!(
                "Nextcloud OCS user endpoint returned HTTP {}",
                status.as_u16()
            )));
        }
        _ => {}
    }

    let envelope: OcsEnvelope = resp
        .json()
        .await
        .map_err(|err| FrError::Network(format!("invalid OCS user response: {err}")))?;

    let data = envelope.ocs.data;
    let display_name = data
        .display_name
        .or(data.displayname)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| data.id.clone());

    let (quota_used_bytes, quota_total_bytes, quota_relative) = match data.quota {
        Some(q) => (
            q.used.unwrap_or(0.0).max(0.0),
            q.total.filter(|t| *t > 0.0),
            q.relative,
        ),
        None => (0.0, None, None),
    };

    Ok(UserAccountInfo {
        id: data.id,
        display_name,
        email: data.email.filter(|s| !s.trim().is_empty()),
        quota_used_bytes,
        quota_total_bytes,
        quota_relative,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_http_client;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_user_profile_and_quota() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ocs/v2.php/cloud/user"))
            .and(query_param("format", "json"))
            .and(header("OCS-APIRequest", "true"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ocs": {
                    "data": {
                        "id": "alice",
                        "display-name": "Alice Engineer",
                        "email": "alice@example.com",
                        "quota": {
                            "used": 1048576.0,
                            "total": 10737418240.0,
                            "relative": 0.01
                        }
                    }
                }
            })))
            .mount(&server)
            .await;

        let creds = NextcloudCredentials {
            server_url: server.uri(),
            login_name: "alice".into(),
            app_password: "secret".into(),
        };
        let client = build_http_client().unwrap();
        let info = fetch_user_account_info(&client, &creds).await.unwrap();
        assert_eq!(info.id, "alice");
        assert_eq!(info.display_name, "Alice Engineer");
        assert_eq!(info.quota_used_bytes, 1_048_576.0);
        assert_eq!(info.quota_total_bytes, Some(10_737_418_240.0));
    }
}
