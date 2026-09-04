//! Network Utilities
//!
//! - VPN detection via network interface inspection (utun/tun/tap/wg/ppp).
//! - Public IP + geolocation lookup via ipinfo.io (bypasses webview HTTP cache).

use std::process::Command;
use std::time::Duration;

#[derive(serde::Serialize, Default)]
pub struct VpnStatus {
    pub detected: bool,
    pub interfaces: Vec<VpnInterface>,
}

#[derive(serde::Serialize)]
pub struct VpnInterface {
    pub name: String,
    pub kind: String,
    /// "active" = has IP + traffic, "idle" = exists but no traffic, "down" = no IP assigned
    pub status: String,
}

/// Known VPN interface prefixes and their human-readable types
#[cfg(any(target_os = "macos", target_os = "linux"))]
const VPN_PREFIXES: &[(&str, &str)] = &[
    ("utun", "VPN Tunnel"),
    ("tun", "TUN"),
    ("tap", "TAP"),
    ("wg", "WireGuard"),
    ("ppp", "PPP"),
    ("ipsec", "IPSec"),
    ("gpd", "GlobalProtect"),
    ("tailscale", "Tailscale"),
];

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn classify_interface(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    for &(prefix, kind) in VPN_PREFIXES {
        if lower.starts_with(prefix) {
            return Some(kind);
        }
    }
    None
}

/// Detect VPN by listing network interfaces and checking their status.
/// Runs on a background thread to avoid blocking the main thread.
#[tauri::command]
pub async fn detect_vpn() -> VpnStatus {
    tokio::task::spawn_blocking(|| {
        let interfaces = detect_vpn_interfaces();
        let detected = interfaces.iter().any(|i| i.status == "active");
        VpnStatus {
            detected,
            interfaces,
        }
    })
    .await
    .unwrap_or_default()
}

// ============================================
// macOS
// ============================================

#[cfg(target_os = "macos")]
fn detect_vpn_interfaces() -> Vec<VpnInterface> {
    // `ifconfig -l` lists all interface names
    let list_output = Command::new("ifconfig").arg("-l").output().ok();

    let Some(list_output) = list_output else {
        return vec![];
    };
    if !list_output.status.success() {
        return vec![];
    }

    let names = String::from_utf8_lossy(&list_output.stdout);
    names
        .split_whitespace()
        .filter_map(|name| {
            let kind = classify_interface(name)?;
            let status = get_interface_status_macos(name);
            Some(VpnInterface {
                name: name.to_string(),
                kind: kind.to_string(),
                status,
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn get_interface_status_macos(name: &str) -> String {
    // Run `ifconfig <name>` to get full details
    let output = Command::new("ifconfig").arg(name).output().ok();

    let Some(output) = output else {
        return "down".to_string();
    };
    if !output.status.success() {
        return "down".to_string();
    }

    let text = String::from_utf8_lossy(&output.stdout);

    // Check if interface has UP flag
    let is_up = text
        .lines()
        .any(|line| line.contains("flags=") && line.contains("UP"));
    if !is_up {
        return "down".to_string();
    }

    // Check if it has an inet (IPv4) or inet6 address (not link-local fe80::)
    let has_ip = text.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.starts_with("inet ") {
            return true;
        }
        if trimmed.starts_with("inet6 ")
            && !trimmed.contains("fe80::")
            && !trimmed.contains("scopeid")
        {
            return true;
        }
        false
    });

    if !has_ip {
        return "down".to_string();
    }

    // Parse TX/RX bytes from `netstat -bI <name>` to determine if traffic is flowing
    let netstat = Command::new("netstat").args(["-bI", name]).output().ok();

    if let Some(ns_output) = netstat {
        if ns_output.status.success() {
            let ns_text = String::from_utf8_lossy(&ns_output.stdout);
            // Data lines (skip header). Look for non-zero bytes in/out columns.
            for line in ns_text.lines().skip(1) {
                let cols: Vec<&str> = line.split_whitespace().collect();
                // netstat -bI format: Name Mtu Network Address Ipkts Ibytes Opkts Obytes ...
                if cols.len() >= 8 && cols[0] == name {
                    let ibytes: u64 = cols[5].parse().unwrap_or(0);
                    let obytes: u64 = cols[7].parse().unwrap_or(0);
                    if ibytes > 0 || obytes > 0 {
                        return "active".to_string();
                    }
                }
            }
        }
    }

    "idle".to_string()
}

// ============================================
// Linux
// ============================================

#[cfg(target_os = "linux")]
fn detect_vpn_interfaces() -> Vec<VpnInterface> {
    let entries = std::fs::read_dir("/sys/class/net").ok();
    let Some(entries) = entries else {
        return vec![];
    };

    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let kind = classify_interface(&name)?;
            let status = get_interface_status_linux(&name);
            Some(VpnInterface {
                name,
                kind: kind.to_string(),
                status,
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn get_interface_status_linux(name: &str) -> String {
    let base = format!("/sys/class/net/{}", name);

    // Check operstate
    let operstate = std::fs::read_to_string(format!("{}/operstate", base)).unwrap_or_default();
    if operstate.trim() != "up" && operstate.trim() != "unknown" {
        return "down".to_string();
    }

    // Check TX/RX bytes
    let rx: u64 = std::fs::read_to_string(format!("{}/statistics/rx_bytes", base))
        .unwrap_or_default()
        .trim()
        .parse()
        .unwrap_or(0);
    let tx: u64 = std::fs::read_to_string(format!("{}/statistics/tx_bytes", base))
        .unwrap_or_default()
        .trim()
        .parse()
        .unwrap_or(0);

    if rx > 0 || tx > 0 {
        "active".to_string()
    } else {
        "idle".to_string()
    }
}

// ============================================
// Windows
// ============================================

#[cfg(target_os = "windows")]
fn detect_vpn_interfaces() -> Vec<VpnInterface> {
    let mut command = Command::new("netsh");
    command.args(["interface", "show", "interface"]);
    // Don't flash a console window during VPN/interface detection.
    app_platform::hide_console(&mut command);
    let output = command.output().ok();

    let Some(output) = output else { return vec![] };
    if !output.status.success() {
        return vec![];
    }

    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .filter_map(|line| {
            let lower = line.to_lowercase();
            if !lower.contains("tap")
                && !lower.contains("tun")
                && !lower.contains("wireguard")
                && !lower.contains("wintun")
                && !lower.contains("tailscale")
            {
                return None;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 4 {
                return None;
            }
            let admin_state = parts[0].to_lowercase();
            let connect_state = parts[1].to_lowercase();
            let name = parts[3..].join(" ");
            let kind = if lower.contains("wireguard") || lower.contains("wintun") {
                "WireGuard"
            } else if lower.contains("tailscale") {
                "Tailscale"
            } else if lower.contains("tap") {
                "TAP"
            } else {
                "TUN"
            };
            let status = if admin_state == "enabled" && connect_state == "connected" {
                "active"
            } else if admin_state == "enabled" {
                "idle"
            } else {
                "down"
            };
            Some(VpnInterface {
                name,
                kind: kind.to_string(),
                status: status.to_string(),
            })
        })
        .collect()
}

// ============================================
// Public IP + Geolocation
// ============================================

#[derive(serde::Serialize, Default)]
pub struct GeoInfo {
    pub ip: String,
    pub city: String,
    pub region: String,
    pub country: String,
    pub org: String,
}

/// Fetch public IP and geolocation from ipinfo.io using reqwest.
/// Bypasses webview HTTP cache — always hits the network.
#[tauri::command]
pub async fn fetch_geo_info() -> Result<GeoInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .map_err(|err| err.to_string())?;

    let resp = client
        .get("https://ipinfo.io/json?token=")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp.json().await.map_err(|err| err.to_string())?;

    Ok(GeoInfo {
        ip: data["ip"].as_str().unwrap_or_default().to_string(),
        city: data["city"].as_str().unwrap_or_default().to_string(),
        region: data["region"].as_str().unwrap_or_default().to_string(),
        country: data["country"].as_str().unwrap_or_default().to_string(),
        org: data["org"].as_str().unwrap_or_default().to_string(),
    })
}

// ============================================
// Local LAN IPv4
// ============================================

fn is_lan_ipv4(ip: &std::net::Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_loopback()
}

fn parse_lan_ipv4(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let ip: std::net::Ipv4Addr = trimmed.parse().ok()?;
    is_lan_ipv4(&ip).then(|| trimmed.to_string())
}

#[cfg(target_os = "macos")]
fn get_local_lan_ip_blocking() -> Result<String, String> {
    for iface in ["en0", "en1", "en2", "bridge0"] {
        let output = Command::new("ipconfig")
            .args(["getifaddr", iface])
            .output()
            .map_err(|err| err.to_string())?;
        if !output.status.success() {
            continue;
        }
        if let Some(ip) = parse_lan_ipv4(&String::from_utf8_lossy(&output.stdout)) {
            return Ok(ip);
        }
    }

    let output = Command::new("ifconfig")
        .output()
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err("ifconfig failed".to_string());
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("inet ") || trimmed.contains("127.0.0.1") {
            continue;
        }
        let ip_part = trimmed
            .strip_prefix("inet ")
            .and_then(|rest| rest.split_whitespace().next())
            .unwrap_or_default();
        if let Some(ip) = parse_lan_ipv4(ip_part) {
            return Ok(ip);
        }
    }

    Err("No LAN IPv4 address found".to_string())
}

#[cfg(target_os = "linux")]
fn get_local_lan_ip_blocking() -> Result<String, String> {
    let output = Command::new("ip")
        .args(["-4", "-o", "addr", "show", "scope", "global", "up"])
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            for token in line.split_whitespace() {
                if let Some(ip) = parse_lan_ipv4(token.split('/').next().unwrap_or_default()) {
                    return Ok(ip);
                }
            }
        }
    }

    let output = Command::new("hostname")
        .args(["-I"])
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        for token in String::from_utf8_lossy(&output.stdout).split_whitespace() {
            if let Some(ip) = parse_lan_ipv4(token) {
                return Ok(ip);
            }
        }
    }

    Err("No LAN IPv4 address found".to_string())
}

#[cfg(target_os = "windows")]
fn get_local_lan_ip_blocking() -> Result<String, String> {
    let mut command = Command::new("ipconfig");
    app_platform::hide_console(&mut command);
    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err("ipconfig failed".to_string());
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let trimmed = line.trim();
        let value = trimmed
            .strip_prefix("IPv4 Address")
            .or_else(|| trimmed.strip_prefix("IP Address"))
            .map(|rest| rest.trim_start_matches(':').trim());
        if let Some(raw) = value {
            if let Some(ip) = parse_lan_ipv4(raw.trim_end_matches("(Preferred)")) {
                return Ok(ip);
            }
        }
    }

    Err("No LAN IPv4 address found".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn get_local_lan_ip_blocking() -> Result<String, String> {
    Err("LAN IP detection is not supported on this platform".to_string())
}

/// Best-effort private IPv4 on the active LAN interface (for Mobile Remote QR URLs).
#[tauri::command]
pub async fn get_local_lan_ip() -> Result<String, String> {
    tokio::task::spawn_blocking(get_local_lan_ip_blocking)
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod lan_ip_tests {
    use super::{is_lan_ipv4, parse_lan_ipv4};

    #[test]
    fn accepts_private_ipv4() {
        assert_eq!(
            parse_lan_ipv4("192.168.1.42").as_deref(),
            Some("192.168.1.42")
        );
        assert_eq!(parse_lan_ipv4("10.0.0.5").as_deref(), Some("10.0.0.5"));
    }

    #[test]
    fn rejects_loopback_and_public_ipv4() {
        assert!(parse_lan_ipv4("127.0.0.1").is_none());
        assert!(parse_lan_ipv4("8.8.8.8").is_none());
    }

    #[test]
    fn lan_ipv4_predicate() {
        assert!(is_lan_ipv4(&"192.168.0.1".parse().unwrap()));
        assert!(!is_lan_ipv4(&"127.0.0.1".parse().unwrap()));
    }
}
