//! `orgtrack` — a standalone CLI over `orgtrack_core`.
//!
//! It loads AI coding-assistant sessions from every tool `orgtrack_core` knows
//! how to read (Claude Code, Codex, Cursor CLI/IDE, Cline, OpenCode, Warp,
//! Windsurf, Trae, Qoder, and more), indexes them into a local SQLite store,
//! and reports usage/cost analytics — all without the desktop app.
//!
//! The whole loading + analysis pipeline is core's, reached through three entry
//! points:
//!   1. [`registry::scan_source`] — discover + cache one provider's sessions.
//!   2. [`session_usage::backfill_session_usage`] — project cached sessions
//!      into the usage table the analytics layer reads.
//!   3. [`usage_dashboard`] / [`imported_history::load_activity_chunks_for_session`]
//!      — analyze and replay.
//!
//! This binary is only argument parsing, orchestration, and formatting.

use std::time::Duration;

use orgtrack_core::sources::imported_history::ImportedHistorySessionRow;

mod commands;
mod content_index;
mod output;
mod plugin_exec;
mod plugins;
mod project;
mod scan;
mod store;
mod triggers;

use crate::commands::{
    cmd_check, cmd_list, cmd_plugins, cmd_scan, cmd_search_content, cmd_show, cmd_sources, cmd_usage,
};
use crate::scan::validate_sources;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Page size handed to each provider scan. The loaders sync their *entire*
/// discovered set into the cache regardless of the window, so this only bounds
/// the rows read back into memory for listing — set high enough to cover any
/// realistic local history.
pub(crate) const SCAN_PAGE: usize = 1_000_000;

/// Default per-provider scan budget. Most providers finish in well under a
/// second; Cursor IDE re-reads a large local DB and can take ~15s. A provider
/// that exceeds this (a locked store, a pathological file) is abandoned so one
/// bad tool never hangs the whole scan.
const DEFAULT_TIMEOUT_SECS: u64 = 30;

const HELP: &str = "\
orgtrack — load and analyze AI coding-assistant sessions across tools

USAGE:
    orgtrack <command> [options]

COMMANDS:
    sources                 List every tool orgtrack can read
    scan                    Discover sessions from disk and index them
    list                    List indexed sessions (alias: ls, sessions)
    search <query>          Search sessions by name/repo/file/model, or add
                            --content for full-text search inside conversations
    usage                   Token & cost analytics (alias: stats)
    check                   Evaluate usage triggers; exit non-zero on error
    show <session-id>       Print a session's conversation/activity stream
    plugins list            Show discovered loader plugins
    plugins trust <id>      Trust an exec plugin so it may run
    help                    Show this help (alias: --help, -h)
    version                 Show version (alias: --version, -V)

OPTIONS:
    --source <id>           Restrict to one tool (repeatable). Default: all.
    --db <path>             SQLite index file. Default: a temp file, fresh each run.
    --limit <n>             Max rows to display (list/search/usage). Default: 50.
    --sort <recent|cost|tokens>   Sort for `usage`. Default: recent.
    --timeout <secs>        Per-tool scan budget; a tool that exceeds it is
                            skipped. Default: 30.
    --triggers <path>       Trigger rules for `check` (default ~/.orgtrack/triggers.toml).
    --strict                `check` exits non-zero on `warn`, not just `error`.
    --content               `search` inside conversations (FTS5); wants --db.
    --project <query>       Filter to a project (git-remote slug or id; stable
                            across machines). Shows in `list --json`.
    --no-scan               Skip disk scan; read an existing --db as-is.
    --no-plugins            Ignore discovered loader plugins.
    --format <fmt>          Output: table (default), json, md, csv, or a
                            formatter plugin id.
    --json                  Shorthand for --format json.

PLUGINS:
    Drop a plugin.toml under ~/.orgtrack/plugins/<name>/ (or a dir on
    $ORGTRACK_PLUGIN_PATH) to add a no-code JSONL loader. See
    docs/orgtrack-plugins-design.md.

EXAMPLES:
    orgtrack sources
    orgtrack scan --db ~/.orgtrack/index.db
    orgtrack list --source claude_code --limit 20
    orgtrack search auth --json
    orgtrack search \"rate limit\" --content --db ~/.orgtrack/index.db
    orgtrack list --project github.com/acme/app --db ~/.orgtrack/index.db
    orgtrack usage --sort cost --db ~/.orgtrack/index.db
    orgtrack list --format md > sessions.md
    orgtrack usage --format csv > usage.csv
    orgtrack show claude_code-4f1e... --format md > session.md
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(err) = run(&args) {
        eprintln!("orgtrack: {err}");
        std::process::exit(1);
    }
}

/// A session row tagged with the provider it came from (the row type itself
/// carries a `category`, not the stable source id, so we track it alongside).
pub(crate) struct ScannedRow {
    pub(crate) source: String,
    pub(crate) row: ImportedHistorySessionRow,
}

#[derive(Default)]
pub(crate) struct Options {
    pub(crate) positionals: Vec<String>,
    pub(crate) sources: Vec<String>,
    pub(crate) db: Option<String>,
    pub(crate) limit: Option<usize>,
    pub(crate) sort: Option<String>,
    pub(crate) timeout: Option<u64>,
    pub(crate) format: Option<String>,
    pub(crate) project: Option<String>,
    pub(crate) triggers: Option<String>,
    pub(crate) no_scan: bool,
    pub(crate) no_plugins: bool,
    pub(crate) content: bool,
    pub(crate) strict: bool,
    pub(crate) json: bool,
}

impl Options {
    pub(crate) fn timeout(&self) -> Duration {
        Duration::from_secs(self.timeout.unwrap_or(DEFAULT_TIMEOUT_SECS).max(1))
    }

    /// The output format. `--format` wins; `--json` is a shorthand; the default
    /// is a human table.
    pub(crate) fn format(&self) -> Result<Format, String> {
        match self.format.as_deref() {
            Some(name) => Format::parse(name),
            None if self.json => Ok(Format::Json),
            None => Ok(Format::Table),
        }
    }
}

/// Output renderer selected by `--format`. `table` and `json` are always
/// available; `md` / `csv` are the built-in export formats. Custom template /
/// exec formatters plug in here in a later phase.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Format {
    Table,
    Json,
    Md,
    Csv,
}

impl Format {
    pub(crate) fn parse(name: &str) -> Result<Self, String> {
        match name {
            "table" => Ok(Format::Table),
            "json" => Ok(Format::Json),
            "md" | "markdown" => Ok(Format::Md),
            "csv" => Ok(Format::Csv),
            other => Err(format!(
                "unknown --format '{other}' (expected table, json, md, or csv)"
            )),
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let Some(command) = args.first() else {
        print!("{HELP}");
        return Ok(());
    };

    match command.as_str() {
        "help" | "--help" | "-h" => {
            print!("{HELP}");
            Ok(())
        }
        "version" | "--version" | "-V" => {
            println!("orgtrack {VERSION}");
            Ok(())
        }
        other => {
            let opts = parse_options(&args[1..])?;
            let discovered = plugins::discover(!opts.no_plugins);
            validate_sources(&opts, &discovered.loaders)?;
            let loaders = &discovered.loaders;
            let processors = &discovered.processors;
            let formatters = &discovered.formatters;
            match other {
                "sources" => cmd_sources(&opts, loaders),
                "plugins" => cmd_plugins(&opts, &discovered),
                "scan" => cmd_scan(&opts, loaders),
                "list" | "ls" | "sessions" => cmd_list(&opts, None, loaders, processors, formatters),
                "search" => {
                    let query = opts.positionals.join(" ");
                    if query.trim().is_empty() {
                        return Err("search needs a query, e.g. `orgtrack search auth`".into());
                    }
                    if opts.content {
                        cmd_search_content(&opts, &query, loaders, formatters)
                    } else {
                        cmd_list(&opts, Some(query), loaders, processors, formatters)
                    }
                }
                "usage" | "stats" => cmd_usage(&opts, loaders, formatters),
                "check" => cmd_check(&opts, loaders, formatters, &discovered.hooks),
                "show" => cmd_show(&opts, loaders, processors, formatters),
                _ => Err(format!(
                    "unknown command '{other}'. Run `orgtrack help` for usage."
                )),
            }
        }
    }
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut opts = Options::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--json" => opts.json = true,
            "--no-scan" => opts.no_scan = true,
            "--no-plugins" => opts.no_plugins = true,
            "--source" => {
                opts.sources
                    .push(next_value(&mut iter, "--source")?.to_string());
            }
            "--db" => opts.db = Some(next_value(&mut iter, "--db")?.to_string()),
            "--limit" => {
                let raw = next_value(&mut iter, "--limit")?;
                opts.limit = Some(
                    raw.parse::<usize>()
                        .map_err(|_| format!("--limit expects a number, got '{raw}'"))?,
                );
            }
            "--sort" => opts.sort = Some(next_value(&mut iter, "--sort")?.to_string()),
            "--format" => opts.format = Some(next_value(&mut iter, "--format")?.to_string()),
            "--project" => opts.project = Some(next_value(&mut iter, "--project")?.to_string()),
            "--triggers" => opts.triggers = Some(next_value(&mut iter, "--triggers")?.to_string()),
            "--content" => opts.content = true,
            "--strict" => opts.strict = true,
            "--timeout" => {
                let raw = next_value(&mut iter, "--timeout")?;
                opts.timeout = Some(
                    raw.parse::<u64>()
                        .map_err(|_| format!("--timeout expects seconds, got '{raw}'"))?,
                );
            }
            flag if flag.starts_with("--") => {
                return Err(format!("unknown option '{flag}'"));
            }
            positional => opts.positionals.push(positional.to_string()),
        }
    }
    // `--source` is validated against built-ins ∪ plugins in `run`, once
    // plugins are discovered.
    Ok(opts)
}

fn next_value<'a>(
    iter: &mut std::slice::Iter<'a, String>,
    flag: &str,
) -> Result<&'a str, String> {
    iter.next()
        .map(String::as_str)
        .ok_or_else(|| format!("{flag} expects a value"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_parse_accepts_known_and_rejects_unknown() {
        assert!(matches!(Format::parse("table").unwrap(), Format::Table));
        assert!(matches!(Format::parse("json").unwrap(), Format::Json));
        assert!(matches!(Format::parse("md").unwrap(), Format::Md));
        assert!(matches!(Format::parse("markdown").unwrap(), Format::Md));
        assert!(matches!(Format::parse("csv").unwrap(), Format::Csv));
        assert!(Format::parse("xml").is_err());
    }
}
