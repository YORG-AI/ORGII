//! Agent browser automation controller.
//!
//! Owns the selected browser provider process and exposes one local control
//! surface to agent tools and Tauri commands.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::process::Command;
use tracing::info;
use uuid::Uuid;

/// Default port for the browser automation service.
pub const DEFAULT_AGENT_BROWSER_PORT: u16 = 9849;

const BROWSER_AUTOMATION_PROVIDER_ENV: &str = "ORGII_BROWSER_AUTOMATION_PROVIDER";
const AGENT_BROWSER_CLI_PATH_ENV: &str = "ORGII_AGENT_BROWSER_CLI";
const PLAYWRIGHT_CLI_PATH_ENV: &str = "ORGII_PLAYWRIGHT_CLI";
const AGENT_BROWSER_CHROME_PATH_ENV: &str = "ORGII_AGENT_BROWSER_CHROME";
const BROWSER_AUTOMATION_PROVIDER_SETTING_KEY: &str = "agentBrowser.provider";
const AGENT_BROWSER_CLI_PATH_SETTING_KEY: &str = "agentBrowser.agentBrowserCliPath";
const PLAYWRIGHT_CLI_PATH_SETTING_KEY: &str = "agentBrowser.playwrightCliPath";
const BROWSER_AUTOMATION_SESSION: &str = "orgii";
const BROWSER_CLI_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const OPTIONAL_SIDECAR_PLACEHOLDER_MARKER: &str = "ORGII_GENERATED_OPTIONAL_SIDECAR_PLACEHOLDER";

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const VENDORED_AGENT_BROWSER_BINARY: &str = "agent-browser-aarch64-apple-darwin";

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const VENDORED_AGENT_BROWSER_BINARY: &str = "agent-browser-x86_64-apple-darwin";

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const VENDORED_AGENT_BROWSER_BINARY: &str = "agent-browser-x86_64-unknown-linux-gnu";

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const VENDORED_AGENT_BROWSER_BINARY: &str = "agent-browser-x86_64-pc-windows-msvc.exe";

#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
const VENDORED_AGENT_BROWSER_BINARY: &str = "agent-browser";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserAutomationProvider {
    AgentBrowser,
    Playwright,
}

impl BrowserAutomationProvider {
    pub const fn default_provider() -> Self {
        Self::AgentBrowser
    }

    pub fn from_env() -> Option<Self> {
        std::env::var(BROWSER_AUTOMATION_PROVIDER_ENV)
            .ok()
            .and_then(|value| Self::parse(&value))
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            value if value.eq_ignore_ascii_case("agent_browser") => Some(Self::AgentBrowser),
            value if value.eq_ignore_ascii_case("playwright") => Some(Self::Playwright),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AgentBrowser => "agent_browser",
            Self::Playwright => "playwright",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentBrowserConfig {
    pub provider: BrowserAutomationProvider,
    pub agent_browser_cli_path: Option<PathBuf>,
    pub playwright_cli_path: Option<PathBuf>,
}

impl Default for AgentBrowserConfig {
    fn default() -> Self {
        Self {
            provider: BrowserAutomationProvider::default_provider(),
            agent_browser_cli_path: None,
            playwright_cli_path: None,
        }
    }
}

impl AgentBrowserConfig {
    pub fn from_settings(settings: &Value) -> Self {
        let provider = BrowserAutomationProvider::from_env().unwrap_or_else(|| {
            settings
                .get(BROWSER_AUTOMATION_PROVIDER_SETTING_KEY)
                .and_then(|value| value.as_str())
                .and_then(BrowserAutomationProvider::parse)
                .unwrap_or_else(BrowserAutomationProvider::default_provider)
        });

        let agent_browser_cli_path =
            optional_path_setting(settings, AGENT_BROWSER_CLI_PATH_SETTING_KEY);
        let playwright_cli_path = optional_path_setting(settings, PLAYWRIGHT_CLI_PATH_SETTING_KEY);

        Self {
            provider,
            agent_browser_cli_path,
            playwright_cli_path,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserCliConfig {
    pub provider: BrowserAutomationProvider,
    pub executable: PathBuf,
    pub uses_node_launcher: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserCliOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl BrowserCliOutput {
    pub fn as_tool_text(&self, command_label: &str) -> String {
        let mut sections = vec![format!("{} completed successfully.", command_label)];
        if !self.stdout.is_empty() {
            sections.push(format!("stdout:\n{}", self.stdout));
        }
        if !self.stderr.is_empty() {
            sections.push(format!("stderr:\n{}", self.stderr));
        }
        sections.join("\n\n")
    }
}

pub struct AgentBrowserController {
    port: u16,
    paused: AtomicBool,
    provider: BrowserAutomationProvider,
    agent_browser_cli_path: Option<PathBuf>,
    playwright_cli_path: Option<PathBuf>,
    cli_session_active: bool,
}

impl Default for AgentBrowserController {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentBrowserController {
    pub fn new() -> Self {
        Self {
            port: DEFAULT_AGENT_BROWSER_PORT,
            paused: AtomicBool::new(false),
            provider: BrowserAutomationProvider::default_provider(),
            agent_browser_cli_path: None,
            playwright_cli_path: None,
            cli_session_active: false,
        }
    }

    pub fn with_config(config: AgentBrowserConfig) -> Self {
        Self {
            provider: config.provider,
            agent_browser_cli_path: config.agent_browser_cli_path,
            playwright_cli_path: config.playwright_cli_path,
            ..Self::new()
        }
    }

    pub fn with_provider(provider: BrowserAutomationProvider) -> Self {
        Self::with_config(AgentBrowserConfig {
            provider,
            agent_browser_cli_path: None,
            playwright_cli_path: None,
        })
    }

    pub fn provider(&self) -> BrowserAutomationProvider {
        self.provider
    }

    pub fn config(&self) -> AgentBrowserConfig {
        AgentBrowserConfig {
            provider: self.provider,
            agent_browser_cli_path: self.agent_browser_cli_path.clone(),
            playwright_cli_path: self.playwright_cli_path.clone(),
        }
    }

    pub fn browser_cli_config(&self) -> Result<BrowserCliConfig, String> {
        resolve_browser_cli_config(
            self.provider,
            self.agent_browser_cli_path.as_deref(),
            self.playwright_cli_path.as_deref(),
        )
    }

    pub fn set_provider(&mut self, provider: BrowserAutomationProvider) -> Result<(), String> {
        if self.is_running() {
            return Err(
                "Browser automation provider cannot be changed while browser automation is running"
                    .to_string(),
            );
        }
        self.provider = provider;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.cli_session_active
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::Relaxed);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::Relaxed);
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub async fn start(&mut self) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }

        let cli_config = self.browser_cli_config()?;
        match self.provider {
            BrowserAutomationProvider::AgentBrowser => {
                verify_agent_browser_cli(&cli_config.executable).await?;
            }
            BrowserAutomationProvider::Playwright => {}
        }

        info!(
            "[agent-browser] Provider '{}' ready in command mode (binary: {})",
            self.provider.as_str(),
            cli_config.executable.display()
        );
        self.cli_session_active = true;
        Ok(())
    }

    pub fn start_screencast_polling(&mut self, _app_handle: AppHandle) {}

    pub fn stop_screencast_polling(&mut self) {}

    pub async fn stop(&mut self) {
        if self.cli_session_active && self.provider == BrowserAutomationProvider::AgentBrowser {
            let _ = self.run_cli_command(vec!["close".to_string()]).await;
        }
        self.cli_session_active = false;
        self.paused.store(false, Ordering::Relaxed);
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.cli_request(method, path, body).await
    }

    pub async fn get_with_query(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<Value, String> {
        self.cli_get_with_query(path, query).await
    }

    async fn cli_request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        if !self.is_running() {
            return Err("Agent browser is not running".to_string());
        }

        match (method.to_uppercase().as_str(), path) {
            ("GET", "/") => self.cli_current_url().await,
            ("POST", "/start") => self.cli_open(None).await,
            ("POST", "/stop") => self.cli_close().await,
            ("POST", "/navigate") => {
                let body = body.unwrap_or_else(|| json!({}));
                let url = body
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Missing navigate url".to_string())?;
                self.cli_open(Some(url)).await
            }
            ("POST", "/screenshot") => self.cli_screenshot(body).await,
            ("POST", "/act") => self.cli_act(body.unwrap_or_else(|| json!({}))).await,
            ("GET", "/tabs") => self.cli_tabs().await,
            ("POST", "/screencast/start")
            | ("POST", "/screencast/stop")
            | ("POST", "/window/show")
            | ("POST", "/window/hide") => Ok(json!({ "ok": true })),
            _ => Err(format!(
                "Unsupported official agent-browser CLI request: {} {}",
                method, path
            )),
        }
    }

    async fn cli_get_with_query(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<Value, String> {
        if !self.is_running() {
            return Err("Agent browser is not running".to_string());
        }

        match path {
            "/snapshot" => self.cli_snapshot(query).await,
            "/console" => self.cli_console().await,
            _ => Err(format!(
                "Unsupported official agent-browser CLI query request: {}",
                path
            )),
        }
    }

    async fn cli_open(&self, url: Option<&str>) -> Result<Value, String> {
        let mut args = vec!["open".to_string()];
        if let Some(url) = url {
            args.push(url.to_string());
        }
        let data = self.run_cli_command(args).await?;
        Ok(json!({
            "url": data.get("url").and_then(Value::as_str).unwrap_or("about:blank"),
            "title": data.get("title").cloned().unwrap_or(Value::Null),
        }))
    }

    async fn cli_close(&self) -> Result<Value, String> {
        self.run_cli_command(vec!["close".to_string()]).await
    }

    async fn cli_current_url(&self) -> Result<Value, String> {
        self.run_cli_command(vec!["get".to_string(), "url".to_string()])
            .await
    }

    async fn cli_snapshot(&self, query: &[(String, String)]) -> Result<Value, String> {
        let mut args = vec!["snapshot".to_string()];
        if query_has_true(query, "interactive") {
            args.push("--interactive".to_string());
        }
        if query_has_true(query, "compact") {
            args.push("--compact".to_string());
        }
        if let Some(selector) = query_value(query, "selector") {
            args.push("--selector".to_string());
            args.push(selector.to_string());
        }

        let data = self.run_cli_command(args).await?;
        Ok(json!({
            "snapshot": data.get("snapshot").and_then(Value::as_str).unwrap_or(""),
            "url": data
                .get("url")
                .or_else(|| data.get("origin"))
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
        }))
    }

    async fn cli_screenshot(&self, body: Option<Value>) -> Result<Value, String> {
        let screenshot_path =
            std::env::temp_dir().join(format!("orgii-agent-browser-{}.png", Uuid::new_v4()));
        let screenshot_path_string = screenshot_path.to_string_lossy().to_string();

        let mut args = vec!["screenshot".to_string(), screenshot_path_string.clone()];
        if body
            .as_ref()
            .and_then(|value| value.get("fullPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            args.push("--full".to_string());
        }

        self.run_cli_command(args).await?;
        let bytes = tokio::fs::read(&screenshot_path)
            .await
            .map_err(|err| format!("Failed to read agent-browser screenshot: {}", err))?;
        let _ = tokio::fs::remove_file(&screenshot_path).await;
        let url = self
            .cli_current_url()
            .await
            .ok()
            .and_then(|value| value.get("url").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string());

        Ok(json!({
            "screenshot": BASE64.encode(bytes),
            "url": url,
        }))
    }

    async fn cli_act(&self, request: Value) -> Result<Value, String> {
        let kind = request
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing act request kind".to_string())?;

        match kind {
            "click" => {
                let selector = required_ref_selector(&request, "ref")?;
                self.run_cli_command(vec!["click".to_string(), selector.clone()])
                    .await?;
                self.action_result(selector).await
            }
            "type" => {
                let selector = required_ref_selector(&request, "ref")?;
                let text = request.get("text").and_then(Value::as_str).unwrap_or("");
                self.run_cli_command(vec!["type".to_string(), selector.clone(), text.to_string()])
                    .await?;
                self.action_result(selector).await
            }
            "fill" => {
                if let Some(fields) = request.get("fields").and_then(Value::as_array) {
                    for field in fields {
                        let selector = required_ref_selector(field, "ref")?;
                        let value = field.get("value").and_then(Value::as_str).unwrap_or("");
                        self.run_cli_command(vec!["fill".to_string(), selector, value.to_string()])
                            .await?;
                    }
                    self.action_result("".to_string()).await
                } else {
                    let selector = required_ref_selector(&request, "ref")?;
                    let text = request.get("text").and_then(Value::as_str).unwrap_or("");
                    self.run_cli_command(vec![
                        "fill".to_string(),
                        selector.clone(),
                        text.to_string(),
                    ])
                    .await?;
                    self.action_result(selector).await
                }
            }
            "press" => {
                let key = request
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Missing press key".to_string())?;
                self.run_cli_command(vec!["press".to_string(), key.to_string()])
                    .await?;
                self.action_result("".to_string()).await
            }
            "hover" => {
                let selector = required_ref_selector(&request, "ref")?;
                self.run_cli_command(vec!["hover".to_string(), selector.clone()])
                    .await?;
                self.action_result(selector).await
            }
            "drag" => {
                let start_selector = required_ref_selector(&request, "startRef")?;
                let end_selector = required_ref_selector(&request, "endRef")?;
                self.run_cli_command(vec!["drag".to_string(), start_selector, end_selector])
                    .await?;
                self.action_result("".to_string()).await
            }
            "select" => {
                let selector = required_ref_selector(&request, "ref")?;
                let values = request
                    .get("values")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "Missing select values".to_string())?;
                let mut args = vec!["select".to_string(), selector.clone()];
                args.extend(values.iter().filter_map(Value::as_str).map(str::to_string));
                self.run_cli_command(args).await?;
                self.action_result(selector).await
            }
            "wait" => {
                let time_ms = request
                    .get("timeMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(1000)
                    .to_string();
                self.run_cli_command(vec!["wait".to_string(), time_ms])
                    .await?;
                self.action_result("".to_string()).await
            }
            "evaluate" => {
                let script = request
                    .get("fn")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Missing evaluate fn".to_string())?;
                let data = self
                    .run_cli_command(vec!["eval".to_string(), script.to_string()])
                    .await?;
                Ok(json!({ "result": data }))
            }
            "close" => self.cli_close().await,
            _ => Err(format!(
                "Unsupported official agent-browser action: {}",
                kind
            )),
        }
    }

    async fn action_result(&self, action_ref: String) -> Result<Value, String> {
        let url = self
            .cli_current_url()
            .await
            .ok()
            .and_then(|value| value.get("url").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        Ok(json!({ "ref": action_ref, "url": url }))
    }

    async fn cli_tabs(&self) -> Result<Value, String> {
        let data = self
            .run_cli_command(vec!["tab".to_string(), "list".to_string()])
            .await?;
        let tabs = data
            .get("tabs")
            .cloned()
            .or_else(|| data.as_array().map(|array| Value::Array(array.clone())))
            .unwrap_or_else(|| json!([]));
        Ok(json!({ "tabs": tabs }))
    }

    async fn cli_console(&self) -> Result<Value, String> {
        let data = self.run_cli_command(vec!["console".to_string()]).await?;
        let messages = data
            .get("messages")
            .or_else(|| data.get("entries"))
            .cloned()
            .or_else(|| data.as_array().map(|array| Value::Array(array.clone())))
            .unwrap_or_else(|| json!([]));
        Ok(json!({ "messages": messages }))
    }

    async fn run_cli_command(&self, command_args: Vec<String>) -> Result<Value, String> {
        let output = run_browser_cli_command(
            self.provider,
            self.agent_browser_cli_path.as_deref(),
            self.playwright_cli_path.as_deref(),
            &command_args,
        )
        .await?;

        let json: Value = serde_json::from_str(&output.stdout).map_err(|err| {
            format!(
                "Failed to parse agent-browser JSON output: {} ({})",
                err, output.stdout
            )
        })?;

        if json.get("success").and_then(Value::as_bool) == Some(false) {
            return Err(json
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("agent-browser command failed")
                .to_string());
        }

        Ok(json.get("data").cloned().unwrap_or(json))
    }
}

pub fn find_available_port(preferred: u16) -> Option<u16> {
    for offset in 0..100 {
        let candidate = preferred.wrapping_add(offset);
        if candidate == 0 {
            continue;
        }
        if is_port_available(candidate) {
            return Some(candidate);
        }
    }
    None
}

pub fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

async fn verify_agent_browser_cli(cli_path: &Path) -> Result<(), String> {
    let mut cmd = Command::new(cli_path);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Suppress console window on Windows.
    #[cfg(windows)]
    cmd.creation_flags(app_platform::CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .await
        .map_err(|err| format!("Failed to execute agent-browser CLI: {}", err))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(format!(
        "agent-browser CLI verification failed with {}: {}{}{}",
        output.status,
        stderr,
        if stderr.is_empty() || stdout.is_empty() {
            ""
        } else {
            "\n"
        },
        stdout
    ))
}

pub fn resolve_browser_cli_config(
    provider: BrowserAutomationProvider,
    agent_browser_cli_path: Option<&Path>,
    playwright_cli_path: Option<&Path>,
) -> Result<BrowserCliConfig, String> {
    match provider {
        BrowserAutomationProvider::AgentBrowser => Ok(BrowserCliConfig {
            provider,
            executable: resolve_agent_browser_cli(agent_browser_cli_path)?,
            uses_node_launcher: false,
        }),
        BrowserAutomationProvider::Playwright => resolve_playwright_cli(playwright_cli_path),
    }
}

pub async fn run_browser_cli_command(
    provider: BrowserAutomationProvider,
    agent_browser_cli_path: Option<&Path>,
    playwright_cli_path: Option<&Path>,
    command_args: &[String],
) -> Result<BrowserCliOutput, String> {
    run_browser_cli_command_with_timeout(
        provider,
        agent_browser_cli_path,
        playwright_cli_path,
        command_args,
        BROWSER_CLI_COMMAND_TIMEOUT,
    )
    .await
}

async fn run_browser_cli_command_with_timeout(
    provider: BrowserAutomationProvider,
    agent_browser_cli_path: Option<&Path>,
    playwright_cli_path: Option<&Path>,
    command_args: &[String],
    timeout: Duration,
) -> Result<BrowserCliOutput, String> {
    let cli_config =
        resolve_browser_cli_config(provider, agent_browser_cli_path, playwright_cli_path)?;
    let mut command = if cli_config.uses_node_launcher {
        let mut command = Command::new("node");
        command.arg(&cli_config.executable);
        command
    } else {
        Command::new(&cli_config.executable)
    };

    match provider {
        BrowserAutomationProvider::AgentBrowser => {
            command
                .arg("--session")
                .arg(BROWSER_AUTOMATION_SESSION)
                .arg("--json")
                .args(command_args)
                .env("AGENT_BROWSER_HEADED", "true");

            if std::env::var("AGENT_BROWSER_EXECUTABLE_PATH").is_err() {
                if let Some(chrome_path) = resolve_local_chrome_path() {
                    command.env("AGENT_BROWSER_EXECUTABLE_PATH", chrome_path);
                }
            }
        }
        BrowserAutomationProvider::Playwright => {
            command.arg(format!("-s={}", BROWSER_AUTOMATION_SESSION));
            command.args(command_args);
        }
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Suppress console window on Windows.
    #[cfg(windows)]
    command.creation_flags(app_platform::CREATE_NO_WINDOW);

    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| {
            format!(
                "{} CLI command timed out after {} seconds",
                provider.as_str(),
                timeout.as_secs()
            )
        })?
        .map_err(|err| format!("Failed to run {} CLI: {}", provider.as_str(), err))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        return Err(format!(
            "{} CLI exited with {}: {}{}{}",
            provider.as_str(),
            output.status,
            stderr,
            if stderr.is_empty() || stdout.is_empty() {
                ""
            } else {
                "\n"
            },
            stdout
        ));
    }

    Ok(BrowserCliOutput {
        status: output.status.code(),
        stdout,
        stderr,
    })
}

pub fn split_browser_cli_command(command: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut quote: Option<char> = None;

    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                } else {
                    current.push(ch);
                }
            }
            '\'' | '"' if quote.is_none() => quote = Some(ch),
            '\'' | '"' if quote == Some(ch) => quote = None,
            ch if ch.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }

    if let Some(unclosed_quote) = quote {
        return Err(format!(
            "Unclosed quote in browser CLI command: {}",
            unclosed_quote
        ));
    }

    if !current.is_empty() {
        args.push(current);
    }

    if args.is_empty() {
        return Err("Browser CLI command cannot be empty".to_string());
    }

    Ok(args)
}

pub fn resolve_agent_browser_cli(configured_path: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(cli_path) = configured_path {
        return require_existing_path(cli_path, "Configured Agent Browser CLI path");
    }

    if let Ok(path) = std::env::var(AGENT_BROWSER_CLI_PATH_ENV) {
        return require_existing_path(
            Path::new(&path),
            &format!("Agent Browser CLI path from {}", AGENT_BROWSER_CLI_PATH_ENV),
        );
    }

    for vendored_path in vendored_agent_browser_paths() {
        if is_real_sidecar_file(&vendored_path) {
            return Ok(vendored_path);
        }
    }

    Ok(PathBuf::from("agent-browser"))
}

fn optional_path_setting(settings: &Value, key: &str) -> Option<PathBuf> {
    settings
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn resolve_playwright_cli(configured_path: Option<&Path>) -> Result<BrowserCliConfig, String> {
    if let Some(cli_path) = configured_path {
        return playwright_cli_config_from_path(
            require_existing_path(cli_path, "Configured Playwright CLI path")?,
            BrowserAutomationProvider::Playwright,
        );
    }

    if let Ok(path) = std::env::var(PLAYWRIGHT_CLI_PATH_ENV) {
        return playwright_cli_config_from_path(
            require_existing_path(
                Path::new(&path),
                &format!("Playwright CLI path from {}", PLAYWRIGHT_CLI_PATH_ENV),
            )?,
            BrowserAutomationProvider::Playwright,
        );
    }

    for dev_path in playwright_cli_dev_paths() {
        if dev_path.exists() {
            return playwright_cli_config_from_path(
                dev_path,
                BrowserAutomationProvider::Playwright,
            );
        }
    }

    Ok(BrowserCliConfig {
        provider: BrowserAutomationProvider::Playwright,
        executable: PathBuf::from("playwright-cli"),
        uses_node_launcher: false,
    })
}

fn playwright_cli_dev_paths() -> Vec<PathBuf> {
    let src_tauri = src_tauri_dir();
    vec![
        src_tauri
            .join("sidecar")
            .join("playwright-cli")
            .join("playwright-cli.js"),
        src_tauri
            .parent()
            .map(|workspace| workspace.join("playwright-cli").join("playwright-cli.js"))
            .unwrap_or_else(|| src_tauri.join("playwright-cli").join("playwright-cli.js")),
    ]
}

fn playwright_cli_config_from_path(
    path: PathBuf,
    provider: BrowserAutomationProvider,
) -> Result<BrowserCliConfig, String> {
    let uses_node_launcher = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("js"));

    Ok(BrowserCliConfig {
        provider,
        executable: path,
        uses_node_launcher,
    })
}

fn is_real_sidecar_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    match fs::read_to_string(path) {
        Ok(content) => !content.starts_with(OPTIONAL_SIDECAR_PLACEHOLDER_MARKER),
        Err(_) => true,
    }
}

fn require_existing_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    if path.exists() {
        return Ok(path.to_path_buf());
    }
    Err(format!("{} does not exist: {}", label, path.display()))
}

fn vendored_agent_browser_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // Runtime-downloaded binary (post-notarized download): ~/.orgii/bin/agent-browser-*
    paths.push(app_paths::sidecar_bin_dir().join(VENDORED_AGENT_BROWSER_BINARY));

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(macos_dir) = current_exe.parent() {
            if let Some(contents_dir) = macos_dir.parent() {
                paths.push(
                    contents_dir
                        .join("Resources")
                        .join("bin")
                        .join(VENDORED_AGENT_BROWSER_BINARY),
                );
            }
        }
    }

    // Dev fallback: src-tauri/bin/
    paths.push(
        src_tauri_dir()
            .join("bin")
            .join(VENDORED_AGENT_BROWSER_BINARY),
    );

    paths
}

fn src_tauri_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn resolve_local_chrome_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var(AGENT_BROWSER_CHROME_PATH_ENV) {
        let chrome_path = PathBuf::from(path);
        if chrome_path.exists() {
            return Some(chrome_path);
        }
    }

    let candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];

    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
}

fn query_value<'a>(query: &'a [(String, String)], key: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(query_key, _)| query_key == key)
        .map(|(_, value)| value.as_str())
}

fn query_has_true(query: &[(String, String)], key: &str) -> bool {
    query_value(query, key).is_some_and(|value| value.eq_ignore_ascii_case("true"))
}

fn required_ref_selector(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(selector_from_ref)
        .ok_or_else(|| format!("Missing {}", key))
}

fn selector_from_ref(value: &str) -> String {
    if value.starts_with('@') {
        return value.to_string();
    }
    format!("@{}", value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_cli_command_timeout_terminates_hung_process() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!(
            "orgii-browser-cli-timeout-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, "#!/bin/sh\nexec sleep 5\n").expect("write timeout fixture");
        let mut permissions = std::fs::metadata(&path)
            .expect("read timeout fixture metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("make timeout fixture executable");

        let started = std::time::Instant::now();
        let error = run_browser_cli_command_with_timeout(
            BrowserAutomationProvider::AgentBrowser,
            Some(&path),
            None,
            &["snapshot".to_string()],
            Duration::from_millis(100),
        )
        .await
        .expect_err("hung browser CLI command must time out");

        std::fs::remove_file(path).expect("remove timeout fixture");
        assert!(error.contains("agent_browser CLI command timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn placeholder_sidecar_file_is_not_real() {
        let path = std::env::temp_dir().join(format!(
            "orgii-agent-browser-placeholder-test-{}",
            std::process::id()
        ));
        std::fs::write(
            &path,
            format!(
                "{}\nresource=bin/agent-browser-aarch64-apple-darwin\n",
                OPTIONAL_SIDECAR_PLACEHOLDER_MARKER
            ),
        )
        .expect("write placeholder");

        assert!(!is_real_sidecar_file(&path));

        std::fs::remove_file(path).expect("remove placeholder");
    }
}
