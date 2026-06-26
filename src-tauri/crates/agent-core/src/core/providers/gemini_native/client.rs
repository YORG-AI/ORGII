use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use serde_json::Value;

use super::request::{code_assist_request_body, CodeAssistEnvelope};
use super::response::{parse_http_response, parse_streaming_response};
use crate::providers::traits::{LLMProvider, LLMResponse, ProviderError, StreamDelta};
use crate::utils::build_http_client;

const CODE_ASSIST_BASE: &str = "https://cloudcode-pa.googleapis.com/v1internal";
const GEMINI_CLI_VERSION: &str = "0.1.0";

#[derive(Clone)]
pub struct GeminiNativeClient {
    client: reqwest::Client,
    account_id: String,
    project_id: String,
    session_id: String,
    default_model: String,
}

impl GeminiNativeClient {
    pub fn new(
        account_id: String,
        project_id: String,
        default_model: String,
        code_assist_session_id: Option<String>,
    ) -> Self {
        Self {
            client: build_http_client(std::time::Duration::from_secs(300)),
            account_id,
            project_id,
            session_id: code_assist_session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            default_model,
        }
    }

    async fn fresh_access_token(
        &self,
        rejected_access_token: Option<&str>,
    ) -> Result<String, ProviderError> {
        let key = if let Some(rejected) = rejected_access_token {
            let current = key_vault::key_store::KEY_SERVICE
                .get_key_by_id(&self.account_id)
                .ok_or_else(|| {
                    ProviderError::AuthError(format!("Account '{}' not found", self.account_id))
                })?;
            if current
                .session_token
                .as_deref()
                .is_some_and(|token| !token.trim().is_empty() && token != rejected)
            {
                current
            } else {
                key_vault::key_store::KEY_SERVICE
                    .refresh_gemini_oauth_key_after_rejection(&self.account_id, rejected)
                    .await
                    .map_err(ProviderError::AuthError)?
            }
        } else {
            key_vault::key_store::KEY_SERVICE
                .ensure_gemini_oauth_key_fresh(&self.account_id)
                .await
                .map_err(ProviderError::AuthError)?
        };
        key.session_token
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| {
                ProviderError::AuthError("Gemini OAuth account has no access token".to_string())
            })
    }

    pub(super) fn endpoint(streaming: bool) -> String {
        let method = if streaming {
            "streamGenerateContent?alt=sse"
        } else {
            "generateContent"
        };
        format!("{CODE_ASSIST_BASE}:{method}")
    }

    fn activity_request_id() -> String {
        uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(16)
            .collect()
    }

    fn user_agent(model: &str) -> String {
        format!(
            "GeminiCLI/{}/{model} ({}; {}; terminal)",
            GEMINI_CLI_VERSION,
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    }

    fn ensure_project_id(&self) -> Result<(), ProviderError> {
        if self.project_id.trim().is_empty() {
            return Err(ProviderError::AuthError(
                "Gemini OAuth account is missing GOOGLE_CLOUD_PROJECT".to_string(),
            ));
        }
        Ok(())
    }

    fn request_body(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
    ) -> CodeAssistEnvelope {
        code_assist_request_body(
            &self.project_id,
            &self.session_id,
            messages,
            tools,
            model,
            max_tokens,
            temperature,
        )
    }

    async fn send_once(
        &self,
        token: &str,
        body: &CodeAssistEnvelope,
        streaming: bool,
    ) -> Result<reqwest::Response, ProviderError> {
        let telemetry = body.telemetry();
        tracing::info!(
            "[gemini_native] request streaming={} model={} project_id_present={} session_id={} contents={} tools={} tool_names={:?} system_bytes={} contents_bytes={} tools_bytes={} body_bytes={}",
            streaming,
            telemetry.model,
            !self.project_id.trim().is_empty(),
            telemetry.session_id,
            telemetry.contents_count,
            telemetry.tool_declarations_count,
            telemetry.tool_names,
            telemetry.system_bytes,
            telemetry.contents_bytes,
            telemetry.tools_bytes,
            telemetry.body_bytes
        );
        #[cfg(debug_assertions)]
        eprintln!(
            "[gemini_native] request streaming={} model={} project_id_present={} session_id={} contents={} tools={} tool_names={:?} system_bytes={} contents_bytes={} tools_bytes={} body_bytes={}",
            streaming,
            telemetry.model,
            !self.project_id.trim().is_empty(),
            telemetry.session_id,
            telemetry.contents_count,
            telemetry.tool_declarations_count,
            telemetry.tool_names,
            telemetry.system_bytes,
            telemetry.contents_bytes,
            telemetry.tools_bytes,
            telemetry.body_bytes
        );
        let mut request = self
            .client
            .post(Self::endpoint(streaming))
            .bearer_auth(token)
            .header("User-Agent", Self::user_agent(&self.default_model))
            .header("x-activity-request-id", Self::activity_request_id());
        if streaming {
            request = request.header("Accept", "text/event-stream");
        }
        let response = request
            .json(body)
            .send()
            .await
            .map_err(|err| ProviderError::RequestFailed(err.to_string()))?;
        tracing::info!(
            "[gemini_native] response streaming={} status={}",
            streaming,
            response.status()
        );
        #[cfg(debug_assertions)]
        eprintln!(
            "[gemini_native] response streaming={} status={}",
            streaming,
            response.status()
        );
        Ok(response)
    }
}

#[async_trait]
impl LLMProvider for GeminiNativeClient {
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        self.ensure_project_id()?;
        let body = self.request_body(messages, tools, model, max_tokens, temperature);
        let mut token = self.fresh_access_token(None).await?;
        let mut response = self.send_once(&token, &body, false).await?;
        if matches!(response.status().as_u16(), 401 | 403) {
            token = self.fresh_access_token(Some(&token)).await?;
            response = self.send_once(&token, &body, false).await?;
        }
        parse_http_response(response).await
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
        self.ensure_project_id()?;
        if cancel_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            return Err(ProviderError::Cancelled);
        }
        let body = self.request_body(messages, tools, model, max_tokens, temperature);
        let mut token = self.fresh_access_token(None).await?;
        let mut response = if let Some(flag) = cancel_flag {
            tokio::select! {
                result = self.send_once(&token, &body, true) => result?,
                _ = async {
                    while !flag.load(Ordering::Relaxed) {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                } => {
                    tracing::info!("[gemini_native] Request cancelled before stream response (model={})", model);
                    return Err(ProviderError::Cancelled);
                }
            }
        } else {
            self.send_once(&token, &body, true).await?
        };
        if matches!(response.status().as_u16(), 401 | 403) {
            token = self.fresh_access_token(Some(&token)).await?;
            response = self.send_once(&token, &body, true).await?;
        }
        parse_streaming_response(response, on_delta, cancel_flag).await
    }

    fn default_model(&self) -> &str {
        &self.default_model
    }

    fn provider_name(&self) -> &str {
        "gemini_native"
    }
}

#[cfg(test)]
mod tests {
    use super::GeminiNativeClient;

    #[test]
    fn endpoint_uses_code_assist_method_url_not_public_model_url() {
        assert_eq!(
            GeminiNativeClient::endpoint(false),
            "https://cloudcode-pa.googleapis.com/v1internal:generateContent"
        );
        assert_eq!(
            GeminiNativeClient::endpoint(true),
            "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn user_agent_matches_gemini_cli_shape() {
        let user_agent = GeminiNativeClient::user_agent("gemini-2.5-pro");

        assert!(user_agent.starts_with("GeminiCLI/0.1.0/gemini-2.5-pro ("));
        assert!(user_agent.ends_with("; terminal)"));
    }
}
