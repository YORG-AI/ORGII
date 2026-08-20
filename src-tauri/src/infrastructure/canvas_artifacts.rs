//! In-memory publish store + custom-scheme serving for agent-generated React
//! canvas artifacts.
//!
//! The packaged webview CSP (`script-src 'self' 'wasm-unsafe-eval'`) cannot
//! execute agent-generated code in-page, and srcdoc iframes inherit the
//! parent policy in WebView2, so an inline-script srcdoc runtime cannot run
//! either. Instead the frontend compiles the artifact into a self-contained
//! HTML document (`reactArtifactDocument.ts`), publishes it here via the
//! `canvas_artifact_publish` command, and renders an iframe whose `src`
//! points at the dedicated `canvas-artifact` URI scheme. Serving the
//! document from this scheme gives the frame its own origin, and the
//! response carries its own `Content-Security-Policy`, so the inline
//! runtime executes while the parent policy only needs a `frame-src`
//! allowance (see `tauri.conf.json`).
//!
//! On Windows, WebView2 maps the scheme onto `http://canvas-artifact.localhost/<id>`;
//! WKWebView/WebKitGTK keep `canvas-artifact://localhost/<id>`. Both shapes
//! put the artifact id in the request path, which is all the handler reads.

use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::Mutex;

/// Maximum number of stored artifacts; the oldest insertion evicts first.
pub const MAX_STORED_ARTIFACTS: usize = 16;

/// Maximum total bytes across all stored artifacts.
pub const MAX_STORED_BYTES: usize = 8 * 1024 * 1024;

/// Maximum size of a single published artifact document.
pub const MAX_ARTIFACT_BYTES: usize = 2 * 1024 * 1024;

/// CSP attached to every artifact response. Mirrors the `<meta http-equiv>`
/// policy embedded in the document by `reactArtifactDocument.ts` (the
/// effective policy is the intersection of the two). `connect-src 'none'`
/// guarantees zero fetch/XHR/WebSocket egress from artifact code, including
/// to the Tauri IPC endpoints.
const ARTIFACT_RESPONSE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";

/// Bounded, insertion-ordered artifact store. Bounds are enforced on insert:
/// entries beyond [`MAX_STORED_ARTIFACTS`] or [`MAX_STORED_BYTES`] evict from
/// the oldest end. Re-publishing an existing id replaces its content and
/// refreshes its position to newest.
#[derive(Default)]
pub struct CanvasArtifactStore {
    inner: Mutex<StoreInner>,
}

#[derive(Default)]
struct StoreInner {
    /// Insertion-ordered entries; front is oldest and evicts first.
    entries: VecDeque<(String, String)>,
    total_bytes: usize,
}

impl CanvasArtifactStore {
    pub fn insert(&self, id: String, html: String) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(position) = inner
            .entries
            .iter()
            .position(|(existing_id, _)| *existing_id == id)
        {
            if let Some((_, previous_html)) = inner.entries.remove(position) {
                inner.total_bytes -= previous_html.len();
            }
        }
        inner.total_bytes += html.len();
        inner.entries.push_back((id, html));
        while inner.entries.len() > MAX_STORED_ARTIFACTS || inner.total_bytes > MAX_STORED_BYTES {
            match inner.entries.pop_front() {
                Some((_, evicted_html)) => inner.total_bytes -= evicted_html.len(),
                None => break,
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<String> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner
            .entries
            .iter()
            .find(|(existing_id, _)| existing_id == id)
            .map(|(_, html)| html.clone())
    }

    #[cfg(test)]
    fn total_bytes(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .total_bytes
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entries
            .len()
    }
}

/// Artifact ids are frontend-derived content hashes: `[A-Za-z0-9_-]{8,64}`.
/// Anything else is rejected at both the publish and the serve boundary.
pub fn is_valid_artifact_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Command body, factored out of the Tauri command for direct unit testing.
pub fn publish_artifact(
    store: &CanvasArtifactStore,
    id: String,
    html: String,
) -> Result<(), String> {
    if !is_valid_artifact_id(&id) {
        return Err("invalid canvas artifact id".to_string());
    }
    if html.len() > MAX_ARTIFACT_BYTES {
        return Err(format!(
            "canvas artifact exceeds the {MAX_ARTIFACT_BYTES}-byte limit"
        ));
    }
    store.insert(id, html);
    Ok(())
}

/// Publishes a compiled artifact document so the `canvas-artifact` scheme
/// can serve it back to the sandboxed iframe.
#[tauri::command]
pub fn canvas_artifact_publish(
    store: tauri::State<'_, CanvasArtifactStore>,
    id: String,
    html: String,
) -> Result<(), String> {
    publish_artifact(&store, id, html)
}

/// Builds the response for a `canvas-artifact` request. `request_path` is
/// `http::Uri::path()`, which is `/<id>` for both the Windows
/// (`http://canvas-artifact.localhost/<id>`) and the macOS/Linux
/// (`canvas-artifact://localhost/<id>`) request shapes.
pub fn protocol_response(
    store: &CanvasArtifactStore,
    request_path: &str,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let id = request_path.trim_start_matches('/');
    let artifact = if is_valid_artifact_id(id) {
        store.get(id)
    } else {
        None
    };
    match artifact {
        Some(html) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", ARTIFACT_RESPONSE_CSP)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(Cow::Owned(html.into_bytes()))
            .expect("static canvas-artifact response metadata must be valid"),
        None => tauri::http::Response::builder()
            .status(404)
            .header("Cache-Control", "no-store")
            .body(Cow::Owned(Vec::new()))
            .expect("static canvas-artifact response metadata must be valid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact_id(index: usize) -> String {
        format!("ra-artifact-{index:04}")
    }

    #[test]
    fn insert_and_get_round_trip() {
        let store = CanvasArtifactStore::default();
        store.insert("ra-12345678".to_string(), "<html>a</html>".to_string());
        assert_eq!(store.get("ra-12345678").as_deref(), Some("<html>a</html>"));
        assert_eq!(store.get("ra-missing0"), None);
    }

    #[test]
    fn reinserting_an_id_replaces_content_and_refreshes_recency() {
        let store = CanvasArtifactStore::default();
        store.insert("ra-aaaaaaaa".to_string(), "old".to_string());
        for index in 0..(MAX_STORED_ARTIFACTS - 1) {
            store.insert(artifact_id(index), "x".to_string());
        }
        // Re-publish refreshes the entry to newest, so the next eviction
        // removes the oldest generic entry instead.
        store.insert("ra-aaaaaaaa".to_string(), "new".to_string());
        store.insert("ra-overflow".to_string(), "y".to_string());

        assert_eq!(store.len(), MAX_STORED_ARTIFACTS);
        assert_eq!(store.get("ra-aaaaaaaa").as_deref(), Some("new"));
        assert_eq!(store.get(&artifact_id(0)), None);
    }

    #[test]
    fn evicts_oldest_beyond_entry_bound() {
        let store = CanvasArtifactStore::default();
        for index in 0..(MAX_STORED_ARTIFACTS + 3) {
            store.insert(artifact_id(index), format!("doc-{index}"));
        }
        assert_eq!(store.len(), MAX_STORED_ARTIFACTS);
        for index in 0..3 {
            assert_eq!(store.get(&artifact_id(index)), None);
        }
        for index in 3..(MAX_STORED_ARTIFACTS + 3) {
            assert_eq!(
                store.get(&artifact_id(index)).as_deref(),
                Some(format!("doc-{index}").as_str())
            );
        }
    }

    #[test]
    fn evicts_oldest_beyond_byte_bound() {
        let store = CanvasArtifactStore::default();
        // Five 2 MiB documents exceed the 8 MiB budget by one document.
        let big = "x".repeat(MAX_ARTIFACT_BYTES);
        for index in 0..5 {
            store.insert(artifact_id(index), big.clone());
        }
        assert_eq!(store.len(), 4);
        assert_eq!(store.get(&artifact_id(0)), None);
        assert!(store.get(&artifact_id(4)).is_some());
        assert!(store.total_bytes() <= MAX_STORED_BYTES);
    }

    #[test]
    fn byte_accounting_survives_replacement() {
        let store = CanvasArtifactStore::default();
        store.insert("ra-aaaaaaaa".to_string(), "x".repeat(1000));
        store.insert("ra-aaaaaaaa".to_string(), "x".repeat(10));
        assert_eq!(store.total_bytes(), 10);
    }

    #[test]
    fn validates_artifact_ids() {
        assert!(is_valid_artifact_id("ra-12345678"));
        assert!(is_valid_artifact_id("A_b-9_Zz0"));
        assert!(!is_valid_artifact_id("short"));
        assert!(!is_valid_artifact_id(&"x".repeat(65)));
        assert!(!is_valid_artifact_id("has space1"));
        assert!(!is_valid_artifact_id("has/slash1"));
        assert!(!is_valid_artifact_id("has.dot99"));
        assert!(!is_valid_artifact_id(""));
    }

    #[test]
    fn publish_rejects_invalid_id_and_oversize_html() {
        let store = CanvasArtifactStore::default();
        assert!(publish_artifact(&store, "bad id".to_string(), "x".to_string()).is_err());
        assert!(publish_artifact(
            &store,
            "ra-12345678".to_string(),
            "x".repeat(MAX_ARTIFACT_BYTES + 1)
        )
        .is_err());
        assert!(publish_artifact(
            &store,
            "ra-12345678".to_string(),
            "x".repeat(MAX_ARTIFACT_BYTES)
        )
        .is_ok());
    }

    #[test]
    fn protocol_serves_stored_artifacts_with_csp_headers() {
        let store = CanvasArtifactStore::default();
        store.insert("ra-12345678".to_string(), "<html>doc</html>".to_string());

        let response = protocol_response(&store, "/ra-12345678");
        assert_eq!(response.status(), 200);
        assert_eq!(
            response
                .headers()
                .get("Content-Type")
                .and_then(|value| value.to_str().ok()),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            response
                .headers()
                .get("Content-Security-Policy")
                .and_then(|value| value.to_str().ok()),
            Some(ARTIFACT_RESPONSE_CSP)
        );
        assert_eq!(
            response
                .headers()
                .get("X-Content-Type-Options")
                .and_then(|value| value.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            response
                .headers()
                .get("Cache-Control")
                .and_then(|value| value.to_str().ok()),
            Some("no-store")
        );
        assert_eq!(response.body().as_ref(), b"<html>doc</html>");
    }

    #[test]
    fn protocol_returns_empty_404_for_missing_or_invalid_ids() {
        let store = CanvasArtifactStore::default();

        let missing = protocol_response(&store, "/ra-missing0");
        assert_eq!(missing.status(), 404);
        assert!(missing.body().is_empty());

        let invalid = protocol_response(&store, "/../etc/passwd");
        assert_eq!(invalid.status(), 404);
        assert!(invalid.body().is_empty());

        let empty = protocol_response(&store, "/");
        assert_eq!(empty.status(), 404);
    }
}
