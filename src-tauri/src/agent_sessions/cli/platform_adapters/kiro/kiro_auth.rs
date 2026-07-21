//! Kiro auth session capture
//!
//! Spawns kiro-cli login with device flow and captures OAuth tokens.
//! Uses AWS IAM Identity Center (Pro license) authentication.
//! Uses PTY to satisfy kiro-cli's TTY requirement.

use std::io::{BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use regex::Regex;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

// Import existing Kiro token reading functions
use key_vault::kiro::get_local_kiro_token;

// ============================================
// Constants
// ============================================

/// Regex to extract device code from kiro-cli output
/// Matches: "Code: XXXX-XXXX" or just "XXXX-XXXX" pattern
static DEVICE_CODE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:Code:?\s*)?([A-Z0-9]{4}-[A-Z0-9]{4})").unwrap());

/// Regex to extract device URL from output
static DEVICE_URL_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(https://[^\s]+awsapps\.com[^\s]*)").unwrap());

// ============================================
// Global State
// ============================================

/// Track active login process
static ACTIVE_LOGIN: LazyLock<Mutex<Option<KiroLoginState>>> = LazyLock::new(|| Mutex::new(None));

struct KiroLoginState {
    stop_flag: Arc<AtomicBool>,
    #[cfg_attr(not(unix), allow(dead_code))]
    child_id: Option<u32>,
}

// ============================================
// Commands
// ============================================

/// Start Kiro login with device flow using PTY
///
/// Spawns kiro-cli login command in a pseudo-terminal and emits progress events.
/// PTY is required because kiro-cli needs a TTY for interactive prompts.
///
/// # Events Emitted
/// - `kiro-login-progress`: Progress updates with device code
/// - `kiro-login-complete`: Final result with credentials or error
#[tauri::command]
pub async fn start_kiro_login(
    app: AppHandle,
    identity_provider: String,
    region: String,
) -> Result<(), String> {
    log::info!(
        "[Kiro] start_kiro_login called with identity_provider={}, region={}",
        identity_provider,
        region
    );

    // Cancel any existing login
    cancel_existing_login();

    let stop_flag = Arc::new(AtomicBool::new(false));

    // Store state
    {
        let mut active = ACTIVE_LOGIN.lock();
        *active = Some(KiroLoginState {
            stop_flag: stop_flag.clone(),
            child_id: None,
        });
    }

    // Emit starting event
    let _ = app.emit(
        "kiro-login-progress",
        serde_json::json!({
            "status": "starting"
        }),
    );

    // Clone values for the thread
    let app_clone = app.clone();
    let identity_provider_clone = identity_provider.clone();
    let region_clone = region.clone();
    let stop_flag_clone = stop_flag.clone();

    // Spawn thread for PTY operations (portable-pty is synchronous)
    thread::spawn(move || {
        log::info!("[Kiro] PTY thread started");

        // Create PTY system
        let pty_system = native_pty_system();

        // Create PTY pair
        let pair = match pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(pair) => pair,
            Err(e) => {
                log::error!("[Kiro] Failed to create PTY: {}", e);
                let _ = app_clone.emit(
                    "kiro-login-complete",
                    serde_json::json!({
                        "success": false,
                        "error": format!("Failed to create PTY: {}", e)
                    }),
                );
                return;
            }
        };

        // Create a temporary directory with scripts to intercept browser opening
        let temp_dir = std::env::temp_dir().join(format!("kiro-intercept-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let url_capture_file = temp_dir.join("captured_url.txt");
        let url_capture_file_clone = url_capture_file.clone();
        let temp_dir_clone = temp_dir.clone();

        // Create fake 'open' command (for macOS)
        let fake_open_path = temp_dir.join("open");
        let fake_open_script = format!(
            r#"#!/bin/bash
# Intercept 'open' command and capture URL
for arg in "$@"; do
    if [[ "$arg" == http* ]]; then
        echo "$arg" >> "{}"
    fi
done
exit 0
"#,
            url_capture_file.display()
        );
        let _ = std::fs::write(&fake_open_path, &fake_open_script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                std::fs::set_permissions(&fake_open_path, std::fs::Permissions::from_mode(0o755));
        }

        // Create browser script (for BROWSER env var)
        let browser_script_path = temp_dir.join("browser-intercept");
        let browser_script = format!(
            r#"#!/bin/bash
# Intercept BROWSER calls and capture URL
echo "$1" >> "{}"
exit 0
"#,
            url_capture_file.display()
        );
        let _ = std::fs::write(&browser_script_path, &browser_script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &browser_script_path,
                std::fs::Permissions::from_mode(0o755),
            );
        }

        log::info!(
            "[Kiro] Created intercept scripts at: {}",
            temp_dir.display()
        );
        log::info!("[Kiro] Fake open: {}", fake_open_path.display());
        log::info!("[Kiro] Browser script: {}", browser_script_path.display());

        // Build command
        let mut cmd = CommandBuilder::new("kiro-cli");
        cmd.args([
            "login",
            "--use-device-flow",
            "--license",
            "pro",
            "--identity-provider",
            &identity_provider_clone,
            "--region",
            &region_clone,
        ]);

        // Set PATH with our fake open FIRST
        let current_path = std::env::var("PATH").unwrap_or_default();
        let new_path = format!("{}:{}", temp_dir.display(), current_path);
        cmd.env("PATH", new_path);

        // Set BROWSER to our intercept script (Rust webbrowser crate respects this)
        cmd.env("BROWSER", browser_script_path.to_string_lossy().to_string());

        // Additional env vars to prevent browser opening
        cmd.env("DISPLAY", "");
        cmd.env("WAYLAND_DISPLAY", "");

        log::info!(
            "[Kiro] Spawning kiro-cli with PATH: {}/open first",
            temp_dir.display()
        );

        // Spawn child in PTY
        let mut child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(e) => {
                log::error!("[Kiro] Failed to spawn kiro-cli: {}", e);
                let _ = app_clone.emit(
                    "kiro-login-complete",
                    serde_json::json!({
                        "success": false,
                        "error": format!("Failed to spawn kiro-cli: {}. Is it installed?", e)
                    }),
                );
                return;
            }
        };

        log::info!("[Kiro] kiro-cli spawned in PTY");

        // Get reader and writer
        let mut reader = match pair.master.try_clone_reader() {
            Ok(r) => BufReader::new(r),
            Err(e) => {
                log::error!("[Kiro] Failed to get PTY reader: {}", e);
                return;
            }
        };

        let mut writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                log::error!("[Kiro] Failed to get PTY writer: {}", e);
                return;
            }
        };

        let mut success = false;
        let mut _device_code_found = false;
        let mut _spinner_logged = false;
        let mut output_buffer = String::new();
        let mut enter_sent = 0;

        // Set read timeout by using non-blocking reads
        // Read bytes directly since PTY output may not have proper newlines
        let mut byte_buffer = [0u8; 1024];
        let start_time = std::time::Instant::now();
        let timeout = Duration::from_secs(120); // 2 minute timeout for login

        loop {
            if stop_flag_clone.load(Ordering::SeqCst) {
                log::info!("[Kiro] Stop flag set, breaking");
                break;
            }

            // Check timeout
            if start_time.elapsed() > timeout {
                log::warn!("[Kiro] Timeout waiting for login");
                break;
            }

            // Check if child has exited
            if let Ok(Some(_status)) = child.try_wait() {
                log::info!("[Kiro] Child process exited");
                // Read any remaining output
                thread::sleep(Duration::from_millis(100));
                break;
            }

            // Try to read bytes (non-blocking via small timeout)
            use std::io::Read;
            match reader.get_mut().read(&mut byte_buffer) {
                Ok(0) => {
                    // No data available, wait a bit
                    thread::sleep(Duration::from_millis(50));
                    continue;
                }
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&byte_buffer[..n]);
                    // Only log non-spinner output (spinner contains \r and lots of unicode blocks)
                    let is_spinner = chunk.contains("Logging in") && chunk.contains('\r');
                    if !is_spinner {
                        log::info!(
                            "[Kiro] PTY output ({} bytes): {}",
                            n,
                            chunk.escape_default()
                        );
                    }
                    output_buffer.push_str(&chunk);

                    // Check for URL immediately in raw chunk (before any processing)
                    if let Some(caps) = DEVICE_URL_REGEX.captures(&chunk) {
                        if let Some(url) = caps.get(1) {
                            let captured_url = url.as_str();
                            log::info!("[Kiro] Found URL in output: {}", captured_url);
                            if !_device_code_found && captured_url.contains("user_code") {
                                _device_code_found = true;
                                // Extract device code from URL
                                let device_code = captured_url
                                    .split("user_code=")
                                    .nth(1)
                                    .map(|s| s.split('&').next().unwrap_or(s))
                                    .unwrap_or("")
                                    .to_string();
                                log::info!("[Kiro] Device code from URL: {}", device_code);
                                let _ = app_clone.emit(
                                    "kiro-login-progress",
                                    serde_json::json!({
                                        "status": "browser_ready",
                                        "deviceCode": device_code,
                                        "verificationUrl": captured_url
                                    }),
                                );
                            }
                        }
                    }

                    // Check for interactive prompts IMMEDIATELY (they don't end with newline)
                    // The prompt shows: "? Enter Start URL › https://..."
                    // We need to press Enter to confirm the pre-filled value
                    if output_buffer.contains("›") && enter_sent < 3 {
                        // Small delay to let the full prompt render
                        thread::sleep(Duration::from_millis(100));
                        log::info!(
                            "[Kiro] Detected prompt (›), sending Enter (count: {})",
                            enter_sent + 1
                        );
                        let _ = writer.write_all(b"\n");
                        let _ = writer.flush();
                        enter_sent += 1;
                        // Clear buffer after sending Enter to avoid re-triggering
                        output_buffer.clear();

                        // After answering prompts, just emit starting status
                        // We'll emit the real URL when we find the device code
                        if enter_sent == 2 {
                            log::info!("[Kiro] Prompts answered, waiting for device code...");
                            let _ = app_clone.emit(
                                "kiro-login-progress",
                                serde_json::json!({
                                    "status": "waiting_for_code"
                                }),
                            );
                        }
                        continue;
                    }

                    // Check for captured URL from fake 'open' command
                    // This gives us the EXACT URL kiro-cli tried to open
                    if !_device_code_found {
                        // Debug: Check if file exists
                        if url_capture_file_clone.exists() {
                            if let Ok(captured) = std::fs::read_to_string(&url_capture_file_clone) {
                                let captured = captured.trim();
                                if !captured.is_empty() {
                                    log::info!("[Kiro] Raw captured content: {}", captured);
                                    // Parse the URL - format might be "open URL" or just "URL"
                                    let url = captured.lines().last().unwrap_or("").trim();
                                    // Remove common prefixes
                                    let url = url.strip_prefix("-a ").unwrap_or(url);
                                    let url = url.strip_prefix("Safari ").unwrap_or(url);
                                    let url = url.strip_prefix("open ").unwrap_or(url);
                                    let url = url.trim_matches('"').trim();

                                    log::info!("[Kiro] Parsed URL: {}", url);

                                    if url.contains("awsapps.com")
                                        || url.contains("user_code")
                                        || url.starts_with("http")
                                    {
                                        log::info!("[Kiro] Captured URL from fake open: {}", url);
                                        _device_code_found = true;

                                        // Extract device code from URL if present
                                        let device_code = url
                                            .split("user_code=")
                                            .nth(1)
                                            .map(|s| s.split('&').next().unwrap_or(s))
                                            .unwrap_or("")
                                            .to_string();

                                        log::info!("[Kiro] Device code from URL: {}", device_code);

                                        // Emit the captured URL directly
                                        let _ = app_clone.emit(
                                            "kiro-login-progress",
                                            serde_json::json!({
                                                "status": "browser_ready",
                                                "deviceCode": device_code,
                                                "verificationUrl": url
                                            }),
                                        );

                                        // Clear the file to prevent re-triggering
                                        let _ = std::fs::write(&url_capture_file_clone, "");
                                    }
                                }
                            }
                        }
                    }

                    // Detect "Logging in" spinner - only log once
                    if output_buffer.contains("Logging in") && !_spinner_logged {
                        _spinner_logged = true;
                        log::info!("[Kiro] Detected 'Logging in...' spinner");
                        if _device_code_found {
                            let _ = app_clone.emit(
                                "kiro-login-progress",
                                serde_json::json!({
                                    "status": "waiting_for_auth"
                                }),
                            );
                        } else {
                            log::warn!("[Kiro] Spinner detected but no device code captured yet!");
                        }
                    }

                    // Fallback: Check for device code in PTY output (in case URL capture fails)
                    if !_device_code_found {
                        if let Some(caps) = DEVICE_CODE_REGEX.captures(&output_buffer) {
                            if let Some(code) = caps.get(1) {
                                let device_code = code.as_str().to_string();
                                _device_code_found = true;

                                // Construct verification URL with device code
                                // Format: https://{id}.awsapps.com/start/#/device?user_code={CODE}
                                // NOTE: Must have slash before hash: /start/#/device not /start#/device
                                let base_url = identity_provider_clone.trim_end_matches('/');
                                let verification_url =
                                    format!("{}/#/device?user_code={}", base_url, device_code);

                                log::info!("[Kiro] Device code found (fallback): {}", device_code);
                                log::info!("[Kiro] Full verification URL: {}", verification_url);

                                // Emit browser_ready with full URL including device code
                                // This is the URL the frontend should open in embedded webview
                                let _ = app_clone.emit(
                                    "kiro-login-progress",
                                    serde_json::json!({
                                        "status": "browser_ready",
                                        "deviceCode": device_code,
                                        "verificationUrl": verification_url
                                    }),
                                );
                            }
                        }

                        // Also check for URL in output (might contain full URL with code)
                        if let Some(caps) = DEVICE_URL_REGEX.captures(&output_buffer) {
                            if let Some(url) = caps.get(1) {
                                log::info!("[Kiro] Device URL found in output: {}", url.as_str());
                            }
                        }
                    }

                    // Process complete lines from buffer for other checks
                    while let Some(newline_pos) = output_buffer.find('\n') {
                        let line: String = output_buffer.drain(..=newline_pos).collect();
                        let line = line.trim();

                        if line.is_empty() {
                            continue;
                        }

                        log::info!("[Kiro] Line: {}", line);

                        // Check for device code (format: "Code: XXXX-XXXX")
                        if !_device_code_found {
                            if let Some(caps) = DEVICE_CODE_REGEX.captures(line) {
                                if let Some(code) = caps.get(1) {
                                    let device_code = code.as_str().to_string();
                                    _device_code_found = true;

                                    // Construct verification URL with device code
                                    // NOTE: Must have slash before hash: /start/#/device not /start#/device
                                    let base_url = identity_provider_clone.trim_end_matches('/');
                                    let verification_url =
                                        format!("{}/#/device?user_code={}", base_url, device_code);

                                    log::info!("[Kiro] Device code found (line): {}", device_code);
                                    log::info!(
                                        "[Kiro] Full verification URL: {}",
                                        verification_url
                                    );

                                    // Emit browser_ready with full URL
                                    let _ = app_clone.emit(
                                        "kiro-login-progress",
                                        serde_json::json!({
                                            "status": "browser_ready",
                                            "deviceCode": device_code,
                                            "verificationUrl": verification_url
                                        }),
                                    );
                                }
                            }
                        }

                        // Check for authorization
                        if line.contains("Device authorized") || line.contains("authorized") {
                            log::info!("[Kiro] Device authorized");
                            let _ = app_clone.emit(
                                "kiro-login-progress",
                                serde_json::json!({
                                    "status": "device_authorized"
                                }),
                            );
                        }

                        // Check for success
                        if line.contains("Logged in successfully") || line.contains("successfully")
                        {
                            log::info!("[Kiro] Login successful");
                            success = true;
                        }

                        // Check for "already logged in" - this is actually success!
                        if line.contains("Already logged in") || line.contains("already logged in")
                        {
                            log::info!("[Kiro] Already logged in - treating as success");
                            success = true;
                        }

                        // Check for errors (but not "already logged in" which we handle above)
                        if (line.contains("error:") || line.contains("Error:"))
                            && !line.contains("Already logged in")
                            && !line.contains("already logged in")
                        {
                            log::error!("[Kiro] Error detected: {}", line);
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // No data available, wait a bit
                    thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    log::debug!("[Kiro] Read error: {}", e);
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }

        // Wait for child to finish
        let exit_status = child.wait();
        log::info!("[Kiro] Child exit status: {:?}", exit_status);

        // Clear active login state
        {
            let mut active = ACTIVE_LOGIN.lock();
            *active = None;
        }

        // Check result
        let exit_ok = exit_status.map(|s| s.success()).unwrap_or(false);

        if success || exit_ok {
            log::info!("[Kiro] Login succeeded, reading tokens...");

            // Try to read tokens - need to do this synchronously
            if let Some(kiro_token) = get_local_kiro_token() {
                log::info!("[Kiro] Tokens found");
                let _ = app_clone.emit(
                    "kiro-login-complete",
                    serde_json::json!({
                        "success": true,
                        "accessToken": kiro_token.access_token,
                        "refreshToken": kiro_token.refresh_token.unwrap_or_default(),
                        "clientId": kiro_token.client_id.unwrap_or_default(),
                        "clientSecret": kiro_token.client_secret.unwrap_or_default(),
                        "startUrl": kiro_token.start_url.unwrap_or_default(),
                        "region": kiro_token.region.unwrap_or_default(),
                        "expiresAt": kiro_token.expires_at.unwrap_or_default()
                    }),
                );
            } else {
                log::warn!("[Kiro] Login succeeded but couldn't read tokens");
                let _ = app_clone.emit(
                    "kiro-login-complete",
                    serde_json::json!({
                        "success": true,
                        "accessToken": "login_verified",
                        "refreshToken": "login_verified"
                    }),
                );
            }
        } else {
            log::error!("[Kiro] Login failed");
            let error_msg = if output_buffer.contains("error:")
                && !output_buffer.contains("Already logged in")
            {
                output_buffer
                    .lines()
                    .find(|l| l.contains("error:") && !l.contains("Already logged in"))
                    .unwrap_or("Login failed")
                    .to_string()
            } else {
                "Login failed".to_string()
            };

            let _ = app_clone.emit(
                "kiro-login-complete",
                serde_json::json!({
                    "success": false,
                    "error": error_msg
                }),
            );
        }

        // Cleanup temp directory with fake 'open' command
        let _ = std::fs::remove_dir_all(&temp_dir_clone);
        log::info!("[Kiro] Cleaned up temp directory");

        log::info!("[Kiro] PTY thread completed");
    });

    log::info!("[Kiro] start_kiro_login returning Ok(())");
    Ok(())
}

/// Cancel ongoing Kiro login
#[tauri::command]
pub fn cancel_kiro_login() -> Result<(), String> {
    cancel_existing_login();
    Ok(())
}

/// Create an embedded webview for Kiro AWS IAM Identity Center login
///
/// Opens a webview to the verification URL where user can complete login.
/// kiro-cli running in background will detect when auth is complete.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_kiro_auth_webview(
    app: AppHandle,
    parent_window: String,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_window(&parent_window)
        .ok_or_else(|| format!("Parent window '{}' not found", parent_window))?;

    // Close existing webview if present
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    log::info!("[Kiro] Creating auth webview for URL: {}", url);

    // Build webview
    let label_for_closure = label.clone();
    let app_for_closure = app.clone();

    let builder = WebviewBuilder::new(
        &label,
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?),
    )
    .auto_resize()
    .on_navigation(move |url| {
        let url_str = url.to_string();
        log::info!("[Kiro] Webview navigating to: {}", url_str);
        let _ = app_for_closure.emit(
            "kiro-webview-url-changed",
            serde_json::json!({
                "url": url_str,
                "webviewLabel": label_for_closure
            }),
        );
        true // Allow all navigation
    });

    let ownership_observation = perf_utils::begin_webview_ownership_observation(label.clone());
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create webview: {}", e))?;
    ownership_observation.commit();

    log::info!("[Kiro] Auth webview created successfully");
    Ok(())
}

/// Close the Kiro auth webview
#[tauri::command]
pub async fn close_kiro_auth_webview(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|e| format!("Failed to close webview: {}", e))?;
        log::info!("[Kiro] Auth webview closed");
    }
    Ok(())
}

/// Read Kiro tokens from local storage (Keychain/SQLite)
///
/// Returns tokens if found, None otherwise.
#[tauri::command]
pub async fn read_kiro_tokens() -> Result<Option<serde_json::Value>, String> {
    // Use existing validation/kiro.rs function to get tokens
    if let Some(kiro_token) = get_local_kiro_token() {
        return Ok(Some(serde_json::json!({
            "access_token": kiro_token.access_token,
            "refresh_token": kiro_token.refresh_token.unwrap_or_default()
        })));
    }

    Ok(None)
}

// ============================================
// Internal Functions
// ============================================

/// Cancel any existing login process
fn cancel_existing_login() {
    let mut active = ACTIVE_LOGIN.lock();
    if let Some(state) = active.take() {
        state.stop_flag.store(true, Ordering::SeqCst);

        // Kill child process if running
        #[cfg(unix)]
        if let Some(pid) = state.child_id {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
    }
}
