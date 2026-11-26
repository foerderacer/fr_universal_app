use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

/// Feature-detected Nextcloud Talk (`spreed`) server capabilities from `/ocs/v1.php/cloud/capabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TalkCapabilities {
    pub enabled: bool,
    pub features: Vec<String>,
    pub max_message_length: u32,
    pub attachments_allowed: bool,
    pub attachments_folder: String,
    pub conversation_subfolders: bool,
    pub rich_object_sharing: bool,
    pub reactions_supported: bool,
    pub edit_messages_supported: bool,
    pub delete_messages_supported: bool,
}

impl Default for TalkCapabilities {
    fn default() -> Self {
        Self {
            enabled: false,
            features: Vec::new(),
            max_message_length: 32_000,
            attachments_allowed: false,
            attachments_folder: "/Talk".to_owned(),
            conversation_subfolders: false,
            rich_object_sharing: false,
            reactions_supported: false,
            edit_messages_supported: false,
            delete_messages_supported: false,
        }
    }
}

/// Talk conversation category matching Nextcloud Talk's integer `type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TalkRoomType {
    OneToOne,
    Group,
    Public,
    Changelog,
    NoteToSelf,
    Other,
}

impl TalkRoomType {
    pub fn from_spreed_type(code: i64) -> Self {
        match code {
            1 => Self::OneToOne,
            2 => Self::Group,
            3 => Self::Public,
            4 => Self::Changelog,
            6 => Self::NoteToSelf,
            _ => Self::Other,
        }
    }

    pub fn to_spreed_type(self) -> i64 {
        match self {
            Self::OneToOne => 1,
            Self::Group => 2,
            Self::Public => 3,
            Self::Changelog => 4,
            Self::NoteToSelf => 6,
            Self::Other => 2,
        }
    }
}

/// Summary of a Nextcloud Talk conversation shown in the sidebar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TalkRoom {
    pub token: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub room_type: TalkRoomType,
    pub is_favorite: bool,
    pub unread_messages: u32,
    pub unread_mention: bool,
    #[specta(type = f64)]
    pub last_activity: i64,
    #[specta(type = Option<f64>)]
    pub last_read_message: Option<i64>,
    pub last_message_preview: Option<String>,
    pub last_message_actor: Option<String>,
    pub read_only: bool,
    pub can_leave: bool,
}

/// Result of listing Talk conversations, including the incremental `modifiedSince` cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TalkRoomsPage {
    pub rooms: Vec<TalkRoom>,
    #[specta(type = Option<f64>)]
    pub modified_before: Option<i64>,
    pub from_cache: bool,
}

/// A Nextcloud file referenced or shared inside a Talk message (zero file copies).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TalkFileReference {
    pub file_id: String,
    pub name: String,
    pub path: Option<String>,
    pub mime_type: Option<String>,
    #[specta(type = Option<f64>)]
    pub size: Option<i64>,
    pub link: Option<String>,
}

/// Compact parent summary when a message replies to an earlier message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TalkParentMessage {
    #[specta(type = f64)]
    pub id: i64,
    pub actor_display_name: String,
    pub message: String,
    pub deleted: bool,
}

/// A single Nextcloud Talk chat message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TalkMessage {
    #[specta(type = f64)]
    pub id: i64,
    pub token: String,
    pub actor_type: String,
    pub actor_id: String,
    pub actor_display_name: String,
    #[specta(type = f64)]
    pub timestamp: i64,
    pub message: String,
    pub message_type: String,
    pub system_message: String,
    pub is_replyable: bool,
    pub deleted: bool,
    pub reference_id: Option<String>,
    pub parent: Option<TalkParentMessage>,
    pub reactions: BTreeMap<String, u32>,
    pub reactions_self: Vec<String>,
    pub file_reference: Option<TalkFileReference>,
}

/// A page of Talk messages plus pagination headers (`X-Chat-Last-Given`, `X-Chat-Last-Common-Read`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TalkMessagesPage {
    pub messages: Vec<TalkMessage>,
    #[specta(type = Option<f64>)]
    pub last_given: Option<i64>,
    #[specta(type = Option<f64>)]
    pub last_common_read: Option<i64>,
    pub from_cache: bool,
}

/// Request payload to create a new 1:1 or group Talk conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateTalkRoomRequest {
    pub room_type: TalkRoomType,
    pub room_name: Option<String>,
    pub invite: Option<String>,
}

/// Request payload to send a new Talk chat message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SendTalkMessageRequest {
    pub token: String,
    pub message: String,
    #[specta(type = Option<f64>)]
    pub reply_to: Option<i64>,
    pub reference_id: Option<String>,
}
