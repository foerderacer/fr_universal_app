use std::collections::BTreeMap;
use std::time::Duration;

use bytes::Bytes;
use fr_core::{FrError, Result};
use fr_nextcloud::NextcloudCredentials;
use fr_storage::{CloudPath, StorageBackend};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::StatusCode;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::models::{
    CreateTalkRoomRequest, TalkCapabilities, TalkFileReference, TalkMessage, TalkMessagesPage,
    TalkParentMessage, TalkRoom, TalkRoomType, TalkRoomsPage,
};

pub const MAX_ATTACHMENT_UPLOAD_BYTES: usize = 50 * 1024 * 1024; // 50 MiB

/// Pure-Rust Nextcloud Talk OCS REST client (chat only — calls are out of scope).
#[derive(Clone)]
pub struct TalkClient {
    http: reqwest::Client,
    creds: NextcloudCredentials,
}

impl std::fmt::Debug for TalkClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TalkClient")
            .field("server_url", &self.creds.server_url)
            .field("login_name", &self.creds.login_name)
            .finish()
    }
}

/// Validates a Talk conversation token before embedding it into an API URL path segment.
pub fn validate_room_token(token: &str) -> Result<&str> {
    let trimmed = token.trim();
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(FrError::InvalidInput(
            "Invalid Nextcloud Talk conversation token.".into(),
        ));
    }
    Ok(trimmed)
}

pub(crate) fn sanitize_path_segment(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c == '/'
                || c == '\\'
                || c == ':'
                || c == '*'
                || c == '?'
                || c == '"'
                || c == '<'
                || c == '>'
                || c == '|'
                || c.is_control()
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c.is_whitespace() || c == '.');
    if trimmed.is_empty() {
        return "attachment".to_owned();
    }

    // Preserve extension when truncating to 120 chars.
    let mut candidate = if trimmed.chars().count() > 120 {
        if let Some((stem, ext)) = trimmed.rsplit_once('.') {
            let ext_chars = ext.chars().count();
            if !stem.is_empty() && ext_chars > 0 && ext_chars <= 20 {
                let keep = 120usize.saturating_sub(ext_chars + 1);
                let short_stem: String = stem.chars().take(keep).collect();
                format!("{short_stem}.{ext}")
            } else {
                trimmed.chars().take(120).collect()
            }
        } else {
            trimmed.chars().take(120).collect()
        }
    } else {
        trimmed.to_owned()
    };

    // Guard against Windows reserved device filenames (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
    let stem_upper = candidate
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
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
        candidate.insert(0, '_');
    }
    candidate
}

fn extract_ocs_message(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["ocs"]["meta"]["message"].as_str().map(ToOwned::to_owned))
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

impl TalkClient {
    pub fn new(http: reqwest::Client, creds: NextcloudCredentials) -> Self {
        Self { http, creds }
    }

    pub fn login_name(&self) -> &str {
        &self.creds.login_name
    }

    fn map_http_error(
        status: StatusCode,
        headers: &reqwest::header::HeaderMap,
        body: &str,
    ) -> FrError {
        if headers.contains_key("x-nextcloud-maintenance-mode")
            || status == StatusCode::SERVICE_UNAVAILABLE
        {
            return FrError::Network(
                "talk_maintenance: Nextcloud is currently in maintenance mode. Try again shortly."
                    .into(),
            );
        }
        let server_hint = extract_ocs_message(body);
        match status {
            StatusCode::UNAUTHORIZED => FrError::AuthRequired(
                "Your Nextcloud session expired. Please sign in again.".into(),
            ),
            StatusCode::FORBIDDEN => FrError::PermissionDenied(server_hint.unwrap_or_else(|| {
                "You don't have permission to perform this action in Nextcloud Talk.".into()
            })),
            StatusCode::BAD_REQUEST => FrError::InvalidInput(
                server_hint
                    .unwrap_or_else(|| "Nextcloud Talk could not process that request.".into()),
            ),
            StatusCode::NOT_FOUND => {
                FrError::NotFound("This conversation or message was not found on Nextcloud.".into())
            }
            StatusCode::PRECONDITION_FAILED => {
                FrError::PermissionDenied(server_hint.unwrap_or_else(|| {
                    "This conversation is currently waiting in a lobby or locked.".into()
                }))
            }
            StatusCode::TOO_MANY_REQUESTS => FrError::Network(
                "talk_rate_limit: Nextcloud Talk rate limit reached. Slowing down automatically."
                    .into(),
            ),
            StatusCode::UPGRADE_REQUIRED => {
                let hint = server_hint
                    .unwrap_or_else(|| "Server requires a newer Talk API version.".into());
                FrError::Other(format!("talk_upgrade_required: {hint}"))
            }
            _ => FrError::Network(format!("Nextcloud Talk returned HTTP {}", status.as_u16())),
        }
    }

    async fn parse_ocs_data(&self, resp: reqwest::Response) -> Result<Value> {
        let status = resp.status();
        let headers = resp.headers().clone();
        let text = resp
            .text()
            .await
            .map_err(|err| FrError::Network(format!("failed to read Talk response: {err}")))?;
        if !status.is_success() {
            return Err(Self::map_http_error(status, &headers, &text));
        }
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|err| FrError::Network(format!("invalid Talk JSON response: {err}")))?;
        Ok(parsed["ocs"]["data"].clone())
    }

    /// Reads `/ocs/v1.php/cloud/capabilities?format=json` to detect Talk availability and features.
    pub async fn fetch_capabilities(&self) -> Result<TalkCapabilities> {
        let url = format!(
            "{}/ocs/v1.php/cloud/capabilities?format=json",
            self.creds.server_url
        );
        let resp = self
            .http
            .get(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| {
                FrError::Network(format!("failed to fetch Nextcloud capabilities: {err}"))
            })?;

        let data = self.parse_ocs_data(resp).await?;
        let spreed = &data["capabilities"]["spreed"];
        if spreed.is_null() {
            return Ok(TalkCapabilities::default());
        }

        let features: Vec<String> = spreed["features"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default();

        let has_feature = |name: &str| features.iter().any(|f| f == name);
        let config = &spreed["config"];
        let max_message_length = config["chat"]["max-length"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|&v| v > 0)
            .unwrap_or(32_000);

        let attachments = &config["attachments"];
        let attachments_allowed = attachments["allowed"].as_bool().unwrap_or(false);
        let raw_folder = attachments["folder"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("/Talk");
        let attachments_folder = CloudPath::parse(raw_folder)
            .map(|p| p.as_str().to_owned())
            .unwrap_or_else(|_| "/Talk".to_owned());
        let conversation_subfolders = attachments["conversation-subfolders"]
            .as_bool()
            .unwrap_or(false);

        Ok(TalkCapabilities {
            enabled: true,
            rich_object_sharing: has_feature("rich-object-sharing")
                || has_feature("rich-object-list-media"),
            reactions_supported: has_feature("reactions"),
            edit_messages_supported: has_feature("edit-messages"),
            delete_messages_supported: has_feature("delete-messages"),
            features,
            max_message_length,
            attachments_allowed,
            attachments_folder,
            conversation_subfolders,
        })
    }

    /// Lists conversations via `GET /ocs/v2.php/apps/spreed/api/v4/room`.
    pub async fn list_rooms(&self, modified_since: Option<i64>) -> Result<TalkRoomsPage> {
        let mut url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v4/room?format=json",
            self.creds.server_url
        );
        if let Some(ts) = modified_since {
            url.push_str(&format!("&modifiedSince={ts}"));
        }
        let resp = self
            .http
            .get(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to load Talk conversations: {err}")))?;

        let modified_before = resp
            .headers()
            .get("x-nextcloud-talk-modified-before")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok());

        if resp.status() == StatusCode::NOT_MODIFIED {
            return Ok(TalkRoomsPage {
                rooms: Vec::new(),
                modified_before,
                from_cache: false,
            });
        }

        let data = self.parse_ocs_data(resp).await?;
        let mut rooms: Vec<TalkRoom> = data
            .as_array()
            .map(|arr| arr.iter().filter_map(parse_room).collect())
            .unwrap_or_default();
        rooms.sort_by(|a, b| {
            b.is_favorite
                .cmp(&a.is_favorite)
                .then_with(|| b.last_activity.cmp(&a.last_activity))
        });

        Ok(TalkRoomsPage {
            rooms,
            modified_before,
            from_cache: false,
        })
    }

    /// Creates a new one-to-one or group conversation (`POST /v4/room`).
    pub async fn create_room(&self, req: &CreateTalkRoomRequest) -> Result<TalkRoom> {
        if matches!(req.room_type, TalkRoomType::Group | TalkRoomType::Public)
            && req
                .room_name
                .as_deref()
                .map(str::trim)
                .is_none_or(str::is_empty)
        {
            return Err(FrError::InvalidInput(
                "A conversation name is required for group chats.".into(),
            ));
        }
        if matches!(req.room_type, TalkRoomType::OneToOne)
            && req
                .invite
                .as_deref()
                .map(str::trim)
                .is_none_or(str::is_empty)
        {
            return Err(FrError::InvalidInput(
                "Enter a teammate's Nextcloud username for a direct message.".into(),
            ));
        }

        let url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v4/room?format=json",
            self.creds.server_url
        );
        let mut body = json!({
            "roomType": req.room_type.to_spreed_type(),
        });
        if let Some(name) = req
            .room_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            body["roomName"] = Value::String(name.to_owned());
        }
        if let Some(invite) = req
            .invite
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            body["invite"] = Value::String(invite.to_owned());
        }

        let resp = self
            .http
            .post(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .json(&body)
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to create conversation: {err}")))?;

        let data = self.parse_ocs_data(resp).await?;
        parse_room(&data).ok_or_else(|| {
            FrError::Network("Nextcloud Talk returned an unexpected room payload.".into())
        })
    }

    pub async fn set_favorite(&self, token: &str, favorite: bool) -> Result<()> {
        let token = validate_room_token(token)?;
        let url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v4/room/{token}/favorite?format=json",
            self.creds.server_url
        );
        let req = if favorite {
            self.http.post(&url)
        } else {
            self.http.delete(&url)
        };
        let resp = req
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to update favorite: {err}")))?;
        let _ = self.parse_ocs_data(resp).await?;
        Ok(())
    }

    pub async fn leave_room(&self, token: &str) -> Result<()> {
        let token = validate_room_token(token)?;
        let url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v4/room/{token}/participants/self?format=json",
            self.creds.server_url
        );
        let resp = self
            .http
            .delete(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to leave conversation: {err}")))?;
        let _ = self.parse_ocs_data(resp).await?;
        Ok(())
    }

    /// Fetches message history (`look_into_future = false`) or long-polls for new messages
    /// (`look_into_future = true`, `timeout_secs` clamped to `1..=60`).
    pub async fn fetch_messages(
        &self,
        token: &str,
        look_into_future: bool,
        last_known_message_id: Option<i64>,
        limit: u32,
        timeout_secs: u32,
    ) -> Result<TalkMessagesPage> {
        let token = validate_room_token(token)?;
        let capped_limit = limit.clamp(1, 200);
        let capped_timeout = timeout_secs.clamp(1, 60);
        let mut url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v1/chat/{token}?format=json&lookIntoFuture={}&limit={capped_limit}",
            self.creds.server_url,
            if look_into_future { 1 } else { 0 }
        );
        if let Some(last_id) = last_known_message_id {
            url.push_str(&format!("&lastKnownMessageId={last_id}"));
        }
        if look_into_future {
            url.push_str(&format!("&timeout={capped_timeout}&setReadMarker=0"));
        }

        let mut req = self
            .http
            .get(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password));
        if look_into_future {
            req = req.timeout(Duration::from_secs(u64::from(capped_timeout) + 15));
        }

        let resp = req
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to fetch chat messages: {err}")))?;

        let last_given = resp
            .headers()
            .get("x-chat-last-given")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok());
        let last_common_read = resp
            .headers()
            .get("x-chat-last-common-read")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok());

        if resp.status() == StatusCode::NOT_MODIFIED {
            return Ok(TalkMessagesPage {
                messages: Vec::new(),
                last_given,
                last_common_read,
                from_cache: false,
            });
        }

        let data = self.parse_ocs_data(resp).await?;
        let mut messages: Vec<TalkMessage> = data
            .as_array()
            .map(|arr| arr.iter().filter_map(parse_message).collect())
            .unwrap_or_default();
        messages.sort_by_key(|m| m.id);

        Ok(TalkMessagesPage {
            messages,
            last_given,
            last_common_read,
            from_cache: false,
        })
    }

    /// Sends a new chat message (`POST /v1/chat/{token}`) with idempotent `referenceId`.
    pub async fn send_message(
        &self,
        token: &str,
        message: &str,
        reply_to: Option<i64>,
        reference_id: Option<&str>,
    ) -> Result<TalkMessage> {
        let token = validate_room_token(token)?;
        let text = message.trim();
        if text.is_empty() {
            return Err(FrError::InvalidInput("Message cannot be empty.".into()));
        }
        if text.chars().count() > 32_000 {
            return Err(FrError::InvalidInput(
                "Message exceeds Nextcloud Talk's 32,000 character limit.".into(),
            ));
        }

        let url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v1/chat/{token}?format=json",
            self.creds.server_url
        );
        let ref_id = reference_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let mut body = json!({
            "message": text,
            "referenceId": ref_id,
        });
        if let Some(parent_id) = reply_to {
            body["replyTo"] = json!(parent_id);
        }

        let resp = self
            .http
            .post(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .json(&body)
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to send Talk message: {err}")))?;

        let data = self.parse_ocs_data(resp).await?;
        parse_message(&data).ok_or_else(|| {
            FrError::Network("Nextcloud Talk returned an unexpected message payload.".into())
        })
    }

    pub async fn edit_message(
        &self,
        token: &str,
        message_id: i64,
        message: &str,
    ) -> Result<TalkMessage> {
        let token = validate_room_token(token)?;
        let text = message.trim();
        if text.is_empty() {
            return Err(FrError::InvalidInput("Message cannot be empty.".into()));
        }
        if text.chars().count() > 32_000 {
            return Err(FrError::InvalidInput(
                "Message exceeds Nextcloud Talk's 32,000 character limit.".into(),
            ));
        }
        let url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v1/chat/{token}/{message_id}?format=json",
            self.creds.server_url
        );
        let resp = self
            .http
            .put(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .json(&json!({ "message": text }))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to edit Talk message: {err}")))?;
        let data = self.parse_ocs_data(resp).await?;
        parse_message(&data).ok_or_else(|| {
            FrError::Network("Nextcloud Talk returned an unexpected edit payload.".into())
        })
    }

    pub async fn delete_message(&self, token: &str, message_id: i64) -> Result<TalkMessage> {
        let token = validate_room_token(token)?;
        let url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v1/chat/{token}/{message_id}?format=json",
            self.creds.server_url
        );
        let resp = self
            .http
            .delete(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to delete Talk message: {err}")))?;
        let data = self.parse_ocs_data(resp).await?;
        parse_message(&data).ok_or_else(|| {
            FrError::Network("Nextcloud Talk returned an unexpected delete payload.".into())
        })
    }

    pub async fn mark_read(&self, token: &str, last_read_message_id: i64) -> Result<()> {
        let token = validate_room_token(token)?;
        let url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v1/chat/{token}/read?format=json",
            self.creds.server_url
        );
        let resp = self
            .http
            .post(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .json(&json!({ "lastReadMessage": last_read_message_id }))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to mark chat as read: {err}")))?;
        let _ = self.parse_ocs_data(resp).await?;
        Ok(())
    }

    pub async fn set_reaction(
        &self,
        token: &str,
        message_id: i64,
        reaction: &str,
        add: bool,
    ) -> Result<()> {
        let token = validate_room_token(token)?;
        let emoji = reaction.trim();
        if emoji.is_empty() || emoji.chars().count() > 16 {
            return Err(FrError::InvalidInput("Invalid reaction emoji.".into()));
        }
        let encoded = utf8_percent_encode(emoji, NON_ALPHANUMERIC).to_string();
        let url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v1/reaction/{token}/{message_id}?format=json&reaction={encoded}",
            self.creds.server_url
        );
        let req = if add {
            self.http.post(&url)
        } else {
            self.http.delete(&url)
        };
        let resp = req
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to update reaction: {err}")))?;
        let _ = self.parse_ocs_data(resp).await?;
        Ok(())
    }

    /// **Flow A2 (default per Plan 06 Decision ③):** shares a pure file-ID reference into a Talk
    /// conversation (`POST /v1/chat/{token}/share`, `objectType: "file"`) with **zero copies**
    /// and **no share-granting** (access control remains enforced by Nextcloud).
    pub async fn share_file_reference(
        &self,
        token: &str,
        file_id: &str,
        reference_id: Option<&str>,
    ) -> Result<TalkMessage> {
        let token = validate_room_token(token)?;
        let clean_id = file_id.trim();
        if clean_id.is_empty() || !clean_id.chars().all(|c| c.is_ascii_digit()) {
            return Err(FrError::InvalidInput(
                "This file does not have a numeric Nextcloud file ID and cannot be referenced directly."
                    .into(),
            ));
        }

        let url = format!(
            "{}/ocs/v2.php/apps/spreed/api/v1/chat/{token}/share?format=json",
            self.creds.server_url
        );
        let ref_id = reference_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let body = json!({
            "objectType": "file",
            "objectId": clean_id,
            "referenceId": ref_id,
            "metaData": "{}",
        });

        let resp = self
            .http
            .post(&url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .json(&body)
            .send()
            .await
            .map_err(|err| FrError::Network(format!("failed to reference file in Talk: {err}")))?;

        let data = self.parse_ocs_data(resp).await?;
        parse_message(&data).ok_or_else(|| {
            FrError::Network("Nextcloud Talk returned an unexpected file reference payload.".into())
        })
    }

    /// **Flow B:** uploads a brand-new file once into the server-configured Talk attachments
    /// folder via [`StorageBackend`] and attaches it to the conversation (`shareType: 10`).
    pub async fn upload_and_attach_file(
        &self,
        storage: &dyn StorageBackend,
        caps: &TalkCapabilities,
        token: &str,
        room_display_name: &str,
        file_name: &str,
        bytes: Bytes,
    ) -> Result<CloudPath> {
        let token = validate_room_token(token)?;
        if !caps.attachments_allowed {
            return Err(FrError::InvalidInput(
                "File uploads to Talk conversations are disabled by your Nextcloud administrator."
                    .into(),
            ));
        }
        if bytes.is_empty() {
            return Err(FrError::InvalidInput("Cannot upload an empty file.".into()));
        }
        if bytes.len() > MAX_ATTACHMENT_UPLOAD_BYTES {
            return Err(FrError::InvalidInput(
                "Attachment exceeds the 50 MiB upload limit.".into(),
            ));
        }

        let base_dir = CloudPath::parse(&caps.attachments_folder)?;
        if let Err(err) = storage.mkdir(&base_dir).await
            && !matches!(err, FrError::AlreadyExists(_))
        {
            return Err(err);
        }

        let target_dir = if caps.conversation_subfolders {
            let conv_seg = format!("{}-{token}", sanitize_path_segment(room_display_name));
            let conv_dir = base_dir.join(&conv_seg)?;
            if let Err(err) = storage.mkdir(&conv_dir).await
                && !matches!(err, FrError::AlreadyExists(_))
            {
                return Err(err);
            }
            conv_dir
        } else {
            base_dir
        };

        let safe_name = sanitize_path_segment(file_name);
        let mut target_path = target_dir.join(&safe_name)?;
        // Avoid overwriting an existing attachment with the same name (UUID suffix prevents same-second collisions).
        if storage.stat(&target_path).await.is_ok() {
            let short_id = &Uuid::new_v4().simple().to_string()[..8];
            let unique = match safe_name.rsplit_once('.') {
                Some((stem, ext)) => format!("{stem}-{short_id}.{ext}"),
                None => format!("{safe_name}-{short_id}"),
            };
            target_path = target_dir.join(&unique)?;
        }

        storage.write(&target_path, bytes, None).await?;

        // Attach the uploaded file into the Talk conversation via OCS Share API (`shareType: 10`).
        let share_url = format!(
            "{}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json",
            self.creds.server_url
        );
        let resp = self
            .http
            .post(&share_url)
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .json(&json!({
                "shareType": 10,
                "shareWith": token,
                "path": target_path.as_str(),
            }))
            .send()
            .await
            .map_err(|err| {
                FrError::Network(format!(
                    "file uploaded but failed to share into Talk: {err}"
                ))
            })?;
        let _ = self.parse_ocs_data(resp).await?;

        Ok(target_path)
    }
}

fn parse_room(val: &Value) -> Option<TalkRoom> {
    let token = val["token"].as_str()?.to_owned();
    let display_name = val["displayName"]
        .as_str()
        .or_else(|| val["name"].as_str())
        .unwrap_or(&token)
        .to_owned();
    let name = val["name"].as_str().unwrap_or(&display_name).to_owned();
    let last_msg = &val["lastMessage"];
    let last_message_preview = last_msg["message"]
        .as_str()
        .map(|s| render_message_placeholders(s, &last_msg["messageParameters"]))
        .filter(|s| !s.trim().is_empty());
    let last_message_actor = last_msg["actorDisplayName"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(ToOwned::to_owned);

    Some(TalkRoom {
        token,
        name,
        display_name,
        description: val["description"].as_str().unwrap_or_default().to_owned(),
        room_type: TalkRoomType::from_spreed_type(val["type"].as_i64().unwrap_or(2)),
        is_favorite: val["isFavorite"].as_bool().unwrap_or(false),
        unread_messages: val["unreadMessages"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0),
        unread_mention: val["unreadMention"].as_bool().unwrap_or(false),
        last_activity: val["lastActivity"].as_i64().unwrap_or(0),
        last_read_message: val["lastReadMessage"].as_i64().filter(|&id| id > 0),
        last_message_preview,
        last_message_actor,
        read_only: val["readOnly"].as_i64().unwrap_or(0) > 0,
        can_leave: val["canLeaveConversation"].as_bool().unwrap_or(true),
    })
}

fn render_message_placeholders(raw: &str, params: &Value) -> String {
    let Some(map) = params.as_object() else {
        return raw.to_owned();
    };
    let mut rendered = raw.to_owned();
    for (key, param) in map {
        let placeholder = format!("{{{key}}}");
        if let Some(name) = param["name"].as_str() {
            rendered = rendered.replace(&placeholder, name);
        }
    }
    rendered
}

fn extract_file_reference(params: &Value) -> Option<TalkFileReference> {
    let map = params.as_object()?;
    let file_obj = map
        .get("file")
        .or_else(|| map.values().find(|v| v["type"].as_str() == Some("file")))?;
    let file_id = file_obj["id"]
        .as_str()
        .map(ToOwned::to_owned)
        .or_else(|| file_obj["id"].as_i64().map(|n| n.to_string()))?;
    let name = file_obj["name"]
        .as_str()
        .unwrap_or("Shared file")
        .to_owned();
    let path = file_obj["path"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .and_then(|raw| CloudPath::parse(raw).ok())
        .map(|p| p.as_str().to_owned());
    let mime_type = file_obj["mimetype"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(ToOwned::to_owned);
    let size = file_obj["size"].as_i64().or_else(|| {
        file_obj["size"]
            .as_str()
            .and_then(|s| s.parse::<i64>().ok())
    });
    let link = file_obj["link"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(ToOwned::to_owned);

    Some(TalkFileReference {
        file_id,
        name,
        path,
        mime_type,
        size,
        link,
    })
}

fn parse_message(val: &Value) -> Option<TalkMessage> {
    let id = val["id"].as_i64()?;
    let token = val["token"].as_str().unwrap_or_default().to_owned();
    let params = &val["messageParameters"];
    let raw_message = val["message"].as_str().unwrap_or_default();
    let message = render_message_placeholders(raw_message, params);
    let message_type = val["messageType"].as_str().unwrap_or("comment").to_owned();
    let system_message = val["systemMessage"].as_str().unwrap_or_default().to_owned();
    let deleted = message_type == "comment_deleted" || system_message == "message_deleted";

    let parent = val.get("parent").and_then(|p| {
        if p.is_null() || !p.is_object() {
            return None;
        }
        let pid = p["id"].as_i64()?;
        let p_raw = p["message"].as_str().unwrap_or_default();
        Some(TalkParentMessage {
            id: pid,
            actor_display_name: p["actorDisplayName"]
                .as_str()
                .unwrap_or("Someone")
                .to_owned(),
            message: render_message_placeholders(p_raw, &p["messageParameters"]),
            deleted: p["messageType"].as_str() == Some("comment_deleted"),
        })
    });

    let mut reactions = BTreeMap::new();
    if let Some(obj) = val["reactions"].as_object() {
        for (emoji, count) in obj {
            if let Some(n) = count.as_u64().and_then(|v| u32::try_from(v).ok())
                && n > 0
            {
                reactions.insert(emoji.clone(), n);
            }
        }
    }
    let reactions_self = val["reactionsSelf"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();

    Some(TalkMessage {
        id,
        token,
        actor_type: val["actorType"].as_str().unwrap_or("users").to_owned(),
        actor_id: val["actorId"].as_str().unwrap_or_default().to_owned(),
        actor_display_name: val["actorDisplayName"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| val["actorId"].as_str())
            .unwrap_or("Unknown")
            .to_owned(),
        timestamp: val["timestamp"].as_i64().unwrap_or(0),
        message,
        message_type,
        system_message,
        is_replyable: val["isReplyable"].as_bool().unwrap_or(true),
        deleted,
        reference_id: val["referenceId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(ToOwned::to_owned),
        parent,
        reactions,
        reactions_self,
        file_reference: extract_file_reference(params),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fr_nextcloud::build_http_client;
    use fr_storage::LocalFsBackend;
    use tempfile::tempdir;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_client(uri: String) -> TalkClient {
        TalkClient::new(
            build_http_client().unwrap(),
            NextcloudCredentials {
                server_url: uri,
                login_name: "alice".into(),
                app_password: "secret".into(),
            },
        )
    }

    #[tokio::test]
    async fn detects_capabilities_lists_rooms_and_handles_long_poll_and_file_reference() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/ocs/v1.php/cloud/capabilities"))
            .and(header("OCS-APIRequest", "true"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ocs": {
                    "data": {
                        "capabilities": {
                            "spreed": {
                                "features": [
                                    "rich-object-sharing",
                                    "reactions",
                                    "edit-messages",
                                    "delete-messages"
                                ],
                                "config": {
                                    "chat": { "max-length": 32000 },
                                    "attachments": {
                                        "allowed": true,
                                        "folder": "/Talk",
                                        "conversation-subfolders": true
                                    }
                                }
                            }
                        }
                    }
                }
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/ocs/v2.php/apps/spreed/api/v4/room"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("X-Nextcloud-Talk-Modified-Before", "1700000100")
                    .set_body_json(json!({
                        "ocs": {
                            "data": [{
                                "token": "team-eng",
                                "name": "Engineering",
                                "displayName": "Engineering",
                                "description": "CAD & Fabrication",
                                "type": 2,
                                "isFavorite": true,
                                "unreadMessages": 3,
                                "unreadMention": false,
                                "lastActivity": 1700000050,
                                "lastReadMessage": 100
                            }]
                        }
                    })),
            )
            .mount(&server)
            .await;

        // Long-poll 304 Not Modified returns cleanly with empty messages.
        Mock::given(method("GET"))
            .and(path("/ocs/v2.php/apps/spreed/api/v1/chat/team-eng"))
            .and(query_param("lookIntoFuture", "1"))
            .respond_with(ResponseTemplate::new(304).insert_header("X-Chat-Last-Given", "105"))
            .mount(&server)
            .await;

        // Pure file-ID reference (Flow A2: zero copies, no share grant).
        Mock::given(method("POST"))
            .and(path("/ocs/v2.php/apps/spreed/api/v1/chat/team-eng/share"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "ocs": {
                    "data": {
                        "id": 106,
                        "token": "team-eng",
                        "actorType": "users",
                        "actorId": "alice",
                        "actorDisplayName": "Alice",
                        "timestamp": 1700000200,
                        "message": "{file}",
                        "messageParameters": {
                            "file": {
                                "type": "file",
                                "id": "9981",
                                "name": "wing_mount.sldprt",
                                "path": "/CAD/wing_mount.sldprt",
                                "mimetype": "application/octet-stream",
                                "size": 524288,
                                "link": "https://cloud.example/f/9981"
                            }
                        },
                        "messageType": "comment",
                        "systemMessage": "",
                        "isReplyable": true
                    }
                }
            })))
            .mount(&server)
            .await;

        let client = test_client(server.uri());
        let caps = client.fetch_capabilities().await.unwrap();
        assert!(caps.enabled);
        assert!(caps.rich_object_sharing);
        assert!(caps.attachments_allowed);
        assert!(caps.conversation_subfolders);
        assert_eq!(caps.attachments_folder, "/Talk");

        let page = client.list_rooms(None).await.unwrap();
        assert_eq!(page.modified_before, Some(1_700_000_100));
        assert_eq!(page.rooms.len(), 1);
        assert_eq!(page.rooms[0].token, "team-eng");

        let poll = client
            .fetch_messages("team-eng", true, Some(105), 50, 1)
            .await
            .unwrap();
        assert!(poll.messages.is_empty());
        assert_eq!(poll.last_given, Some(105));

        let shared = client
            .share_file_reference("team-eng", "9981", None)
            .await
            .unwrap();
        assert_eq!(shared.id, 106);
        assert_eq!(shared.message, "wing_mount.sldprt");
        let file_ref = shared.file_reference.unwrap();
        assert_eq!(file_ref.file_id, "9981");
        assert_eq!(file_ref.path.as_deref(), Some("/CAD/wing_mount.sldprt"));

        // Non-numeric file ID (such as a fallback path) must be rejected.
        assert!(
            client
                .share_file_reference("team-eng", "/CAD/wing_mount.sldprt", None)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn uploads_attachment_via_storage_backend_and_shares_to_conversation() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ocs/v2.php/apps/files_sharing/api/v1/shares"))
            .and(wiremock::matchers::body_partial_json(json!({
                "shareType": 10,
                "shareWith": "team-eng",
                "path": "/Talk/Engineering-team-eng/sketch.png"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ocs": { "data": { "id": 77 } }
            })))
            .mount(&server)
            .await;

        let dir = tempdir().unwrap();
        let storage = LocalFsBackend::new(dir.path());
        let client = test_client(server.uri());
        let caps = TalkCapabilities {
            enabled: true,
            attachments_allowed: true,
            attachments_folder: "/Talk".into(),
            conversation_subfolders: true,
            ..TalkCapabilities::default()
        };

        let uploaded = client
            .upload_and_attach_file(
                &storage,
                &caps,
                "team-eng",
                "Engineering",
                "sketch.png",
                Bytes::from_static(b"png-bytes"),
            )
            .await
            .unwrap();
        assert_eq!(uploaded.as_str(), "/Talk/Engineering-team-eng/sketch.png");
        let (stored, _) = storage.read(&uploaded).await.unwrap();
        assert_eq!(stored.as_ref(), b"png-bytes");

        // Oversized upload rejected before storage write.
        let oversized = Bytes::from(vec![0u8; MAX_ATTACHMENT_UPLOAD_BYTES + 1]);
        assert!(matches!(
            client
                .upload_and_attach_file(
                    &storage,
                    &caps,
                    "team-eng",
                    "Engineering",
                    "huge.bin",
                    oversized
                )
                .await,
            Err(FrError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn maps_http_statuses_and_sanitizes_segments_and_tokens() {
        assert!(validate_room_token("../etc/passwd").is_err());
        assert!(validate_room_token("valid_room-123").is_ok());
        assert_eq!(sanitize_path_segment("CON.txt"), "_CON.txt");
        assert!(sanitize_path_segment(&format!("{}.pdf", "a".repeat(200))).ends_with(".pdf"));
        assert!(!sanitize_path_segment("../../evil.png").contains('/'));

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ocs/v2.php/apps/spreed/api/v4/room"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/ocs/v2.php/apps/spreed/api/v1/chat/locked"))
            .respond_with(ResponseTemplate::new(412).set_body_json(json!({
                "ocs": { "meta": { "message": "Lobby is active" } }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/ocs/v2.php/apps/spreed/api/v1/chat/forbidden"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "ocs": { "meta": { "message": "Read-only conversation" } }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/ocs/v2.php/apps/spreed/api/v1/chat/outdated"))
            .respond_with(ResponseTemplate::new(426).set_body_json(json!({
                "ocs": { "meta": { "message": "Talk API v2 required" } }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/ocs/v2.php/apps/spreed/api/v1/chat/maint"))
            .respond_with(
                ResponseTemplate::new(503).insert_header("X-Nextcloud-Maintenance-Mode", "1"),
            )
            .mount(&server)
            .await;

        let client = test_client(server.uri());
        assert!(
            matches!(client.list_rooms(None).await, Err(FrError::Network(m)) if m.contains("talk_rate_limit"))
        );
        assert!(
            matches!(client.send_message("locked", "hi", None, None).await, Err(FrError::PermissionDenied(m)) if m.contains("Lobby"))
        );
        assert!(
            matches!(client.send_message("forbidden", "hi", None, None).await, Err(FrError::PermissionDenied(m)) if m.contains("Read-only"))
        );
        assert!(
            matches!(client.send_message("outdated", "hi", None, None).await, Err(FrError::Other(m)) if m.contains("talk_upgrade_required"))
        );
        assert!(
            matches!(client.send_message("maint", "hi", None, None).await, Err(FrError::Network(m)) if m.contains("talk_maintenance"))
        );
    }
}
