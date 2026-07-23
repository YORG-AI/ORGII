//! Command handlers: one function per subcommand (`sources`, `plugins`, `scan`,
//! `list`/`search`, `usage`, `show`) plus their table/markdown/CSV renderers.

use std::io::{self, Write};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;

use orgtrack_core::session_usage;
use orgtrack_core::sources::imported_history::{
    replay::{
        self, ImportedHistorySourceId, ReplayCursor, ReplayIndexedChunk, ReplayLimits,
        ReplayPayloadDescriptor, ReplayPayloadRange,
    },
    router as replay_router,
};
use orgtrack_core::sources::registry;
use orgtrack_core::usage_dashboard::{
    self, TrendBucket, UsageFilter, UsageRoundQuery, UsageSessionRow, UsageSummary,
};

use crate::output::{
    chunk_body, csv_row, formatter_for, md_cell, parse_sort, preview_of, print_usage_session_row,
    print_usage_summary, render_template, row_matches, session_label, to_json, truncate,
};
use crate::plugin_exec::{
    apply_chunk_processors, apply_session_processors, load_plugin_session_chunks, source_of_session,
};
use crate::plugins::{self, FormatterPlugin, LoaderPlugin, ProcessorPlugin};
use crate::scan::{counts_by_source, read_cached, scan_all};
use crate::store::{count_usage_rows, db_target, open_conn};
use crate::triggers;
use crate::{Format, Options, ScannedRow, SCAN_PAGE};

pub(crate) fn cmd_sources(opts: &Options, plugins: &[LoaderPlugin]) -> Result<(), String> {
    let builtins = registry::registered_sources();
    if opts.json {
        let mut json: Vec<_> = builtins
            .iter()
            .map(|source| {
                serde_json::json!({ "id": source.id, "label": source.label, "kind": "builtin" })
            })
            .collect();
        json.extend(plugins.iter().map(|plugin| {
            serde_json::json!({ "id": plugin.id, "label": plugin.label, "kind": "plugin" })
        }));
        println!("{}", to_json(&json)?);
        return Ok(());
    }
    println!("{:<14}  {:<8}  TOOL", "ID", "KIND");
    println!("{}", "-".repeat(48));
    for source in builtins {
        println!("{:<14}  {:<8}  {}", source.id, "built-in", source.label);
    }
    for plugin in plugins {
        println!("{:<14}  {:<8}  {}", plugin.id, "plugin", plugin.label);
    }
    println!(
        "\n{} tools ({} built-in, {} plugin).",
        builtins.len() + plugins.len(),
        builtins.len(),
        plugins.len()
    );
    Ok(())
}

/// `orgtrack plugins list|trust <id>` — inspect and trust plugins. `list`
/// surfaces broken manifests (with the reason) so they are visible, not silent;
/// `trust` pins an exec plugin's content hash so it may run.
pub(crate) fn cmd_plugins(opts: &Options, discovered: &plugins::Discovered) -> Result<(), String> {
    let subcommand = opts
        .positionals
        .first()
        .map(String::as_str)
        .unwrap_or("list");
    match subcommand {
        "list" => cmd_plugins_list(opts, discovered),
        "trust" => {
            let id = opts.positionals.get(1).ok_or(
                "`plugins trust` needs a plugin id, e.g. `orgtrack plugins trust my_agent`",
            )?;
            let hash = plugins::trust(id, discovered)?;
            println!("Trusted '{id}' (sha256 {}…).", &hash[..hash.len().min(12)]);
            Ok(())
        }
        other => Err(format!(
            "unknown `plugins` subcommand '{other}' (expected list or trust)"
        )),
    }
}

pub(crate) fn cmd_plugins_list(
    opts: &Options,
    discovered: &plugins::Discovered,
) -> Result<(), String> {
    if opts.json {
        println!(
            "{}",
            to_json(&serde_json::json!({
                "loaders": discovered.loaders.iter().map(|plugin| serde_json::json!({
                    "id": plugin.id,
                    "label": plugin.label,
                    "kind": plugin.kind_label(),
                    "trust": plugin.trust.label(),
                    "sessionPrefix": plugin.session_prefix,
                    "dir": plugin.manifest_dir.to_string_lossy(),
                })).collect::<Vec<_>>(),
                "processors": discovered.processors.iter().map(|plugin| serde_json::json!({
                    "id": plugin.id,
                    "label": plugin.label,
                    "kind": format!("processor ({})", plugin.stage.as_str()),
                    "trust": plugin.trust.label(),
                    "scope": plugin.scope,
                    "dir": plugin.manifest_dir.to_string_lossy(),
                })).collect::<Vec<_>>(),
                "formatters": discovered.formatters.iter().map(|plugin| serde_json::json!({
                    "id": plugin.id,
                    "label": plugin.label,
                    "kind": "formatter (template)",
                    "dir": plugin.manifest_dir.to_string_lossy(),
                })).collect::<Vec<_>>(),
                "hooks": discovered.hooks.iter().map(|plugin| serde_json::json!({
                    "id": plugin.id,
                    "label": plugin.label,
                    "kind": "hook (exec)",
                    "trust": plugin.trust.label(),
                    "on": plugin.on,
                    "dir": plugin.manifest_dir.to_string_lossy(),
                })).collect::<Vec<_>>(),
                "broken": discovered.broken.iter().map(|broken| serde_json::json!({
                    "dir": broken.dir.to_string_lossy(),
                    "error": broken.error,
                })).collect::<Vec<_>>(),
            }))?
        );
        return Ok(());
    }
    if discovered.loaders.is_empty()
        && discovered.processors.is_empty()
        && discovered.formatters.is_empty()
        && discovered.hooks.is_empty()
        && discovered.broken.is_empty()
    {
        println!("No plugins found. Drop a plugin.toml under ~/.orgtrack/plugins/<name>/");
        println!("or set $ORGTRACK_PLUGIN_PATH. See docs/orgtrack-plugins-design.md.");
        return Ok(());
    }
    for plugin in &discovered.loaders {
        println!(
            "{:<14}  {:<18}  {:<9}  prefix={:<10}  {}",
            plugin.id,
            plugin.kind_label(),
            plugin.trust.label(),
            plugin.session_prefix,
            plugin.manifest_dir.display()
        );
    }
    for plugin in &discovered.processors {
        println!(
            "{:<14}  {:<18}  {:<9}  scope={:<10}  {}",
            plugin.id,
            format!("processor ({})", plugin.stage.as_str()),
            plugin.trust.label(),
            plugin.scope.join(","),
            plugin.manifest_dir.display()
        );
    }
    for plugin in &discovered.formatters {
        println!(
            "{:<14}  {:<18}  {:<9}  {}",
            plugin.id,
            "formatter (tmpl)",
            "-",
            plugin.manifest_dir.display()
        );
    }
    for plugin in &discovered.hooks {
        let on = if plugin.on.is_empty() {
            "any".to_string()
        } else {
            plugin.on.join(",")
        };
        println!(
            "{:<14}  {:<18}  {:<9}  on={:<10}  {}",
            plugin.id,
            "hook (exec)",
            plugin.trust.label(),
            on,
            plugin.manifest_dir.display()
        );
    }
    for broken in &discovered.broken {
        println!("{}  INVALID  {}", broken.dir.display(), broken.error);
    }
    Ok(())
}

pub(crate) fn cmd_scan(opts: &Options, plugins: &[LoaderPlugin]) -> Result<(), String> {
    let target = db_target(opts)?;
    let scanned = scan_all(&target.path, opts, plugins);

    // Bridge the imported caches into the usage projection so a later `usage`
    // run against the same --db sees these sessions without rescanning. A
    // per-session recompute failure is non-fatal (and makes `backfill` return
    // Err even though it projected the rest), so report the real row count from
    // the table rather than the call's Ok/Err.
    let conn = open_conn(&target.path)?;
    if let Err(err) = session_usage::backfill_session_usage(&conn, SCAN_PAGE) {
        eprintln!("orgtrack: some sessions could not be projected ({err})");
    }
    let projected = count_usage_rows(&conn);

    if opts.json {
        println!(
            "{}",
            to_json(&serde_json::json!({
                "indexed": scanned.len(),
                "projected": projected,
                "bySource": counts_by_source(&scanned),
                "db": opts.db.clone().unwrap_or_else(|| ":memory:".into()),
            }))?
        );
        return Ok(());
    }

    println!(
        "\nIndexed {} sessions ({} with usage projected).",
        scanned.len(),
        projected
    );
    match &opts.db {
        Some(path) if path != ":memory:" => println!("Index written to {path}"),
        _ => println!("(in-memory index — pass --db <path> to persist)"),
    }
    Ok(())
}

pub(crate) fn cmd_list(
    opts: &Options,
    search: Option<String>,
    plugins: &[LoaderPlugin],
    processors: &[ProcessorPlugin],
    formatters: &[FormatterPlugin],
) -> Result<(), String> {
    let target = db_target(opts)?;
    let mut scanned = if opts.no_scan {
        let conn = open_conn(&target.path)?;
        read_cached(&conn, opts, plugins)?
    } else {
        scan_all(&target.path, opts, plugins)
    };

    // Session-stage processors reshape the rows before search/sort/display.
    scanned = apply_session_processors(scanned, processors, opts.timeout());

    // Cross-machine project filter: match the git-remote-derived slug or id.
    if let Some(project_query) = opts.project.as_ref().map(|value| value.to_lowercase()) {
        scanned.retain(|item| {
            let repo = item.row.repo_path.as_deref().unwrap_or("");
            crate::project::identify_cached(repo)
                .map(|project| {
                    project.slug.contains(&project_query) || project.id.contains(&project_query)
                })
                .unwrap_or(false)
        });
    }

    if let Some(query) = search.as_ref().map(|q| q.to_lowercase()) {
        scanned.retain(|item| row_matches(&item.row, &query));
    }
    // Newest first.
    scanned.sort_by(|a, b| b.row.updated_at.cmp(&a.row.updated_at));

    let limit = opts.limit.unwrap_or(50);
    let shown: Vec<&ScannedRow> = scanned.iter().take(limit).collect();

    if let Some(formatter) = formatter_for(opts, formatters) {
        let context = serde_json::json!({
            "command": "list",
            "sessions": list_rows_json(&shown),
            "total": scanned.len(),
        });
        return render_template(formatter, &context);
    }
    match opts.format()? {
        Format::Json => println!("{}", to_json(&list_rows_json(&shown))?),
        Format::Md => print!("{}", render_list_md(&shown)),
        Format::Csv => print!("{}", render_list_csv(&shown)),
        Format::Table => render_list_table(&shown, scanned.len()),
    }
    Ok(())
}

/// `search --content`: full-text search inside conversations (SQLite FTS5),
/// not just titles/paths. Refreshes the cache, incrementally (re)indexes only
/// changed sessions, then runs the ranked `MATCH` query with highlighted
/// snippets. Wants a persistent `--db` so the index survives between runs.
pub(crate) fn cmd_search_content(
    opts: &Options,
    query: &str,
    plugins: &[LoaderPlugin],
    formatters: &[FormatterPlugin],
) -> Result<(), String> {
    let target = db_target(opts)?;
    if target.temp {
        eprintln!(
            "orgtrack: content search re-indexes from scratch without --db; \
             pass --db <path> to persist the index and make repeat searches fast."
        );
    }
    if !opts.no_scan {
        scan_all(&target.path, opts, plugins);
    }
    let mut conn = open_conn(&target.path)?;
    crate::content_index::update(&mut conn, opts, plugins, opts.timeout())?;

    let limit = opts.limit.unwrap_or(50);
    let hits = crate::content_index::search(&conn, query, limit)?;
    let hits_json: Vec<serde_json::Value> = hits
        .iter()
        .map(|hit| {
            serde_json::json!({
                "sessionId": hit.session_id,
                "source": hit.source,
                "name": hit.name,
                "snippet": hit.snippet,
            })
        })
        .collect();

    if let Some(formatter) = formatter_for(opts, formatters) {
        let context = serde_json::json!({ "command": "search", "query": query, "hits": hits_json });
        return render_template(formatter, &context);
    }
    match opts.format()? {
        Format::Json => println!("{}", to_json(&hits_json)?),
        Format::Md => {
            print!("# orgtrack content search: {query}\n\n");
            for hit in &hits {
                println!(
                    "- **{}** ({}) — {}",
                    md_cell(&hit.name),
                    md_cell(&hit.source),
                    md_cell(&hit.snippet)
                );
            }
        }
        Format::Csv => {
            println!("source,name,snippet,session_id");
            for hit in &hits {
                print!(
                    "{}",
                    csv_row(&[&hit.source, &hit.name, &hit.snippet, &hit.session_id])
                );
            }
        }
        Format::Table => {
            if hits.is_empty() {
                println!("No content matches for '{query}'.");
                return Ok(());
            }
            println!("{:<12}  {:<32}  MATCH", "TOOL", "SESSION");
            println!("{}", "-".repeat(96));
            for hit in &hits {
                println!(
                    "{:<12}  {:<32}  {}",
                    truncate(&hit.source, 12),
                    truncate(&hit.name, 32),
                    truncate(&hit.snippet.replace('\n', " "), 46),
                );
            }
            println!("\n{} match(es).", hits.len());
        }
    }
    Ok(())
}

/// Session rows as JSON, each tagged with its `source`.
pub(crate) fn list_rows_json(shown: &[&ScannedRow]) -> Vec<serde_json::Value> {
    shown
        .iter()
        .map(|item| {
            let mut value = serde_json::to_value(&item.row).unwrap_or(serde_json::Value::Null);
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "source".into(),
                    serde_json::Value::String(item.source.clone()),
                );
                if let Some(project) =
                    crate::project::identify_cached(item.row.repo_path.as_deref().unwrap_or(""))
                {
                    object.insert("projectId".into(), serde_json::Value::String(project.id));
                    object.insert(
                        "projectSlug".into(),
                        serde_json::Value::String(project.slug),
                    );
                }
            }
            value
        })
        .collect()
}

pub(crate) fn render_list_table(shown: &[&ScannedRow], total: usize) {
    if shown.is_empty() {
        println!("No sessions found.");
        return;
    }
    println!(
        "{:<14}  {:<19}  {:<10}  {:>8}  {:>5}  SESSION",
        "TOOL", "UPDATED", "MODEL", "TOKENS", "FILES"
    );
    println!("{}", "-".repeat(96));
    for item in shown {
        let row = &item.row;
        println!(
            "{:<14}  {:<19}  {:<10}  {:>8}  {:>5}  {}",
            truncate(&item.source, 14),
            truncate(&row.updated_at, 19),
            truncate(row.model.as_deref().unwrap_or("-"), 10),
            row.total_tokens,
            row.files_changed,
            truncate(&session_label(row), 44),
        );
    }
    println!(
        "\n{} shown{}.",
        shown.len(),
        if total > shown.len() {
            format!(" of {total} (use --limit)")
        } else {
            String::new()
        }
    );
}

pub(crate) fn render_list_md(shown: &[&ScannedRow]) -> String {
    let mut out = String::from("# orgtrack sessions\n\n");
    out.push_str("| Tool | Updated | Model | Tokens | Files | Session | Repo |\n");
    out.push_str("|---|---|---|--:|--:|---|---|\n");
    for item in shown {
        let row = &item.row;
        out.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} |\n",
            md_cell(&item.source),
            md_cell(&row.updated_at),
            md_cell(row.model.as_deref().unwrap_or("-")),
            row.total_tokens,
            row.files_changed,
            md_cell(&row.name),
            md_cell(row.repo_name.as_deref().unwrap_or("")),
        ));
    }
    out
}

pub(crate) fn render_list_csv(shown: &[&ScannedRow]) -> String {
    let mut out = String::from(
        "source,updated_at,model,total_tokens,files_changed,name,repo_name,session_id\n",
    );
    for item in shown {
        let row = &item.row;
        out.push_str(&csv_row(&[
            &item.source,
            &row.updated_at,
            row.model.as_deref().unwrap_or(""),
            &row.total_tokens.to_string(),
            &row.files_changed.to_string(),
            &row.name,
            row.repo_name.as_deref().unwrap_or(""),
            &row.session_id,
        ]));
    }
    out
}

pub(crate) fn cmd_usage(
    opts: &Options,
    plugins: &[LoaderPlugin],
    formatters: &[FormatterPlugin],
) -> Result<(), String> {
    let target = db_target(opts)?;
    if !opts.no_scan {
        scan_all(&target.path, opts, plugins);
    }
    let conn = open_conn(&target.path)?;
    // Non-fatal: analytics should still render on whatever is already
    // projected even if a transient lock (e.g. an abandoned scan worker)
    // interrupts the bridge.
    if let Err(err) = session_usage::backfill_session_usage(&conn, SCAN_PAGE) {
        eprintln!("orgtrack: usage projection incomplete ({err})");
    }

    // The CLI reports usage across every source it indexed — long-tail
    // built-ins and plugins included — not just the dashboard's four buckets.
    let filter = UsageFilter {
        all_sources: true,
        ..UsageFilter::default()
    };
    let sort = parse_sort(opts.sort.as_deref())?;
    let limit = opts.limit.unwrap_or(50);

    let sessions = usage_dashboard::usage_sessions(&conn, &filter, sort, 0, limit)?;
    // Trend series (daily) is computed for JSON consumers; the table view
    // shows the headline + per-session rows.
    let overview = usage_dashboard::usage_overview(
        &conn,
        &filter,
        &UsageRoundQuery::default(),
        sort,
        0,
        limit,
        TrendBucket::Day,
        true,
        true,
        false,
    )?;
    let summary = overview.summary;
    let trends = overview.trends;

    if let Some(formatter) = formatter_for(opts, formatters) {
        let context = serde_json::json!({
            "command": "usage",
            "summary": summary,
            "sessions": sessions,
            "trends": trends,
        });
        return render_template(formatter, &context);
    }
    match opts.format()? {
        Format::Json => println!(
            "{}",
            to_json(&serde_json::json!({
                "summary": summary,
                "sessions": sessions,
                "trends": trends,
            }))?
        ),
        Format::Md => print!("{}", render_usage_md(&summary, &sessions)),
        Format::Csv => print!("{}", render_usage_csv(&sessions)),
        Format::Table => {
            print_usage_summary(&summary);
            if sessions.is_empty() {
                println!("\nNo per-session usage rows (no token-bearing sessions found).");
                return Ok(());
            }
            println!(
                "\n{:<12}  {:<10}  {:>10}  {:>9}  SESSION",
                "SOURCE", "MODEL", "TOKENS", "COST($)"
            );
            println!("{}", "-".repeat(88));
            for row in &sessions {
                print_usage_session_row(row);
            }
        }
    }
    Ok(())
}

pub(crate) fn render_usage_md(summary: &UsageSummary, sessions: &[UsageSessionRow]) -> String {
    let mut out = String::from("# orgtrack usage\n\n");
    out.push_str(&format!(
        "- **sessions:** {}\n- **requests:** {}\n- **total tokens:** {}\n- **estimated cost:** ${:.2}\n- **cache hit rate:** {:.1}%\n\n",
        summary.session_count,
        summary.request_count,
        summary.real_total_tokens,
        summary.cost_usd,
        summary.cache_hit_rate * 100.0
    ));
    out.push_str("| Source | Model | Tokens | Cost ($) | Session |\n");
    out.push_str("|---|---|--:|--:|---|\n");
    for row in sessions {
        out.push_str(&format!(
            "| {} | {} | {} | {:.2} | {} |\n",
            md_cell(&row.source),
            md_cell(row.model.as_deref().unwrap_or("-")),
            row.real_total_tokens,
            row.cost_usd,
            md_cell(&row.name),
        ));
    }
    out
}

pub(crate) fn render_usage_csv(sessions: &[UsageSessionRow]) -> String {
    let mut out = String::from(
        "source,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd,name,session_id\n",
    );
    for row in sessions {
        out.push_str(&csv_row(&[
            &row.source,
            row.model.as_deref().unwrap_or(""),
            &row.input_tokens.to_string(),
            &row.output_tokens.to_string(),
            &row.cache_read_tokens.to_string(),
            &row.cache_write_tokens.to_string(),
            &row.real_total_tokens.to_string(),
            &format!("{:.4}", row.cost_usd),
            &row.name,
            &row.session_id,
        ]));
    }
    out
}

/// `orgtrack check`: evaluate usage/behavior triggers and compile the firings
/// into a report. Exits 2 if any `error` fired, 1 if `--strict` and any `warn`
/// fired, else 0 — so it composes with CI and cron.
pub(crate) fn cmd_check(
    opts: &Options,
    plugins: &[LoaderPlugin],
    formatters: &[FormatterPlugin],
    hooks: &[plugins::HookPlugin],
) -> Result<(), String> {
    let rules = load_triggers(opts)?;
    if rules.is_empty() {
        println!("No triggers configured.");
        println!(
            "Add rules to ~/.orgtrack/triggers.toml (or pass --triggers <path>). \
             See docs/orgtrack-triggers-design.md."
        );
        return Ok(());
    }

    let target = db_target(opts)?;
    if !opts.no_scan {
        scan_all(&target.path, opts, plugins);
    }
    let conn = open_conn(&target.path)?;
    if let Err(err) = session_usage::backfill_session_usage(&conn, SCAN_PAGE) {
        eprintln!("orgtrack: usage projection incomplete ({err})");
    }

    let filter = UsageFilter {
        all_sources: true,
        ..UsageFilter::default()
    };
    let mut sessions = usage_dashboard::usage_sessions(
        &conn,
        &filter,
        usage_dashboard::SessionSort::Recent,
        0,
        SCAN_PAGE,
    )?;
    if !opts.sources.is_empty() {
        sessions.retain(|row| opts.sources.iter().any(|source| source == &row.source));
    }

    let project_of = project_map(&conn);
    let firings = triggers::evaluate(&sessions, &project_of, &rules);

    render_check(opts, &firings, formatters)?;
    run_hooks(&firings, hooks, opts.timeout());
    std::process::exit(triggers::exit_code(&firings, opts.strict));
}

/// Invoke each trusted hook whose `on` severities intersect the fired ones,
/// passing the firings JSON on stdin. An untrusted or failing hook is a stderr
/// note, never fatal — the report and exit code stand on their own.
fn run_hooks(
    firings: &[triggers::Firing],
    hooks: &[plugins::HookPlugin],
    timeout: std::time::Duration,
) {
    if firings.is_empty() || hooks.is_empty() {
        return;
    }
    let payload = serde_json::json!({
        "firings": firings.iter().map(|firing| serde_json::json!({
            "trigger": firing.trigger_id,
            "severity": firing.severity.label(),
            "scope": firing.scope,
            "scopeKey": firing.scope_key,
            "actual": firing.actual,
            "limit": firing.limit,
            "message": firing.message,
        })).collect::<Vec<_>>(),
    })
    .to_string();
    let fired: std::collections::HashSet<&str> = firings
        .iter()
        .map(|firing| firing.severity.label())
        .collect();

    for hook in hooks {
        if !fired.iter().any(|severity| hook.wants(severity)) {
            continue;
        }
        if !hook.runnable() {
            eprintln!(
                "orgtrack: hook '{}' is untrusted — skipped (run `orgtrack plugins trust {}`)",
                hook.id, hook.id
            );
            continue;
        }
        match crate::plugin_exec::run_hook(&hook.spec, &payload, timeout) {
            Ok(()) => eprintln!("orgtrack: hook '{}' ran", hook.id),
            Err(err) => eprintln!("orgtrack: hook '{}' failed ({err})", hook.id),
        }
    }
}

/// Load trigger rules from `--triggers <path>` or `~/.orgtrack/triggers.toml`.
fn load_triggers(opts: &Options) -> Result<Vec<triggers::Trigger>, String> {
    let (path, explicit) = match &opts.triggers {
        Some(path) => (std::path::PathBuf::from(path), true),
        None => match std::env::var_os("HOME") {
            Some(home) => (
                std::path::Path::new(&home).join(".orgtrack/triggers.toml"),
                false,
            ),
            None => return Ok(Vec::new()),
        },
    };
    if !path.is_file() {
        if explicit {
            return Err(format!("triggers file not found: {}", path.display()));
        }
        return Ok(Vec::new());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|err| format!("read {}: {err}", path.display()))?;
    triggers::parse(&text)
}

/// `session_id → project slug`, for `scope = "project"` triggers.
fn project_map(conn: &Connection) -> std::collections::BTreeMap<String, String> {
    let mut map = std::collections::BTreeMap::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, repo_path FROM imported_history_session_cache
         WHERE listable = 1 AND repo_path IS NOT NULL AND repo_path != ''",
    ) else {
        return map;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return map;
    };
    for (session_id, repo_path) in rows.flatten() {
        if let Some(project) = crate::project::identify_cached(&repo_path) {
            map.insert(session_id, project.slug);
        }
    }
    map
}

fn render_check(
    opts: &Options,
    firings: &[triggers::Firing],
    formatters: &[FormatterPlugin],
) -> Result<(), String> {
    let firings_json: Vec<serde_json::Value> = firings
        .iter()
        .map(|firing| {
            serde_json::json!({
                "trigger": firing.trigger_id,
                "severity": firing.severity.label(),
                "scope": firing.scope,
                "scopeKey": firing.scope_key,
                "op": firing.op.symbol(),
                "actual": firing.actual,
                "limit": firing.limit,
                "message": firing.message,
            })
        })
        .collect();

    if let Some(formatter) = formatter_for(opts, formatters) {
        let context = serde_json::json!({ "command": "check", "firings": firings_json });
        return render_template(formatter, &context);
    }
    match opts.format()? {
        Format::Json => println!("{}", to_json(&firings_json)?),
        Format::Md => {
            print!("# orgtrack triggers\n\n");
            if firings.is_empty() {
                println!("All triggers passed.");
            }
            for firing in firings {
                println!(
                    "- **{}** `{}` — {} {} {} ({}={}) — {}",
                    firing.severity.label(),
                    firing.trigger_id,
                    triggers::format_value(firing.actual, firing.is_ratio),
                    firing.op.symbol(),
                    triggers::format_value(firing.limit, firing.is_ratio),
                    firing.scope,
                    md_cell(&firing.scope_key),
                    md_cell(&firing.message),
                );
            }
        }
        Format::Csv => {
            println!("severity,trigger,scope,scope_key,actual,op,limit,message");
            for firing in firings {
                print!(
                    "{}",
                    csv_row(&[
                        firing.severity.label(),
                        &firing.trigger_id,
                        firing.scope,
                        &firing.scope_key,
                        &triggers::format_value(firing.actual, firing.is_ratio),
                        firing.op.symbol(),
                        &triggers::format_value(firing.limit, firing.is_ratio),
                        &firing.message,
                    ])
                );
            }
        }
        Format::Table => {
            if firings.is_empty() {
                println!("All triggers passed.");
                return Ok(());
            }
            println!(
                "{:<8}  {:<16}  {:<22}  {:>10}  {:<8}  MESSAGE",
                "SEVERITY", "TRIGGER", "SCOPE", "ACTUAL", "LIMIT"
            );
            println!("{}", "-".repeat(100));
            for firing in firings {
                println!(
                    "{:<8}  {:<16}  {:<22}  {:>10}  {:<8}  {}",
                    firing.severity.label(),
                    truncate(&firing.trigger_id, 16),
                    truncate(&format!("{}={}", firing.scope, firing.scope_key), 22),
                    triggers::format_value(firing.actual, firing.is_ratio),
                    format!(
                        "{} {}",
                        firing.op.symbol(),
                        triggers::format_value(firing.limit, firing.is_ratio)
                    ),
                    truncate(&firing.message, 40),
                );
            }
            let errors = firings
                .iter()
                .filter(|f| f.severity.label() == "error")
                .count();
            let warns = firings
                .iter()
                .filter(|f| f.severity.label() == "warn")
                .count();
            println!(
                "\n{} trigger(s) fired ({errors} error, {warns} warn).",
                firings.len()
            );
        }
    }
    Ok(())
}

pub(crate) fn cmd_show(
    opts: &Options,
    plugins: &[LoaderPlugin],
    processors: &[ProcessorPlugin],
    formatters: &[FormatterPlugin],
) -> Result<(), String> {
    let Some(session_id) = opts.positionals.first().cloned() else {
        return Err("show needs a session id, e.g. `orgtrack show claude_code-<uuid>`".into());
    };
    let target = db_target(opts)?;
    if !opts.no_scan {
        scan_all(&target.path, opts, plugins);
    }
    let mut conn = open_conn(&target.path)?;

    // Canonical built-in prefixes always take the compact replay path. A
    // third-party plugin cannot shadow one and accidentally re-enable a full
    // provider transcript load.
    if let Some(source) = replay_router::source_for_session(&session_id) {
        if let Some(formatter) = formatter_for(opts, formatters) {
            eprintln!(
                "orgtrack: custom show formatters receive bounded compact pages; deferred payloads remain previews"
            );
            return stream_builtin_show_template(
                &mut conn,
                &session_id,
                source.as_str(),
                opts,
                processors,
                formatter,
            );
        }
        return stream_builtin_show(&mut conn, &session_id, source, opts, processors);
    }

    // Plugin loaders are an explicit third-party compatibility boundary. They
    // may return a Vec because their protocol is a single JSON response, but no
    // built-in source can reach this branch.
    let chunks = load_plugin_session_chunks(&conn, &session_id, plugins, opts.timeout())?
        .ok_or_else(|| {
            format!("'{session_id}' is not a known imported session id (nothing to show)")
        })?;
    let source = source_of_session(&session_id, plugins);
    let chunks = apply_chunk_processors(&session_id, &source, chunks, processors, opts.timeout());

    if let Some(formatter) = formatter_for(opts, formatters) {
        let context = serde_json::json!({
            "command": "show",
            "sessionId": session_id,
            "chunks": chunks,
        });
        return render_template(formatter, &context);
    }
    match opts.format()? {
        Format::Json => println!("{}", to_json(&chunks)?),
        Format::Md => print!("{}", render_show_md(&session_id, &chunks)),
        Format::Csv => print!("{}", render_show_csv(&chunks)),
        Format::Table => {
            println!("Session {session_id} — {} activity chunks\n", chunks.len());
            for chunk in &chunks {
                let label = if chunk.function.is_empty() {
                    chunk.action_type.clone()
                } else {
                    format!("{}:{}", chunk.action_type, chunk.function)
                };
                println!("[{}] {}", truncate(&chunk.created_at, 19), label);
                if let Some(text) = preview_of(&chunk.args).or_else(|| preview_of(&chunk.result)) {
                    println!("    {}", truncate(&text, 160));
                }
            }
        }
    }
    Ok(())
}

const SHOW_PAGE_EVENTS: usize = 64;
const SHOW_PAGE_IPC_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct StreamedShowSummary {
    chunks: usize,
    has_more: bool,
}

/// Visit compact replay pages without ever dropping payload descriptors or
/// accumulating pages into a session-sized vector.
fn for_each_builtin_indexed_show_page(
    conn: &mut Connection,
    session_id: &str,
    max_chunks: usize,
    mut visit: impl FnMut(
        &mut Connection,
        usize,
        &ReplayCursor,
        bool,
        &[ReplayIndexedChunk],
    ) -> Result<(), String>,
) -> Result<StreamedShowSummary, String> {
    let mut cursor: Option<ReplayCursor> = None;
    let mut page_index = 0usize;
    let mut consumed = 0usize;
    let mut has_more = false;

    while consumed < max_chunks {
        let previous_sequence = cursor.as_ref().map_or(-1, |cursor| cursor.through_sequence);
        let remaining = max_chunks.saturating_sub(consumed);
        let limits = ReplayLimits {
            max_turns: replay::HARD_MAX_TURNS,
            max_events: remaining.min(SHOW_PAGE_EVENTS).max(1),
            max_ipc_bytes: SHOW_PAGE_IPC_BYTES,
        };
        let scan = replay_router::scan_activity_chunks_for_session(
            conn,
            session_id,
            cursor.as_ref(),
            limits,
        )?
        .ok_or_else(|| format!("Unknown built-in imported session id: {session_id}"))?;
        if scan.chunks.is_empty()
            && scan.has_more
            && scan.cursor.through_sequence <= previous_sequence
        {
            return Err(format!(
                "Bounded replay scan made no progress for {session_id} after sequence {}",
                scan.cursor.through_sequence
            ));
        }

        let raw_count = scan.chunks.len();
        let scan_has_more = scan.has_more;
        let scan_cursor = scan.cursor;
        if raw_count > 0 || (!scan_has_more && page_index == 0) {
            visit(conn, page_index, &scan_cursor, scan_has_more, &scan.chunks)?;
        }

        consumed = consumed.saturating_add(raw_count);
        has_more = scan_has_more;
        cursor = Some(scan_cursor);
        page_index = page_index.saturating_add(1);
        if !has_more {
            break;
        }
    }

    Ok(StreamedShowSummary {
        chunks: consumed,
        has_more,
    })
}

/// Third-party processors still speak the historical `Vec<ActivityChunk>`
/// protocol. Keep that compatibility boundary page-bounded and prevent it
/// from becoming a built-in provider loader fallback.
fn for_each_builtin_processed_show_page(
    conn: &mut Connection,
    session_id: &str,
    source: &str,
    processors: &[ProcessorPlugin],
    timeout: std::time::Duration,
    max_chunks: usize,
    mut visit: impl FnMut(usize, &ReplayCursor, bool, &[ActivityChunk]) -> Result<(), String>,
) -> Result<StreamedShowSummary, String> {
    for_each_builtin_indexed_show_page(
        conn,
        session_id,
        max_chunks,
        |_conn, page_index, cursor, has_more, indexed| {
            let chunks = indexed
                .iter()
                .map(|indexed| indexed.chunk.clone())
                .collect::<Vec<_>>();
            let chunks = apply_chunk_processors(session_id, source, chunks, processors, timeout);
            visit(page_index, cursor, has_more, &chunks)
        },
    )
}

fn stream_builtin_show_template(
    conn: &mut Connection,
    session_id: &str,
    source: &str,
    opts: &Options,
    processors: &[ProcessorPlugin],
    formatter: &FormatterPlugin,
) -> Result<(), String> {
    let max_chunks = opts.limit.unwrap_or(usize::MAX);
    for_each_builtin_processed_show_page(
        conn,
        session_id,
        source,
        processors,
        opts.timeout(),
        max_chunks,
        |page_index, cursor, has_more, chunks| {
            let context = serde_json::json!({
                "command": "show",
                "sessionId": session_id,
                "chunks": chunks,
                "page": {
                    "index": page_index,
                    "hasMore": has_more,
                    "generation": &cursor.generation,
                    "revision": cursor.revision,
                    "throughSequence": cursor.through_sequence,
                },
            });
            render_template(formatter, &context)
        },
    )?;
    Ok(())
}

fn stream_builtin_show(
    conn: &mut Connection,
    session_id: &str,
    source: ImportedHistorySourceId,
    opts: &Options,
    processors: &[ProcessorPlugin],
) -> Result<(), String> {
    let format = opts.format()?;
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    match format {
        Format::Json => out.write_all(b"[\n").map_err(show_write_error)?,
        Format::Md => writeln!(out, "# Session {session_id}\n").map_err(show_write_error)?,
        Format::Csv => out
            .write_all(b"created_at,role,action_type,function,preview\n")
            .map_err(show_write_error)?,
        Format::Table => writeln!(out, "Session {session_id} — streaming activity chunks\n")
            .map_err(show_write_error)?,
    }

    let mut wrote_json_chunk = false;
    let max_chunks = opts.limit.unwrap_or(usize::MAX);
    let summary = if processors.is_empty() {
        for_each_builtin_indexed_show_page(
            conn,
            session_id,
            max_chunks,
            |conn, _page_index, cursor, _has_more, chunks| {
                for indexed in chunks {
                    if format == Format::Json && wrote_json_chunk {
                        out.write_all(b",\n").map_err(show_write_error)?;
                    }
                    write_indexed_show_chunk(
                        conn,
                        &mut out,
                        source,
                        session_id,
                        &cursor.generation,
                        format,
                        indexed,
                    )?;
                    wrote_json_chunk |= format == Format::Json;
                }
                Ok(())
            },
        )?
    } else {
        eprintln!(
            "orgtrack: custom chunk processors receive bounded compact pages; deferred payloads remain previews"
        );
        for_each_builtin_processed_show_page(
            conn,
            session_id,
            source.as_str(),
            processors,
            opts.timeout(),
            max_chunks,
            |_page_index, _cursor, _has_more, chunks| {
                for chunk in chunks {
                    if format == Format::Json && wrote_json_chunk {
                        out.write_all(b",\n").map_err(show_write_error)?;
                    }
                    write_processed_show_chunk(&mut out, format, chunk)?;
                    wrote_json_chunk |= format == Format::Json;
                }
                Ok(())
            },
        )?
    };

    match format {
        Format::Json => out.write_all(b"\n]\n").map_err(show_write_error)?,
        Format::Table => {
            writeln!(out, "\n{} activity chunks shown.", summary.chunks)
                .map_err(show_write_error)?;
        }
        Format::Md | Format::Csv => {}
    }
    out.flush().map_err(show_write_error)?;
    if summary.has_more {
        eprintln!(
            "orgtrack: output stopped at --limit {} (more activity is available)",
            opts.limit.unwrap_or(summary.chunks)
        );
    }
    Ok(())
}

fn write_processed_show_chunk(
    writer: &mut impl Write,
    format: Format,
    chunk: &ActivityChunk,
) -> Result<(), String> {
    match format {
        Format::Json => {
            serde_json::to_writer(writer, chunk).map_err(|err| format!("json encode: {err}"))
        }
        Format::Md => writer
            .write_all(render_show_md_chunk(chunk).as_bytes())
            .map_err(show_write_error),
        Format::Csv => writer
            .write_all(render_show_csv_chunk(chunk).as_bytes())
            .map_err(show_write_error),
        Format::Table => write_show_table_chunk(writer, chunk),
    }
}

#[allow(clippy::too_many_arguments)]
fn write_indexed_show_chunk(
    conn: &mut Connection,
    writer: &mut impl Write,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    format: Format,
    indexed: &ReplayIndexedChunk,
) -> Result<(), String> {
    if format == Format::Table {
        return write_show_table_chunk(writer, &indexed.chunk);
    }
    let mut read_range = |field_path: &str, offset: u64, max_bytes: usize| {
        replay::read_payload_range(
            conn,
            source,
            session_id,
            generation,
            &indexed.chunk.chunk_id,
            field_path,
            offset,
            Some(max_bytes),
        )
    };
    match format {
        Format::Json => write_indexed_chunk_json_with_reader(writer, indexed, &mut read_range),
        Format::Md => write_indexed_chunk_md_with_reader(writer, indexed, &mut read_range),
        Format::Csv => write_indexed_chunk_csv_with_reader(writer, indexed, &mut read_range),
        Format::Table => unreachable!("table returned before opening a payload reader"),
    }
}

fn write_indexed_chunk_json_with_reader<W, R>(
    writer: &mut W,
    indexed: &ReplayIndexedChunk,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    let chunk = &indexed.chunk;
    writer
        .write_all(b"{\"chunk_id\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.chunk_id)?;
    writer
        .write_all(b",\"session_id\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.session_id)?;
    writer
        .write_all(b",\"action_type\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.action_type)?;
    writer
        .write_all(b",\"function\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.function)?;
    writer.write_all(b",\"args\":").map_err(show_write_error)?;
    write_replay_json_value_with_reader(
        writer,
        "args",
        &chunk.args,
        &indexed.payloads,
        read_range,
    )?;
    writer
        .write_all(b",\"result\":")
        .map_err(show_write_error)?;
    write_replay_json_value_with_reader(
        writer,
        "result",
        &chunk.result,
        &indexed.payloads,
        read_range,
    )?;
    writer
        .write_all(b",\"created_at\":")
        .map_err(show_write_error)?;
    write_small_json(writer, &chunk.created_at)?;
    if let Some(thread_id) = &chunk.thread_id {
        writer
            .write_all(b",\"thread_id\":")
            .map_err(show_write_error)?;
        write_small_json(writer, thread_id)?;
    }
    if let Some(process_id) = &chunk.process_id {
        writer
            .write_all(b",\"process_id\":")
            .map_err(show_write_error)?;
        write_small_json(writer, process_id)?;
    }
    writer.write_all(b"}").map_err(show_write_error)
}

fn write_small_json(writer: &mut impl Write, value: &impl serde::Serialize) -> Result<(), String> {
    serde_json::to_writer(writer, value).map_err(|err| format!("json encode: {err}"))
}

fn write_replay_json_value_with_reader<W, R>(
    writer: &mut W,
    path: &str,
    value: &serde_json::Value,
    payloads: &[ReplayPayloadDescriptor],
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    if let Some(payload) = payloads.iter().find(|payload| payload.field_path == path) {
        return match payload.resolved_encoding() {
            replay::ReplayPayloadEncoding::JsonValue => {
                stream_payload_with_reader(writer, path, false, read_range)
            }
            replay::ReplayPayloadEncoding::Utf8Text => {
                writer.write_all(b"\"").map_err(show_write_error)?;
                stream_payload_with_reader(writer, path, true, read_range)?;
                writer.write_all(b"\"").map_err(show_write_error)
            }
            replay::ReplayPayloadEncoding::LegacyPathInferred => {
                unreachable!("resolved replay payload encoding cannot remain legacy")
            }
        };
    }

    match value {
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => write_small_json(writer, value),
        serde_json::Value::Array(values) => {
            writer.write_all(b"[").map_err(show_write_error)?;
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(show_write_error)?;
                }
                write_replay_json_value_with_reader(
                    writer,
                    &format!("{path}.{index}"),
                    value,
                    payloads,
                    read_range,
                )?;
            }
            writer.write_all(b"]").map_err(show_write_error)
        }
        serde_json::Value::Object(values) => {
            writer.write_all(b"{").map_err(show_write_error)?;
            let mut wrote_field = false;
            for (key, value) in values {
                if replay::is_compact_only_replay_field(key) {
                    continue;
                }
                if wrote_field {
                    writer.write_all(b",").map_err(show_write_error)?;
                }
                wrote_field = true;
                write_small_json(writer, key)?;
                writer.write_all(b":").map_err(show_write_error)?;
                write_replay_json_value_with_reader(
                    writer,
                    &format!("{path}.{key}"),
                    value,
                    payloads,
                    read_range,
                )?;
            }
            writer.write_all(b"}").map_err(show_write_error)
        }
    }
}

fn stream_payload_with_reader<W, R>(
    writer: &mut W,
    field_path: &str,
    escape_json_string: bool,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    let mut offset = 0u64;
    loop {
        let range = read_range(field_path, offset, replay::HARD_MAX_PAYLOAD_RANGE_BYTES)?;
        if range.field_path != field_path {
            return Err(format!(
                "Replay payload {field_path} returned mismatched path {}",
                range.field_path
            ));
        }
        if range.offset != offset {
            return Err(format!(
                "Replay payload {field_path} skipped from {offset} to {}",
                range.offset
            ));
        }
        if escape_json_string {
            write_json_string_content(writer, &range.text)?;
        } else {
            writer
                .write_all(range.text.as_bytes())
                .map_err(show_write_error)?;
        }
        if range.next_offset <= offset && !range.eof {
            return Err(format!(
                "Replay payload {field_path} made no progress at {offset}"
            ));
        }
        offset = range.next_offset;
        if range.eof {
            if offset != range.total_bytes {
                return Err(format!(
                    "Replay payload {field_path} ended at {offset}, expected {}",
                    range.total_bytes
                ));
            }
            break;
        }
    }
    Ok(())
}

fn write_json_string_content(writer: &mut impl Write, text: &str) -> Result<(), String> {
    for ch in text.chars() {
        match ch {
            '"' => writer.write_all(b"\\\"").map_err(show_write_error)?,
            '\\' => writer.write_all(b"\\\\").map_err(show_write_error)?,
            '\u{08}' => writer.write_all(b"\\b").map_err(show_write_error)?,
            '\u{0c}' => writer.write_all(b"\\f").map_err(show_write_error)?,
            '\n' => writer.write_all(b"\\n").map_err(show_write_error)?,
            '\r' => writer.write_all(b"\\r").map_err(show_write_error)?,
            '\t' => writer.write_all(b"\\t").map_err(show_write_error)?,
            control if control <= '\u{1f}' => {
                write!(writer, "\\u{:04x}", control as u32).map_err(show_write_error)?;
            }
            other => {
                let mut encoded = [0u8; 4];
                writer
                    .write_all(other.encode_utf8(&mut encoded).as_bytes())
                    .map_err(show_write_error)?;
            }
        }
    }
    Ok(())
}

enum ReplayBodySelection<'a> {
    Compact(String),
    Payload(&'a ReplayPayloadDescriptor),
    Projection(&'a replay::ReplayPayloadBodyProjection),
    CompactProjection(String),
}

fn select_replay_body(indexed: &ReplayIndexedChunk) -> Option<ReplayBodySelection<'_>> {
    select_replay_body_root(indexed, "args", &indexed.chunk.args)
        .or_else(|| select_replay_body_root(indexed, "result", &indexed.chunk.result))
}

fn select_replay_body_root<'a>(
    indexed: &'a ReplayIndexedChunk,
    root: &'static str,
    value: &'a serde_json::Value,
) -> Option<ReplayBodySelection<'a>> {
    let payloads = indexed
        .payloads
        .iter()
        .filter(|payload| payload_path_is_under(&payload.field_path, root))
        .collect::<Vec<_>>();
    if let Some(payload) = payloads.iter().find(|payload| payload.field_path == root) {
        if let Some(projection) = payload.body_projection.as_ref() {
            return Some(ReplayBodySelection::Projection(projection));
        }
        return chunk_body(value).map(ReplayBodySelection::CompactProjection);
    }

    let selected_path = selected_compact_body_path(value, root)?;
    if let Some(payload) = payloads
        .iter()
        .find(|payload| payload.field_path == selected_path)
    {
        return Some(ReplayBodySelection::Payload(payload));
    }
    if selected_path == root && !payloads.is_empty() {
        return chunk_body(value).map(ReplayBodySelection::CompactProjection);
    }
    chunk_body(value).map(ReplayBodySelection::Compact)
}

fn selected_compact_body_path(value: &serde_json::Value, root: &str) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => non_blank_path(text, root),
        serde_json::Value::Object(map) if map.is_empty() => None,
        serde_json::Value::Array(items) if items.is_empty() => None,
        serde_json::Value::Object(map) => {
            if let Some(text) = map
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| content.as_str())
            {
                if let Some(path) = non_blank_path(text, &format!("{root}.message.content")) {
                    return Some(path);
                }
            }
            for key in [
                "content",
                "text",
                "observation",
                "cmd",
                "command",
                "body",
                "summary",
                "prompt",
                "description",
            ] {
                if let Some(text) = map.get(key).and_then(|value| value.as_str()) {
                    if let Some(path) = non_blank_path(text, &format!("{root}.{key}")) {
                        return Some(path);
                    }
                }
            }
            Some(root.to_string())
        }
        _ => Some(root.to_string()),
    }
}

fn non_blank_path(text: &str, path: &str) -> Option<String> {
    (!text.trim().is_empty()).then(|| path.to_string())
}

fn payload_path_is_under(field_path: &str, root: &str) -> bool {
    field_path == root
        || field_path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn write_selected_replay_body<W, R>(
    writer: &mut W,
    selection: ReplayBodySelection<'_>,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    match selection {
        ReplayBodySelection::Compact(text) => {
            writer.write_all(text.as_bytes()).map_err(show_write_error)
        }
        ReplayBodySelection::Payload(payload) => {
            stream_payload_with_reader(writer, &payload.field_path, false, read_range)
        }
        ReplayBodySelection::Projection(projection) => {
            writer
                .write_all(projection.text.as_bytes())
                .map_err(show_write_error)?;
            if projection.truncated {
                writer
                    .write_all(REPLAY_BODY_TRUNCATED_NOTICE)
                    .map_err(show_write_error)?;
            }
            Ok(())
        }
        ReplayBodySelection::CompactProjection(text) => {
            writer
                .write_all(text.as_bytes())
                .map_err(show_write_error)?;
            writer
                .write_all(REPLAY_BODY_TRUNCATED_NOTICE)
                .map_err(show_write_error)
        }
    }
}

const REPLAY_BODY_TRUNCATED_NOTICE: &[u8] =
    b"\n... [large replay body truncated; use --format json or export for the full payload]";

fn write_indexed_chunk_md_with_reader<W, R>(
    writer: &mut W,
    indexed: &ReplayIndexedChunk,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    let chunk = &indexed.chunk;
    writeln!(
        writer,
        "**{}** · {}\n",
        chunk_role(chunk),
        truncate(&chunk.created_at, 19)
    )
    .map_err(show_write_error)?;
    let Some(selection) = select_replay_body(indexed) else {
        return writer
            .write_all(b"_(no content)_\n\n")
            .map_err(show_write_error);
    };
    if chunk.action_type == "tool_call" {
        writer.write_all(b"```\n").map_err(show_write_error)?;
        write_selected_replay_body(writer, selection, read_range)?;
        writer.write_all(b"\n```\n\n").map_err(show_write_error)
    } else {
        write_selected_replay_body(writer, selection, read_range)?;
        writer.write_all(b"\n\n").map_err(show_write_error)
    }
}

fn write_indexed_chunk_csv_with_reader<W, R>(
    writer: &mut W,
    indexed: &ReplayIndexedChunk,
    read_range: &mut R,
) -> Result<(), String>
where
    W: Write,
    R: FnMut(&str, u64, usize) -> Result<ReplayPayloadRange, String>,
{
    let chunk = &indexed.chunk;
    let role = chunk_role(chunk);
    for field in [
        chunk.created_at.as_str(),
        role.as_str(),
        chunk.action_type.as_str(),
        chunk.function.as_str(),
    ] {
        write_csv_field(writer, field)?;
        writer.write_all(b",").map_err(show_write_error)?;
    }
    writer.write_all(b"\"").map_err(show_write_error)?;
    if let Some(selection) = select_replay_body(indexed) {
        let mut csv_body = CsvBodyWriter { inner: writer };
        write_selected_replay_body(&mut csv_body, selection, read_range)?;
    }
    writer.write_all(b"\"\n").map_err(show_write_error)
}

fn write_csv_field(writer: &mut impl Write, field: &str) -> Result<(), String> {
    if field.contains([',', '"', '\n', '\r']) {
        writer.write_all(b"\"").map_err(show_write_error)?;
        let mut escaped = CsvBodyWriter { inner: writer };
        escaped
            .write_all(field.as_bytes())
            .map_err(show_write_error)?;
        writer.write_all(b"\"").map_err(show_write_error)
    } else {
        writer.write_all(field.as_bytes()).map_err(show_write_error)
    }
}

struct CsvBodyWriter<'a, W> {
    inner: &'a mut W,
}

impl<W: Write> Write for CsvBodyWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut start = 0usize;
        for (index, byte) in bytes.iter().enumerate() {
            let replacement = match byte {
                b'"' => Some(&b"\"\""[..]),
                b'\n' => Some(&b" "[..]),
                _ => None,
            };
            if let Some(replacement) = replacement {
                self.inner.write_all(&bytes[start..index])?;
                self.inner.write_all(replacement)?;
                start = index + 1;
            }
        }
        self.inner.write_all(&bytes[start..])?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn write_show_table_chunk(writer: &mut impl Write, chunk: &ActivityChunk) -> Result<(), String> {
    let label = if chunk.function.is_empty() {
        chunk.action_type.clone()
    } else {
        format!("{}:{}", chunk.action_type, chunk.function)
    };
    writeln!(writer, "[{}] {}", truncate(&chunk.created_at, 19), label)
        .map_err(show_write_error)?;
    if let Some(text) = preview_of(&chunk.args).or_else(|| preview_of(&chunk.result)) {
        writeln!(writer, "    {}", truncate(&text, 160)).map_err(show_write_error)?;
    }
    Ok(())
}

fn show_write_error(error: io::Error) -> String {
    format!("write show output: {error}")
}

/// Portable markdown transcript of a session — the export format. Message
/// bodies render as prose; tool calls render as fenced code so a transcript
/// round-trips into any markdown viewer.
pub(crate) fn render_show_md(session_id: &str, chunks: &[ActivityChunk]) -> String {
    let mut out = format!("# Session {session_id}\n\n");
    for chunk in chunks {
        out.push_str(&render_show_md_chunk(chunk));
    }
    out
}

fn render_show_md_chunk(chunk: &ActivityChunk) -> String {
    let role = chunk_role(chunk);
    let mut out = format!("**{role}** · {}\n\n", truncate(&chunk.created_at, 19));
    let body = chunk_body(&chunk.args).or_else(|| chunk_body(&chunk.result));
    match body {
        Some(text) if chunk.action_type == "tool_call" => {
            out.push_str(&format!("```\n{}\n```\n\n", text.trim_end()))
        }
        Some(text) => out.push_str(&format!("{}\n\n", text.trim_end())),
        None => out.push_str("_(no content)_\n\n"),
    }
    out
}

pub(crate) fn render_show_csv(chunks: &[ActivityChunk]) -> String {
    let mut out = String::from("created_at,role,action_type,function,preview\n");
    for chunk in chunks {
        out.push_str(&render_show_csv_chunk(chunk));
    }
    out
}

fn render_show_csv_chunk(chunk: &ActivityChunk) -> String {
    let preview = preview_of(&chunk.args)
        .or_else(|| preview_of(&chunk.result))
        .unwrap_or_default();
    csv_row(&[
        &chunk.created_at,
        &chunk_role(chunk),
        &chunk.action_type,
        &chunk.function,
        &preview,
    ])
}

/// Human role label for a chunk: `user`, `assistant`, `assistant (thinking)`,
/// or `tool: <name>`.
pub(crate) fn chunk_role(chunk: &ActivityChunk) -> String {
    match chunk.action_type.as_str() {
        "raw" if chunk.function.contains("user") => "user".to_string(),
        "assistant" => "assistant".to_string(),
        "thinking" => "assistant (thinking)".to_string(),
        "tool_call" => format!("tool: {}", chunk.function),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod show_stream_tests {
    use super::*;

    fn payload(
        field_path: &str,
        encoding: replay::ReplayPayloadEncoding,
        total_bytes: usize,
    ) -> ReplayPayloadDescriptor {
        ReplayPayloadDescriptor {
            field_path: field_path.to_string(),
            kind: replay::ReplayPayloadKind::ToolOutput,
            encoding,
            body_projection: None,
            spans: Vec::new(),
            total_bytes: total_bytes as u64,
            source_ordinal: None,
            source_key: None,
        }
    }

    fn range_for(
        text: &str,
        field_path: &str,
        offset: u64,
        max_bytes: usize,
    ) -> ReplayPayloadRange {
        let start = offset as usize;
        let end = (start + max_bytes).min(text.len());
        ReplayPayloadRange {
            event_id: "event-1".to_string(),
            field_path: field_path.to_string(),
            offset,
            next_offset: end as u64,
            eof: end == text.len(),
            total_bytes: text.len() as u64,
            text: text[start..end].to_string(),
        }
    }

    #[test]
    fn streamed_json_restores_root_and_nested_array_payloads() {
        let args_full = r#"{"command":"FULL_ROOT_COMMAND"}"#;
        let result_full = "FULL_NESTED_\"quoted\"\\path\nnext";
        let indexed = ReplayIndexedChunk {
            sequence: 7,
            turn_index: 2,
            chunk: ActivityChunk::new("codex-test", "tool_call", "shell")
                .with_args(serde_json::json!({
                    "command": "ARGS_TAIL_PREVIEW",
                    "_preview": "compact-only"
                }))
                .with_result(serde_json::json!({
                    "content": [{"text": "ARRAY_TAIL_PREVIEW", "kind": "text"}]
                })),
            payloads: vec![
                payload(
                    "args",
                    replay::ReplayPayloadEncoding::JsonValue,
                    args_full.len(),
                ),
                payload(
                    "result.content.0.text",
                    replay::ReplayPayloadEncoding::Utf8Text,
                    result_full.len(),
                ),
            ],
        };
        let mut offsets = Vec::new();
        let mut output = Vec::new();

        write_indexed_chunk_json_with_reader(
            &mut output,
            &indexed,
            &mut |field_path, offset, max_bytes| {
                offsets.push((field_path.to_string(), offset));
                let text = match field_path {
                    "args" => args_full,
                    "result.content.0.text" => result_full,
                    other => panic!("unexpected payload path {other}"),
                };
                Ok(range_for(text, field_path, offset, max_bytes))
            },
        )
        .expect("streamed JSON should rebuild both payload shapes");

        let value: serde_json::Value = serde_json::from_slice(&output).expect("valid JSON");
        assert_eq!(value["args"]["command"], "FULL_ROOT_COMMAND");
        assert!(value["args"].get("_preview").is_none());
        assert_eq!(value["result"]["content"][0]["text"], result_full);
        assert_eq!(value["result"]["content"][0]["kind"], "text");
        assert!(!String::from_utf8(output).unwrap().contains("TAIL_PREVIEW"));
        assert_eq!(
            offsets,
            vec![
                ("args".to_string(), 0),
                ("result.content.0.text".to_string(), 0)
            ]
        );
    }

    #[test]
    fn streamed_markdown_and_csv_use_canonical_payload_not_preview() {
        let canonical = "FULL,\"quoted\"\nsecond-line";
        let indexed = ReplayIndexedChunk {
            sequence: 1,
            turn_index: 0,
            chunk: ActivityChunk::new("claude_code-test", "assistant", "assistant")
                .with_result(serde_json::json!({"observation": "TAIL_PREVIEW"})),
            payloads: vec![payload(
                "result.observation",
                replay::ReplayPayloadEncoding::Utf8Text,
                canonical.len(),
            )],
        };
        let mut markdown = Vec::new();
        write_indexed_chunk_md_with_reader(
            &mut markdown,
            &indexed,
            &mut |field_path, offset, max_bytes| {
                Ok(range_for(canonical, field_path, offset, max_bytes))
            },
        )
        .expect("markdown payload should stream");
        let markdown = String::from_utf8(markdown).unwrap();
        assert!(markdown.contains(canonical));
        assert!(!markdown.contains("TAIL_PREVIEW"));

        let mut csv = Vec::new();
        write_indexed_chunk_csv_with_reader(
            &mut csv,
            &indexed,
            &mut |field_path, offset, max_bytes| {
                Ok(range_for(canonical, field_path, offset, max_bytes))
            },
        )
        .expect("CSV payload should stream");
        let csv = String::from_utf8(csv).unwrap();
        assert!(csv.contains("FULL,"));
        assert!(csv.contains("\"\"quoted\"\" second-line"));
        assert!(!csv.contains("TAIL_PREVIEW"));
    }

    #[test]
    fn root_body_projection_keeps_markdown_and_csv_bounded_without_payload_reads() {
        let mut descriptor = payload(
            "args",
            replay::ReplayPayloadEncoding::JsonValue,
            10 * 1024 * 1024,
        );
        descriptor.body_projection = Some(replay::ReplayPayloadBodyProjection {
            field_path: "args.command".to_string(),
            text: "cargo test --workspace".to_string(),
            truncated: true,
        });
        let indexed = ReplayIndexedChunk {
            sequence: 1,
            turn_index: 0,
            chunk: ActivityChunk::new("codex-test", "tool_call", "shell")
                .with_args(serde_json::json!({"command":"COMPACT_PREVIEW"})),
            payloads: vec![descriptor],
        };

        let mut markdown = Vec::new();
        write_indexed_chunk_md_with_reader(&mut markdown, &indexed, &mut |_, _, _| {
            panic!("bounded body projection must not hydrate the root payload")
        })
        .expect("projected markdown");
        let markdown = String::from_utf8(markdown).unwrap();
        assert!(markdown.contains("cargo test --workspace"));
        assert!(markdown.contains("large replay body truncated"));
        assert!(!markdown.contains("COMPACT_PREVIEW"));

        let mut csv = Vec::new();
        write_indexed_chunk_csv_with_reader(&mut csv, &indexed, &mut |_, _, _| {
            panic!("bounded body projection must not hydrate the root payload")
        })
        .expect("projected CSV");
        let csv = String::from_utf8(csv).unwrap();
        assert!(csv.contains("cargo test --workspace"));
        assert!(csv.contains("large replay body truncated"));
        assert!(!csv.contains("COMPACT_PREVIEW"));
    }

    #[test]
    fn explicit_encoding_not_path_shape_controls_json_reconstruction() {
        let canonical = r#"{"text":"FULL_OBJECT","kind":"text"}"#;
        let indexed = ReplayIndexedChunk {
            sequence: 1,
            turn_index: 0,
            chunk: ActivityChunk::new("codex-test", "assistant", "assistant")
                .with_result(serde_json::json!({"content":["COMPACT_PREVIEW"]})),
            payloads: vec![payload(
                "result.content.0",
                replay::ReplayPayloadEncoding::JsonValue,
                canonical.len(),
            )],
        };
        let mut output = Vec::new();
        write_indexed_chunk_json_with_reader(
            &mut output,
            &indexed,
            &mut |field_path, offset, max_bytes| {
                Ok(range_for(canonical, field_path, offset, max_bytes))
            },
        )
        .expect("nested JSON value payload");
        let restored: serde_json::Value = serde_json::from_slice(&output).expect("valid JSON");
        assert_eq!(restored["result"]["content"][0]["text"], "FULL_OBJECT");
        assert_eq!(restored["result"]["content"][0]["kind"], "text");
    }
}
