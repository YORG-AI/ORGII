//! Generic test utilities shared across the `app` crate.
//!
//! Anything tightly coupled to a specific subsystem lives next to that
//! subsystem's tests instead. For example, the agent-flavoured fakes
//! (`FakeTool`, `MockEventHandler`, message builders, `tool_call`,
//! `test_registry`) live in `agent_core::test_support`; the
//! sandbox guard and `temp_dir_with_files` are owned by the
//! `test_helpers` workspace crate and `app_utils::testing` respectively
//! and are simply re-exported here for ergonomic in-tree call sites.

use std::sync::Once;

pub mod test_env;

/// Install the `ring` rustls crypto provider exactly once per test process.
///
/// The workspace's `reqwest` dep is built with the `rustls-no-provider`
/// feature, which requires the host binary to install a `CryptoProvider`
/// before any TLS code runs. Production does this in [`crate::run`]; tests
/// need their own one-shot bootstrap or the first `reqwest::Client::new()`
/// (or any indirect wiremock / `Client::builder().build()`) panics with
/// `"No provider set"` — this is a process-wide, not a per-client, panic.
///
/// Call this at the top of any `#[test]` / `#[tokio::test]` (or test
/// helper) that may construct a `reqwest::Client`. Idempotent and cheap
/// to call repeatedly.
pub fn install_crypto_provider_for_tests() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    });
}

// `temp_dir_with_files` lives in `app_utils::testing` (feature-gated) so
// extracted workspace crates (`search`, `test_runner`)
// can use it via their own dev-deps without depending back into `app`.
// Re-exported here for the existing `crate::test_utils::temp_dir_with_files`
// call sites inside the monolithic `app` library.
pub use app_utils::testing::temp_dir_with_files;
