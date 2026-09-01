//! External IDE integration
//!
//! Handles detecting installed IDEs and opening folders in them.

use std::process::Command;
use tokio::process::Command as AsyncCommand;

use crate::cli_binary_resolver::{all_cli_binary_metadata, resolve_cli_binary};

// ============================================
// IDE Detection
// ============================================

/// Detect installed IDEs with version and last-used metadata.
///
/// Uses `which`/`where` for CLI-based IDEs, then checks platform-specific
/// install paths (macOS .app bundles, Windows Program Files/AppData,
/// Linux /opt and ~/.local) for GUI apps that may not have a CLI in `$PATH`.
///
/// For installed IDEs, also detects:
/// - **version**: via `<binary> --version` or platform bundle metadata
/// - **last_used**: via macOS Spotlight (`mdls`), or file modification time
#[tauri::command]
pub async fn server_detect_ides() -> Result<Vec<serde_json::Value>, String> {
    // (id, display_name, cli_binary, category) — GUI IDE CLIs stay on `which`/`where`.
    let cli_ides: Vec<(&str, &str, &str, &str)> = vec![
        ("vscode", "Visual Studio Code", "code", "ide"),
        (
            "vscode-insiders",
            "VS Code Insiders",
            "code-insiders",
            "ide",
        ),
        ("cursor", "Cursor", "cursor", "ide"),
        ("trae", "Trae", "trae", "ide"),
        ("windsurf", "Windsurf", "windsurf", "ide"),
        ("zed", "Zed", "zed", "ide"),
        ("fleet", "Fleet", "fleet", "ide"),
        ("sublime", "Sublime Text", "subl", "ide"),
        ("intellij", "IntelliJ IDEA", "idea", "ide"),
        ("webstorm", "WebStorm", "webstorm", "ide"),
        ("pycharm", "PyCharm", "pycharm", "ide"),
        ("goland", "GoLand", "goland", "ide"),
        ("phpstorm", "PhpStorm", "phpstorm", "ide"),
        ("rubymine", "RubyMine", "rubymine", "ide"),
        ("clion", "CLion", "clion", "ide"),
        ("rider", "Rider", "rider", "ide"),
        ("rustrover", "RustRover", "rustrover", "ide"),
        ("vim", "Vim", "vim", "ide"),
        ("nvim", "Neovim", "nvim", "ide"),
        ("emacs", "Emacs", "emacs", "ide"),
        ("helix", "Helix", "hx", "ide"),
        ("kakoune", "Kakoune", "kak", "ide"),
        ("lapce", "Lapce", "lapce", "ide"),
        ("textmate", "TextMate", "mate", "ide"),
        ("eclipse", "Eclipse", "eclipse", "ide"),
        ("netbeans", "NetBeans", "netbeans", "ide"),
        ("atom", "Atom", "atom", "ide"),
    ];

    let which_cmd = if cfg!(windows) { "where" } else { "which" };

    // Stage 1: detect which GUI IDE CLIs are present (parallel)
    let cli_futures: Vec<_> = cli_ides
        .iter()
        .map(|(ide_id, name, binary, category)| async move {
            let mut which_cmd_builder = AsyncCommand::new(which_cmd);
            which_cmd_builder
                .arg(binary)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            // Suppress console window on Windows.
            #[cfg(windows)]
            which_cmd_builder.creation_flags(app_platform::CREATE_NO_WINDOW);
            let which_output = which_cmd_builder.output().await;

            let (installed, binary_path) = match which_output {
                Ok(output) if output.status.success() => {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    (true, path)
                }
                _ => (false, String::new()),
            };

            (*ide_id, *name, *binary, *category, installed, binary_path)
        })
        .collect();

    let mut cli_results = futures::future::join_all(cli_futures).await;
    let ai_cli_results = all_cli_binary_metadata()
        .iter()
        .map(|metadata| {
            let resolution = resolve_cli_binary(metadata.id);
            (
                metadata.row_id,
                metadata.display_name,
                metadata.command,
                "ai_cli",
                resolution.installed(),
                resolution.path_for_detection(),
            )
        })
        .collect::<Vec<_>>();
    cli_results.extend(ai_cli_results);

    let mut results = Vec::new();
    let mut found_ids = std::collections::HashSet::<String>::new();
    // Track (ide_id, binary, path_or_app) for version/last-used enrichment
    let mut enrich_tasks: Vec<(String, String, String)> = Vec::new();

    for (ide_id, name, binary, category, installed, binary_path) in &cli_results {
        if *installed {
            found_ids.insert(ide_id.to_string());
            enrich_tasks.push((ide_id.to_string(), binary.to_string(), binary_path.clone()));
        }
        results.push(serde_json::json!({
            "id": ide_id,
            "name": name,
            "installed": installed,
            "path": binary_path,
            "category": category,
            "version": null,
            "lastUsed": null,
        }));
    }

    // Stage 2: platform-specific app detection for IDEs without CLI in PATH
    let app_ides = collect_app_ide_paths();
    for (ide_id, name, app_path) in app_ides {
        if found_ids.contains(&ide_id) {
            continue;
        }
        let installed = std::path::Path::new(&app_path).exists();
        if installed {
            found_ids.insert(ide_id.clone());
            enrich_tasks.push((ide_id.clone(), String::new(), app_path.clone()));
        }
        results.retain(|r| r.get("id").and_then(|v| v.as_str()) != Some(&ide_id));
        results.push(serde_json::json!({
            "id": ide_id,
            "name": name,
            "installed": installed,
            "path": if installed { &app_path } else { "" },
            "category": "ide",
            "version": null,
            "lastUsed": null,
        }));
    }

    // Stage 3: enrich installed IDEs with version + last-used (parallel)
    let app_path_map = build_app_path_map();
    let enrich_futures: Vec<_> = enrich_tasks
        .into_iter()
        .map(|(ide_id, binary, path)| {
            let app_path = app_path_map.get(&ide_id).cloned();
            async move {
                let version =
                    detect_ide_version(&ide_id, &binary, &path, app_path.as_deref()).await;
                let last_used = detect_last_used(&ide_id, &path, app_path.as_deref()).await;
                (ide_id, version, last_used)
            }
        })
        .collect();

    let enrichments = futures::future::join_all(enrich_futures).await;

    for (ide_id, version, last_used) in enrichments {
        if let Some(entry) = results
            .iter_mut()
            .find(|r| r.get("id").and_then(|v| v.as_str()) == Some(&ide_id))
        {
            if let Some(ver) = version {
                entry["version"] = serde_json::Value::String(ver);
            }
            if let Some(ts) = last_used {
                entry["lastUsed"] = serde_json::Value::String(ts);
            }
        }
    }

    Ok(results)
}

/// Try to detect IDE version.
///
/// Strategy:
/// 1. Run `<binary> --version` if a CLI binary is known
/// 2. On macOS, read CFBundleShortVersionString from the .app bundle's Info.plist
async fn detect_ide_version(
    _ide_id: &str,
    binary: &str,
    path: &str,
    app_path: Option<&str>,
) -> Option<String> {
    // Try CLI --version first (if binary name is known)
    if !binary.is_empty() {
        let mut version_cmd = AsyncCommand::new(binary);
        version_cmd
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // Suppress console window on Windows.
        #[cfg(windows)]
        version_cmd.creation_flags(app_platform::CREATE_NO_WINDOW);
        if let Ok(output) = version_cmd.output().await {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let raw = if stdout.trim().is_empty() {
                    stderr.to_string()
                } else {
                    stdout.to_string()
                };
                if let Some(ver) = parse_version_string(&raw) {
                    return Some(ver);
                }
            }
        }
    }

    // macOS: read version from .app bundle plist
    #[cfg(target_os = "macos")]
    {
        let bundle = if path.ends_with(".app") {
            Some(path)
        } else {
            app_path
        };
        if let Some(app) = bundle {
            let plist_path = format!("{}/Contents/Info", app);
            if let Ok(output) = AsyncCommand::new("defaults")
                .args(["read", &plist_path, "CFBundleShortVersionString"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .output()
                .await
            {
                if output.status.success() {
                    let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !ver.is_empty() {
                        return Some(ver);
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, app_path);
    }

    None
}

/// Extract a version number (e.g. "1.95.3") from CLI output.
fn parse_version_string(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        for token in trimmed.split_whitespace() {
            let clean = token
                .trim_matches(&['"', '\'', '(', ')'] as &[char])
                .trim_start_matches('v')
                .trim_end_matches(&[',', ';'] as &[char]);
            if clean.chars().next().is_some_and(|c| c.is_ascii_digit()) && clean.contains('.') {
                return Some(clean.to_string());
            }
        }
    }
    None
}

/// Detect when an IDE was last used.
///
/// Priority:
/// 1. User data directory mtime (most accurate — written to during active use)
/// 2. macOS Spotlight `kMDItemLastUsedDate` for .app bundles
/// 3. Fallback: file modification time of the binary/app path (least accurate)
async fn detect_last_used(ide_id: &str, path: &str, app_path: Option<&str>) -> Option<String> {
    // Best signal: user data directory is written to during active use
    if let Some(data_dir) = get_user_data_dir(ide_id) {
        if let Some(ts) = newest_mtime_in_dir(&data_dir) {
            return Some(ts);
        }
    }

    // macOS: Spotlight last-used date for .app bundles
    #[cfg(target_os = "macos")]
    {
        let bundle = if path.ends_with(".app") {
            Some(path.to_string())
        } else {
            app_path.map(String::from)
        };
        if let Some(app) = bundle {
            if let Ok(output) = AsyncCommand::new("mdls")
                .args(["-name", "kMDItemLastUsedDate", "-raw", &app])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .output()
                .await
            {
                if output.status.success() {
                    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !raw.is_empty() && raw != "(null)" {
                        if let Some(iso) = spotlight_date_to_iso(&raw) {
                            return Some(iso);
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_path;
    }

    // Fallback: file modification time of the binary/app
    if !path.is_empty() {
        if let Ok(meta) = std::fs::metadata(path) {
            if let Ok(modified) = meta.modified() {
                let datetime: chrono::DateTime<chrono::Utc> = modified.into();
                return Some(datetime.to_rfc3339());
            }
        }
    }

    None
}

/// Get the user data directory for a given IDE (written to during active use).
fn get_user_data_dir(ide_id: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        let app_support = format!("{}/Library/Application Support", home);
        let dir = match ide_id {
            "vscode" => format!("{}/Code", app_support),
            "vscode-insiders" => format!("{}/Code - Insiders", app_support),
            "cursor" => format!("{}/Cursor", app_support),
            "windsurf" => format!("{}/Windsurf", app_support),
            "trae" => format!("{}/Trae", app_support),
            "zed" => format!("{}/Zed", app_support),
            "sublime" => format!("{}/Sublime Text", app_support),
            "fleet" => format!("{}/JetBrains/Fleet", app_support),
            "intellij" | "webstorm" | "pycharm" | "goland" | "phpstorm" | "rubymine" | "clion"
            | "rider" | "rustrover" => {
                format!("{}/JetBrains", app_support)
            }
            "textmate" => format!("{}/TextMate", app_support),
            "eclipse" => format!("{}/Eclipse", home),
            "netbeans" => format!("{}/.netbeans", home),
            "atom" => format!("{}/.atom", home),
            _ => return None,
        };
        if std::path::Path::new(&dir).is_dir() {
            Some(dir)
        } else {
            None
        }
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        let dir = match ide_id {
            "vscode" => format!(r"{}\Code", appdata),
            "vscode-insiders" => format!(r"{}\Code - Insiders", appdata),
            "cursor" => format!(r"{}\Cursor", appdata),
            "windsurf" => format!(r"{}\Windsurf", appdata),
            "trae" => format!(r"{}\Trae", appdata),
            "sublime" => format!(r"{}\Sublime Text", appdata),
            "eclipse" => {
                let home = std::env::var("USERPROFILE").ok()?;
                format!(r"{}\eclipse", home)
            }
            "netbeans" => format!(r"{}\NetBeans", appdata),
            "atom" => {
                let home = std::env::var("USERPROFILE").ok()?;
                format!(r"{}\.atom", home)
            }
            _ => return None,
        };
        if std::path::Path::new(&dir).is_dir() {
            Some(dir)
        } else {
            None
        }
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").ok()?;
        let config = format!("{}/.config", home);
        let dir = match ide_id {
            "vscode" => format!("{}/Code", config),
            "vscode-insiders" => format!("{}/Code - Insiders", config),
            "cursor" => format!("{}/Cursor", config),
            "windsurf" => format!("{}/Windsurf", config),
            "trae" => format!("{}/Trae", config),
            "zed" => format!("{}/zed", config),
            "sublime" => format!("{}/sublime-text", config),
            "eclipse" => format!("{}/eclipse", home),
            "netbeans" => format!("{}/.netbeans", home),
            "atom" => format!("{}/.atom", home),
            _ => return None,
        };
        if std::path::Path::new(&dir).is_dir() {
            Some(dir)
        } else {
            None
        }
    }
}

/// Get the most recent modification time from a directory's immediate children.
fn newest_mtime_in_dir(dir: &str) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut newest: Option<std::time::SystemTime> = None;

    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                match newest {
                    Some(current) if modified > current => newest = Some(modified),
                    None => newest = Some(modified),
                    _ => {}
                }
            }
        }
    }

    let datetime: chrono::DateTime<chrono::Utc> = newest?.into();
    Some(datetime.to_rfc3339())
}

/// Build a map from ide_id -> macOS .app path for plist/Spotlight lookups.
fn build_app_path_map() -> std::collections::HashMap<String, String> {
    #[cfg(target_os = "macos")]
    {
        let mut map = std::collections::HashMap::new();
        let macos_apps: &[(&str, &str)] = &[
            ("vscode", "/Applications/Visual Studio Code.app"),
            (
                "vscode-insiders",
                "/Applications/Visual Studio Code - Insiders.app",
            ),
            ("cursor", "/Applications/Cursor.app"),
            ("trae", "/Applications/Trae.app"),
            ("windsurf", "/Applications/Windsurf.app"),
            ("zed", "/Applications/Zed.app"),
            ("fleet", "/Applications/Fleet.app"),
            ("sublime", "/Applications/Sublime Text.app"),
            ("xcode", "/Applications/Xcode.app"),
            ("android-studio", "/Applications/Android Studio.app"),
            ("nova", "/Applications/Nova.app"),
            ("lapce", "/Applications/Lapce.app"),
            ("textmate", "/Applications/TextMate.app"),
            ("eclipse", "/Applications/Eclipse.app"),
            ("netbeans", "/Applications/NetBeans.app"),
            ("atom", "/Applications/Atom.app"),
        ];
        for (id, path) in macos_apps {
            if std::path::Path::new(path).exists() {
                map.insert(id.to_string(), path.to_string());
            }
        }
        map
    }

    #[cfg(not(target_os = "macos"))]
    {
        std::collections::HashMap::new()
    }
}

/// Convert macOS Spotlight date format ("2026-03-05 14:30:22 +0000") to ISO 8601.
#[cfg(target_os = "macos")]
fn spotlight_date_to_iso(raw: &str) -> Option<String> {
    let fmt = "%Y-%m-%d %H:%M:%S %z";
    if let Ok(dt) = chrono::DateTime::parse_from_str(raw, fmt) {
        return Some(dt.to_rfc3339());
    }
    // Spotlight sometimes omits timezone — assume UTC
    let naive_fmt = "%Y-%m-%d %H:%M:%S";
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(raw.trim(), naive_fmt) {
        let dt = naive.and_utc();
        return Some(dt.to_rfc3339());
    }
    None
}

/// Collect IDE paths to check on the current platform.
fn collect_app_ide_paths() -> Vec<(String, String, String)> {
    let mut paths: Vec<(String, String, String)> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let macos_apps: &[(&str, &str, &str)] = &[
            (
                "vscode",
                "Visual Studio Code",
                "/Applications/Visual Studio Code.app",
            ),
            (
                "vscode-insiders",
                "VS Code Insiders",
                "/Applications/Visual Studio Code - Insiders.app",
            ),
            ("cursor", "Cursor", "/Applications/Cursor.app"),
            ("trae", "Trae", "/Applications/Trae.app"),
            ("windsurf", "Windsurf", "/Applications/Windsurf.app"),
            ("zed", "Zed", "/Applications/Zed.app"),
            ("fleet", "Fleet", "/Applications/Fleet.app"),
            ("sublime", "Sublime Text", "/Applications/Sublime Text.app"),
            ("xcode", "Xcode", "/Applications/Xcode.app"),
            (
                "android-studio",
                "Android Studio",
                "/Applications/Android Studio.app",
            ),
            ("nova", "Nova", "/Applications/Nova.app"),
            ("lapce", "Lapce", "/Applications/Lapce.app"),
            ("textmate", "TextMate", "/Applications/TextMate.app"),
            ("eclipse", "Eclipse", "/Applications/Eclipse.app"),
            ("netbeans", "NetBeans", "/Applications/NetBeans.app"),
            ("atom", "Atom", "/Applications/Atom.app"),
        ];
        for (id, name, path) in macos_apps {
            paths.push((id.to_string(), name.to_string(), path.to_string()));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".to_string());
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            let home =
                std::env::var("USERPROFILE").unwrap_or_else(|_| r"C:\Users\Default".to_string());
            format!(r"{}\AppData\Local", home)
        });

        let windows_apps: Vec<(&str, &str, String)> = vec![
            (
                "vscode",
                "Visual Studio Code",
                format!(r"{}\Microsoft VS Code\Code.exe", program_files),
            ),
            (
                "vscode-insiders",
                "VS Code Insiders",
                format!(
                    r"{}\Microsoft VS Code Insiders\Code - Insiders.exe",
                    program_files
                ),
            ),
            (
                "cursor",
                "Cursor",
                format!(r"{}\Programs\cursor\Cursor.exe", local_app_data),
            ),
            (
                "trae",
                "Trae",
                format!(r"{}\Programs\Trae\Trae.exe", local_app_data),
            ),
            (
                "windsurf",
                "Windsurf",
                format!(r"{}\Programs\Windsurf\Windsurf.exe", local_app_data),
            ),
            (
                "sublime",
                "Sublime Text",
                format!(r"{}\Sublime Text\sublime_text.exe", program_files),
            ),
            (
                "android-studio",
                "Android Studio",
                format!(r"{}\Android\Android Studio\bin\studio64.exe", program_files),
            ),
            (
                "fleet",
                "Fleet",
                format!(r"{}\JetBrains\Fleet\Fleet.exe", local_app_data),
            ),
            (
                "lapce",
                "Lapce",
                format!(r"{}\Programs\Lapce\Lapce.exe", local_app_data),
            ),
            (
                "eclipse",
                "Eclipse",
                format!(r"{}\eclipse\eclipse.exe", program_files),
            ),
            (
                "netbeans",
                "NetBeans",
                format!(r"{}\NetBeans\bin\netbeans64.exe", program_files),
            ),
            (
                "atom",
                "Atom",
                format!(r"{}\Programs\atom\Atom.exe", local_app_data),
            ),
        ];
        for (id, name, path) in windows_apps {
            paths.push((id.to_string(), name.to_string(), path));
        }

        // JetBrains Toolbox installs IDEs under LOCALAPPDATA\JetBrains\Toolbox\apps\
        let jb_toolbox_base = format!(r"{}\JetBrains\Toolbox\apps", local_app_data);
        let jb_ides: &[(&str, &str, &str)] = &[
            ("intellij", "IntelliJ IDEA", "IDEA-U"),
            ("webstorm", "WebStorm", "WebStorm"),
            ("pycharm", "PyCharm", "PyCharm-P"),
            ("goland", "GoLand", "GoLand"),
            ("phpstorm", "PhpStorm", "PhpStorm"),
            ("rubymine", "RubyMine", "RubyMine"),
            ("clion", "CLion", "CLion"),
            ("rider", "Rider", "Rider"),
            ("rustrover", "RustRover", "RustRover"),
        ];
        for (id, name, folder) in jb_ides {
            let dir = format!(r"{}\{}", jb_toolbox_base, folder);
            paths.push((id.to_string(), name.to_string(), dir));
        }
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());

        let linux_apps: Vec<(&str, &str, String)> = vec![
            (
                "vscode",
                "Visual Studio Code",
                "/usr/share/code/code".to_string(),
            ),
            (
                "vscode-insiders",
                "VS Code Insiders",
                "/usr/share/code-insiders/code-insiders".to_string(),
            ),
            ("cursor", "Cursor", format!("{}/.local/bin/cursor", home)),
            ("trae", "Trae", format!("{}/.local/bin/trae", home)),
            (
                "windsurf",
                "Windsurf",
                format!("{}/.local/bin/windsurf", home),
            ),
            (
                "sublime",
                "Sublime Text",
                "/opt/sublime_text/sublime_text".to_string(),
            ),
            (
                "android-studio",
                "Android Studio",
                "/opt/android-studio/bin/studio.sh".to_string(),
            ),
            (
                "fleet",
                "Fleet",
                format!(
                    "{}/.local/share/JetBrains/Toolbox/apps/Fleet/bin/Fleet",
                    home
                ),
            ),
            ("zed", "Zed", format!("{}/.local/bin/zed", home)),
            ("lapce", "Lapce", "/usr/bin/lapce".to_string()),
            ("eclipse", "Eclipse", "/opt/eclipse/eclipse".to_string()),
            (
                "netbeans",
                "NetBeans",
                "/opt/netbeans/bin/netbeans".to_string(),
            ),
            ("atom", "Atom", "/usr/bin/atom".to_string()),
        ];
        for (id, name, path) in linux_apps {
            paths.push((id.to_string(), name.to_string(), path));
        }

        // Snap-installed IDEs
        let snap_apps: &[(&str, &str, &str)] = &[
            (
                "vscode",
                "Visual Studio Code",
                "/snap/code/current/usr/share/code/code",
            ),
            (
                "sublime",
                "Sublime Text",
                "/snap/sublime-text/current/opt/sublime_text/sublime_text",
            ),
            (
                "eclipse",
                "Eclipse",
                "/snap/eclipse/current/eclipse/eclipse",
            ),
            (
                "netbeans",
                "NetBeans",
                "/snap/netbeans/current/netbeans/bin/netbeans",
            ),
            ("atom", "Atom", "/snap/atom/current/usr/share/atom/atom"),
        ];
        for (id, name, path) in snap_apps {
            paths.push((id.to_string(), name.to_string(), path.to_string()));
        }

        // Flatpak-installed IDEs (check .desktop files)
        let flatpak_apps: &[(&str, &str, &str)] = &[
            (
                "vscode",
                "Visual Studio Code",
                "/var/lib/flatpak/app/com.visualstudio.code",
            ),
            (
                "sublime",
                "Sublime Text",
                "/var/lib/flatpak/app/com.sublimetext.three",
            ),
            (
                "eclipse",
                "Eclipse",
                "/var/lib/flatpak/app/org.eclipse.Java",
            ),
            ("atom", "Atom", "/var/lib/flatpak/app/io.atom.Atom"),
        ];
        for (id, name, path) in flatpak_apps {
            paths.push((id.to_string(), name.to_string(), path.to_string()));
        }

        // JetBrains Toolbox on Linux
        let jb_toolbox_base = format!("{}/.local/share/JetBrains/Toolbox/apps", home);
        let jb_ides: &[(&str, &str, &str)] = &[
            ("intellij", "IntelliJ IDEA", "IDEA-U"),
            ("webstorm", "WebStorm", "WebStorm"),
            ("pycharm", "PyCharm", "PyCharm-P"),
            ("goland", "GoLand", "GoLand"),
            ("phpstorm", "PhpStorm", "PhpStorm"),
            ("rubymine", "RubyMine", "RubyMine"),
            ("clion", "CLion", "CLion"),
            ("rider", "Rider", "Rider"),
            ("rustrover", "RustRover", "RustRover"),
        ];
        for (id, name, folder) in jb_ides {
            let dir = format!("{}/{}", jb_toolbox_base, folder);
            paths.push((id.to_string(), name.to_string(), dir));
        }
    }

    paths
}

// ============================================
// Open in IDE
// ============================================

// ============================================
// Show in Folder
// ============================================

/// Reveal a file or folder in the system file explorer
#[tauri::command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let result = Command::new("open").args(["-R", &path]).spawn();

            match result {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Failed to reveal in Finder: {}", e)),
            }
        }

        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("explorer");
            cmd.args(["/select,", &path]);
            // Suppress console window on Windows.
            app_platform::hide_console(&mut cmd);
            let result = cmd.spawn();

            match result {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Failed to reveal in Explorer: {}", e)),
            }
        }

        #[cfg(target_os = "linux")]
        {
            use std::path::Path;
            let file_path = Path::new(&path);
            let parent = file_path
                .parent()
                .ok_or_else(|| "Failed to get parent directory".to_string())?;

            let mut cmd = Command::new("xdg-open");
            cmd.arg(parent);
            // Suppress console window on Windows.
            app_platform::hide_console(&mut cmd);
            let result = cmd.spawn();

            match result {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Failed to open file manager: {}", e)),
            }
        }
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Open a directory in the system file explorer (navigates into it).
#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            Command::new("open")
                .arg(&path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Failed to open in Finder: {}", e))
        }

        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("explorer");
            cmd.arg(&path);
            // Suppress console window on Windows.
            app_platform::hide_console(&mut cmd);
            cmd.spawn()
                .map(|_| ())
                .map_err(|e| format!("Failed to open in Explorer: {}", e))
        }

        #[cfg(target_os = "linux")]
        {
            let mut cmd = Command::new("xdg-open");
            cmd.arg(&path);
            // Suppress console window on Windows.
            app_platform::hide_console(&mut cmd);
            cmd.spawn()
                .map(|_| ())
                .map_err(|e| format!("Failed to open file manager: {}", e))
        }
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}
