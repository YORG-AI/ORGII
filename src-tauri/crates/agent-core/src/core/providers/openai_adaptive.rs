//! Endpoint-adaptive OpenAI provider.
//!
//! Starts from the account-scoped OpenAI endpoint policy and can learn that a
//! specific account/base/model alias requires the public Responses endpoint.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::AtomicBool;

use super::openai_compat::OpenAICompatClient;
use super::openai_policy::{
    openai_chat_wire_preference_from_error, openai_error_requires_responses,
    remember_openai_chat_wire_preference, remember_openai_responses_required,
    resolve_openai_endpoint_policy, OpenAiChatWirePolicy, OpenAiEndpointPolicy,
};
use super::openai_responses::OpenAIResponsesClient;
use super::registry::ProviderSpec;
use super::traits::{LLMProvider, LLMResponse, ProviderConfig, ProviderError, StreamDelta};

pub(crate) struct OpenAiAdaptiveClient {
    spec: &'static ProviderSpec,
    account_id: Option<String>,
    custom_base_url: Option<String>,
    default_model: String,
    chat_client: OpenAICompatClient,
    responses_client: OpenAIResponsesClient,
}

impl OpenAiAdaptiveClient {
    pub(crate) fn new(
        config: ProviderConfig,
        spec: &'static ProviderSpec,
        default_model: String,
        account_id: Option<String>,
        custom_base_url: Option<String>,
    ) -> Self {
        let chat_account_id = account_id.clone();
        Self {
            spec,
            account_id: account_id.clone(),
            custom_base_url,
            default_model: default_model.clone(),
            chat_client: OpenAICompatClient::new_with_account(
                config.clone(),
                spec,
                default_model.clone(),
                chat_account_id,
            ),
            responses_client: OpenAIResponsesClient::new_with_account(
                config,
                default_model,
                account_id.clone(),
            ),
        }
    }

    fn policy(&self, model: &str) -> OpenAiEndpointPolicy {
        resolve_openai_endpoint_policy(
            self.spec,
            self.account_id.as_deref(),
            self.custom_base_url.as_deref(),
            model,
        )
    }

    fn remember_responses_required(&self, model: &str) {
        remember_openai_responses_required(
            self.spec,
            self.account_id.as_deref(),
            self.custom_base_url.as_deref(),
            model,
        );
    }

    fn should_try_responses(&self, err: &ProviderError) -> bool {
        match err {
            ProviderError::RequestFailed(body) | ProviderError::ModelNotFound(body) => {
                openai_error_requires_responses(body)
            }
            _ => false,
        }
    }

    fn remember_chat_wire_preference_from_error(
        &self,
        model: &str,
        err: &ProviderError,
        current_policy: OpenAiChatWirePolicy,
    ) -> bool {
        let body = match err {
            ProviderError::RequestFailed(body) | ProviderError::ModelNotFound(body) => body,
            _ => return false,
        };
        let Some(preference) = openai_chat_wire_preference_from_error(body, current_policy) else {
            return false;
        };
        remember_openai_chat_wire_preference(
            self.spec,
            self.account_id.as_deref(),
            self.custom_base_url.as_deref(),
            model,
            preference,
        );
        true
    }
}

#[async_trait]
impl LLMProvider for OpenAiAdaptiveClient {
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: Option<u32>,
        temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        match self.policy(model) {
            OpenAiEndpointPolicy::Responses => {
                self.responses_client
                    .chat(messages, tools, model, max_tokens, temperature)
                    .await
            }
            OpenAiEndpointPolicy::ChatCompletions(chat_policy) => match self
                .chat_client
                .chat(messages, tools, model, max_tokens, temperature)
                .await
            {
                Ok(response) => Ok(response),
                Err(err)
                    if self.remember_chat_wire_preference_from_error(model, &err, chat_policy) =>
                {
                    self.chat_client
                        .chat(messages, tools, model, max_tokens, temperature)
                        .await
                }
                Err(err) if self.should_try_responses(&err) => {
                    let response = self
                        .responses_client
                        .chat(messages, tools, model, max_tokens, temperature)
                        .await?;
                    self.remember_responses_required(model);
                    Ok(response)
                }
                Err(err) => Err(err),
            },
        }
    }

    async fn chat_streaming(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: Option<u32>,
        temperature: f32,
        on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<LLMResponse, ProviderError> {
        match self.policy(model) {
            OpenAiEndpointPolicy::Responses => {
                self.responses_client
                    .chat_streaming(
                        messages,
                        tools,
                        model,
                        max_tokens,
                        temperature,
                        on_delta,
                        cancel_flag,
                    )
                    .await
            }
            OpenAiEndpointPolicy::ChatCompletions(chat_policy) => match self
                .chat_client
                .chat_streaming(
                    messages,
                    tools,
                    model,
                    max_tokens,
                    temperature,
                    on_delta,
                    cancel_flag,
                )
                .await
            {
                Ok(response) => Ok(response),
                Err(err)
                    if self.remember_chat_wire_preference_from_error(model, &err, chat_policy) =>
                {
                    self.chat_client
                        .chat_streaming(
                            messages,
                            tools,
                            model,
                            max_tokens,
                            temperature,
                            on_delta,
                            cancel_flag,
                        )
                        .await
                }
                Err(err) if self.should_try_responses(&err) => {
                    let response = self
                        .responses_client
                        .chat_streaming(
                            messages,
                            tools,
                            model,
                            max_tokens,
                            temperature,
                            on_delta,
                            cancel_flag,
                        )
                        .await?;
                    self.remember_responses_required(model);
                    Ok(response)
                }
                Err(err) => Err(err),
            },
        }
    }

    fn default_model(&self) -> &str {
        &self.default_model
    }

    fn provider_name(&self) -> &str {
        self.spec.name
    }
}
