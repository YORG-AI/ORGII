//! ChatGPT account id extraction from Codex OAuth id tokens.

pub(super) fn extract_account_id_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    value
        .get("https://api.openai.com/auth.chatgpt_account_id")
        .or_else(|| value.get("chatgpt_account_id"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}
