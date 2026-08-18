use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const IDENTITY_SNAPSHOT_INVALIDATED_EVENT: &str = "identity://snapshot-invalidated";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentitySnapshotInvalidated {
    revision: u64,
}

pub fn emit_snapshot_invalidated(app: &AppHandle, revision: u64) {
    if let Err(error) = app.emit(
        IDENTITY_SNAPSHOT_INVALIDATED_EVENT,
        IdentitySnapshotInvalidated { revision },
    ) {
        tracing::warn!(
            %error,
            revision,
            "failed to emit identity snapshot invalidation"
        );
    }
}
