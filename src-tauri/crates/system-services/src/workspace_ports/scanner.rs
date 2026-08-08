//! Cross-platform listening TCP port scanner with workspace attribution.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::advertised_urls;
use super::attribution::{
    attribute_port_to_workspaces, normalize_workspace_port_probes, NormalizedWorkspacePortProbe,
};
use super::types::{
    WorkspacePort, WorkspacePortKillRequest, WorkspacePortKillResult, WorkspacePortKind,
    WorkspacePortProbe, WorkspacePortProtocol, WorkspacePortScanResult,
};

const COMMAND_TIMEOUT_MS: u64 = 4_000;
const COMMAND_OUTPUT_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_PORTS: usize = 200;
const INITIAL_TIMEOUT_BACKOFF_MS: u64 = 60_000;
const MAX_TIMEOUT_BACKOFF_MS: u64 = 5 * 60_000;

const HTTP_PORTS: &[u16] = &[80, 3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888];
const HTTPS_PORTS: &[u16] = &[443, 8443];

#[derive(Debug, Clone)]
pub(crate) struct RawListeningPort {
    pub host: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    pub command_line: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct ProcessMetadata {
    process_name: Option<String>,
    command_line: Option<String>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    cwd: Option<String>,
}

struct TimeoutBackoff {
    consecutive_timeouts: u32,
    cooldown_until: Option<Instant>,
}

impl TimeoutBackoff {
    fn new() -> Self {
        Self {
            consecutive_timeouts: 0,
            cooldown_until: None,
        }
    }

    fn is_cooling_down(&self) -> Option<Duration> {
        let until = self.cooldown_until?;
        let now = Instant::now();
        if until > now {
            Some(until - now)
        } else {
            None
        }
    }

    fn record_timeout(&mut self) {
        self.consecutive_timeouts = self.consecutive_timeouts.saturating_add(1);
        let delay_ms = (INITIAL_TIMEOUT_BACKOFF_MS
            .saturating_mul(2u64.saturating_pow(self.consecutive_timeouts.saturating_sub(1))))
        .min(MAX_TIMEOUT_BACKOFF_MS);
        self.cooldown_until = Some(Instant::now() + Duration::from_millis(delay_ms));
    }

    fn record_success(&mut self) {
        self.consecutive_timeouts = 0;
        self.cooldown_until = None;
    }
}

fn timeout_backoff() -> &'static Mutex<TimeoutBackoff> {
    static BACKOFF: OnceLock<Mutex<TimeoutBackoff>> = OnceLock::new();
    BACKOFF.get_or_init(|| Mutex::new(TimeoutBackoff::new()))
}

/// Scan listening ports and attribute them to workspace folder probes.
pub fn scan_workspace_ports(folders: &[WorkspacePortProbe]) -> WorkspacePortScanResult {
    if let Ok(guard) = timeout_backoff().lock() {
        if let Some(remaining) = guard.is_cooling_down() {
            return make_unavailable_scan(format!(
                "Port scanning is temporarily paused after a command timeout. Retrying in {}s.",
                remaining.as_secs().saturating_add(1)
            ));
        }
    }

    match scan_platform_listening_ports() {
        Ok(raw_ports) => {
            if let Ok(mut guard) = timeout_backoff().lock() {
                guard.record_success();
            }
            let normalized = normalize_workspace_port_probes(folders);
            let mut ports: Vec<WorkspacePort> = raw_ports
                .into_iter()
                .map(|port| enrich_port(port, &normalized))
                .collect();
            ports.sort_by(compare_workspace_ports);
            ports.truncate(MAX_PORTS);
            WorkspacePortScanResult {
                platform: std::env::consts::OS.to_string(),
                scanned_at: now_ms(),
                ports,
                unavailable_reason: None,
            }
        }
        Err(error) => {
            if error.is_timeout() {
                if let Ok(mut guard) = timeout_backoff().lock() {
                    guard.record_timeout();
                }
            }
            tracing::warn!(error = %error, "workspace port scan failed");
            make_unavailable_scan(format!(
                "Port scanning is unavailable on {}.",
                std::env::consts::OS
            ))
        }
    }
}

/// Re-verify ownership then stop a workspace-owned listening process.
pub fn kill_workspace_port(request: &WorkspacePortKillRequest) -> WorkspacePortKillResult {
    if request.pid == 0 || request.port == 0 {
        return WorkspacePortKillResult {
            ok: false,
            reason: Some("Invalid process or port.".to_string()),
        };
    }

    let scan = scan_workspace_ports(&request.folders);
    let Some(port) = scan
        .ports
        .iter()
        .find(|candidate| candidate.pid == Some(request.pid) && candidate.port == request.port)
    else {
        return WorkspacePortKillResult {
            ok: false,
            reason: Some("The port is no longer listening.".to_string()),
        };
    };

    if port.kind != WorkspacePortKind::Workspace {
        return WorkspacePortKillResult {
            ok: false,
            reason: Some("Only workspace-owned local processes can be stopped here.".to_string()),
        };
    }

    let Some(pid) = port.pid else {
        return WorkspacePortKillResult {
            ok: false,
            reason: Some("The owning process is unknown.".to_string()),
        };
    };

    if pid == std::process::id() {
        return WorkspacePortKillResult {
            ok: false,
            reason: Some("Cannot stop the application process.".to_string()),
        };
    }

    if port
        .process_name
        .as_deref()
        .is_some_and(|name| name.eq_ignore_ascii_case("Electron"))
    {
        return WorkspacePortKillResult {
            ok: false,
            reason: Some("Cannot stop the application process.".to_string()),
        };
    }

    match terminate_process(pid) {
        Ok(()) => WorkspacePortKillResult {
            ok: true,
            reason: None,
        },
        Err(message) => WorkspacePortKillResult {
            ok: false,
            reason: Some(message),
        },
    }
}

fn terminate_process(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T"]);
        app_platform::hide_console(&mut command);
        let output = command.output().map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }
}

fn make_unavailable_scan(reason: String) -> WorkspacePortScanResult {
    WorkspacePortScanResult {
        platform: std::env::consts::OS.to_string(),
        scanned_at: now_ms(),
        ports: Vec::new(),
        unavailable_reason: Some(reason),
    }
}

fn enrich_port(port: RawListeningPort, folders: &[NormalizedWorkspacePortProbe]) -> WorkspacePort {
    let owner =
        attribute_port_to_workspaces(port.cwd.as_deref(), port.command_line.as_deref(), folders);
    let connect_host = connect_host_for_bind_host(&port.host);
    let mut protocol = infer_protocol(port.port);
    let mut advertised_url = None;
    let kind = if let Some(ref owner) = owner {
        if let Some(advertised) =
            advertised_urls::lookup_advertised_url(&owner.folder_id, port.port)
        {
            protocol = advertised.protocol;
            advertised_url = Some(advertised.origin);
        }
        WorkspacePortKind::Workspace
    } else if is_container_process(&port) {
        WorkspacePortKind::Container
    } else {
        WorkspacePortKind::External
    };

    WorkspacePort {
        id: format!(
            "{}:{}:{}",
            port.host,
            port.port,
            port.pid
                .map(|pid| pid.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        bind_host: port.host,
        connect_host,
        port: port.port,
        pid: port.pid,
        process_name: port.process_name,
        protocol,
        kind,
        owner,
        advertised_url,
    }
}

fn compare_workspace_ports(a: &WorkspacePort, b: &WorkspacePort) -> std::cmp::Ordering {
    let rank = |kind: WorkspacePortKind| match kind {
        WorkspacePortKind::Workspace => 0,
        WorkspacePortKind::Container => 1,
        WorkspacePortKind::External => 2,
    };
    rank(a.kind)
        .cmp(&rank(b.kind))
        .then(a.port.cmp(&b.port))
        .then(a.connect_host.cmp(&b.connect_host))
}

fn infer_protocol(port: u16) -> WorkspacePortProtocol {
    if HTTPS_PORTS.contains(&port) {
        WorkspacePortProtocol::Https
    } else if HTTP_PORTS.contains(&port) {
        WorkspacePortProtocol::Http
    } else {
        WorkspacePortProtocol::Unknown
    }
}

pub(crate) fn is_container_process(port: &RawListeningPort) -> bool {
    let haystack = format!(
        "{} {}",
        port.process_name.as_deref().unwrap_or(""),
        port.command_line.as_deref().unwrap_or("")
    )
    .to_lowercase();
    haystack.contains("container")
        || haystack.contains("com.docker")
        || haystack.contains("com.container")
}

fn connect_host_for_bind_host(host: &str) -> String {
    if matches!(host, "*" | "0.0.0.0" | "::") {
        "localhost".to_string()
    } else {
        host.to_string()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug)]
struct ScanError {
    message: String,
    timed_out: bool,
}

impl ScanError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            timed_out: false,
        }
    }

    fn timeout(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            timed_out: true,
        }
    }

    fn is_timeout(&self) -> bool {
        self.timed_out
    }
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

fn scan_platform_listening_ports() -> Result<Vec<RawListeningPort>, ScanError> {
    #[cfg(target_os = "macos")]
    {
        scan_darwin_lsof_ports()
    }
    #[cfg(target_os = "linux")]
    {
        return scan_linux_proc_ports();
    }
    #[cfg(windows)]
    {
        return scan_windows_netstat_ports();
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        Err(ScanError::new(format!(
            "Port scanning is not supported on {}",
            std::env::consts::OS
        )))
    }
}

fn run_command(program: &str, args: &[&str]) -> Result<String, ScanError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    app_platform::hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| ScanError::new(format!("Failed to spawn {program}: {error}")))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| ScanError::new(format!("{program} stdout unavailable")))?;

    let program_name = program.to_string();
    let stdout_reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let remaining = COMMAND_OUTPUT_LIMIT_BYTES.saturating_sub(output.len());
                    if remaining > 0 {
                        output.extend_from_slice(&buffer[..count.min(remaining)]);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    return Err(ScanError::new(format!(
                        "{program_name} read failed: {error}"
                    )));
                }
            }
        }
        Ok(output)
    });

    let deadline = Instant::now() + Duration::from_millis(COMMAND_TIMEOUT_MS);
    loop {
        match child
            .try_wait()
            .map_err(|error| ScanError::new(format!("{program} wait failed: {error}")))?
        {
            Some(status) => {
                let output = stdout_reader
                    .join()
                    .map_err(|_| ScanError::new(format!("{program} stdout reader panicked")))??;
                if !status.success() {
                    return Err(ScanError::new(format!(
                        "{program} exited with status {status}"
                    )));
                }
                return Ok(String::from_utf8_lossy(&output).into_owned());
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ScanError::timeout(format!(
                    "{program} timed out after {COMMAND_TIMEOUT_MS}ms"
                )));
            }
            None => {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_lsof_listening_output(output: &str) -> Vec<RawListeningPort> {
    let mut ports = Vec::new();
    let mut current_pid: Option<u32> = None;
    let mut current_process_name: Option<String> = None;

    for line in output.lines() {
        if line.is_empty() {
            continue;
        }
        let (tag, value) = line.split_at(1);
        match tag {
            "p" => {
                current_pid = value.parse().ok();
                current_process_name = None;
            }
            "c" => {
                current_process_name = Some(value.to_string());
            }
            "n" => {
                if let Some(parsed) = parse_address_with_port(value) {
                    ports.push(RawListeningPort {
                        host: parsed.host,
                        port: parsed.port,
                        pid: current_pid,
                        process_name: current_process_name.clone(),
                        command_line: None,
                        cwd: None,
                    });
                }
            }
            _ => {}
        }
    }
    dedupe_raw_ports(ports)
}

#[cfg(any(windows, test))]
pub(crate) fn parse_netstat_listening_output(output: &str) -> Vec<RawListeningPort> {
    let mut ports = Vec::new();
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields
            .first()
            .map(|value| value.eq_ignore_ascii_case("TCP"))
            != Some(true)
        {
            continue;
        }
        let Some(state_index) = fields
            .iter()
            .position(|field| field.eq_ignore_ascii_case("LISTENING"))
        else {
            continue;
        };
        if state_index < 2 {
            continue;
        }
        let Some(parsed) = parse_address_with_port(fields[1]) else {
            continue;
        };
        let pid = fields
            .get(state_index + 1)
            .and_then(|value| value.parse().ok());
        ports.push(RawListeningPort {
            host: parsed.host,
            port: parsed.port,
            pid,
            process_name: None,
            command_line: None,
            cwd: None,
        });
    }
    dedupe_raw_ports(ports)
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_proc_net_tcp(content: &str) -> Vec<(String, u16, u64)> {
    let mut results = Vec::new();
    for line in content.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let Some(parsed) = parse_proc_address(fields[1]) else {
            continue;
        };
        let Ok(inode) = fields[9].parse::<u64>() else {
            continue;
        };
        if inode == 0 {
            continue;
        }
        results.push((parsed.host, parsed.port, inode));
    }
    results
}

fn dedupe_raw_ports(ports: Vec<RawListeningPort>) -> Vec<RawListeningPort> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for port in ports {
        let key = format!(
            "{}:{}:{}",
            connect_host_for_bind_host(&port.host),
            port.port,
            port.pid
                .map(|pid| pid.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        );
        if seen.insert(key) {
            result.push(port);
        }
    }
    result
}

struct ParsedAddress {
    host: String,
    port: u16,
}

fn parse_address_with_port(value: &str) -> Option<ParsedAddress> {
    let trimmed = value.trim().trim_end_matches(" (LISTEN)");
    if let Some(captures) = trimmed.strip_prefix('[') {
        let (host, rest) = captures.split_once("]:")?;
        let port = rest.parse().ok()?;
        if port == 0 {
            return None;
        }
        return Some(ParsedAddress {
            host: host.to_string(),
            port,
        });
    }
    let (host, port_text) = trimmed.rsplit_once(':')?;
    let port = port_text.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some(ParsedAddress {
        host: host.to_string(),
        port,
    })
}

#[cfg(any(target_os = "linux", test))]
fn parse_proc_address(hex_address: &str) -> Option<ParsedAddress> {
    let (addr_hex, port_hex) = hex_address.split_once(':')?;
    let port = u16::from_str_radix(port_hex, 16).ok()?;
    if port == 0 {
        return None;
    }
    if addr_hex.len() == 8 {
        let bytes = [6usize, 4, 2, 0]
            .into_iter()
            .map(|index| u8::from_str_radix(&addr_hex[index..index + 2], 16).ok())
            .collect::<Option<Vec<_>>>()?;
        return Some(ParsedAddress {
            host: format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]),
            port,
        });
    }
    if addr_hex.len() == 32 {
        if addr_hex == "00000000000000000000000000000000" {
            return Some(ParsedAddress {
                host: "::".to_string(),
                port,
            });
        }
        if addr_hex == "00000000000000000000000001000000" {
            return Some(ParsedAddress {
                host: "::1".to_string(),
                port,
            });
        }
        return Some(ParsedAddress {
            host: format_ipv6_address(addr_hex),
            port,
        });
    }
    None
}

#[cfg(any(target_os = "linux", test))]
fn format_ipv6_address(hex: &str) -> String {
    let mut groups = Vec::new();
    let mut index = 0;
    while index < 32 {
        let chunk = &hex[index..index + 8];
        let reversed = format!(
            "{}{}{}{}",
            &chunk[6..8],
            &chunk[4..6],
            &chunk[2..4],
            &chunk[0..2]
        );
        groups.push(reversed[0..4].trim_start_matches('0').to_string());
        if groups.last().map(|value| value.is_empty()).unwrap_or(false) {
            *groups.last_mut().unwrap() = "0".to_string();
        }
        groups.push(reversed[4..8].trim_start_matches('0').to_string());
        if groups.last().map(|value| value.is_empty()).unwrap_or(false) {
            *groups.last_mut().unwrap() = "0".to_string();
        }
        index += 8;
    }
    groups.join(":")
}

#[cfg(target_os = "macos")]
fn scan_darwin_lsof_ports() -> Result<Vec<RawListeningPort>, ScanError> {
    let stdout = run_command("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])?;
    let mut ports = parse_lsof_listening_output(&stdout);
    let pids: HashSet<u32> = ports.iter().filter_map(|port| port.pid).collect();
    let metadata = load_darwin_process_metadata(&pids);
    for port in &mut ports {
        if let Some(pid) = port.pid {
            if let Some(meta) = metadata.get(&pid) {
                if port.process_name.is_none() {
                    port.process_name = meta.process_name.clone();
                }
                port.command_line = meta.command_line.clone();
                port.cwd = meta.cwd.clone();
            }
        }
    }
    Ok(ports)
}

#[cfg(target_os = "macos")]
fn load_darwin_process_metadata(pids: &HashSet<u32>) -> HashMap<u32, ProcessMetadata> {
    let mut result = HashMap::new();
    if pids.is_empty() {
        return result;
    }
    let pid_list = pids
        .iter()
        .map(|pid| pid.to_string())
        .collect::<Vec<_>>()
        .join(",");

    if let Ok(cwd_output) = run_command("lsof", &["-a", "-p", &pid_list, "-d", "cwd", "-Fn"]) {
        let mut current_pid: Option<u32> = None;
        for line in cwd_output.lines() {
            if let Some(value) = line.strip_prefix('p') {
                current_pid = value.parse().ok();
            } else if let Some(value) = line.strip_prefix('n') {
                if let Some(pid) = current_pid {
                    let entry = result.entry(pid).or_default();
                    entry.cwd = Some(value.to_string());
                }
            }
        }
    }

    if let Ok(command_output) =
        run_command("ps", &["-p", &pid_list, "-o", "pid=", "-o", "command="])
    {
        for line in command_output.lines() {
            let trimmed = line.trim();
            let Some((pid_text, command)) = trimmed.split_once(char::is_whitespace) else {
                continue;
            };
            let Ok(pid) = pid_text.parse::<u32>() else {
                continue;
            };
            let entry = result.entry(pid).or_default();
            entry.command_line = Some(command.trim().to_string());
        }
    }

    result
}

#[cfg(windows)]
fn scan_windows_netstat_ports() -> Result<Vec<RawListeningPort>, ScanError> {
    let stdout = run_command("netstat", &["-ano", "-p", "tcp"])?;
    let mut ports = parse_netstat_listening_output(&stdout);
    let pids: HashSet<u32> = ports.iter().filter_map(|port| port.pid).collect();
    let metadata = load_windows_process_metadata(&pids);
    for port in &mut ports {
        if let Some(pid) = port.pid {
            if let Some(meta) = metadata.get(&pid) {
                port.process_name = meta.process_name.clone();
                port.command_line = meta.command_line.clone();
            }
        }
    }
    Ok(ports)
}

#[cfg(windows)]
fn load_windows_process_metadata(pids: &HashSet<u32>) -> HashMap<u32, ProcessMetadata> {
    let mut result = HashMap::new();
    if pids.is_empty() {
        return result;
    }
    let pid_filter = pids
        .iter()
        .map(|pid| format!("ProcessId={pid}"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let script = format!(
        "Get-CimInstance Win32_Process -Filter \"{pid_filter}\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    );
    let Ok(stdout) = run_command("powershell.exe", &["-NoProfile", "-Command", &script]) else {
        return result;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&stdout) else {
        return result;
    };
    let rows = match value {
        serde_json::Value::Array(rows) => rows,
        other => vec![other],
    };
    for row in rows {
        let Some(pid) = row.get("ProcessId").and_then(|value| value.as_u64()) else {
            continue;
        };
        let pid = pid as u32;
        if !pids.contains(&pid) {
            continue;
        }
        result.insert(
            pid,
            ProcessMetadata {
                process_name: row
                    .get("Name")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                command_line: row
                    .get("CommandLine")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            },
        );
    }
    result
}

#[cfg(target_os = "linux")]
fn scan_linux_proc_ports() -> Result<Vec<RawListeningPort>, ScanError> {
    let mut sockets = Vec::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            sockets.extend(parse_proc_net_tcp(&content));
        }
    }
    let inodes: HashSet<u64> = sockets.iter().map(|(_, _, inode)| *inode).collect();
    let inode_to_pid = map_linux_inodes_to_pids(&inodes);
    let mut metadata = HashMap::new();
    let mut raw_ports = Vec::new();
    for (host, port, inode) in sockets {
        let pid = inode_to_pid.get(&inode).copied();
        if let Some(pid) = pid {
            metadata
                .entry(pid)
                .or_insert_with(|| load_linux_process_metadata(pid));
        }
        let meta = pid
            .and_then(|pid| metadata.get(&pid))
            .cloned()
            .unwrap_or_default();
        raw_ports.push(RawListeningPort {
            host,
            port,
            pid,
            process_name: meta.process_name,
            command_line: meta.command_line,
            cwd: meta.cwd,
        });
    }
    Ok(dedupe_raw_ports(raw_ports))
}

#[cfg(target_os = "linux")]
fn map_linux_inodes_to_pids(inodes: &HashSet<u64>) -> HashMap<u64, u32> {
    let mut result = HashMap::new();
    if inodes.is_empty() {
        return result;
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return result;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(pid_text) = file_name.to_str() else {
            continue;
        };
        if !pid_text.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = pid_text.parse::<u32>() else {
            continue;
        };
        let fd_dir = entry.path().join("fd");
        let Ok(fds) = std::fs::read_dir(fd_dir) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(link) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let Some(link_text) = link.to_str() else {
                continue;
            };
            let Some(inode_text) = link_text
                .strip_prefix("socket:[")
                .and_then(|value| value.strip_suffix(']'))
            else {
                continue;
            };
            let Ok(inode) = inode_text.parse::<u64>() else {
                continue;
            };
            if inodes.contains(&inode) {
                result.insert(inode, pid);
            }
        }
    }
    result
}

#[cfg(target_os = "linux")]
fn load_linux_process_metadata(pid: u32) -> ProcessMetadata {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|value| value.trim().to_string());
    let cmdline = std::fs::read_to_string(format!("/proc/{pid}/cmdline"))
        .ok()
        .map(|value| value.replace('\0', " ").trim().to_string())
        .filter(|value| !value.is_empty());
    let cwd = std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    ProcessMetadata {
        process_name: comm,
        command_line: cmdline,
        cwd,
    }
}

#[cfg(test)]
#[path = "scanner_tests.rs"]
mod tests;
