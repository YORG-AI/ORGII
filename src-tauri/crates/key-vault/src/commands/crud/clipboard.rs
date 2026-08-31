/// Write text to the system clipboard via arboard.
/// Used by the frontend when `navigator.clipboard.writeText` fails (e.g.
/// after an async RPC call where the user-gesture token has expired).
#[tauri::command]
pub async fn clipboard_write_text(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|err| format!("Clipboard access failed: {}", err))?;
        clipboard
            .set_text(&text)
            .map_err(|err| format!("Clipboard write failed: {}", err))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}
