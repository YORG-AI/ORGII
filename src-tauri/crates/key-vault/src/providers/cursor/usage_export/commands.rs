use crate::key_store::{ModelType, KEY_SERVICE};

use super::{
    coordinator::CursorUsageExporter,
    types::{
        ArchivedCursorUsageCache, CursorUsageAccount, CursorUsageError, CursorUsageFailureKind,
        CursorUsagePage, CursorUsageSnapshot,
    },
    DEFAULT_CURSOR_USAGE_PAGE_SIZE,
};

/// Sync one stored Cursor Key Vault account without touching local session
/// history. This is the narrow Rust entry point for background coordinators
/// and command wrappers.
pub async fn sync_key_vault_cursor_billing_usage(
    account_id: String,
    force: bool,
) -> Result<CursorUsageSnapshot, CursorUsageError> {
    let account = load_key_vault_cursor_usage_account(account_id).await?;
    CursorUsageExporter::for_key_vault()?
        .sync_account(&account, force)
        .await
}

async fn load_key_vault_cursor_usage_account(
    account_id: String,
) -> Result<CursorUsageAccount, CursorUsageError> {
    let lookup_id = account_id.clone();
    let key = tokio::task::spawn_blocking(move || {
        KEY_SERVICE.get_key_checked(&ModelType::CursorCli, Some(&lookup_id))
    })
    .await
    .map_err(|error| {
        CursorUsageError::new(
            CursorUsageFailureKind::Cache,
            format!("Cursor account lookup task failed: {error}"),
        )
    })?
    .map_err(|error| CursorUsageError::new(CursorUsageFailureKind::Cache, error))?
    .ok_or_else(|| {
        CursorUsageError::new(
            CursorUsageFailureKind::InvalidAccount,
            format!("Cursor account {account_id} was not found"),
        )
    })?;
    CursorUsageAccount::from_model_key(&key)
}

/// Tauri-ready command. The app crate only needs to register this symbol in
/// its handler list; no duplicate fetch/cache implementation is required.
#[tauri::command]
pub async fn cursor_sync_billing_usage(
    account_id: String,
    force: bool,
) -> Result<CursorUsageSnapshot, String> {
    sync_key_vault_cursor_billing_usage(account_id, force)
        .await
        .map_err(|error| error.to_string())
}

/// Read a hard-bounded page from the current account's private raw cache.
#[tauri::command]
pub async fn cursor_read_billing_usage_page(
    account_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
) -> Result<CursorUsagePage, String> {
    let account = load_key_vault_cursor_usage_account(account_id)
        .await
        .map_err(|error| error.to_string())?;
    CursorUsageExporter::for_key_vault()
        .map_err(|error| error.to_string())?
        .read_account_page(
            &account,
            cursor.as_deref(),
            limit.unwrap_or(DEFAULT_CURSOR_USAGE_PAGE_SIZE),
        )
        .await
        .map_err(|error| error.to_string())
}

/// Tauri-ready logout hook for the bounded, recoverable account archive.
#[tauri::command]
pub async fn cursor_archive_billing_usage_cache(
    account_id: String,
) -> Result<ArchivedCursorUsageCache, String> {
    CursorUsageExporter::for_key_vault()
        .map_err(|error| error.to_string())?
        .archive_account_cache(&account_id)
        .await
        .map_err(|error| error.to_string())
}
