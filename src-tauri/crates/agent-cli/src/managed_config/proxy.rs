//! Local managed proxy: port/URL resolution, the per-session proxy token,
//! and the authenticated route base URLs handed to each CLI.

use rand::RngCore;

use super::registry::{CLAUDE_CODE_AGENT, CODEX_AGENT};

#[cfg(test)]
pub(super) const DEFAULT_PROXY_URL: &str = "http://127.0.0.1:17888";
const DEFAULT_PROXY_PORT: u16 = 17888;
const PROXY_PORT_ENV: &str = "ORGII_CLI_PROXY_PORT";

pub fn managed_proxy_port() -> u16 {
    std::env::var(PROXY_PORT_ENV)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PROXY_PORT)
}

pub fn managed_proxy_url() -> String {
    format!("http://127.0.0.1:{}", managed_proxy_port())
}

pub(super) fn generate_proxy_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn proxy_route_base_url(
    proxy_url: &str,
    agent_name: &str,
    proxy_token: &str,
    suffix: &str,
) -> String {
    let root = proxy_url.trim().trim_end_matches('/');
    format!("{root}/cli/{agent_name}/{proxy_token}/{suffix}")
}

pub(super) fn codex_proxy_base_url(proxy_url: &str, proxy_token: &str) -> String {
    proxy_route_base_url(proxy_url, CODEX_AGENT, proxy_token, "v1")
}

pub(super) fn claude_code_proxy_base_url(proxy_url: &str, proxy_token: &str) -> String {
    proxy_route_base_url(proxy_url, CLAUDE_CODE_AGENT, proxy_token, "claude")
}

pub(super) fn openai_chat_proxy_base_url(
    proxy_url: &str,
    agent_name: &str,
    proxy_token: &str,
) -> String {
    proxy_route_base_url(proxy_url, agent_name, proxy_token, "v1")
}
