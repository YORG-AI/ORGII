//! Command handlers: one function per subcommand (`sources`, `plugins`, `scan`,
//! `list`/`search`, `usage`, `show`) plus their table/markdown/CSV renderers.

use core_types::activity::ActivityChunk;
use rusqlite::Connection;

use orgtrack_core::session_usage;
use orgtrack_core::sources::registry;
use orgtrack_core::usage_dashboard::{
    self, TrendBucket, UsageFilter, UsageRoundQuery, UsageSessionRow, UsageSummary,
};

use crate::output::chunk_body;
use crate::output::{
    csv_row, formatter_for, md_cell, parse_sort, preview_of, print_usage_session_row,
    print_usage_summary, render_template, row_matches, session_label, to_json, truncate,
};
use crate::plugin_exec::{
    apply_chunk_processors, apply_session_processors, load_session_chunks, source_of_session,
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

    let summary = usage_dashboard::usage_summary(&conn, &filter)?;
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
        false,
        true,
        false,
    )?;

    if let Some(formatter) = formatter_for(opts, formatters) {
        let context = serde_json::json!({
            "command": "usage",
            "summary": summary,
            "sessions": sessions,
            "trends": overview.trends,
        });
        return render_template(formatter, &context);
    }
    match opts.format()? {
        Format::Json => println!(
            "{}",
            to_json(&serde_json::json!({
                "summary": summary,
                "sessions": sessions,
                "trends": overview.trends,
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
    let conn = open_conn(&target.path)?;
    let chunks =
        load_session_chunks(&conn, &session_id, plugins, opts.timeout())?.ok_or_else(|| {
            format!("'{session_id}' is not a known imported session id (nothing to show)")
        })?;
    // Chunk-stage processors reshape the conversation before rendering.
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

/// Portable markdown transcript of a session — the export format. Message
/// bodies render as prose; tool calls render as fenced code so a transcript
/// round-trips into any markdown viewer.
pub(crate) fn render_show_md(session_id: &str, chunks: &[ActivityChunk]) -> String {
    let mut out = format!("# Session {session_id}\n\n");
    for chunk in chunks {
        let role = chunk_role(chunk);
        out.push_str(&format!(
            "**{role}** · {}\n\n",
            truncate(&chunk.created_at, 19)
        ));
        let body = chunk_body(&chunk.args).or_else(|| chunk_body(&chunk.result));
        match body {
            Some(text) if chunk.action_type == "tool_call" => {
                out.push_str(&format!("```\n{}\n```\n\n", text.trim_end()))
            }
            Some(text) => out.push_str(&format!("{}\n\n", text.trim_end())),
            None => out.push_str("_(no content)_\n\n"),
        }
    }
    out
}

pub(crate) fn render_show_csv(chunks: &[ActivityChunk]) -> String {
    let mut out = String::from("created_at,role,action_type,function,preview\n");
    for chunk in chunks {
        let preview = preview_of(&chunk.args)
            .or_else(|| preview_of(&chunk.result))
            .unwrap_or_default();
        out.push_str(&csv_row(&[
            &chunk.created_at,
            &chunk_role(chunk),
            &chunk.action_type,
            &chunk.function,
            &preview,
        ]));
    }
    out
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
