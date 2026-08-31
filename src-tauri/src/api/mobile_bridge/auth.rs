//! Mobile bridge authentication — static LAN token from user settings.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::http::{HeaderMap, StatusCode};

pub const MOBILE_TOKEN_HEADER: &str = "x-orgii-mobile-token";
pub const MOBILE_TOKEN_QUERY: &str = "token";

/// Phase 0 mobile remote settings snapshot (read from `~/.orgii/settings.jsonc`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MobileRemoteSettings {
    pub enabled: bool,
    pub lan_token: String,
    pub allow_lan_exposure: bool,
}

impl Default for MobileRemoteSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            lan_token: String::new(),
            allow_lan_exposure: false,
        }
    }
}

/// Resolve IDE server bind address from mobile remote LAN exposure setting.
pub fn ide_server_bind_addr(port: u16) -> SocketAddr {
    let settings = load_settings();
    let ip = if settings.allow_lan_exposure {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    SocketAddr::new(ip, port)
}

/// Load mobile-remote settings from disk. Missing keys fall back to safe defaults.
pub fn load_settings() -> MobileRemoteSettings {
    let Ok(settings) = settings::file_io::read_settings() else {
        return MobileRemoteSettings::default();
    };

    MobileRemoteSettings {
        enabled: settings
            .get("mobileRemote.enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        lan_token: settings
            .get("mobileRemote.lanToken")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        allow_lan_exposure: settings
            .get("mobileRemote.allowLanExposure")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

/// Timing-safe comparison against the configured LAN token.
pub fn token_matches(candidate: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let expected = expected.as_bytes();
    let candidate = candidate.as_bytes();
    if expected.len() != candidate.len() {
        return false;
    }
    expected
        .iter()
        .zip(candidate)
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

/// Validate bearer token against explicit settings (unit-testable).
pub fn validate_token_against_settings(
    candidate: &str,
    settings: &MobileRemoteSettings,
) -> Result<(), AuthFailure> {
    if !settings.enabled {
        return Err(AuthFailure::FeatureDisabled);
    }
    if settings.lan_token.is_empty() {
        return Err(AuthFailure::TokenNotConfigured);
    }
    if candidate.is_empty() || !token_matches(candidate, &settings.lan_token) {
        return Err(AuthFailure::InvalidToken);
    }
    Ok(())
}

/// Validate bearer token against current settings.
pub fn validate_token(candidate: &str) -> Result<MobileRemoteSettings, AuthFailure> {
    let settings = load_settings();
    validate_token_against_settings(candidate, &settings)?;
    Ok(settings)
}

/// Extract token from REST headers (case-insensitive header name).
pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get(MOBILE_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFailure {
    MissingToken,
    InvalidToken,
    TokenNotConfigured,
    FeatureDisabled,
}

impl AuthFailure {
    pub fn status_code(self) -> StatusCode {
        match self {
            Self::MissingToken | Self::InvalidToken | Self::TokenNotConfigured => {
                StatusCode::UNAUTHORIZED
            }
            Self::FeatureDisabled => StatusCode::FORBIDDEN,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::MissingToken => "missing mobile token",
            Self::InvalidToken => "invalid mobile token",
            Self::TokenNotConfigured => "mobile LAN token not configured",
            Self::FeatureDisabled => "mobile remote disabled",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_matches_rejects_empty_expected() {
        assert!(!token_matches("abc", ""));
    }

    #[test]
    fn token_matches_rejects_length_mismatch() {
        assert!(!token_matches("short", "much-longer-token"));
        assert!(!token_matches("much-longer-token", "short"));
    }

    #[test]
    fn token_matches_accepts_equal_tokens() {
        let token = "01234567-89ab-cdef-0123-456789abcdef";
        assert!(token_matches(token, token));
    }

    #[test]
    fn token_matches_rejects_wrong_token() {
        assert!(!token_matches(
            "01234567-89ab-cdef-0123-456789abcdef",
            "fedcba98-7654-3210-dcba-9876543210fe"
        ));
    }

    #[test]
    fn token_from_headers_reads_mobile_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            MOBILE_TOKEN_HEADER,
            "test-token".parse().expect("valid header value"),
        );
        assert_eq!(token_from_headers(&headers).as_deref(), Some("test-token"));
    }

    #[test]
    fn token_from_headers_ignores_empty() {
        let mut headers = HeaderMap::new();
        headers.insert(
            MOBILE_TOKEN_HEADER,
            "   ".parse().expect("valid header value"),
        );
        assert_eq!(token_from_headers(&headers), None);
    }

    fn enabled_settings(token: &str) -> MobileRemoteSettings {
        MobileRemoteSettings {
            enabled: true,
            lan_token: token.to_string(),
            allow_lan_exposure: false,
        }
    }

    #[test]
    fn validate_token_against_settings_accepts_matching_token() {
        let settings = enabled_settings("lan-secret");
        assert!(validate_token_against_settings("lan-secret", &settings).is_ok());
    }

    #[test]
    fn validate_token_against_settings_rejects_when_disabled() {
        let settings = MobileRemoteSettings {
            enabled: false,
            lan_token: "lan-secret".to_string(),
            allow_lan_exposure: false,
        };
        assert_eq!(
            validate_token_against_settings("lan-secret", &settings),
            Err(AuthFailure::FeatureDisabled)
        );
    }

    #[test]
    fn validate_token_against_settings_rejects_unconfigured_token() {
        let settings = MobileRemoteSettings {
            enabled: true,
            lan_token: String::new(),
            allow_lan_exposure: false,
        };
        assert_eq!(
            validate_token_against_settings("anything", &settings),
            Err(AuthFailure::TokenNotConfigured)
        );
    }

    #[test]
    fn validate_token_against_settings_rejects_wrong_token() {
        let settings = enabled_settings("lan-secret");
        assert_eq!(
            validate_token_against_settings("wrong-secret", &settings),
            Err(AuthFailure::InvalidToken)
        );
    }

    #[test]
    fn validate_token_against_settings_rejects_empty_candidate() {
        let settings = enabled_settings("lan-secret");
        assert_eq!(
            validate_token_against_settings("", &settings),
            Err(AuthFailure::InvalidToken)
        );
    }
}
