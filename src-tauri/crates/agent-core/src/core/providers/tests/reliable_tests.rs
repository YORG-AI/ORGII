//! Tests for the reliable provider wrapper (retry + backoff + fallback).
//!
//! Included from `reliable.rs` via `#[path = "tests/reliable_tests.rs"] mod tests;`
//! so `super::*` resolves to the `reliable` module.

use super::super::traits::finish_reason as finish;
use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

/// Stub provider that fails N times then succeeds.
struct FailNProvider {
    fail_count: AtomicU32,
    fail_with: fn(u32) -> ProviderError,
}

impl FailNProvider {
    fn new(total_failures: u32, fail_with: fn(u32) -> ProviderError) -> Self {
        Self {
            fail_count: AtomicU32::new(total_failures),
            fail_with,
        }
    }
}

#[async_trait]
impl LLMProvider for FailNProvider {
    async fn chat(
        &self,
        _messages: &[Value],
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let remaining = self.fail_count.fetch_sub(1, Ordering::SeqCst);
        if remaining > 0 {
            Err((self.fail_with)(remaining))
        } else {
            Ok(LLMResponse {
                content: Some("ok".into()),
                tool_calls: vec![],
                finish_reason: finish::STOP.into(),
                usage: HashMap::new(),
                reasoning_content: None,
                blocks: Vec::new(),
                stream_error_kind: None,
                retry_after_ms: None,
            })
        }
    }

    fn default_model(&self) -> &str {
        "test"
    }

    fn provider_name(&self) -> &str {
        "test"
    }
}

// --- backoff_ms tests ---

#[test]
fn backoff_normal_doubles_and_caps() {
    let provider = ReliableProvider::single(
        "t".into(),
        Box::new(FailNProvider::new(0, |_| ProviderError::Other("".into()))),
        3,
        100,
    );
    assert_eq!(provider.backoff_ms(0, false), 100);
    assert_eq!(provider.backoff_ms(1, false), 200);
    assert_eq!(provider.backoff_ms(2, false), 400);
    assert!(provider.backoff_ms(20, false) <= MAX_BACKOFF_MS);
}

#[test]
fn backoff_overloaded_starts_higher_and_caps_higher() {
    let provider = ReliableProvider::single(
        "t".into(),
        Box::new(FailNProvider::new(0, |_| ProviderError::Other("".into()))),
        3,
        100,
    );
    let b0 = provider.backoff_ms(0, true);
    assert_eq!(b0, OVERLOAD_BASE_BACKOFF_MS);
    assert!(b0 > provider.backoff_ms(0, false));

    let b_high = provider.backoff_ms(20, true);
    assert!(b_high <= MAX_OVERLOAD_BACKOFF_MS);
    assert!(b_high > MAX_BACKOFF_MS);
}

// --- retry_after_ms tests ---

#[test]
fn retry_after_extracts_from_rate_limited() {
    let err = ProviderError::RateLimited {
        message: "slow down".into(),
        retry_after_secs: Some(5),
    };
    assert_eq!(ReliableProvider::retry_after_ms(&err), Some(5000));
}

#[test]
fn retry_after_extracts_from_overloaded() {
    let err = ProviderError::Overloaded {
        message: "busy".into(),
        retry_after_secs: Some(30),
    };
    assert_eq!(ReliableProvider::retry_after_ms(&err), Some(30_000));
}

#[test]
fn retry_after_returns_none_for_other_errors() {
    let err = ProviderError::RequestFailed("fail".into());
    assert_eq!(ReliableProvider::retry_after_ms(&err), None);
}

#[tokio::test]
async fn shared_rate_limit_cooldown_waits_for_same_provider_model() {
    let provider_name = "cooldown-test";
    let model = "model";
    let key = ReliableProvider::cooldown_key(provider_name, model);
    RATE_LIMIT_COOLDOWNS.lock().unwrap().remove(&key);

    ReliableProvider::record_rate_limit_cooldown(provider_name, model, 20);
    let started_at = std::time::Instant::now();
    ReliableProvider::wait_for_rate_limit_cooldown(provider_name, model).await;

    assert!(started_at.elapsed() >= std::time::Duration::from_millis(15));
    assert!(!RATE_LIMIT_COOLDOWNS.lock().unwrap().contains_key(&key));
}

// --- is_non_retryable tests ---

#[test]
fn auth_error_is_non_retryable() {
    assert!(ReliableProvider::is_non_retryable(
        &ProviderError::AuthError("bad key".into())
    ));
}

#[test]
fn model_not_found_is_non_retryable() {
    assert!(ReliableProvider::is_non_retryable(
        &ProviderError::ModelNotFound("gpt-99".into())
    ));
}

#[test]
fn long_retry_after_rate_limit_fails_fast() {
    assert!(ReliableProvider::should_fail_fast_rate_limit(
        &ProviderError::RateLimited {
            message: "quota exhausted".into(),
            retry_after_secs: Some(60 * 60),
        }
    ));
}

#[test]
fn short_retry_after_rate_limit_can_retry() {
    assert!(!ReliableProvider::should_fail_fast_rate_limit(
        &ProviderError::RateLimited {
            message: "slow down".into(),
            retry_after_secs: Some(2),
        }
    ));
}

#[test]
fn moderate_retry_after_rate_limit_is_waited_out() {
    // A 60s window is a routine PAYG rate-limit that the server directive
    // asks us to ride out — it must NOT fail fast. Only multi-minute
    // quota/capacity windows (>10min ceiling) do.
    assert!(!ReliableProvider::should_fail_fast_rate_limit(
        &ProviderError::RateLimited {
            message: "slow down".into(),
            retry_after_secs: Some(60),
        }
    ));
    assert!(!ReliableProvider::should_fail_fast_rate_limit(
        &ProviderError::RateLimited {
            message: "slow down".into(),
            retry_after_secs: Some(600),
        }
    ));
    assert!(ReliableProvider::should_fail_fast_rate_limit(
        &ProviderError::RateLimited {
            message: "quota exhausted".into(),
            retry_after_secs: Some(601),
        }
    ));
}

#[test]
fn x_should_retry_false_suppresses_retry_of_retryable_error() {
    assert!(ReliableProvider::is_non_retryable(
        &ProviderError::RequestFailed(format!(
            "HTTP 500: internal error {X_SHOULD_RETRY_FALSE_MARKER}"
        ))
    ));
    assert!(ReliableProvider::is_non_retryable(
        &ProviderError::Overloaded {
            message: format!("overloaded {X_SHOULD_RETRY_FALSE_MARKER}"),
            retry_after_secs: None,
        }
    ));
}

#[test]
fn x_should_retry_true_allows_retry_of_non_retryable_error() {
    assert!(!ReliableProvider::is_non_retryable(
        &ProviderError::AuthError(format!("token flaked {X_SHOULD_RETRY_TRUE_MARKER}"))
    ));
    // Even a connection-error-shaped message obeys the explicit directive.
    assert!(!ReliableProvider::is_non_retryable(
        &ProviderError::RequestFailed(format!(
            "HTTP 400: invalid model {X_SHOULD_RETRY_TRUE_MARKER}"
        ))
    ));
}

#[test]
fn no_directive_keeps_status_heuristics() {
    assert!(ReliableProvider::is_non_retryable(
        &ProviderError::AuthError("bad key".into())
    ));
    assert!(!ReliableProvider::is_non_retryable(
        &ProviderError::RequestFailed("HTTP 500: internal error".into())
    ));
}

#[test]
fn rate_limited_is_retryable() {
    assert!(!ReliableProvider::is_non_retryable(
        &ProviderError::RateLimited {
            message: "x".into(),
            retry_after_secs: None,
        }
    ));
}

#[test]
fn overloaded_is_retryable() {
    assert!(!ReliableProvider::is_non_retryable(
        &ProviderError::Overloaded {
            message: "x".into(),
            retry_after_secs: None,
        }
    ));
}

#[test]
fn deepseek_thinking_tool_choice_400_is_non_retryable() {
    // DeepSeek thinking models reject forced tool_choice with a deterministic
    // 400. Retrying it 10× wastes the side-query budget and times out SM
    // extraction; it must fail fast so side_query falls back to no-tool_choice.
    assert!(ReliableProvider::is_non_retryable(
        &ProviderError::RequestFailed(
            "HTTP 400: {\"error\":{\"message\":\"Thinking mode does not support this tool_choice\"}}"
                .into()
        )
    ));
}

// --- Integration: retry succeeds ---

#[tokio::test]
async fn retries_rate_limited_then_succeeds() {
    let stub = FailNProvider::new(2, |_| ProviderError::RateLimited {
        message: "429".into(),
        retry_after_secs: None,
    });
    let reliable = ReliableProvider::single("test".into(), Box::new(stub), 3, MIN_BASE_BACKOFF_MS);
    let result = reliable.chat(&[], None, "model", 100, 0.0).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap().content.unwrap(), "ok");
}

#[tokio::test]
async fn retries_overloaded_then_succeeds() {
    let stub = FailNProvider::new(1, |_| ProviderError::Overloaded {
        message: "529".into(),
        retry_after_secs: None,
    });
    let reliable = ReliableProvider::single("test".into(), Box::new(stub), 2, MIN_BASE_BACKOFF_MS);
    let result = reliable.chat(&[], None, "model", 100, 0.0).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn long_retry_after_rate_limit_returns_without_sleeping() {
    let stub = FailNProvider::new(100, |_| ProviderError::RateLimited {
        message: "quota exhausted".into(),
        retry_after_secs: Some(60 * 60),
    });
    let reliable = ReliableProvider::single("test".into(), Box::new(stub), 5, MIN_BASE_BACKOFF_MS);
    let started_at = std::time::Instant::now();
    let result = reliable.chat(&[], None, "model", 100, 0.0).await;

    assert!(result.is_err());
    assert!(started_at.elapsed() < std::time::Duration::from_secs(1));
    assert!(matches!(
        result.unwrap_err(),
        ProviderError::RateLimited { .. }
    ));
}

#[tokio::test]
async fn exhausts_retries_returns_last_error() {
    let stub = FailNProvider::new(100, |_| ProviderError::RateLimited {
        message: "429".into(),
        retry_after_secs: None,
    });
    let reliable = ReliableProvider::single("test".into(), Box::new(stub), 1, MIN_BASE_BACKOFF_MS);
    let result = reliable.chat(&[], None, "model", 100, 0.0).await;
    assert!(result.is_err());
    assert!(matches!(
        result.unwrap_err(),
        ProviderError::RateLimited { .. }
    ));
}

#[tokio::test]
async fn overloaded_uses_independent_budget_and_stops_after_max() {
    // Fail N times with Overloaded. With max_retries=10 but overloaded
    // budget capped at MAX_OVERLOADED_RETRIES=3, we should stop after
    // roughly 3 overloaded retries even though the general budget is 10.
    //
    // The actual stop condition is "attempt before the check" — with
    // `overloaded_retries >= MAX_OVERLOADED_RETRIES` the loop breaks
    // before the 4th overloaded retry, so a provider that fails 100
    // times with Overloaded must surface an error (never succeed within
    // the overloaded cap).
    let stub = FailNProvider::new(100, |_| ProviderError::Overloaded {
        message: "529".into(),
        retry_after_secs: None,
    });
    let reliable = ReliableProvider::single("test".into(), Box::new(stub), 10, MIN_BASE_BACKOFF_MS);
    let result = reliable.chat(&[], None, "model", 100, 0.0).await;
    assert!(
        result.is_err(),
        "overloaded should exhaust independent budget"
    );
    assert!(matches!(
        result.unwrap_err(),
        ProviderError::Overloaded { .. }
    ));
}

#[tokio::test]
async fn overloaded_then_success_within_budget() {
    // 2 overloaded failures (under the cap of 3), then success.
    let stub = FailNProvider::new(2, |_| ProviderError::Overloaded {
        message: "529".into(),
        retry_after_secs: None,
    });
    let reliable = ReliableProvider::single("test".into(), Box::new(stub), 10, MIN_BASE_BACKOFF_MS);
    let result = reliable.chat(&[], None, "model", 100, 0.0).await;
    assert!(result.is_ok());
}

#[test]
fn error_kind_classifies_known_variants() {
    assert_eq!(
        ReliableProvider::error_kind(&ProviderError::RateLimited {
            message: "x".into(),
            retry_after_secs: None,
        }),
        "rate_limited"
    );
    assert_eq!(
        ReliableProvider::error_kind(&ProviderError::Overloaded {
            message: "x".into(),
            retry_after_secs: None,
        }),
        "overloaded"
    );
    assert_eq!(
        ReliableProvider::error_kind(&ProviderError::AuthError("x".into())),
        "auth_error"
    );
    assert_eq!(
        ReliableProvider::error_kind(&ProviderError::ContextTooLong("x".into())),
        "context_too_long"
    );
}

#[tokio::test]
async fn auth_error_skips_retries() {
    let stub = FailNProvider::new(100, |_| ProviderError::AuthError("bad key".into()));
    let reliable = ReliableProvider::single("test".into(), Box::new(stub), 5, MIN_BASE_BACKOFF_MS);
    let result = reliable.chat(&[], None, "model", 100, 0.0).await;
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), ProviderError::AuthError(_)));
}

// --- chat_with_options forwarding ---

/// Stub that records the `ChatOptions` it receives via `chat_with_options`.
struct OptionRecordingProvider {
    skip_cache_write_seen: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[async_trait]
impl LLMProvider for OptionRecordingProvider {
    async fn chat(
        &self,
        _messages: &[Value],
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        Ok(LLMResponse::text("ok"))
    }

    async fn chat_with_options(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        options: ChatOptions,
    ) -> Result<LLMResponse, ProviderError> {
        self.skip_cache_write_seen
            .store(options.skip_cache_write, Ordering::SeqCst);
        self.chat(messages, tools, model, max_tokens, temperature)
            .await
    }

    fn default_model(&self) -> &str {
        "test"
    }

    fn provider_name(&self) -> &str {
        "test"
    }
}

/// Without the `chat_with_options` override, the trait's default method
/// would route through `ReliableProvider::chat` and silently drop the
/// options before they reach the inner provider.
#[tokio::test]
async fn chat_with_options_forwards_options_to_inner_provider() {
    let skip_seen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stub = OptionRecordingProvider {
        skip_cache_write_seen: skip_seen.clone(),
    };
    let reliable = ReliableProvider::single("test".into(), Box::new(stub), 1, MIN_BASE_BACKOFF_MS);
    let result = reliable
        .chat_with_options(
            &[],
            None,
            "model",
            100,
            0.0,
            ChatOptions {
                skip_cache_write: true,
            },
        )
        .await;
    assert!(result.is_ok());
    assert!(
        skip_seen.load(Ordering::SeqCst),
        "skip_cache_write must reach the inner provider through the retry loop"
    );
}
