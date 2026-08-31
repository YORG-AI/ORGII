use std::net::SocketAddr;
use std::path::PathBuf;

use mobile_relay_protocol::MOBILE_WS_PATH;

#[derive(Debug, Clone)]
pub struct RelayConfig {
    pub listen_addr: SocketAddr,
    pub database_path: PathBuf,
    pub desktop_token: String,
    pub public_ws_url: String,
    pub public_app_url: String,
    pub pairing_ttl_seconds: u64,
}

impl RelayConfig {
    pub fn from_env() -> Result<Self, String> {
        let listen_addr = std::env::var("ORGII_RELAY_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
            .parse::<SocketAddr>()
            .map_err(|err| format!("invalid ORGII_RELAY_LISTEN: {err}"))?;
        let database_path = std::env::var_os("ORGII_RELAY_DATABASE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("orgii-mobile-relay.sqlite3"));
        let desktop_token = std::env::var("ORGII_RELAY_DESKTOP_TOKEN")
            .map_err(|_| "ORGII_RELAY_DESKTOP_TOKEN is required".to_string())?;
        if desktop_token.trim().len() < 24 {
            return Err(
                "ORGII_RELAY_DESKTOP_TOKEN must contain at least 24 characters".to_string(),
            );
        }
        let public_ws_url = std::env::var("ORGII_RELAY_PUBLIC_WS_URL")
            .unwrap_or_else(|_| format!("ws://{listen_addr}{MOBILE_WS_PATH}"));
        validate_public_ws_url(&public_ws_url)?;
        let public_app_url = match std::env::var("ORGII_RELAY_PUBLIC_APP_URL") {
            Ok(value) => value,
            Err(_) => default_public_app_url(&public_ws_url)?,
        };
        validate_public_app_url(&public_app_url)?;

        Ok(Self {
            listen_addr,
            database_path,
            desktop_token,
            public_ws_url,
            public_app_url,
            pairing_ttl_seconds: 120,
        })
    }
}

fn default_public_app_url(public_ws_url: &str) -> Result<String, String> {
    let mut url = url::Url::parse(public_ws_url)
        .map_err(|err| format!("invalid ORGII_RELAY_PUBLIC_WS_URL: {err}"))?;
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return Err("relay public URL must use ws:// or wss://".to_string()),
    };
    url.set_scheme(scheme)
        .map_err(|_| "could not derive public app URL".to_string())?;
    url.set_path("/orgii/mobile");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn validate_public_app_url(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|err| format!("invalid public app URL: {err}"))?;
    if url.fragment().is_some() {
        return Err("relay public app URL must not contain a fragment".to_string());
    }
    if matches!(url.scheme(), "http" | "https") {
        Ok(())
    } else {
        Err("relay public app URL must use http:// or https://".to_string())
    }
}

pub fn validate_public_ws_url(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|err| format!("invalid relay public URL: {err}"))?;
    if !matches!(url.scheme(), "ws" | "wss") {
        return Err("relay public URL must use ws:// or wss://".to_string());
    }
    if url.host_str().is_none() {
        return Err("relay public URL must include a host".to_string());
    }
    if url.fragment().is_some() {
        return Err("relay public URL must not contain a fragment".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_url_rejects_http_and_relative_values() {
        assert!(validate_public_ws_url("https://relay.example.com").is_err());
        assert!(validate_public_ws_url("/v1/mobile/ws").is_err());
        assert!(validate_public_ws_url("wss://[").is_err());
        assert!(validate_public_ws_url("wss://relay.example.com/path#secret").is_err());
        assert!(validate_public_ws_url("wss://relay.example.com/v1/mobile/ws").is_ok());
    }

    #[test]
    fn app_url_is_derived_without_websocket_path_or_query() {
        assert_eq!(
            default_public_app_url("wss://relay.example.com/v1/mobile/ws?old=query")
                .expect("app URL"),
            "https://relay.example.com/orgii/mobile"
        );
    }
}
