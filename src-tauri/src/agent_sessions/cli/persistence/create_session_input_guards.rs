//! These tests pin the wire-typo guards in `create_session` without
//! requiring a real SQLite connection. They exercise `KeySource::parse`
//! and `SessionRunner::parse` directly, which is what the production
//! code calls before issuing the INSERT — a typo'd input MUST fail
//! at the boundary, otherwise `row_to_session` would later refuse to
//! load the row and the session would be created-but-unloadable.
use super::super::types::{KeySource, SessionRunner};

#[test]
fn key_source_typo_rejected_at_parse() {
    // The production write path forwards through `KeySource::parse`;
    // a typo like a hyphen instead of an underscore must not silently
    // become `OwnKey` (which would mis-bill a market session).
    assert!(KeySource::parse("own-key").is_none());
    assert!(KeySource::parse("OWN_KEY").is_none());
    assert!(KeySource::parse("free").is_none());
    assert!(KeySource::parse("").is_none());

    // Sanity: legal values still parse.
    assert!(matches!(
        KeySource::parse("own_key"),
        Some(KeySource::OwnKey)
    ));
    assert!(matches!(
        KeySource::parse("hosted_key"),
        Some(KeySource::HostedKey)
    ));
}

#[test]
fn session_runner_typo_rejected_at_parse() {
    // Adding a future `Remote` runner without updating
    // `SessionRunner::parse` would have silently fallen back to
    // `Local` under the old `_ =>` arm. Pin that the only legal
    // value today is `local`.
    assert!(SessionRunner::parse("remote").is_none());
    assert!(SessionRunner::parse("Local").is_none());
    assert!(SessionRunner::parse("").is_none());

    assert!(matches!(
        SessionRunner::parse("local"),
        Some(SessionRunner::Local)
    ));
}
