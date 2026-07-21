use super::AppMemoryProcessRole;
use std::collections::HashMap;
use std::io;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const LAUNCHCTL_PATH: &str = "/bin/launchctl";
const SERVICE_CACHE_TTL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Default)]
pub(super) struct WebKitServiceSnapshot {
    pub(super) roles_by_pid: HashMap<u32, AppMemoryProcessRole>,
}

#[derive(Debug)]
struct WebKitServiceCache {
    root_pid: u32,
    captured_at: Instant,
    snapshot: WebKitServiceSnapshot,
}

static WEBKIT_SERVICE_CACHE: OnceLock<Mutex<Option<WebKitServiceCache>>> = OnceLock::new();

/// Query the current process bootstrap namespace for active WebKit XPC
/// services. Unlike a system-wide process scan, this mapping is scoped to the
/// exact ORG2 host process, so Safari and other ORG2 instances cannot enter the
/// result.
pub(super) fn owned_webkit_services(root_pid: u32) -> io::Result<WebKitServiceSnapshot> {
    let cache = WEBKIT_SERVICE_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.as_ref().filter(|cached| {
            cached.root_pid == root_pid && cached.captured_at.elapsed() < SERVICE_CACHE_TTL
        }) {
            return Ok(cached.snapshot.clone());
        }
    }

    let output = Command::new(LAUNCHCTL_PATH)
        .args(["print", &format!("pid/{root_pid}")])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "launchctl print failed with status {}",
            output.status
        )));
    }

    let snapshot = parse_launchctl_pid_print(&String::from_utf8_lossy(&output.stdout));
    if snapshot.roles_by_pid.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "launchctl reported no active WebKit services",
        ));
    }

    if let Ok(mut guard) = cache.lock() {
        *guard = Some(WebKitServiceCache {
            root_pid,
            captured_at: Instant::now(),
            snapshot: snapshot.clone(),
        });
    }
    Ok(snapshot)
}

fn parse_launchctl_pid_print(output: &str) -> WebKitServiceSnapshot {
    let roles_by_pid = output
        .lines()
        .filter_map(parse_service_line)
        .collect::<HashMap<_, _>>();
    WebKitServiceSnapshot { roles_by_pid }
}

fn parse_service_line(line: &str) -> Option<(u32, AppMemoryProcessRole)> {
    let mut fields = line.split_whitespace();
    let pid = fields.next()?.parse::<u32>().ok()?;
    if pid == 0 || fields.next()? != "-" {
        return None;
    }
    let service = fields.next()?;
    webkit_service_role(service).map(|role| (pid, role))
}

fn webkit_service_role(service: &str) -> Option<AppMemoryProcessRole> {
    if service == "com.apple.WebKit.WebContent"
        || service.starts_with("com.apple.WebKit.WebContent.")
    {
        Some(AppMemoryProcessRole::Renderer)
    } else if service == "com.apple.WebKit.GPU" || service.starts_with("com.apple.WebKit.GPU.") {
        Some(AppMemoryProcessRole::Gpu)
    } else if service == "com.apple.WebKit.Networking"
        || service.starts_with("com.apple.WebKit.Networking.")
    {
        Some(AppMemoryProcessRole::Network)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_active_webkit_service_instances() {
        let output = r#"
services = {
           0      -  com.apple.WebKit.WebContent
       88149      -  com.apple.WebKit.Networking.9AA51455-FC8B-45CF-A445-9A3405971C43
       88193      -  com.apple.WebKit.WebContent.33FB2837-0833-477E-8EDB-B03AEB6022ED
       88148      -  com.apple.WebKit.GPU.0D074C49-F848-409D-9226-95A1B8680608
       88192      -  com.apple.SafariPlatformSupport.Helper
}
service stubs = {
    com.apple.WebKit.WebContent
}
endpoints = {
    0x123 A D com.apple.WebKit.GPU
}
"#;
        let snapshot = parse_launchctl_pid_print(output);
        assert_eq!(snapshot.roles_by_pid.len(), 3);
        assert_eq!(
            snapshot.roles_by_pid.get(&88193),
            Some(&AppMemoryProcessRole::Renderer)
        );
        assert_eq!(
            snapshot.roles_by_pid.get(&88148),
            Some(&AppMemoryProcessRole::Gpu)
        );
        assert_eq!(
            snapshot.roles_by_pid.get(&88149),
            Some(&AppMemoryProcessRole::Network)
        );
    }

    #[test]
    fn parses_non_suffixed_service_labels_for_older_macos_output() {
        let output = "42 - com.apple.WebKit.WebContent\n43 - com.apple.WebKit.GPU\n";
        let snapshot = parse_launchctl_pid_print(output);
        assert_eq!(snapshot.roles_by_pid.len(), 2);
        assert_eq!(
            snapshot.roles_by_pid.get(&42),
            Some(&AppMemoryProcessRole::Renderer)
        );
    }
}
