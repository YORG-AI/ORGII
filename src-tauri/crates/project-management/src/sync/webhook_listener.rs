//! Inbound webhook listener for the sync framework.
//!
//! The listener is a single axum route mounted on the unified IDE
//! HTTP server (`api::server`) at `POST /sync/webhook/:adapter_id/:slug`.
//! It is **not** a separate socket — the IDE server already owns
//! port 13847 on the loopback interface, and webhook delivery
//! reaches the listener through whatever tunnel the user has put
//! in front of that port (cloudflared / ngrok / tailscale-funnel).
//!
//! Per-request flow:
//!
//! 1. Path params `(adapter_id, project_slug)` resolve the adapter
//!    in the global registry and the shared HMAC secret in
//!    `webhook_secrets`. A missing adapter or missing secret short-
//!    circuits to **404**: the listener never reveals which side is
//!    missing (refuse to confirm the existence of the project to a
//!    caller that can't already prove they own the secret).
//! 2. The adapter's `verify_webhook` runs against the raw body +
//!    headers. Mismatch → **401**, telemetry records
//!    `MetricOutcome::AuthFailed`, no DB mutation. This is the only
//!    side-channel a remote can probe; constant-time compare in the
//!    individual adapter impls keeps it from being a timing oracle.
//! 3. Verified deliveries flow through `adapter.handle_webhook`,
//!    which produces the same `ExternalChange` shape the pull cycle
//!    emits. The listener writes them as `merge_external` outbox
//!    rows so the existing merge cycle picks them up — no separate
//!    apply path. This is the reason `handle_webhook` is wired
//!    through the same trait as `pull`: webhook ingestion is a
//!    latency optimization, not a new data path.
//! 4. `projects.sync_last_webhook_at` is stamped so the worker's
//!    poll-cycle scheduler can skip the next 5-minute poll
//!    (freshness window: 10 min). The pull-cycle stamp
//!    (`sync_last_pull_at`) is **not** advanced — that one tracks
//!    cursor progress, which webhooks don't carry.
//! 5. Telemetry: every delivery records exactly one `MetricKind::Webhook`
//!    row. `MetricOutcome::Empty` covers no-change deliveries
//!    (e.g. GitHub `ping` events) so the dashboard can distinguish
//!    "we got an irrelevant delivery" from "we got a delivery and
//!    skipped the poll."
//!
//! # Headers folding
//!
//! axum hands us a [`HeaderMap`]; we collapse to lower-cased name →
//! first value before calling the adapter. This shields adapter code
//! from the wire-format spelling (`Linear-Signature` vs
//! `linear-signature`) and matches what every webhook spec we ship
//! expects. Multi-valued headers are degraded to "first wins" — none
//! of our supported providers rely on header repetition for their
//! signature scheme.

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use tracing::{debug, warn};

use super::adapter::{ExternalChange, SyncContext, WebhookHeaders};
use super::adapters;
use super::io;
use super::metrics::{self, MetricKind, MetricOutcome};
use super::types::{OutboxEntry, OutboxOp, OutboxStatus, SyncError};
use super::webhook_secrets;

/// HTTP path the listener registers under. Exposed as `pub const`
/// so the install command can build the user-visible webhook URL
/// without duplicating the literal.
pub const WEBHOOK_BASE_PATH: &str = "/sync/webhook";

/// Build the route fragment for the unified IDE server to nest.
///
/// `api::server::start_server` calls this and merges the result into
/// its top-level router. Returns a `Router<()>` (no shared state) —
/// every dependency the handler needs (registry, DB pool) is a
/// process-singleton accessed through the standard module entry
/// points.
pub fn router() -> Router {
    Router::new()
        .route(
            "/sync/webhook/{adapter_id}/{project_slug}",
            post(handle_webhook_request),
        )
        .route(
            "/routine/webhook/{routine_name}",
            post(crate::work_item_features::routine_webhook::handle_http),
        )
}

/// Path params for the webhook route.
#[derive(Debug, serde::Deserialize)]
struct WebhookPath {
    adapter_id: String,
    project_slug: String,
}

/// Single handler — both `Path` and `Bytes` extractors run before we
/// see the request, so a malformed path 400s upstream and a body
/// larger than axum's default cap (2MB) is rejected by the framework.
async fn handle_webhook_request(
    Path(path): Path<WebhookPath>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = std::time::Instant::now();
    match handle_inner(&path, &headers, &body).await {
        Ok(WebhookResult { changes_count }) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            metrics::record(
                path.project_slug.clone(),
                path.adapter_id.clone(),
                MetricKind::Webhook,
                if changes_count == 0 {
                    MetricOutcome::Empty
                } else {
                    MetricOutcome::Ok
                },
                duration_ms,
                changes_count,
            );
            (StatusCode::OK, "ok").into_response()
        }
        Err(WebhookHandlerError {
            status,
            note,
            outcome,
        }) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            metrics::record_with_note(
                path.project_slug.clone(),
                path.adapter_id.clone(),
                MetricKind::Webhook,
                outcome,
                duration_ms,
                /* count = */ 0,
                note.clone(),
            );
            warn!(
                "[sync::webhook] reject project='{}' adapter='{}' status={} note={}",
                path.project_slug, path.adapter_id, status, note
            );
            (status, note).into_response()
        }
    }
}

#[cfg_attr(test, derive(Debug))]
struct WebhookResult {
    changes_count: u64,
}

#[cfg_attr(test, derive(Debug))]
struct WebhookHandlerError {
    status: StatusCode,
    note: String,
    outcome: MetricOutcome,
}

impl WebhookHandlerError {
    fn not_found(note: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            note: note.into(),
            outcome: MetricOutcome::Permanent,
        }
    }

    fn auth_failed(note: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            note: note.into(),
            outcome: MetricOutcome::Auth,
        }
    }

    fn permanent(note: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            note: note.into(),
            outcome: MetricOutcome::Permanent,
        }
    }

    fn internal(note: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            note: note.into(),
            outcome: MetricOutcome::Transient,
        }
    }
}

async fn handle_inner(
    path: &WebhookPath,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<WebhookResult, WebhookHandlerError> {
    // 1. Resolve adapter (404 hides "we have no such adapter installed").
    let adapter = adapters::get(&path.adapter_id)
        .ok_or_else(|| WebhookHandlerError::not_found("adapter not found"))?;

    if !adapter.supports_webhook() {
        // The `supports_webhook` flag is the listener's source of
        // truth; an adapter with no webhook impl returns 404 even if
        // a stale secret row exists for it.
        return Err(WebhookHandlerError::not_found(
            "adapter does not accept webhooks",
        ));
    }

    // 2. Resolve secret (same 404 hides "we have no secret installed").
    let owned_slug = path.project_slug.clone();
    let owned_adapter = path.adapter_id.clone();
    let secret = tokio::task::spawn_blocking(move || {
        webhook_secrets::read_via_pool(&owned_slug, &owned_adapter)
    })
    .await
    .map_err(|err| WebhookHandlerError::internal(format!("secret lookup join error: {}", err)))?
    .map_err(WebhookHandlerError::internal)?
    .ok_or_else(|| WebhookHandlerError::not_found("webhook not installed for this project"))?;

    // 3. HMAC verify. Adapter-specific so each provider's signature
    //    header / scheme stays in one place.
    let folded_headers = fold_headers(headers);
    if let Err(err) = adapter.verify_webhook(body, &folded_headers, &secret.secret_hex) {
        return Err(match err {
            SyncError::AuthFailed(msg) => WebhookHandlerError::auth_failed(msg),
            SyncError::Permanent(msg) => WebhookHandlerError::permanent(msg),
            other => WebhookHandlerError::internal(other.to_string()),
        });
    }

    // 4. Resolve adapter binding for this project to build the
    //    `SyncContext`. A project that has installed a webhook secret
    //    but isn't bound (sync_kind='none') indicates a stale install
    //    — reject as permanent so the user re-attaches.
    let binding_slug = path.project_slug.clone();
    let binding = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let conn = io::conn()?;
        io::read_adapter_binding(&conn, &binding_slug)
    })
    .await
    .map_err(|err| WebhookHandlerError::internal(format!("binding join error: {}", err)))?
    .map_err(WebhookHandlerError::internal)?
    .ok_or_else(|| {
        WebhookHandlerError::permanent(
            "project has no sync adapter bound — re-attach to receive webhooks",
        )
    })?;

    if binding.adapter_id != path.adapter_id {
        return Err(WebhookHandlerError::permanent(format!(
            "webhook adapter mismatch: project bound to '{}', delivery for '{}'",
            binding.adapter_id, path.adapter_id
        )));
    }
    let config_json = binding.config_json;

    let ctx = SyncContext {
        adapter_id: path.adapter_id.clone(),
        // Tokens aren't needed to parse a webhook body — verification
        // is HMAC, not bearer. Pass `None` so the adapter's parser
        // doesn't accidentally try to make a follow-up API call from
        // inside the parse path.
        auth_token: None,
        project_slug: path.project_slug.clone(),
        cursor_blob: None,
        config_json,
    };

    let changes = adapter
        .handle_webhook(body, &folded_headers, &ctx)
        .await
        .map_err(|err| match err {
            SyncError::AuthFailed(msg) => WebhookHandlerError::auth_failed(msg),
            SyncError::Permanent(msg) => WebhookHandlerError::permanent(msg),
            SyncError::Transient(msg) => WebhookHandlerError::internal(msg),
            SyncError::RateLimited { message, .. } => WebhookHandlerError::internal(message),
        })?;

    let changes_count = persist_changes(&path.project_slug, changes)
        .await
        .map_err(WebhookHandlerError::internal)?;

    debug!(
        "[sync::webhook] accepted project='{}' adapter='{}' changes={}",
        path.project_slug, path.adapter_id, changes_count
    );

    Ok(WebhookResult { changes_count })
}

/// Persist the adapter's parsed `ExternalChange` list as
/// `merge_external` outbox rows (the same shape the pull cycle
/// emits) and stamp `projects.sync_last_webhook_at`.
///
/// Returns the number of changes persisted so the caller can
/// classify the metric outcome (`Empty` vs `Ok`).
async fn persist_changes(slug: &str, changes: Vec<ExternalChange>) -> Result<u64, String> {
    let owned_slug = slug.to_string();
    let result = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let conn = io::conn()?;
        let now = now_ms();
        for change in &changes {
            let payload = serde_json::to_string(change).map_err(|err| {
                format!(
                    "merge_external payload serialization failed (webhook): {}",
                    err
                )
            })?;
            let row = OutboxEntry {
                id: None,
                project_slug: owned_slug.clone(),
                entity_type: change.entity_type,
                entity_id: change.external_id.clone(),
                op: OutboxOp::MergeExternal,
                field_path: None,
                payload_json: payload,
                created_at: now,
                retry_count: 0,
                last_attempted_at: None,
                last_error: None,
                status: OutboxStatus::Pending,
            };
            io::append(&conn, &row)?;
        }
        // `sync_last_webhook_at` is the gate the pull-cycle scheduler
        // uses to skip a poll. It updates on every delivery — even
        // empty ones — because GitHub's `ping` event is a real
        // signal of "the webhook is reachable", which is exactly
        // what the scheduler wants to know.
        conn.execute(
            "UPDATE projects SET sync_last_webhook_at = ?1 WHERE slug = ?2",
            rusqlite::params![now, owned_slug],
        )
        .map_err(|err| format!("DB error (stamp last_webhook_at): {}", err))?;
        Ok(changes.len() as u64)
    })
    .await
    .map_err(|err| format!("webhook persist join error: {}", err))?;
    result
}

/// Fold an [`HeaderMap`] into the lower-cased single-value form
/// adapters expect. See module docs for why first-wins is correct.
fn fold_headers(headers: &HeaderMap) -> WebhookHeaders {
    let mut out = WebhookHeaders::with_capacity(headers.len());
    for (name, value) in headers.iter() {
        // axum strips invalid bytes from header values during
        // parsing, so `to_str` only fails on non-ASCII bytes.
        // Skipping the entry is correct — adapters cannot validate
        // a header they can't read.
        if let Ok(text) = value.to_str() {
            out.entry(name.as_str().to_lowercase())
                .or_insert_with(|| text.to_string());
        }
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|dur| dur.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn fold_headers_lower_cases_names() {
        let mut headers = HeaderMap::new();
        headers.insert("Linear-Signature", HeaderValue::from_static("abc"));
        headers.insert("X-Hub-Signature-256", HeaderValue::from_static("def"));

        let folded = fold_headers(&headers);
        assert_eq!(
            folded.get("linear-signature").map(String::as_str),
            Some("abc")
        );
        assert_eq!(
            folded.get("x-hub-signature-256").map(String::as_str),
            Some("def")
        );
    }

    #[test]
    fn fold_headers_first_wins_for_repeated_header() {
        let mut headers = HeaderMap::new();
        headers.append("X-Custom", HeaderValue::from_static("first"));
        headers.append("X-Custom", HeaderValue::from_static("second"));

        let folded = fold_headers(&headers);
        // axum's HeaderMap iterator yields entries in insertion
        // order; we lock in "first wins" because none of our supported
        // providers depend on header repetition.
        assert_eq!(folded.get("x-custom").map(String::as_str), Some("first"));
    }

    #[test]
    fn fold_headers_skips_non_ascii_values() {
        let mut headers = HeaderMap::new();
        headers.insert("X-Bad", HeaderValue::from_bytes(&[0xff]).unwrap());
        headers.insert("X-Good", HeaderValue::from_static("ok"));

        let folded = fold_headers(&headers);
        assert!(!folded.contains_key("x-bad"));
        assert_eq!(folded.get("x-good").map(String::as_str), Some("ok"));
    }

    // ── Integration tests for `handle_inner` ──
    //
    // These exercise the full request pipeline (adapter resolution,
    // secret lookup, signature verification, binding check, change
    // persistence, last-webhook-at stamping) against an in-process
    // SQLite sandbox. They use the `EchoAdapter` because it is the
    // only adapter whose webhook signature scheme we control end-to-
    // end without a real upstream provider.

    use crate::sync::adapters::echo::ECHO_SIGNATURE_HEADER;
    use crate::sync::worker::WEBHOOK_FRESHNESS_WINDOW_MS;
    use crate::sync::{io as sync_io, webhook_secrets};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use test_helpers::test_env;

    fn echo_signature(body: &[u8], secret_hex: &str) -> String {
        let key = hex::decode(secret_hex).expect("hex secret");
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).expect("mac key");
        mac.update(body);
        format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
    }

    fn seed_project_and_attach_echo(slug: &str) {
        let conn = sync_io::conn().expect("conn");
        crate::projects::schema::init_project_tables(&conn).expect("init schema");
        conn.execute(
            "INSERT INTO projects (id, name, slug, short_id_prefix, created_at, updated_at)
             VALUES (?1, ?1, ?2, 'AAA', 0, 0)",
            rusqlite::params![format!("p-{}", slug), slug],
        )
        .expect("insert project");
        sync_io::attach_adapter(&conn, slug, "echo", "{}", "connection-echo").expect("attach echo");
    }

    fn install_secret(slug: &str) -> String {
        let conn = sync_io::conn().expect("conn");
        webhook_secrets::rotate_secret(&conn, slug, "echo", 1).expect("install secret")
    }

    #[tokio::test]
    async fn handle_inner_unknown_adapter_returns_404() {
        let _sandbox = test_env::sandbox();
        let path = WebhookPath {
            adapter_id: "no_such_adapter".to_string(),
            project_slug: "alpha".to_string(),
        };
        let err = handle_inner(&path, &HeaderMap::new(), &Bytes::new())
            .await
            .expect_err("must reject unknown adapter");
        assert_eq!(err.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn handle_inner_missing_secret_returns_404() {
        let _sandbox = test_env::sandbox();
        seed_project_and_attach_echo("alpha");
        let path = WebhookPath {
            adapter_id: "echo".to_string(),
            project_slug: "alpha".to_string(),
        };
        let err = handle_inner(&path, &HeaderMap::new(), &Bytes::new())
            .await
            .expect_err("must reject when no secret installed");
        assert_eq!(err.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn handle_inner_bad_signature_returns_401_and_no_outbox_rows() {
        let _sandbox = test_env::sandbox();
        seed_project_and_attach_echo("alpha");
        let _secret = install_secret("alpha");

        let path = WebhookPath {
            adapter_id: "echo".to_string(),
            project_slug: "alpha".to_string(),
        };
        let body = Bytes::from_static(br#"{"changes":[]}"#);
        let mut headers = HeaderMap::new();
        // Wrong signature — derived from a secret we never installed.
        let bogus = echo_signature(&body, &"00".repeat(32));
        headers.insert(
            ECHO_SIGNATURE_HEADER,
            axum::http::HeaderValue::from_str(&bogus).expect("header"),
        );

        let err = handle_inner(&path, &headers, &body)
            .await
            .expect_err("must reject bad signature");
        assert_eq!(err.status, StatusCode::UNAUTHORIZED);

        let conn = sync_io::conn().expect("conn");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox_entries WHERE project_slug = 'alpha'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 0, "rejected delivery must not write outbox rows");

        let stamp: Option<i64> = conn
            .query_row(
                "SELECT sync_last_webhook_at FROM projects WHERE slug = 'alpha'",
                [],
                |row| row.get(0),
            )
            .expect("stamp");
        assert!(
            stamp.is_none(),
            "rejected delivery must not stamp last_webhook_at"
        );
    }

    #[tokio::test]
    async fn handle_inner_valid_delivery_persists_changes_and_stamps_clock() {
        let _sandbox = test_env::sandbox();
        seed_project_and_attach_echo("alpha");
        let secret = install_secret("alpha");

        let path = WebhookPath {
            adapter_id: "echo".to_string(),
            project_slug: "alpha".to_string(),
        };
        let body = Bytes::from_static(
            br#"{"changes":[{"entity_type":"work_item","external_id":"ext-1","fields":{},"updated_at":"2026-01-01T00:00:00Z","deleted":false}]}"#,
        );
        let sig = echo_signature(&body, &secret);
        let mut headers = HeaderMap::new();
        headers.insert(
            ECHO_SIGNATURE_HEADER,
            axum::http::HeaderValue::from_str(&sig).expect("header"),
        );

        let result = handle_inner(&path, &headers, &body)
            .await
            .expect("valid delivery");
        assert_eq!(result.changes_count, 1);

        let conn = sync_io::conn().expect("conn");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox_entries
                  WHERE project_slug = 'alpha' AND op = 'merge_external'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 1, "valid delivery must enqueue merge_external row");

        let stamp: Option<i64> = conn
            .query_row(
                "SELECT sync_last_webhook_at FROM projects WHERE slug = 'alpha'",
                [],
                |row| row.get(0),
            )
            .expect("stamp");
        let stamp = stamp.expect("clock must be stamped");
        // Sanity-check: stamp falls inside the freshness window of "now"
        // — would only fail if the system clock was wildly skewed.
        let now = now_ms();
        assert!(
            (now - stamp).unsigned_abs() < WEBHOOK_FRESHNESS_WINDOW_MS as u64,
            "stamp {} too far from now {}",
            stamp,
            now
        );
    }

    #[tokio::test]
    async fn handle_inner_empty_delivery_still_stamps_clock() {
        // Mirrors GitHub `ping` — adapter parses zero changes but the
        // delivery is a real signal of webhook reachability.
        let _sandbox = test_env::sandbox();
        seed_project_and_attach_echo("alpha");
        let secret = install_secret("alpha");

        let path = WebhookPath {
            adapter_id: "echo".to_string(),
            project_slug: "alpha".to_string(),
        };
        let body = Bytes::from_static(br#"{"changes":[]}"#);
        let sig = echo_signature(&body, &secret);
        let mut headers = HeaderMap::new();
        headers.insert(
            ECHO_SIGNATURE_HEADER,
            axum::http::HeaderValue::from_str(&sig).expect("header"),
        );

        let result = handle_inner(&path, &headers, &body)
            .await
            .expect("empty delivery");
        assert_eq!(result.changes_count, 0);

        let conn = sync_io::conn().expect("conn");
        let stamp: Option<i64> = conn
            .query_row(
                "SELECT sync_last_webhook_at FROM projects WHERE slug = 'alpha'",
                [],
                |row| row.get(0),
            )
            .expect("stamp");
        assert!(stamp.is_some(), "empty delivery must still stamp clock");
    }
}
