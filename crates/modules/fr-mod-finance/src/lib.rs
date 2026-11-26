//! Financing domain module (`FrModule`) providing an account-scoped SQLite ledger for
//! invoices, receipts, and budgets linked to Nextcloud documents, RFC 4180 CSV export
//! (with formula-injection neutralization), and `finance_*` MCP Server tools.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use directories::ProjectDirs;
use fr_core::{FrError, FrModule, ModuleCapability, ModuleDescriptor, ModuleStatus, Result};
use fr_mcp::{McpToolHandler, McpToolRegistry};
use fr_storage::CloudPath;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FinanceEntryKind {
    Invoice,
    Receipt,
    Budget,
}

impl FinanceEntryKind {
    fn as_db(self) -> &'static str {
        match self {
            Self::Invoice => "invoice",
            Self::Receipt => "receipt",
            Self::Budget => "budget",
        }
    }

    fn from_db(s: &str) -> Self {
        match s {
            "receipt" => Self::Receipt,
            "budget" => Self::Budget,
            _ => Self::Invoice,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FinanceEntryStatus {
    Pending,
    Approved,
    Paid,
}

impl FinanceEntryStatus {
    fn as_db(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Paid => "paid",
        }
    }

    fn from_db(s: &str) -> Self {
        match s {
            "approved" => Self::Approved,
            "paid" => Self::Paid,
            _ => Self::Pending,
        }
    }
}

/// Structured financial record linked optionally to a Nextcloud invoice/receipt file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FinanceEntry {
    pub id: String,
    pub kind: FinanceEntryKind,
    pub vendor: String,
    pub description: String,
    pub category: String,
    /// Exact monetary amount in minor units (cents) to avoid floating-point rounding drift.
    #[specta(type = f64)]
    pub amount_cents: i64,
    pub currency: String,
    /// ISO calendar date (`YYYY-MM-DD`).
    pub entry_date: String,
    pub status: FinanceEntryStatus,
    pub cloud_file_path: Option<CloudPath>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request payload for creating or updating a [`FinanceEntry`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpsertFinanceEntryRequest {
    pub id: Option<String>,
    pub kind: FinanceEntryKind,
    pub vendor: String,
    pub description: String,
    pub category: String,
    #[specta(type = f64)]
    pub amount_cents: i64,
    pub currency: String,
    pub entry_date: String,
    pub status: FinanceEntryStatus,
    pub cloud_file_path: Option<String>,
}

/// Aggregated ledger totals for one currency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FinanceCurrencySummary {
    pub currency: String,
    #[specta(type = f64)]
    pub total_invoices_cents: i64,
    #[specta(type = f64)]
    pub total_receipts_cents: i64,
    #[specta(type = f64)]
    pub total_budgets_cents: i64,
    pub pending_count: u32,
    pub entry_count: u32,
}

/// Pluggable Financing module descriptor registered in [`fr_core::ModuleRegistry`].
#[derive(Debug, Default)]
pub struct FinanceModule;

impl FrModule for FinanceModule {
    fn descriptor(&self) -> ModuleDescriptor {
        ModuleDescriptor {
            id: "finance".into(),
            name: "Finance".into(),
            description:
                "Track invoices, receipts, and budgets linked to Nextcloud documents with CSV export."
                    .into(),
            icon: "wallet".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            status: ModuleStatus::Active,
            capabilities: vec![
                ModuleCapability::Storage,
                ModuleCapability::Preview,
                ModuleCapability::McpServerTools,
            ],
        }
    }
}

fn sqlite_err(err: rusqlite::Error) -> FrError {
    FrError::Other(format!("finance database error: {err}"))
}

/// Account-scoped SQLite ledger for invoices, receipts, and budgets.
#[derive(Clone)]
pub struct FinanceLedger {
    conn: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for FinanceLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FinanceLedger").finish()
    }
}

impl FinanceLedger {
    pub fn default_db_path() -> Result<PathBuf> {
        let proj = ProjectDirs::from("de", "foerderacer", "FRUniversalApp")
            .ok_or_else(|| FrError::InvalidConfig("unable to resolve OS data directory".into()))?;
        Ok(proj.data_local_dir().join("finance.sqlite"))
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
            CREATE TABLE IF NOT EXISTS finance_entries (
                id TEXT PRIMARY KEY,
                account_scope TEXT NOT NULL,
                kind TEXT NOT NULL,
                vendor TEXT NOT NULL,
                description TEXT NOT NULL,
                category TEXT NOT NULL,
                amount_cents INTEGER NOT NULL,
                currency TEXT NOT NULL,
                entry_date TEXT NOT NULL,
                status TEXT NOT NULL,
                cloud_file_path TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_finance_scope_date
                ON finance_entries (account_scope, entry_date DESC);
            ",
        )
        .map_err(sqlite_err)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn list_entries(&self, account_scope: &str) -> Result<Vec<FinanceEntry>> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, vendor, description, category, amount_cents, currency,
                        entry_date, status, cloud_file_path, created_at, updated_at
                 FROM finance_entries
                 WHERE account_scope = ?1
                 ORDER BY entry_date DESC, updated_at DESC",
            )
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map(params![account_scope], |r| {
                let cloud_raw: Option<String> = r.get(9)?;
                let created_raw: String = r.get(10)?;
                let updated_raw: String = r.get(11)?;
                Ok(FinanceEntry {
                    id: r.get(0)?,
                    kind: FinanceEntryKind::from_db(&r.get::<_, String>(1)?),
                    vendor: r.get(2)?,
                    description: r.get(3)?,
                    category: r.get(4)?,
                    amount_cents: r.get(5)?,
                    currency: r.get(6)?,
                    entry_date: r.get(7)?,
                    status: FinanceEntryStatus::from_db(&r.get::<_, String>(8)?),
                    cloud_file_path: cloud_raw.and_then(|p| CloudPath::parse(&p).ok()),
                    created_at: DateTime::parse_from_rfc3339(&created_raw)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                    updated_at: DateTime::parse_from_rfc3339(&updated_raw)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                })
            })
            .map_err(sqlite_err)?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(sqlite_err)?);
        }
        Ok(entries)
    }

    pub fn upsert_entry(
        &self,
        account_scope: &str,
        req: UpsertFinanceEntryRequest,
    ) -> Result<FinanceEntry> {
        let vendor = req.vendor.trim().to_owned();
        if vendor.is_empty() {
            return Err(FrError::InvalidConfig("Vendor or title is required".into()));
        }
        let currency = req.currency.trim().to_ascii_uppercase();
        if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(FrError::InvalidConfig(
                "Currency must be a 3-letter ISO code (e.g. EUR, USD)".into(),
            ));
        }
        let entry_date = req.entry_date.trim().to_owned();
        if entry_date.len() != 10 || NaiveDate::parse_from_str(&entry_date, "%Y-%m-%d").is_err() {
            return Err(FrError::InvalidConfig(
                "Date must be a valid calendar date in YYYY-MM-DD format".into(),
            ));
        }
        let cloud_file_path = match req.cloud_file_path {
            Some(ref raw) if !raw.trim().is_empty() => Some(CloudPath::parse(raw)?),
            _ => None,
        };

        let now = Utc::now();
        let id = req
            .id
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let category = if req.category.trim().is_empty() {
            "General".to_owned()
        } else {
            req.category.trim().to_owned()
        };
        let description = req.description.trim().to_owned();

        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let affected = conn
            .execute(
                "INSERT INTO finance_entries
                 (id, account_scope, kind, vendor, description, category, amount_cents, currency,
                  entry_date, status, cloud_file_path, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET
                   kind = excluded.kind,
                   vendor = excluded.vendor,
                   description = excluded.description,
                   category = excluded.category,
                   amount_cents = excluded.amount_cents,
                   currency = excluded.currency,
                   entry_date = excluded.entry_date,
                   status = excluded.status,
                   cloud_file_path = excluded.cloud_file_path,
                   updated_at = excluded.updated_at
                 WHERE account_scope = excluded.account_scope",
                params![
                    id,
                    account_scope,
                    req.kind.as_db(),
                    vendor,
                    description,
                    category,
                    req.amount_cents,
                    currency,
                    entry_date,
                    req.status.as_db(),
                    cloud_file_path.as_ref().map(CloudPath::as_str),
                    now.to_rfc3339(),
                    now.to_rfc3339(),
                ],
            )
            .map_err(sqlite_err)?;
        if affected == 0 {
            return Err(FrError::NotFound(format!(
                "finance entry '{id}' does not belong to the active account"
            )));
        }

        Ok(FinanceEntry {
            id,
            kind: req.kind,
            vendor,
            description,
            category,
            amount_cents: req.amount_cents,
            currency,
            entry_date,
            status: req.status,
            cloud_file_path,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn delete_entry(&self, account_scope: &str, id: &str) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        conn.execute(
            "DELETE FROM finance_entries WHERE id = ?1 AND account_scope = ?2",
            params![id, account_scope],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    pub fn summarize(&self, account_scope: &str) -> Result<Vec<FinanceCurrencySummary>> {
        let entries = self.list_entries(account_scope)?;
        let mut by_curr: std::collections::BTreeMap<String, FinanceCurrencySummary> =
            std::collections::BTreeMap::new();
        for entry in entries {
            let summary =
                by_curr
                    .entry(entry.currency.clone())
                    .or_insert_with(|| FinanceCurrencySummary {
                        currency: entry.currency.clone(),
                        total_invoices_cents: 0,
                        total_receipts_cents: 0,
                        total_budgets_cents: 0,
                        pending_count: 0,
                        entry_count: 0,
                    });
            match entry.kind {
                FinanceEntryKind::Invoice => {
                    summary.total_invoices_cents = summary
                        .total_invoices_cents
                        .saturating_add(entry.amount_cents);
                }
                FinanceEntryKind::Receipt => {
                    summary.total_receipts_cents = summary
                        .total_receipts_cents
                        .saturating_add(entry.amount_cents);
                }
                FinanceEntryKind::Budget => {
                    summary.total_budgets_cents = summary
                        .total_budgets_cents
                        .saturating_add(entry.amount_cents);
                }
            }
            if entry.status == FinanceEntryStatus::Pending {
                summary.pending_count += 1;
            }
            summary.entry_count += 1;
        }
        Ok(by_curr.into_values().collect())
    }

    /// Exports all entries for `account_scope` as RFC 4180 CSV with spreadsheet formula-injection
    /// neutralization (`=`, `+`, `-`, `@`, `\t`, `\r` prefixed with `'`).
    pub fn export_csv(&self, account_scope: &str) -> Result<String> {
        let entries = self.list_entries(account_scope)?;
        let mut out = String::from(
            "Date,Kind,Vendor,Category,Amount,Currency,Status,Description,NextcloudFile\r\n",
        );
        for e in entries {
            let amount = format_cents_exact(e.amount_cents);
            let fields = [
                csv_escape(&e.entry_date),
                csv_escape(e.kind.as_db()),
                csv_escape(&e.vendor),
                csv_escape(&e.category),
                amount,
                csv_escape(&e.currency),
                csv_escape(e.status.as_db()),
                csv_escape(&e.description),
                csv_escape(e.cloud_file_path.as_ref().map_or("", CloudPath::as_str)),
            ];
            out.push_str(&fields.join(","));
            out.push_str("\r\n");
        }
        Ok(out)
    }
}

fn format_cents_exact(amount_cents: i64) -> String {
    let sign = if amount_cents < 0 { "-" } else { "" };
    let abs = amount_cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

fn csv_escape(raw: &str) -> String {
    let trimmed_start = raw.trim_start();
    let neutralized = if trimmed_start.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{raw}")
    } else {
        raw.to_owned()
    };
    let escaped = neutralized.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// Callback returning the active account scope (`server|login`) for MCP Finance tool calls.
pub type AccountScopeProvider = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// Registers `finance_*` tools in the built-in local MCP Server.
pub fn register_finance_tools(
    registry: &McpToolRegistry,
    ledger: Arc<FinanceLedger>,
    scope_provider: AccountScopeProvider,
) {
    registry.register(FinanceListTool(ledger.clone(), scope_provider.clone()));
    registry.register(FinanceSummaryTool(ledger.clone(), scope_provider.clone()));
    registry.register(FinanceAddTool(ledger, scope_provider));
}

fn require_scope(provider: &AccountScopeProvider) -> Result<String> {
    provider()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| FrError::AuthRequired("Nextcloud is not signed in".into()))
}

struct FinanceListTool(Arc<FinanceLedger>, AccountScopeProvider);

#[async_trait]
impl McpToolHandler for FinanceListTool {
    fn name(&self) -> &str {
        "finance_list_entries"
    }
    fn description(&self) -> &str {
        "List invoices, receipts, and budgets recorded in the workspace Finance ledger."
    }
    fn module_id(&self) -> &str {
        "finance"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    fn summarize_audit(&self, _args: &Value) -> String {
        "List finance entries".into()
    }
    async fn call(&self, _args: Value) -> Result<Value> {
        let scope = require_scope(&self.1)?;
        let entries = self.0.list_entries(&scope)?;
        Ok(serde_json::to_value(entries)?)
    }
}

struct FinanceSummaryTool(Arc<FinanceLedger>, AccountScopeProvider);

#[async_trait]
impl McpToolHandler for FinanceSummaryTool {
    fn name(&self) -> &str {
        "finance_summary"
    }
    fn description(&self) -> &str {
        "Return aggregated Finance totals (invoices, receipts, budgets, pending counts) per currency."
    }
    fn module_id(&self) -> &str {
        "finance"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    fn summarize_audit(&self, _args: &Value) -> String {
        "Summarize finance ledger".into()
    }
    async fn call(&self, _args: Value) -> Result<Value> {
        let scope = require_scope(&self.1)?;
        let summary = self.0.summarize(&scope)?;
        Ok(serde_json::to_value(summary)?)
    }
}

struct FinanceAddTool(Arc<FinanceLedger>, AccountScopeProvider);

#[async_trait]
impl McpToolHandler for FinanceAddTool {
    fn name(&self) -> &str {
        "finance_add_entry"
    }
    fn description(&self) -> &str {
        "Add a new invoice, receipt, or budget entry to the Finance ledger (requires user approval)."
    }
    fn module_id(&self) -> &str {
        "finance"
    }
    fn is_write(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["vendor", "amount_cents", "currency", "entry_date"],
            "properties": {
                "kind": { "type": "string", "enum": ["invoice", "receipt", "budget"], "default": "invoice" },
                "vendor": { "type": "string" },
                "description": { "type": "string" },
                "category": { "type": "string" },
                "amount_cents": { "type": "integer", "description": "Amount in minor units (e.g. 1250 = 12.50)." },
                "currency": { "type": "string", "description": "3-letter ISO currency code (e.g. EUR)." },
                "entry_date": { "type": "string", "description": "Date in YYYY-MM-DD format." },
                "cloud_file_path": { "type": "string", "description": "Optional linked Nextcloud file path." }
            }
        })
    }
    fn summarize_audit(&self, args: &Value) -> String {
        let kind = args
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("invoice");
        let curr = args
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("EUR");
        format!("Add finance {kind} ({curr})")
    }
    fn summarize_approval(&self, args: &Value) -> String {
        let vendor = args.get("vendor").and_then(Value::as_str).unwrap_or("?");
        let curr = args
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("EUR");
        let amount = args
            .get("amount_cents")
            .and_then(Value::as_i64)
            .map(format_cents_exact)
            .unwrap_or_else(|| "?".into());
        format!("Add finance entry for '{vendor}' ({amount} {curr})")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let scope = require_scope(&self.1)?;
        let vendor = args
            .get("vendor")
            .and_then(Value::as_str)
            .ok_or_else(|| FrError::InvalidConfig("missing 'vendor'".into()))?
            .to_owned();
        let amount_cents = args
            .get("amount_cents")
            .and_then(Value::as_i64)
            .ok_or_else(|| FrError::InvalidConfig("missing integer 'amount_cents'".into()))?;
        let currency = args
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("EUR")
            .to_owned();
        let entry_date = args
            .get("entry_date")
            .and_then(Value::as_str)
            .ok_or_else(|| FrError::InvalidConfig("missing 'entry_date' (YYYY-MM-DD)".into()))?
            .to_owned();
        let kind = FinanceEntryKind::from_db(
            args.get("kind")
                .and_then(Value::as_str)
                .unwrap_or("invoice"),
        );
        let entry = self.0.upsert_entry(
            &scope,
            UpsertFinanceEntryRequest {
                id: None,
                kind,
                vendor,
                description: args
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                category: args
                    .get("category")
                    .and_then(Value::as_str)
                    .unwrap_or("General")
                    .to_owned(),
                amount_cents,
                currency,
                entry_date,
                status: FinanceEntryStatus::Pending,
                cloud_file_path: args
                    .get("cloud_file_path")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            },
        )?;
        Ok(serde_json::to_value(entry)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn finance_ledger_isolates_accounts_summarizes_and_neutralizes_csv() {
        let dir = tempdir().unwrap();
        let ledger = FinanceLedger::open(dir.path().join("finance.sqlite")).unwrap();

        let e1 = ledger
            .upsert_entry(
                "https://cloud.example|alice",
                UpsertFinanceEntryRequest {
                    id: None,
                    kind: FinanceEntryKind::Invoice,
                    vendor: "=HYPERLINK(\"http://evil\")".into(),
                    description: "Carbon fiber sheets".into(),
                    category: "Materials".into(),
                    amount_cents: 45_000,
                    currency: "eur".into(),
                    entry_date: "2026-11-25".into(),
                    status: FinanceEntryStatus::Pending,
                    cloud_file_path: Some("/Finance/inv-01.pdf".into()),
                },
            )
            .unwrap();
        assert_eq!(e1.currency, "EUR");

        // Bob on the same server cannot see Alice's ledger.
        assert!(
            ledger
                .list_entries("https://cloud.example|bob")
                .unwrap()
                .is_empty()
        );

        let summaries = ledger.summarize("https://cloud.example|alice").unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].total_invoices_cents, 45_000);
        assert_eq!(summaries[0].pending_count, 1);

        let csv = ledger.export_csv("https://cloud.example|alice").unwrap();
        assert!(csv.contains("\"'=HYPERLINK("));
        assert!(csv.contains("450.00"));

        // Invalid calendar date must be rejected.
        assert!(
            ledger
                .upsert_entry(
                    "https://cloud.example|alice",
                    UpsertFinanceEntryRequest {
                        id: None,
                        kind: FinanceEntryKind::Receipt,
                        vendor: "Test".into(),
                        description: String::new(),
                        category: "General".into(),
                        amount_cents: 100,
                        currency: "EUR".into(),
                        entry_date: "2026-02-31".into(),
                        status: FinanceEntryStatus::Pending,
                        cloud_file_path: None,
                    },
                )
                .is_err()
        );

        // Bob cannot overwrite Alice's entry by reusing her entry ID.
        assert!(
            ledger
                .upsert_entry(
                    "https://cloud.example|bob",
                    UpsertFinanceEntryRequest {
                        id: Some(e1.id),
                        kind: FinanceEntryKind::Invoice,
                        vendor: "Hijacked".into(),
                        description: String::new(),
                        category: "General".into(),
                        amount_cents: 1,
                        currency: "EUR".into(),
                        entry_date: "2026-11-25".into(),
                        status: FinanceEntryStatus::Paid,
                        cloud_file_path: None,
                    },
                )
                .is_err()
        );
    }
}
