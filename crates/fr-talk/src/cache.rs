use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use directories::ProjectDirs;
use fr_core::{FrError, Result};
use rusqlite::{Connection, OptionalExtension, params};

use crate::models::{TalkMessage, TalkRoom};

const MAX_CACHED_MESSAGES_PER_ROOM: i64 = 200;

fn sqlite_err(err: rusqlite::Error) -> FrError {
    FrError::Other(format!("talk cache database error: {err}"))
}

/// Account-scoped SQLite store for offline-readable Talk rooms, recent messages, and unsent drafts.
#[derive(Clone)]
pub struct TalkCacheStore {
    conn: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for TalkCacheStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TalkCacheStore").finish()
    }
}

impl TalkCacheStore {
    pub fn default_db_path() -> Result<PathBuf> {
        let proj = ProjectDirs::from("de", "foerderacer", "FRUniversalApp")
            .ok_or_else(|| FrError::InvalidConfig("unable to resolve OS data directory".into()))?;
        Ok(proj.data_local_dir().join("talk.sqlite"))
    }

    pub fn open(db_path: impl Into<PathBuf>) -> Result<Self> {
        let path = db_path.into();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path).map_err(sqlite_err)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS talk_rooms (
                account_scope TEXT NOT NULL,
                token TEXT NOT NULL,
                room_json TEXT NOT NULL,
                last_activity INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (account_scope, token)
            );
            CREATE TABLE IF NOT EXISTS talk_messages (
                account_scope TEXT NOT NULL,
                token TEXT NOT NULL,
                message_id INTEGER NOT NULL,
                message_json TEXT NOT NULL,
                PRIMARY KEY (account_scope, token, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_talk_messages_room
                ON talk_messages (account_scope, token, message_id DESC);
            CREATE TABLE IF NOT EXISTS talk_drafts (
                account_scope TEXT NOT NULL,
                token TEXT NOT NULL,
                draft_text TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (account_scope, token)
            );
            ",
        )
        .map_err(sqlite_err)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn put_rooms(&self, account_scope: &str, rooms: &[TalkRoom], replace: bool) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let mut conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let tx = conn.transaction().map_err(sqlite_err)?;
        if replace {
            tx.execute(
                "DELETE FROM talk_rooms WHERE account_scope = ?1",
                params![account_scope],
            )
            .map_err(sqlite_err)?;
        }
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO talk_rooms (account_scope, token, room_json, last_activity, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(account_scope, token) DO UPDATE SET
                       room_json = excluded.room_json,
                       last_activity = excluded.last_activity,
                       updated_at_ms = excluded.updated_at_ms",
                )
                .map_err(sqlite_err)?;
            for room in rooms {
                let json = serde_json::to_string(room)?;
                stmt.execute(params![
                    account_scope,
                    room.token,
                    json,
                    room.last_activity,
                    now
                ])
                .map_err(sqlite_err)?;
            }
        }
        tx.commit().map_err(sqlite_err)?;
        Ok(())
    }

    pub fn list_rooms(&self, account_scope: &str) -> Result<Vec<TalkRoom>> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT room_json FROM talk_rooms
                 WHERE account_scope = ?1
                 ORDER BY last_activity DESC",
            )
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map(params![account_scope], |r| r.get::<_, String>(0))
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(room) = serde_json::from_str::<TalkRoom>(&row.map_err(sqlite_err)?) {
                out.push(room);
            }
        }
        Ok(out)
    }

    pub fn put_messages(
        &self,
        account_scope: &str,
        token: &str,
        messages: &[TalkMessage],
    ) -> Result<()> {
        if messages.is_empty() {
            return Ok(());
        }
        let mut conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let tx = conn.transaction().map_err(sqlite_err)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO talk_messages (account_scope, token, message_id, message_json)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(account_scope, token, message_id) DO UPDATE SET
                       message_json = excluded.message_json",
                )
                .map_err(sqlite_err)?;
            for msg in messages {
                let json = serde_json::to_string(msg)?;
                stmt.execute(params![account_scope, token, msg.id, json])
                    .map_err(sqlite_err)?;
            }
        }
        tx.execute(
            "DELETE FROM talk_messages
             WHERE account_scope = ?1 AND token = ?2 AND message_id NOT IN (
                 SELECT message_id FROM talk_messages
                 WHERE account_scope = ?1 AND token = ?2
                 ORDER BY message_id DESC LIMIT ?3
             )",
            params![account_scope, token, MAX_CACHED_MESSAGES_PER_ROOM],
        )
        .map_err(sqlite_err)?;
        tx.commit().map_err(sqlite_err)?;
        Ok(())
    }

    pub fn list_messages(
        &self,
        account_scope: &str,
        token: &str,
        limit: usize,
    ) -> Result<Vec<TalkMessage>> {
        let capped = (limit.clamp(1, MAX_CACHED_MESSAGES_PER_ROOM as usize)) as i64;
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT message_json FROM talk_messages
                 WHERE account_scope = ?1 AND token = ?2
                 ORDER BY message_id DESC LIMIT ?3",
            )
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map(params![account_scope, token, capped], |r| {
                r.get::<_, String>(0)
            })
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(msg) = serde_json::from_str::<TalkMessage>(&row.map_err(sqlite_err)?) {
                out.push(msg);
            }
        }
        // Return in chronological order (oldest -> newest) for chat rendering.
        out.reverse();
        Ok(out)
    }

    pub fn save_draft(&self, account_scope: &str, token: &str, text: &str) -> Result<()> {
        let trimmed = text.trim();
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if trimmed.is_empty() {
            conn.execute(
                "DELETE FROM talk_drafts WHERE account_scope = ?1 AND token = ?2",
                params![account_scope, token],
            )
            .map_err(sqlite_err)?;
            return Ok(());
        }
        let now = Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO talk_drafts (account_scope, token, draft_text, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_scope, token) DO UPDATE SET
               draft_text = excluded.draft_text,
               updated_at_ms = excluded.updated_at_ms",
            params![account_scope, token, text, now],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    pub fn get_draft(&self, account_scope: &str, token: &str) -> Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.query_row(
            "SELECT draft_text FROM talk_drafts WHERE account_scope = ?1 AND token = ?2",
            params![account_scope, token],
            |r| r.get(0),
        )
        .optional()
        .map_err(sqlite_err)
    }

    pub fn clear_account_cache(&self, account_scope: &str) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.execute(
            "DELETE FROM talk_rooms WHERE account_scope = ?1",
            params![account_scope],
        )
        .map_err(sqlite_err)?;
        conn.execute(
            "DELETE FROM talk_messages WHERE account_scope = ?1",
            params![account_scope],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TalkRoomType;
    use std::collections::BTreeMap;
    use tempfile::tempdir;

    #[test]
    fn talk_cache_isolates_accounts_and_persists_drafts() {
        let dir = tempdir().unwrap();
        let store = TalkCacheStore::open(dir.path().join("talk.sqlite")).unwrap();

        let room = TalkRoom {
            token: "abc123".into(),
            name: "Engineering".into(),
            display_name: "Engineering".into(),
            description: String::new(),
            room_type: TalkRoomType::Group,
            is_favorite: true,
            unread_messages: 2,
            unread_mention: false,
            last_activity: 1_700_000_000,
            last_read_message: Some(10),
            last_message_preview: Some("Hello!".into()),
            last_message_actor: Some("Alice".into()),
            read_only: false,
            can_leave: true,
        };
        store
            .put_rooms("https://cloud.example|alice", &[room], true)
            .unwrap();
        assert_eq!(
            store
                .list_rooms("https://cloud.example|alice")
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .list_rooms("https://cloud.example|bob")
                .unwrap()
                .is_empty()
        );

        let msg = TalkMessage {
            id: 42,
            token: "abc123".into(),
            actor_type: "users".into(),
            actor_id: "alice".into(),
            actor_display_name: "Alice".into(),
            timestamp: 1_700_000_001,
            message: "Look at this CAD part".into(),
            message_type: "comment".into(),
            system_message: String::new(),
            is_replyable: true,
            deleted: false,
            reference_id: None,
            parent: None,
            reactions: BTreeMap::new(),
            reactions_self: Vec::new(),
            file_reference: None,
        };
        store
            .put_messages("https://cloud.example|alice", "abc123", &[msg])
            .unwrap();
        let msgs = store
            .list_messages("https://cloud.example|alice", "abc123", 50)
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, 42);

        store
            .save_draft("https://cloud.example|alice", "abc123", "Draft note")
            .unwrap();
        assert_eq!(
            store
                .get_draft("https://cloud.example|alice", "abc123")
                .unwrap()
                .as_deref(),
            Some("Draft note")
        );
        store
            .save_draft("https://cloud.example|alice", "abc123", "   ")
            .unwrap();
        assert_eq!(
            store
                .get_draft("https://cloud.example|alice", "abc123")
                .unwrap(),
            None
        );
    }
}
