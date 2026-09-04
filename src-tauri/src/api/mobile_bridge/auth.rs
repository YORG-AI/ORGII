//! Mobile bridge authentication — static LAN token from user settings.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};

use axum::http::{HeaderMap, StatusCode};

pub const MOBILE_TOKEN_HEADER: &str = "x-orgii-mobile-token";
pub const MOBILE_TOKEN_QUERY: &str = "token";

/// Default TCP port of the mobile bridge listener.
///
/// Must stay in sync with `MOBILE_REMOTE_DEFAULT_LAN_PORT` in
/// `src/config/settingsSchema/registry/mobileRemote.ts` — that constant is the
/// default of `mobileRemote.lanPort`, which Settings encodes into the pairing
/// QR code. It sits outside the unified IDE server's per-instance port range
/// (13847 + instance offset, capped at instance 99) so the bridge never
/// contends with the loopback-only IDE server.
pub const DEFAULT_MOBILE_LAN_PORT: u16 = 13947;

/// Whether the live bridge listener was bound to every interface.
///
/// Written once by the listener task at bind time. Bridge routes read it so
/// that revoking `mobileRemote.allowLanExposure` takes effect on the next
/// request instead of on the next app restart.
static BRIDGE_BOUND_LAN: AtomicBool = AtomicBool::new(false);

/// Phase 0 mobile remote settings snapshot (read from `~/.orgii/settings.jsonc`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MobileRemoteSettings {
    pub enabled: bool,
    pub lan_token: String,
    pub allow_lan_exposure: bool,
}

/// Why the mobile bridge listener was not started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeBindSkip {
    /// `mobileRemote.enabled` is off — the bridge must not listen at all.
    Disabled,
    /// `mobileRemote.lanPort` collides with the unified IDE server port.
    /// Binding there would fail (the IDE server claims the port first) and, if
    /// it ever won the race, would take the IDE server offline. Stay down and
    /// tell the user instead.
    IdeServerPortConflict,
}

impl BridgeBindSkip {
    pub fn message(self) -> &'static str {
        match self {
            Self::Disabled => "mobile remote disabled; no bridge listener started",
            Self::IdeServerPortConflict => {
                "mobileRemote.lanPort collides with the IDE server port; no bridge listener started"
            }
        }
    }
}

/// Bind address of the unified IDE server. Always loopback.
///
/// That server carries the unauthenticated `/git`, `/search`, `/agent`, `/ws`
/// and webhook routes, so it must never be reachable off this machine. LAN
/// exposure is a mobile-bridge-only concern and is served by the bridge's own
/// listener — see [`mobile_bridge_bind_addr`].
pub fn ide_server_bind_addr(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

/// Resolve the mobile bridge listener address.
///
/// The bridge listens only while Mobile Remote is enabled, and reaches beyond
/// loopback only when the user opted into LAN exposure. `ide_server_port` is
/// passed so a misconfigured `mobileRemote.lanPort` is refused loudly rather
/// than fighting the IDE server for its port.
pub fn mobile_bridge_bind_addr(
    settings: &MobileRemoteSettings,
    lan_port: u16,
    ide_server_port: u16,
) -> Result<SocketAddr, BridgeBindSkip> {
    if !settings.enabled {
        return Err(BridgeBindSkip::Disabled);
    }
    if lan_port == ide_server_port {
        return Err(BridgeBindSkip::IdeServerPortConflict);
    }
    let ip = if settings.allow_lan_exposure {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    Ok(SocketAddr::new(ip, lan_port))
}

/// Mobile bridge TCP port from `mobileRemote.lanPort`.
pub fn mobile_lan_port() -> u16 {
    let Ok(settings) = settings::file_io::read_settings() else {
        return DEFAULT_MOBILE_LAN_PORT;
    };
    settings
        .get("mobileRemote.lanPort")
        .and_then(|value| value.as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_MOBILE_LAN_PORT)
}

/// Record how the live bridge listener was bound.
pub fn set_bridge_bound_lan(bound_lan: bool) {
    BRIDGE_BOUND_LAN.store(bound_lan, Ordering::Relaxed);
}

/// Whether a bridge route may answer at all, given the settings read for this
/// request and how the listener happens to be bound.
///
/// A listener bound to every interface stops serving as soon as the user
/// revokes LAN exposure, so flipping either Mobile Remote toggle off removes
/// LAN reachability immediately rather than at the next restart.
pub fn bridge_route_available(settings: &MobileRemoteSettings, bound_lan: bool) -> bool {
    settings.enabled && (!bound_lan || settings.allow_lan_exposure)
}

/// Live per-request gate shared by every mobile bridge route.
pub fn check_bridge_available(settings: &MobileRemoteSettings) -> Result<(), AuthFailure> {
    if bridge_route_available(settings, BRIDGE_BOUND_LAN.load(Ordering::Relaxed)) {
        Ok(())
    } else {
        Err(AuthFailure::FeatureDisabled)
    }
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

    fn settings_matrix(enabled: bool, allow_lan_exposure: bool) -> MobileRemoteSettings {
        MobileRemoteSettings {
            enabled,
            lan_token: "lan-secret".to_string(),
            allow_lan_exposure,
        }
    }

    #[test]
    fn ide_server_bind_addr_is_always_loopback() {
        // The IDE server carries unauthenticated /git, /agent, /search and /ws
        // routes; no setting may widen it beyond this machine.
        for port in [1u16, 13_847, 13_945, 65_535] {
            let addr = ide_server_bind_addr(port);
            assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST), "port {port}");
            assert_eq!(addr.port(), port);
        }
    }

    #[test]
    fn mobile_bridge_bind_addr_refuses_to_listen_when_disabled() {
        for allow_lan_exposure in [false, true] {
            assert_eq!(
                mobile_bridge_bind_addr(
                    &settings_matrix(false, allow_lan_exposure),
                    DEFAULT_MOBILE_LAN_PORT,
                    13_847
                ),
                Err(BridgeBindSkip::Disabled),
                "allow_lan_exposure = {allow_lan_exposure}"
            );
        }
    }

    #[test]
    fn mobile_bridge_bind_addr_stays_on_loopback_without_exposure() {
        assert_eq!(
            mobile_bridge_bind_addr(&settings_matrix(true, false), DEFAULT_MOBILE_LAN_PORT, 13_847),
            Ok(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                DEFAULT_MOBILE_LAN_PORT
            ))
        );
    }

    #[test]
    fn mobile_bridge_bind_addr_opens_all_interfaces_with_exposure() {
        assert_eq!(
            mobile_bridge_bind_addr(&settings_matrix(true, true), DEFAULT_MOBILE_LAN_PORT, 13_847),
            Ok(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::UNSPECIFIED),
                DEFAULT_MOBILE_LAN_PORT
            ))
        );
    }

    #[test]
    fn mobile_bridge_bind_addr_refuses_the_ide_server_port() {
        // Sharing the IDE server port is what leaked /git, /agent and /ws to
        // the LAN in the first place; the bridge never binds there again.
        for allow_lan_exposure in [false, true] {
            assert_eq!(
                mobile_bridge_bind_addr(&settings_matrix(true, allow_lan_exposure), 13_847, 13_847),
                Err(BridgeBindSkip::IdeServerPortConflict),
                "allow_lan_exposure = {allow_lan_exposure}"
            );
        }
    }

    #[test]
    fn default_mobile_lan_port_is_outside_the_ide_server_range() {
        // Instance ids run 1..=99, so IDE servers occupy 13847..=13945.
        assert!(!(13_847..=13_945).contains(&DEFAULT_MOBILE_LAN_PORT));
    }

    #[test]
    fn bridge_routes_close_when_either_toggle_is_revoked() {
        // Bound to loopback: only `enabled` matters.
        assert!(bridge_route_available(&settings_matrix(true, false), false));
        assert!(bridge_route_available(&settings_matrix(true, true), false));
        assert!(!bridge_route_available(&settings_matrix(false, true), false));

        // Bound to every interface: revoking exposure closes the routes even
        // though the socket stays bound until the next restart.
        assert!(bridge_route_available(&settings_matrix(true, true), true));
        assert!(!bridge_route_available(&settings_matrix(true, false), true));
        assert!(!bridge_route_available(&settings_matrix(false, true), true));
    }
}
