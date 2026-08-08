//! Interactive CLI dogfood harness for the Gateway Agent.
//!
//! This binary talks to a running **debug** Tauri app (`npm run tauri:dev`)
//! over its localhost agent HTTP API. It lets a human operator chat with
//! the Gateway Agent from the terminal as if they were a Telegram user —
//! without any actual Telegram account, without touching production, and
//! without any way for real users of the app to leak messages into this
//! buffer.
//!
//! # Safety
//!
//! - The app's outbound tap is **disarmed by default**. This CLI explicitly
//!   calls `POST /test/gateway/outbound-tap/arm` on startup and
//!   `/disarm` on exit (best effort; the arm flag also resets on app
//!   restart).
//! - The tap, the drain endpoint, and this entire binary target only the
//!   `test/gateway` surface, which is guarded by `#![cfg(debug_assertions)]`
//!   in the API layer. Release builds of the app reject every request this
//!   CLI makes (the routes don't exist).
//! - No messages are written to disk. The tap buffer lives in process
//!   memory and is capped at 128 entries with FIFO eviction.
//!
//! # Usage
//!
//! 1. Run the app in dev mode: `npm run tauri:dev` in the workspace root.
//! 2. Wait until the agent API is ready (default port 13847).
//! 3. In a second terminal, either:
//!
//!    **Interactive mode** — chat freely:
//!    ```bash
//!    cargo run --bin gateway-chat-cli
//!    # or override the target:
//!    ORGII_AGENT_URL=http://127.0.0.1:13847 cargo run --bin gateway-chat-cli
//!    ```
//!
//!    **Scripted mode** — replay a pre-canned scenario for regression /
//!    dogfood archiving. Each non-empty, non-comment line of the script
//!    is sent verbatim as a user message; replies are captured into the
//!    transcript file next to it.
//!    ```bash
//!    cargo run --bin gateway-chat-cli -- \
//!        --script docs/agent/gateway-dogfood/scenarios/news_brief.md \
//!        --transcript docs/agent/gateway-dogfood/transcripts/news_brief--MMDD.md
//!    ```
//!    Each run uses a fresh `source_chat_id` derived from the script
//!    basename + UTC timestamp so scenarios don't bleed into each other.
//!
//! 4. Interactive mode: type messages. Each line is injected through
//!    the real Gateway inbound queue (`/test/gateway/inject-normal`);
//!    the reply is polled from `/test/gateway/outbound-tap/drain` and
//!    printed.
//!
//! # What this exercises
//!
//! - Gateway Agent Tier-0 / Tier-1 routing
//! - Slash commands (`/new`, `/status`, `/compact`, `/help`)
//! - Session binding, reset/fork, idle-reset notices
//! - Real outbound formatting (delivery splits, empty-outbound guard)
//!
//! It does **not** exercise the Telegram/Feishu HTTP transport layer;
//! for that, use `telegram-smoke` (separate binary).

use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tokio::time::{sleep, Instant};

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:13847";
const DEFAULT_SOURCE_CHANNEL: &str = "dogfood:cli";
const DEFAULT_SOURCE_CHAT_ID: &str = "cli-operator";
const DEFAULT_SENDER_ID: &str = "cli-user";
const REPLY_POLL_INTERVAL: Duration = Duration::from_millis(300);
const REPLY_TIMEOUT: Duration = Duration::from_secs(180);
const INITIAL_REPLY_GRACE: Duration = Duration::from_millis(200);

struct Cli {
    base_url: String,
    source_channel: String,
    source_chat_id: String,
    sender_id: String,
    model: Option<String>,
    account_id: Option<String>,
    http: reqwest::Client,
}

impl Cli {
    fn from_env() -> Self {
        let base_url = env::var("ORGII_AGENT_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        let source_channel =
            env::var("ORGII_CLI_CHANNEL").unwrap_or_else(|_| DEFAULT_SOURCE_CHANNEL.to_string());
        let source_chat_id =
            env::var("ORGII_CLI_CHAT_ID").unwrap_or_else(|_| DEFAULT_SOURCE_CHAT_ID.to_string());
        let sender_id =
            env::var("ORGII_CLI_SENDER_ID").unwrap_or_else(|_| DEFAULT_SENDER_ID.to_string());
        let model = env::var("ORGII_CLI_MODEL").ok().filter(|s| !s.is_empty());
        let account_id = env::var("ORGII_CLI_ACCOUNT_ID")
            .ok()
            .filter(|s| !s.is_empty());
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client");

        Self {
            base_url,
            source_channel,
            source_chat_id,
            sender_id,
            model,
            account_id,
            http,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/agent{}", self.base_url, path)
    }

    async fn arm(&self) -> Result<(), String> {
        let resp = self
            .http
            .post(self.url("/test/gateway/outbound-tap/arm"))
            .json(&json!({}))
            .send()
            .await
            .map_err(|err| format!("arm request failed: {err}"))?;
        if !resp.status().is_success() {
            return Err(format!("arm returned HTTP {}", resp.status()));
        }
        Ok(())
    }

    async fn disarm(&self) {
        let _ = self
            .http
            .post(self.url("/test/gateway/outbound-tap/disarm"))
            .json(&json!({}))
            .send()
            .await;
    }

    async fn inject(&self, content: &str) -> Result<(), String> {
        let mut body = json!({
            "source_channel": self.source_channel,
            "source_chat_id": self.source_chat_id,
            "sender_id": self.sender_id,
            "content": content,
        });
        if let Some(ref model) = self.model {
            body["model"] = json!(model);
        }
        if let Some(ref aid) = self.account_id {
            body["account_id"] = json!(aid);
        }
        let resp = self
            .http
            .post(self.url("/test/gateway/inject-normal"))
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("inject request failed: {err}"))?;
        let status = resp.status();
        let payload: serde_json::Value = resp
            .json()
            .await
            .map_err(|err| format!("inject response parse failed: {err}"))?;
        if !status.is_success() || payload.get("error").is_some() {
            return Err(format!("inject rejected: {payload}"));
        }
        Ok(())
    }

    async fn drain(&self, clear: bool) -> Result<Vec<ReplyMessage>, String> {
        let resp = self
            .http
            .post(self.url("/test/gateway/outbound-tap/drain"))
            .json(&json!({ "clear": clear }))
            .send()
            .await
            .map_err(|err| format!("drain request failed: {err}"))?;
        if !resp.status().is_success() {
            return Err(format!("drain returned HTTP {}", resp.status()));
        }
        let payload: serde_json::Value = resp
            .json()
            .await
            .map_err(|err| format!("drain parse failed: {err}"))?;
        let messages = payload
            .get("messages")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(messages
            .into_iter()
            .filter_map(|entry| {
                Some(ReplyMessage {
                    channel: entry.get("channel")?.as_str()?.to_string(),
                    chat_id: entry.get("chat_id")?.as_str()?.to_string(),
                    content: entry.get("content")?.as_str()?.to_string(),
                })
            })
            .collect())
    }
}

#[derive(Debug)]
struct ReplyMessage {
    channel: String,
    chat_id: String,
    content: String,
}

fn print_help() {
    println!();
    println!("Commands:");
    println!("  /quit, /exit   leave and disarm the tap");
    println!("  /help          show this message");
    println!("  /arm           re-arm tap (idempotent)");
    println!("  /clear         drop any pending buffered replies");
    println!();
    println!("Anything else is sent as a user message through");
    println!("/test/gateway/inject-normal. Gateway slash commands");
    println!("like /new, /status, /compact, /help work too —");
    println!("prefix them with `.` to escape CLI commands if needed.");
    println!();
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match parse_mode(&args) {
        RunMode::Interactive => run_interactive().await,
        RunMode::Scripted {
            script_path,
            transcript_path,
        } => run_script(script_path, transcript_path).await,
        RunMode::Help => print_cli_help(),
    }
}

enum RunMode {
    Interactive,
    Scripted {
        script_path: PathBuf,
        transcript_path: Option<PathBuf>,
    },
    Help,
}

fn parse_mode(args: &[String]) -> RunMode {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return RunMode::Help;
    }
    let mut script: Option<PathBuf> = None;
    let mut transcript: Option<PathBuf> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--script" => script = iter.next().map(PathBuf::from),
            "--transcript" => transcript = iter.next().map(PathBuf::from),
            _ => {}
        }
    }
    match script {
        Some(script_path) => RunMode::Scripted {
            script_path,
            transcript_path: transcript,
        },
        None => RunMode::Interactive,
    }
}

fn print_cli_help() {
    println!("gateway-chat-cli — Gateway Agent dogfood harness");
    println!();
    println!("USAGE:");
    println!("  gateway-chat-cli                    Interactive REPL");
    println!("  gateway-chat-cli --script <path>    Replay a scenario script");
    println!("      [--transcript <path>]           Capture transcript to file");
    println!();
    println!("ENV (both modes):");
    println!("  ORGII_AGENT_URL       default http://127.0.0.1:13847");
    println!("  ORGII_CLI_CHANNEL     default dogfood:cli");
    println!("  ORGII_CLI_CHAT_ID     default cli-operator (overridden in scripted mode)");
    println!("  ORGII_CLI_SENDER_ID   default cli-user");
    println!("  ORGII_CLI_MODEL       optional — override Gateway model for this run");
    println!("  ORGII_CLI_ACCOUNT_ID  optional — override key vault account");
    println!();
    println!("SCRIPT FORMAT:");
    println!("  Plain text. Each non-empty, non-`#`-prefixed line is one user turn.");
    println!("  Blank lines and `# comment` lines are ignored.");
    println!("  Lines starting with `@wait <seconds>` insert a pause (e.g. @wait 2).");
}

async fn run_interactive() {
    let cli = Cli::from_env();
    print_banner(&cli);

    print!("Arming outbound tap... ");
    io::stdout().flush().ok();
    match cli.arm().await {
        Ok(()) => println!("ok"),
        Err(err) => {
            println!("failed");
            eprintln!("error: {err}");
            eprintln!("hint: is the app running in dev mode at {}?", cli.base_url);
            std::process::exit(1);
        }
    }

    let _ = cli.drain(true).await;

    print_help();

    let stdin = io::stdin();
    let mut line = String::new();
    loop {
        print!("you > ");
        io::stdout().flush().ok();
        line.clear();
        let Ok(read) = stdin.lock().read_line(&mut line) else {
            break;
        };
        if read == 0 {
            break;
        }
        let input = line.trim();
        if input.is_empty() {
            continue;
        }
        match input {
            "/quit" | "/exit" => break,
            "/help" => {
                print_help();
                continue;
            }
            "/arm" => {
                match cli.arm().await {
                    Ok(()) => println!("[armed]"),
                    Err(err) => eprintln!("[arm failed: {err}]"),
                }
                continue;
            }
            "/clear" => {
                match cli.drain(true).await {
                    Ok(msgs) => println!("[cleared {} buffered message(s)]", msgs.len()),
                    Err(err) => eprintln!("[clear failed: {err}]"),
                }
                continue;
            }
            _ => {}
        }

        let payload = if let Some(escaped) = input.strip_prefix('.') {
            escaped.to_string()
        } else {
            input.to_string()
        };

        if let Err(err) = cli.inject(&payload).await {
            eprintln!("[inject failed: {err}]");
            continue;
        }

        sleep(INITIAL_REPLY_GRACE).await;

        let start = Instant::now();
        let mut printed = 0usize;
        loop {
            match cli.drain(true).await {
                Ok(msgs) => {
                    for msg in msgs {
                        render_reply(&msg);
                        printed += 1;
                    }
                }
                Err(err) => {
                    eprintln!("[drain failed: {err}]");
                    break;
                }
            }
            if printed > 0 && Instant::now().duration_since(start) > Duration::from_millis(800) {
                break;
            }
            if Instant::now().duration_since(start) >= REPLY_TIMEOUT {
                if printed == 0 {
                    eprintln!("[timeout after {:?} — no outbound captured]", REPLY_TIMEOUT);
                }
                break;
            }
            sleep(REPLY_POLL_INTERVAL).await;
        }
    }

    print!("Disarming outbound tap... ");
    io::stdout().flush().ok();
    cli.disarm().await;
    println!("bye.");
}

fn render_reply(msg: &ReplyMessage) {
    println!("gw  > [{}/{}]", msg.channel, msg.chat_id);
    for line in msg.content.lines() {
        println!("     │ {line}");
    }
}

fn print_banner(cli: &Cli) {
    println!("╭─────────────────────────────────────────────────────────────╮");
    println!("│ gateway-chat-cli  —  Gateway Agent dogfood                  │");
    println!("├─────────────────────────────────────────────────────────────┤");
    println!("│ Target:          {:<44}│", cli.base_url);
    println!(
        "│ Source channel:  {:<44}│",
        format!("{} / {}", cli.source_channel, cli.source_chat_id)
    );
    println!("│ Sender id:       {:<44}│", cli.sender_id);
    println!("╰─────────────────────────────────────────────────────────────╯");
}

/// Derive a unique `source_chat_id` for a scripted run so two replays of
/// the same script don't share state via Gateway binding cache.
///
/// Format: `script-<basename>-<epoch_seconds>`. We keep it deterministic
/// enough to be greppable in logs but unique-per-invocation.
fn derive_chat_id(script: &Path) -> String {
    let basename = script
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("script");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("script-{basename}-{ts}")
}

/// Parse a scenario script.
///
/// Rules (kept trivial on purpose — human-authored markdown):
/// - Lines before the `# === turn-by-turn ===` separator are treated as
///   a free-form header (scenario description, probes, observations).
///   Everything in the header is ignored, so you can write as much
///   markdown prose as you want up top without accidentally being
///   injected as a user turn.
/// - After the separator:
///   - Blank lines and `# ...` comment lines: ignored.
///   - `@wait <secs>` directive: inserts a wall-clock pause before the
///     next injected turn.
///   - Everything else: one line = one user message.
///
/// Backward compatibility: if no separator is present (old scripts), we
/// fall back to treating the whole file as turns — same behaviour as
/// before. The separator is just a safety belt for scripts that want to
/// carry inline documentation.
fn parse_script(raw: &str) -> Vec<ScriptStep> {
    const SEPARATOR: &str = "# === turn-by-turn ===";

    let body = if let Some((_header, turns)) = raw.split_once(SEPARATOR) {
        turns
    } else {
        raw
    };

    let mut out = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("@wait ") {
            if let Ok(secs) = rest.trim().parse::<u64>() {
                out.push(ScriptStep::Wait(Duration::from_secs(secs)));
            }
            continue;
        }
        out.push(ScriptStep::User(trimmed.to_string()));
    }
    out
}

enum ScriptStep {
    User(String),
    Wait(Duration),
}

async fn run_script(script_path: PathBuf, transcript_path: Option<PathBuf>) {
    let script_src = match fs::read_to_string(&script_path) {
        Ok(s) => s,
        Err(err) => {
            eprintln!(
                "error: could not read script {}: {err}",
                script_path.display()
            );
            std::process::exit(2);
        }
    };
    let steps = parse_script(&script_src);
    if steps.is_empty() {
        eprintln!(
            "error: script {} contained no injectable turns (only comments / blanks)",
            script_path.display()
        );
        std::process::exit(2);
    }

    let mut cli = Cli::from_env();
    // Override chat id unconditionally so replay runs are isolated.
    // Callers who need a fixed id should edit this binary directly —
    // the whole point of scripted mode is reproducibility WITHOUT
    // polluting existing bindings.
    cli.source_chat_id = derive_chat_id(&script_path);
    print_banner(&cli);
    println!("Script:           {}", script_path.display());
    if let Some(ref tp) = transcript_path {
        println!("Transcript:       {}", tp.display());
    }
    println!();

    if let Err(err) = cli.arm().await {
        eprintln!("error: arm failed: {err}");
        eprintln!("hint: is the app running at {}?", cli.base_url);
        std::process::exit(1);
    }
    let _ = cli.drain(true).await;

    let mut transcript = TranscriptBuffer::new(&script_path, &cli);
    let total_user_turns = steps
        .iter()
        .filter(|s| matches!(s, ScriptStep::User(_)))
        .count();
    let mut idx = 0usize;

    for step in steps {
        match step {
            ScriptStep::Wait(dur) => {
                println!("-- @wait {:?} --", dur);
                transcript.add_note(&format!("@wait {}s", dur.as_secs()));
                sleep(dur).await;
            }
            ScriptStep::User(content) => {
                idx += 1;
                println!("[{idx}/{total_user_turns}] you > {content}");
                transcript.add_user(&content);

                if let Err(err) = cli.inject(&content).await {
                    eprintln!("[inject failed: {err}]");
                    transcript.add_error(&format!("inject failed: {err}"));
                    continue;
                }

                sleep(INITIAL_REPLY_GRACE).await;
                let replies = collect_replies(&cli).await;
                for r in &replies {
                    render_reply(r);
                    transcript.add_gateway(r);
                }
                if replies.is_empty() {
                    transcript.add_error("no outbound captured (timeout)");
                }
            }
        }
    }

    println!();
    cli.disarm().await;

    if let Some(path) = transcript_path {
        if let Err(err) = transcript.write(&path) {
            eprintln!(
                "warn: failed to save transcript to {}: {err}",
                path.display()
            );
        } else {
            println!("Transcript saved -> {}", path.display());
        }
    }
    println!("done.");
}

async fn collect_replies(cli: &Cli) -> Vec<ReplyMessage> {
    let start = Instant::now();
    let mut collected: Vec<ReplyMessage> = Vec::new();
    loop {
        match cli.drain(true).await {
            Ok(msgs) => collected.extend(msgs),
            Err(err) => {
                eprintln!("[drain failed: {err}]");
                break;
            }
        }
        if !collected.is_empty()
            && Instant::now().duration_since(start) > Duration::from_millis(1200)
        {
            break;
        }
        if Instant::now().duration_since(start) >= REPLY_TIMEOUT {
            if collected.is_empty() {
                eprintln!("[timeout after {:?} — no outbound captured]", REPLY_TIMEOUT);
            }
            break;
        }
        sleep(REPLY_POLL_INTERVAL).await;
    }
    collected
}

/// In-memory markdown transcript built up as the scripted run progresses.
///
/// Kept purposefully simple: one file per run, header with provenance,
/// then alternating `## you` / `## gateway` sections. Good enough for
/// human review; trivially diff-able across re-runs.
struct TranscriptBuffer {
    header: String,
    body: String,
}

impl TranscriptBuffer {
    fn new(script_path: &Path, cli: &Cli) -> Self {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let header = format!(
            "# Gateway dogfood transcript\n\n\
             - Script: `{}`\n\
             - Target: `{}`\n\
             - Source chat: `{}` / `{}`\n\
             - Unix ts: `{ts}`\n\n---\n\n",
            script_path.display(),
            cli.base_url,
            cli.source_channel,
            cli.source_chat_id,
        );
        Self {
            header,
            body: String::new(),
        }
    }

    fn add_user(&mut self, content: &str) {
        self.body.push_str("## you\n\n");
        for line in content.lines() {
            self.body.push_str("> ");
            self.body.push_str(line);
            self.body.push('\n');
        }
        self.body.push('\n');
    }

    fn add_gateway(&mut self, msg: &ReplyMessage) {
        self.body
            .push_str(&format!("## gateway → {}/{}\n\n", msg.channel, msg.chat_id));
        self.body.push_str(&msg.content);
        if !msg.content.ends_with('\n') {
            self.body.push('\n');
        }
        self.body.push('\n');
    }

    fn add_note(&mut self, note: &str) {
        self.body.push_str(&format!("_note: {note}_\n\n"));
    }

    fn add_error(&mut self, err: &str) {
        self.body.push_str(&format!("_**error**: {err}_\n\n"));
    }

    fn write(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = self.header.clone();
        out.push_str(&self.body);
        fs::write(path, out)
    }
}

#[cfg(test)]
mod script_parse_tests {
    use super::{parse_script, ScriptStep};

    #[test]
    fn header_before_separator_is_ignored() {
        let src = "# Scenario: foo\n\nA user does X. Probes Y.\nAnother prose line.\n\n# === turn-by-turn ===\n\nhi\n\n@wait 2\n\nnext turn\n";
        let steps = parse_script(src);
        let users: Vec<&str> = steps
            .iter()
            .filter_map(|s| match s {
                ScriptStep::User(u) => Some(u.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(users, vec!["hi", "next turn"]);
    }

    #[test]
    fn missing_separator_falls_back_to_whole_file() {
        let src = "# comment\nhello\nworld\n";
        let steps = parse_script(src);
        let users: Vec<&str> = steps
            .iter()
            .filter_map(|s| match s {
                ScriptStep::User(u) => Some(u.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(users, vec!["hello", "world"]);
    }

    #[test]
    fn comments_and_blank_lines_ignored_after_separator() {
        let src = "# === turn-by-turn ===\n\n# this is a comment\n\nactual user line\n# another comment\n";
        let steps = parse_script(src);
        assert_eq!(steps.len(), 1);
    }
}
