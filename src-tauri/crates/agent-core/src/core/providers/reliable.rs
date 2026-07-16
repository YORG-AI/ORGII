//! Reliable LLM provider wrapper with retry, backoff, and fallback chains.
//!
//! Wraps one or more [`LLMProvider`] implementations and automatically
//! retries transient failures with exponential backoff. When a provider
//! is exhausted, falls back to the next one in the chain.

use async_trait::async_trait;
use serde_json::Value;
use tracing::{info, warn};

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use super::traits::{ChatOptions, LLMProvider, LLMResponse, ProviderError, StreamDelta};

/// Maximum backoff duration for rate-limit retries (10 seconds).
const MAX_BACKOFF_MS: u64 = 10_000;

/// Maximum backoff duration for overloaded/529 retries (60 seconds).
const MAX_OVERLOAD_BACKOFF_MS: u64 = 60_000;

/// Server-supplied rate-limit windows up to this bound are honored as the
/// retry delay — the retry-after header is a server directive and overrides
/// the local backoff cap (matches the in-stream
/// `RETRY_AFTER_SANITY_CEILING_MS` in `stream_error_recovery`). Longer
/// windows are quota/capacity blockers (5-hour resets), not retry delays,
/// and fail fast instead of parking a foreground turn.
const MAX_RATE_LIMIT_RETRY_AFTER_MS: u64 = 10 * 60 * 1000;

/// Message markers carrying the server's explicit `x-should-retry` response
/// header directive (non-standard, sent by Anthropic). Provider error
/// classifiers append these to the error message — the only channel
/// `ProviderError` carries today — and [`ReliableProvider`] obeys them over
/// its status-code heuristics: `false` suppresses retry of an otherwise
/// retryable error, `true` allows retry of an otherwise non-retryable one.
pub const X_SHOULD_RETRY_FALSE_MARKER: &str = "[x-should-retry: false]";
pub const X_SHOULD_RETRY_TRUE_MARKER: &str = "[x-should-retry: true]";

/// Minimum base backoff (50ms).
const MIN_BASE_BACKOFF_MS: u64 = 50;

/// Base backoff multiplier for overloaded errors (start higher).
const OVERLOAD_BASE_BACKOFF_MS: u64 = 2_000;

/// Independent retry budget for `Overloaded` (HTTP 529) errors.
///
/// Mirrors `turn_executor::MAX_OVERLOADED_RETRIES = 3`. Overloaded errors
/// signal backend capacity exhaustion; repeated retries rarely help and
/// consuming the general retry budget starves recoveries for genuinely
/// transient errors (connection resets, idle timeouts). Cap them short.
const MAX_OVERLOADED_RETRIES: u32 = 3;

static RATE_LIMIT_COOLDOWNS: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// A provider wrapper that adds retry with exponential backoff
/// and fallback to alternative providers.
///
/// Providers are tried in order. For each provider, up to
/// `max_retries + 1` attempts are made before moving to the next.
pub struct ReliableProvider {
    /// Ordered list of (name, provider). First is primary, rest are fallbacks.
    providers: Vec<(String, Box<dyn LLMProvider>)>,
    /// Maximum retry attempts per provider (0 = no retries, just one attempt).
    max_retries: u32,
    /// Base backoff in milliseconds (doubles each retry, capped at MAX_BACKOFF_MS).
    base_backoff_ms: u64,
    /// Session ID for broadcasting retry warnings to the frontend.
    /// Set via `set_session_id()` before each request so the user sees "retrying…".
    session_id: Mutex<Option<String>>,
}

impl ReliableProvider {
    /// Create a new reliable provider wrapping a single provider.
    pub fn single(
        name: String,
        provider: Box<dyn LLMProvider>,
        max_retries: u32,
        base_backoff_ms: u64,
    ) -> Self {
        Self {
            providers: vec![(name, provider)],
            max_retries,
            base_backoff_ms: base_backoff_ms.max(MIN_BASE_BACKOFF_MS),
            session_id: Mutex::new(None),
        }
    }

    /// Create a new reliable provider with a primary and fallback providers.
    pub fn with_fallbacks(
        providers: Vec<(String, Box<dyn LLMProvider>)>,
        max_retries: u32,
        base_backoff_ms: u64,
    ) -> Self {
        assert!(
            !providers.is_empty(),
            "ReliableProvider requires at least one provider"
        );
        Self {
            providers,
            max_retries,
            base_backoff_ms: base_backoff_ms.max(MIN_BASE_BACKOFF_MS),
            session_id: Mutex::new(None),
        }
    }

    /// Set the session ID for retry warning broadcasts.
    ///
    /// Called by the processor before each LLM request so retries
    /// can notify the frontend via `agent:warning` events.
    pub fn set_session_id(&self, session_id: &str) {
        if let Ok(mut guard) = self.session_id.lock() {
            *guard = Some(session_id.to_string());
        }
    }

    /// Broadcast a pre-stream retry signal to the frontend.
    ///
    /// Emits the same `agent:stream_retry` event shape that `turn_executor`
    /// emits for in-stream retries so the footer retry indicator
    /// ("Reconnecting… attempt N/M") lights up uniformly regardless of
    /// where the failure surfaced (before vs during token streaming).
    /// Surfaces retry state through a single consistent channel.
    ///
    /// `attempt` is 1-indexed (first retry = 1, matching
    /// `TurnEventHandler::on_stream_retry`).
    fn broadcast_retry(
        &self,
        provider_name: &str,
        err: &ProviderError,
        attempt: u32,
        max: u32,
        backoff_ms: u64,
    ) {
        let sid = self.session_id.lock().ok().and_then(|g| g.clone());
        let Some(sid) = sid else { return };

        let kind = Self::error_kind(err);

        crate::foundation::bus::broadcast_event(
            "agent:stream_retry",
            serde_json::json!({
                "sessionId": sid,
                "kind": kind,
                "attempt": attempt,
                "maxAttempts": max,
                "backoffMs": backoff_ms,
                "provider": provider_name,
                "prestream": true,
            }),
        );
    }

    /// Classify a [`ProviderError`] into the same snake_case kind strings
    /// that `turn_executor` emits for in-stream retries. Keeps the two
    /// retry surfaces reporting consistent labels to the frontend.
    ///
    /// The match is exhaustive on purpose: a new `ProviderError` variant
    /// must be classified explicitly, otherwise the previous `_ =>`
    /// catch-all would have silently labelled it `provider_error` and
    /// the frontend (which special-cases `rate_limited` / `overloaded`
    /// for backoff UI) would lose the new signal without a single test
    /// failure.
    fn error_kind(err: &ProviderError) -> &'static str {
        match err {
            ProviderError::RateLimited { .. } => "rate_limited",
            ProviderError::Overloaded { .. } => "overloaded",
            ProviderError::ContextTooLong(_) => "context_too_long",
            ProviderError::MaxTokensExceedContext(_) => "max_tokens_exceed_context",
            ProviderError::MediaTooLarge(_) => "media_too_large",
            ProviderError::AuthError(_) => "auth_error",
            ProviderError::ModelNotFound(_) => "model_not_found",
            ProviderError::Cancelled => "cancelled",
            ProviderError::RequestFailed(_) => "request_failed",
            ProviderError::ParseError(_) => "parse_error",
            ProviderError::Other(_) => "provider_error",
        }
    }

    /// Check if an error is non-retryable.
    ///
    /// Non-retryable errors include auth failures, model issues, and
    /// connection errors (tcp connect timeout / refused) — these indicate
    /// the server is unreachable, so retrying just wastes time.
    ///
    /// The match is exhaustive on purpose: a new `ProviderError`
    /// variant must declare its retry policy explicitly. The previous
    /// `_ => false` catch-all would have made any new error variant
    /// silently retryable, including ones that should fail fast.
    fn is_non_retryable(err: &ProviderError) -> bool {
        // An explicit server directive (`x-should-retry` response header)
        // overrides the status-code heuristics below. The >10min rate-limit
        // fail-fast still applies afterwards: a server "true" on a
        // multi-hour quota window must not park a foreground turn.
        if let Some(should_retry) = Self::server_retry_directive(err) {
            return !should_retry;
        }
        match err {
            ProviderError::AuthError(_)
            | ProviderError::ModelNotFound(_)
            | ProviderError::ContextTooLong(_)
            // Recoverable by the turn loop's dedicated rescue arms (lower
            // max_tokens / strip media) — provider-level retry of the SAME
            // request would just re-fail.
            | ProviderError::MaxTokensExceedContext(_)
            | ProviderError::MediaTooLarge(_)
            | ProviderError::Cancelled => true,
            ProviderError::RequestFailed(msg) => {
                let lower = msg.to_lowercase();
                lower.contains("tcp connect error")
                    || lower.contains("connection refused")
                    || lower.contains("dns error")
                    || lower.contains("no such host")
                    || (lower.contains("http 400")
                        && (lower.contains("model is not supported")
                            || lower.contains("model_not_found")
                            || lower.contains("unsupported model")
                            || lower.contains("invalid model")
                            || lower.contains("unsupported tool type")
                            || lower.contains("temperature` is deprecated")
                            || lower.contains("temperature is deprecated")
                            || lower.contains("thinking may not be enabled")
                            || lower.contains("does not support this tool_choice")))
            }
            // Retryable: server told us to back off, generic transient
            // errors. The frontend / backoff loop handles these.
            ProviderError::RateLimited { .. }
            | ProviderError::Overloaded { .. }
            | ProviderError::ParseError(_)
            | ProviderError::Other(_) => false,
        }
    }

    /// Extract the server's explicit `x-should-retry` directive from an
    /// error, if the provider's classifier stamped one into the message
    /// (see [`X_SHOULD_RETRY_FALSE_MARKER`] / [`X_SHOULD_RETRY_TRUE_MARKER`]).
    fn server_retry_directive(err: &ProviderError) -> Option<bool> {
        let text = err.to_string();
        if text.contains(X_SHOULD_RETRY_FALSE_MARKER) {
            Some(false)
        } else if text.contains(X_SHOULD_RETRY_TRUE_MARKER) {
            Some(true)
        } else {
            None
        }
    }

    /// Extract retry-after duration from a RateLimited or Overloaded error.
    ///
    /// Exhaustive on purpose: the only two variants that carry a
    /// server-supplied `retry_after_secs` are listed explicitly. Any
    /// new variant has to opt into providing one rather than being
    /// silently treated as "no hint" by a `_ => None` catch-all.
    fn retry_after_ms(err: &ProviderError) -> Option<u64> {
        match err {
            ProviderError::RateLimited {
                retry_after_secs, ..
            }
            | ProviderError::Overloaded {
                retry_after_secs, ..
            } => retry_after_secs.map(|secs| secs * 1000),
            ProviderError::AuthError(_)
            | ProviderError::ModelNotFound(_)
            | ProviderError::ContextTooLong(_)
            | ProviderError::MaxTokensExceedContext(_)
            | ProviderError::MediaTooLarge(_)
            | ProviderError::Cancelled
            | ProviderError::RequestFailed(_)
            | ProviderError::ParseError(_)
            | ProviderError::Other(_) => None,
        }
    }

    fn should_fail_fast_rate_limit(err: &ProviderError) -> bool {
        matches!(
            err,
            ProviderError::RateLimited {
                retry_after_secs: Some(secs),
                ..
            } if secs.saturating_mul(1000) > MAX_RATE_LIMIT_RETRY_AFTER_MS
        )
    }

    /// Calculate backoff duration for a given attempt.
    fn backoff_ms(&self, attempt: u32, overloaded: bool) -> u64 {
        let (base, cap) = if overloaded {
            (OVERLOAD_BASE_BACKOFF_MS, MAX_OVERLOAD_BACKOFF_MS)
        } else {
            (self.base_backoff_ms, MAX_BACKOFF_MS)
        };
        let backoff = base.saturating_mul(1u64 << attempt.min(10));
        backoff.min(cap)
    }

    fn cooldown_key(provider_name: &str, model: &str) -> String {
        format!("{provider_name}|{model}")
    }

    async fn wait_for_rate_limit_cooldown(provider_name: &str, model: &str) {
        let key = Self::cooldown_key(provider_name, model);
        let remaining = RATE_LIMIT_COOLDOWNS.lock().ok().and_then(|mut cooldowns| {
            let deadline = cooldowns.get(&key).copied()?;
            let now = Instant::now();
            if deadline <= now {
                cooldowns.remove(&key);
                None
            } else {
                Some(deadline.duration_since(now))
            }
        });
        if let Some(duration) = remaining {
            info!(
                "[reliable] Waiting {}ms for shared rate-limit cooldown provider='{}' model='{}'",
                duration.as_millis(),
                provider_name,
                model
            );
            tokio::time::sleep(duration).await;
            if let Ok(mut cooldowns) = RATE_LIMIT_COOLDOWNS.lock() {
                if cooldowns
                    .get(&key)
                    .is_some_and(|deadline| *deadline <= Instant::now())
                {
                    cooldowns.remove(&key);
                }
            }
        }
    }

    fn record_rate_limit_cooldown(provider_name: &str, model: &str, backoff_ms: u64) {
        let key = Self::cooldown_key(provider_name, model);
        let deadline = Instant::now() + Duration::from_millis(backoff_ms);
        if let Ok(mut cooldowns) = RATE_LIMIT_COOLDOWNS.lock() {
            let current = cooldowns.get(&key).copied();
            if current.is_none_or(|existing| deadline > existing) {
                cooldowns.insert(key, deadline);
            }
        }
    }
}

#[async_trait]
impl LLMProvider for ReliableProvider {
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        self.chat_with_options(
            messages,
            tools,
            model,
            max_tokens,
            temperature,
            ChatOptions::default(),
        )
        .await
    }

    /// The retry/fallback loop for non-streaming chat. [`Self::chat`]
    /// delegates here with default options; this override exists because the
    /// trait's default `chat_with_options` routes through `chat` and would
    /// silently drop the options before they reach the inner providers.
    async fn chat_with_options(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        options: ChatOptions,
    ) -> Result<LLMResponse, ProviderError> {
        let mut last_error: Option<ProviderError> = None;

        for (provider_idx, (name, provider)) in self.providers.iter().enumerate() {
            let mut backoff_ms = self.base_backoff_ms;
            // Overloaded errors burn an independent budget (cap 3) so they
            // can't starve retries for genuinely transient errors. Matches
            // `turn_executor::MAX_OVERLOADED_RETRIES`.
            let mut overloaded_retries: u32 = 0;

            for attempt in 0..=self.max_retries {
                Self::wait_for_rate_limit_cooldown(name, model).await;
                match provider
                    .chat_with_options(messages, tools, model, max_tokens, temperature, options)
                    .await
                {
                    Ok(response) => {
                        if attempt > 0 || provider_idx > 0 {
                            info!(
                                "[reliable] Recovered on provider='{}' attempt={}",
                                name, attempt
                            );
                        }
                        return Ok(response);
                    }
                    Err(err) => {
                        warn!(
                            "[reliable] provider='{}' attempt={}/{} error: {}",
                            name, attempt, self.max_retries, err
                        );

                        if Self::is_non_retryable(&err) {
                            warn!("[reliable] Non-retryable error, skipping to next provider");
                            last_error = Some(err);
                            break;
                        }

                        if Self::should_fail_fast_rate_limit(&err) {
                            warn!(
                                "[reliable] Rate-limit retry-after exceeds foreground retry budget, skipping to next provider"
                            );
                            last_error = Some(err);
                            break;
                        }

                        let is_overloaded = matches!(err, ProviderError::Overloaded { .. });
                        if is_overloaded && overloaded_retries >= MAX_OVERLOADED_RETRIES {
                            warn!(
                                "[reliable] Overloaded budget exhausted ({}/{}), moving on",
                                overloaded_retries, MAX_OVERLOADED_RETRIES
                            );
                            last_error = Some(err);
                            break;
                        }

                        if attempt == self.max_retries {
                            last_error = Some(err);
                            break;
                        }

                        let sleep_ms = Self::retry_after_ms(&err).unwrap_or(backoff_ms);
                        if matches!(err, ProviderError::RateLimited { .. }) {
                            Self::record_rate_limit_cooldown(name, model, sleep_ms);
                        }

                        self.broadcast_retry(name, &err, attempt + 1, self.max_retries, sleep_ms);

                        info!(
                            "[reliable] Retrying in {}ms{}...",
                            sleep_ms,
                            if is_overloaded { " (overloaded)" } else { "" }
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;

                        backoff_ms = self.backoff_ms(attempt + 1, is_overloaded);
                        if is_overloaded {
                            overloaded_retries += 1;
                        }
                        last_error = Some(err);
                    }
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            ProviderError::Other("All providers exhausted with no attempts made.".into())
        }))
    }

    async fn chat_streaming(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<LLMResponse, ProviderError> {
        let mut last_error: Option<ProviderError> = None;
        // Track whether any deltas have been emitted. Once content has been
        // streamed to the caller, retrying would produce duplicate/overlapping
        // output, so we must stop retrying.
        let delta_emitted = std::sync::atomic::AtomicBool::new(false);
        let guarded_on_delta = |delta: StreamDelta| {
            delta_emitted.store(true, std::sync::atomic::Ordering::Release);
            on_delta(delta);
        };

        for (provider_idx, (name, provider)) in self.providers.iter().enumerate() {
            let mut backoff_ms = self.base_backoff_ms;
            let mut overloaded_retries: u32 = 0;

            for attempt in 0..=self.max_retries {
                if cancel_flag.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
                    return Err(ProviderError::Cancelled);
                }
                Self::wait_for_rate_limit_cooldown(name, model).await;
                if cancel_flag.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
                    return Err(ProviderError::Cancelled);
                }
                match provider
                    .chat_streaming(
                        messages,
                        tools,
                        model,
                        max_tokens,
                        temperature,
                        &guarded_on_delta,
                        cancel_flag,
                    )
                    .await
                {
                    Ok(response) => {
                        if attempt > 0 || provider_idx > 0 {
                            info!(
                                "[reliable] Streaming recovered on provider='{}' attempt={}",
                                name, attempt
                            );
                        }
                        return Ok(response);
                    }
                    Err(err) => {
                        if delta_emitted.load(std::sync::atomic::Ordering::Acquire) {
                            warn!(
                                "[reliable] Streaming failed after partial output on provider='{}', not retrying to avoid duplicates. Error: {}",
                                name, err
                            );
                            return Err(err);
                        }

                        warn!(
                            "[reliable] Streaming provider='{}' attempt={}/{} error: {}",
                            name, attempt, self.max_retries, err
                        );

                        if Self::is_non_retryable(&err) {
                            warn!("[reliable] Non-retryable error, skipping to next provider");
                            last_error = Some(err);
                            break;
                        }

                        if Self::should_fail_fast_rate_limit(&err) {
                            warn!(
                                "[reliable] Rate-limit retry-after exceeds foreground retry budget, skipping to next provider"
                            );
                            last_error = Some(err);
                            break;
                        }

                        let is_overloaded = matches!(err, ProviderError::Overloaded { .. });
                        if is_overloaded && overloaded_retries >= MAX_OVERLOADED_RETRIES {
                            warn!(
                                "[reliable] Overloaded budget exhausted ({}/{}), moving on",
                                overloaded_retries, MAX_OVERLOADED_RETRIES
                            );
                            last_error = Some(err);
                            break;
                        }

                        if attempt == self.max_retries {
                            last_error = Some(err);
                            break;
                        }

                        let sleep_ms = Self::retry_after_ms(&err).unwrap_or(backoff_ms);
                        if matches!(err, ProviderError::RateLimited { .. }) {
                            Self::record_rate_limit_cooldown(name, model, sleep_ms);
                        }

                        self.broadcast_retry(name, &err, attempt + 1, self.max_retries, sleep_ms);

                        info!(
                            "[reliable] Retrying stream in {}ms{}...",
                            sleep_ms,
                            if is_overloaded { " (overloaded)" } else { "" }
                        );
                        if let Some(flag) = cancel_flag {
                            tokio::select! {
                                _ = tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)) => {}
                                _ = async {
                                    while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                    }
                                } => return Err(ProviderError::Cancelled),
                            }
                        } else {
                            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                        }

                        backoff_ms = self.backoff_ms(attempt + 1, is_overloaded);
                        if is_overloaded {
                            overloaded_retries += 1;
                        }
                        last_error = Some(err);
                    }
                }
            }

            // If partial content was streamed, don't try fallback providers either
            if delta_emitted.load(std::sync::atomic::Ordering::Acquire) {
                return Err(last_error.unwrap_or_else(|| {
                    ProviderError::Other("Streaming failed after partial output.".into())
                }));
            }
        }

        Err(last_error.unwrap_or_else(|| {
            ProviderError::Other("All providers exhausted with no attempts made.".into())
        }))
    }

    fn default_model(&self) -> &str {
        self.providers
            .first()
            .map(|(_, provider)| provider.default_model())
            .unwrap_or("unknown")
    }

    fn provider_name(&self) -> &str {
        "reliable"
    }

    fn set_session_context(&self, session_id: &str) {
        self.set_session_id(session_id);
    }
}

#[cfg(test)]
#[path = "tests/reliable_tests.rs"]
mod tests;
