//! Codex tool-argument normalization into canonical ORGII tool calls.

use serde_json::{json, Value};

use crate::sources::imported_history;

use super::impact::patch_file_path_from_line;

pub(crate) fn normalize_codex_tool_calls(raw_name: &str, args: Value) -> Vec<(String, Value)> {
    let key = normalize_tool_name_key(raw_name);
    match key.as_str() {
        key if is_codex_shell_tool_key(key) => {
            let shell_args = normalize_shell_args(args);
            if let Some(read_args) = read_file_arg_values_from_shell_args(&shell_args) {
                read_args
                    .into_iter()
                    .map(|args| (imported_history::FUNCTION_READ_FILE.to_string(), args))
                    .collect()
            } else if let Some(calls) = exploration_tool_calls_from_shell_args(&shell_args) {
                calls
            } else {
                vec![(
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    shell_args,
                )]
            }
        }
        "rg" | "ripgrep" | "grep" | "search" | "code_search" | "search_code"
        | "search_codebase" => vec![(
            imported_history::FUNCTION_CODE_SEARCH.to_string(),
            normalize_search_args(args),
        )],
        "web__run" | "web_run" | "web_search" => {
            vec![("web_search".to_string(), normalize_web_search_args(args))]
        }
        "write_stdin" => vec![(
            imported_history::FUNCTION_AWAIT_OUTPUT.to_string(),
            normalize_write_stdin_args(args),
        )],
        "spawn_agent" => vec![("subagent".to_string(), normalize_spawn_agent_args(args))],
        "send_message" | "followup_task" => normalize_agent_message_args(key.as_str(), args)
            .map(|args| vec![("org_send_message".to_string(), args)])
            .unwrap_or_default(),
        "cat" | "sed" | "head" | "tail" => {
            let shell_args = normalize_shell_args(args);
            if let Some(read_args) = read_file_args_from_shell_args(&shell_args) {
                vec![(imported_history::FUNCTION_READ_FILE.to_string(), read_args)]
            } else {
                vec![(
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    shell_args,
                )]
            }
        }
        "apply_patch" => vec![(
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_apply_patch_args(args),
        )],
        "edit" | "edit_file" | "write" | "write_file" | "create_file" => vec![(
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        )],
        _ => vec![(raw_name.to_string(), args)],
    }
}

fn normalize_spawn_agent_args(args: Value) -> Value {
    let task_name = args
        .get("task_name")
        .or_else(|| args.get("taskName"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let message = args
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut normalized = args.as_object().cloned().unwrap_or_default();
    normalized.insert("payload".to_string(), args);
    normalized
        .entry("description".to_string())
        .or_insert_with(|| Value::String(task_name.clone()));
    normalized
        .entry("task".to_string())
        .or_insert_with(|| Value::String(task_name));
    if !message.is_empty() && !is_encrypted_collaboration_text(&message) {
        normalized
            .entry("prompt".to_string())
            .or_insert_with(|| Value::String(message));
    }
    Value::Object(normalized)
}

fn normalize_agent_message_args(action: &str, args: Value) -> Option<Value> {
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let message = args
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    // Codex encrypts parent-side collaboration messages. Unlike the initial
    // spawn prompt, later interactions are not persisted as plaintext in the
    // child rollout, so rendering these calls would produce empty message
    // cards. Keep plaintext follow-ups, but omit unrecoverable placeholders.
    if message.is_empty() || is_encrypted_collaboration_text(&message) {
        return None;
    }
    let mut normalized = args.as_object().cloned().unwrap_or_default();
    normalized.insert("payload".to_string(), args);
    normalized.insert("kind".to_string(), Value::String("plain".to_string()));
    normalized.insert("action".to_string(), Value::String(action.to_string()));
    normalized
        .entry("recipient_member_id".to_string())
        .or_insert_with(|| Value::String(target));
    normalized
        .entry("text".to_string())
        .or_insert_with(|| Value::String(message.clone()));
    normalized
        .entry("summary".to_string())
        .or_insert_with(|| Value::String(message));
    Some(Value::Object(normalized))
}

fn is_encrypted_collaboration_text(value: &str) -> bool {
    // Codex collaboration messages are Fernet tokens in the parent rollout.
    // The child rollout contains a plaintext first user message, which the
    // session linker uses instead. Never surface the opaque token as a prompt.
    value.starts_with("gAAAAA") && value.len() >= 80
}

pub(super) fn is_codex_shell_tool_key(key: &str) -> bool {
    matches!(
        key,
        "shell"
            | "shell_command"
            | "exec_command"
            | "bash"
            | "terminal"
            | "terminal_command"
            | "run_shell"
            | "run_command"
            | "execute"
            | "exec"
    )
}

fn normalize_shell_args(args: Value) -> Value {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("cmd").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let cwd = args
        .get("cwd")
        .and_then(Value::as_str)
        .or_else(|| args.get("workdir").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    json!({
        "command": command.clone(),
        "cmd": command,
        "cwd": cwd.clone(),
        "workdir": cwd,
        "payload": args,
    })
}

fn normalize_write_stdin_args(args: Value) -> Value {
    let session_id = args
        .get("session_id")
        .or_else(|| args.get("sessionId"))
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .unwrap_or_default();
    let chars = args
        .get("chars")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let block_until_ms = args
        .get("yield_time_ms")
        .or_else(|| args.get("yield_time"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    json!({
        "command": "wait_for",
        "handle": session_id.clone(),
        "handles": [session_id.clone()],
        "session_id": session_id,
        "chars": chars,
        "block_until_ms": block_until_ms,
        "payload": args,
    })
}

fn normalize_apply_patch_args(args: Value) -> Value {
    let patch = args
        .get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("patch_text").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let file_path = first_apply_patch_file_path(&patch).unwrap_or_default();
    json!({
        "action": "apply_patch",
        "patch": patch.clone(),
        "patch_text": patch,
        "file_path": file_path.clone(),
        "target_file": file_path,
        "payload": args,
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    if args
        .get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("patch_text").and_then(Value::as_str))
        .is_some()
    {
        return normalize_apply_patch_args(args);
    }

    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .or_else(|| args.get("target_file").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let old_content = args
        .get("old_content")
        .and_then(Value::as_str)
        .or_else(|| args.get("old_str").and_then(Value::as_str))
        .or_else(|| args.get("old_string").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let new_content = args
        .get("new_content")
        .and_then(Value::as_str)
        .or_else(|| args.get("new_str").and_then(Value::as_str))
        .or_else(|| args.get("new_string").and_then(Value::as_str))
        .or_else(|| args.get("content").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();

    json!({
        "action": raw_name,
        "file_path": file_path.clone(),
        "target_file": file_path,
        "old_content": old_content.clone(),
        "new_content": new_content.clone(),
        "content": new_content,
        "payload": args,
    })
}

fn normalize_search_args(args: Value) -> Value {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .or_else(|| args.get("pattern").and_then(Value::as_str))
        .or_else(|| args.get("search_query").and_then(Value::as_str))
        .or_else(|| args.get("regex").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    json!({
        "action": "grep",
        "query": query.clone(),
        "pattern": query,
        "payload": args,
    })
}

pub(super) fn normalize_web_search_args(args: Value) -> Value {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .or_else(|| args.get("type").and_then(Value::as_str))
        .unwrap_or("search")
        .to_string();
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .or_else(|| args.get("search_query").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .or_else(|| (!url.is_empty()).then_some(url.as_str()))
        .or_else(|| (!pattern.is_empty()).then_some(pattern.as_str()))
        .unwrap_or_default()
        .to_string();
    let queries = args.get("queries").cloned().unwrap_or_else(|| json!([]));
    json!({
        "action": action,
        "query": query,
        "queries": queries,
        "url": url,
        "pattern": pattern,
        "payload": args,
    })
}

fn read_file_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    read_file_arg_values_from_shell_args(shell_args)?
        .into_iter()
        .next()
}

fn read_file_arg_values_from_shell_args(shell_args: &Value) -> Option<Vec<Value>> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    if command.is_empty() {
        return None;
    }

    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let commands = split_shell_read_command_chain(command)?;
    let command_count = commands.len();
    let mut read_args_values = Vec::with_capacity(command_count);

    for (index, command_part) in commands.iter().enumerate() {
        let tokens = shell_tokens(command_part);
        let read_args = read_file_args_from_tokens(&tokens)?;
        if command_count > 1 && read_args.limit.is_none() {
            return None;
        }
        let mut value = shell_read_args_to_value(
            read_args,
            command_part,
            &cwd,
            shell_args,
            command,
            index,
            command_count,
        );
        if command_count == 1 {
            if let Some(obj) = value.as_object_mut() {
                obj.remove("source_command");
                obj.remove("command_index");
                obj.remove("command_count");
            }
        }
        read_args_values.push(value);
    }

    if read_args_values.is_empty() {
        None
    } else {
        Some(read_args_values)
    }
}

fn shell_read_args_to_value(
    read_args: ShellReadArgs,
    command: &str,
    cwd: &str,
    shell_args: &Value,
    source_command: &str,
    command_index: usize,
    command_count: usize,
) -> Value {
    json!({
        "path": read_args.path.clone(),
        "file_path": read_args.path.clone(),
        "target_file": read_args.path,
        "offset": read_args.offset,
        "limit": read_args.limit,
        "command": command,
        "source_command": source_command,
        "command_index": command_index,
        "command_count": command_count,
        "cwd": cwd,
        "payload": shell_args.clone(),
    })
}

struct ShellReadArgs {
    path: String,
    offset: Option<i64>,
    limit: Option<i64>,
}

fn split_shell_read_command_chain(command: &str) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            current.push(ch);
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' && active_quote == '"' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            continue;
        }

        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                push_shell_command_part(&mut parts, &mut current)?;
            }
            '|' if chars.peek() == Some(&'|') => return None,
            ';' => {
                push_shell_command_part(&mut parts, &mut current)?;
            }
            _ => current.push(ch),
        }
    }

    if quote.is_some() {
        return None;
    }
    push_shell_command_part(&mut parts, &mut current)?;
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

fn push_shell_command_part(parts: &mut Vec<String>, current: &mut String) -> Option<()> {
    let part = current.trim();
    if part.is_empty() {
        return None;
    }
    parts.push(part.to_string());
    current.clear();
    Some(())
}

fn read_file_args_from_tokens(tokens: &[String]) -> Option<ShellReadArgs> {
    if tokens.is_empty() {
        return None;
    }
    if let Some(read_args) = read_file_args_from_nl_sed_pipeline(tokens) {
        return Some(read_args);
    }
    if tokens.iter().any(|token| is_shell_separator(token)) {
        return None;
    }

    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0].as_str());
    match executable {
        "cat" => read_file_args_from_cat(&tokens[1..]),
        "sed" => read_file_args_from_sed(&tokens[1..]),
        "head" => read_file_args_from_head_tail(&tokens[1..], true),
        "tail" => read_file_args_from_head_tail(&tokens[1..], false),
        _ => None,
    }
}

fn read_file_args_from_nl_sed_pipeline(tokens: &[String]) -> Option<ShellReadArgs> {
    if tokens
        .iter()
        .any(|token| matches!(token.as_str(), "&&" | "||" | ";"))
    {
        return None;
    }

    let mut pipe_indices = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "|").then_some(index));
    let pipe_index = pipe_indices.next()?;
    if pipe_indices.next().is_some() || pipe_index == 0 || pipe_index + 1 >= tokens.len() {
        return None;
    }

    let path = read_file_path_from_nl(&tokens[..pipe_index])?;
    let (offset, limit) = read_range_from_pipeline_sed(&tokens[(pipe_index + 1)..])?;
    Some(ShellReadArgs {
        path,
        offset,
        limit,
    })
}

fn read_file_path_from_nl(tokens: &[String]) -> Option<String> {
    if tokens.is_empty() {
        return None;
    }
    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0].as_str());
    if executable != "nl" {
        return None;
    }

    let mut paths = Vec::new();
    let mut index = 1usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "--" {
            paths.extend(tokens[(index + 1)..].iter().cloned());
            break;
        }
        if token.starts_with('-') {
            index += if nl_option_consumes_next(token) { 2 } else { 1 };
            continue;
        }
        paths.push(token.to_string());
        index += 1;
    }

    single_shell_path_arg(&paths)
}

fn nl_option_consumes_next(token: &str) -> bool {
    matches!(
        token,
        "-b" | "-d" | "-f" | "-h" | "-i" | "-l" | "-n" | "-s" | "-v" | "-w"
    ) || matches!(
        token,
        "--body-numbering"
            | "--section-delimiter"
            | "--footer-numbering"
            | "--header-numbering"
            | "--line-increment"
            | "--join-blank-lines"
            | "--number-format"
            | "--number-separator"
            | "--starting-line-number"
            | "--number-width"
    )
}

fn read_range_from_pipeline_sed(tokens: &[String]) -> Option<(Option<i64>, Option<i64>)> {
    if tokens.is_empty() {
        return None;
    }
    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0].as_str());
    if executable != "sed" {
        return None;
    }

    let mut index = 1usize;
    let mut has_quiet = false;
    let mut range_expr: Option<&str> = None;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        match token {
            "-n" | "--quiet" | "--silent" => {
                has_quiet = true;
                index += 1;
            }
            "-e" | "--expression" => {
                range_expr = tokens.get(index + 1).map(String::as_str);
                index += 2;
            }
            _ if token.starts_with('-') => return None,
            _ if range_expr.is_none() => {
                range_expr = Some(token);
                index += 1;
            }
            _ => return None,
        }
    }

    if !has_quiet {
        return None;
    }
    sed_range_to_offset_limit(range_expr?)
}

fn read_file_args_from_cat(tokens: &[String]) -> Option<ShellReadArgs> {
    let paths = shell_path_args(
        tokens,
        &["-n", "-b", "-s", "-v", "-e", "-t", "-A", "--number"],
    )?;
    let path = single_shell_path_arg(&paths)?;
    Some(ShellReadArgs {
        path,
        offset: None,
        limit: None,
    })
}

fn read_file_args_from_sed(tokens: &[String]) -> Option<ShellReadArgs> {
    let mut index = 0usize;
    let mut has_quiet = false;
    let mut range_expr: Option<&str> = None;
    let mut paths: Vec<String> = Vec::new();

    while index < tokens.len() {
        let token = tokens[index].as_str();
        match token {
            "-n" | "--quiet" | "--silent" => {
                has_quiet = true;
                index += 1;
            }
            "-e" | "--expression" => {
                range_expr = tokens.get(index + 1).map(String::as_str);
                index += 2;
            }
            "--" => {
                paths.extend(tokens[(index + 1)..].iter().cloned());
                break;
            }
            _ if token.starts_with('-') => return None,
            _ if range_expr.is_none() => {
                range_expr = Some(token);
                index += 1;
            }
            _ => {
                paths.push(token.to_string());
                index += 1;
            }
        }
    }

    if !has_quiet {
        return None;
    }
    let (offset, limit) = sed_range_to_offset_limit(range_expr?)?;
    let path = single_shell_path_arg(&paths)?;
    Some(ShellReadArgs {
        path,
        offset,
        limit,
    })
}

fn read_file_args_from_head_tail(tokens: &[String], is_head: bool) -> Option<ShellReadArgs> {
    let mut index = 0usize;
    let mut line_count: Option<i64> = None;
    let mut paths = Vec::new();

    while index < tokens.len() {
        let token = tokens[index].as_str();
        match token {
            "-n" | "--lines" => {
                line_count = tokens
                    .get(index + 1)
                    .and_then(|value| value.trim_start_matches('+').parse::<i64>().ok());
                index += 2;
            }
            "--" => {
                paths.extend(tokens[(index + 1)..].iter().cloned());
                break;
            }
            _ if token.starts_with("-n") && token.len() > 2 => {
                line_count = token[2..].trim_start_matches('+').parse::<i64>().ok();
                index += 1;
            }
            _ if token.starts_with("--lines=") => {
                line_count = token
                    .trim_start_matches("--lines=")
                    .trim_start_matches('+')
                    .parse::<i64>()
                    .ok();
                index += 1;
            }
            _ if token.starts_with('-') => return None,
            _ => {
                paths.push(token.to_string());
                index += 1;
            }
        }
    }

    let path = single_shell_path_arg(&paths)?;
    Some(ShellReadArgs {
        path,
        offset: if is_head { Some(0) } else { None },
        limit: line_count,
    })
}

fn shell_path_args(tokens: &[String], flag_allowlist: &[&str]) -> Option<Vec<String>> {
    let mut paths = Vec::new();
    let mut index = 0usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "--" {
            paths.extend(tokens[(index + 1)..].iter().cloned());
            break;
        }
        if token.starts_with('-') {
            if flag_allowlist.contains(&token) {
                index += 1;
                continue;
            }
            return None;
        }
        paths.push(token.to_string());
        index += 1;
    }
    Some(paths)
}

fn single_shell_path_arg(paths: &[String]) -> Option<String> {
    if paths.len() != 1 {
        return None;
    }
    let path = paths[0].trim();
    if path.is_empty() || path == "-" {
        return None;
    }
    Some(path.to_string())
}

fn sed_range_to_offset_limit(expr: &str) -> Option<(Option<i64>, Option<i64>)> {
    let expr = expr.trim().trim_end_matches(';');
    if expr.contains('/') || expr.contains('s') {
        return None;
    }
    let mut parts = expr
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty());
    let first_part = parts.next()?;
    let (offset, limit) = sed_single_range_to_offset_limit(first_part)?;
    for part in parts {
        sed_single_range_to_offset_limit(part)?;
    }
    if expr.contains(';') {
        return Some((offset, None));
    }
    Some((offset, limit))
}

fn sed_single_range_to_offset_limit(expr: &str) -> Option<(Option<i64>, Option<i64>)> {
    if !expr.ends_with('p') {
        return None;
    }
    let range = expr.trim_end_matches('p').trim();
    if let Some((start_raw, end_raw)) = range.split_once(',') {
        let start = start_raw.trim().parse::<i64>().ok()?;
        let end = end_raw.trim().parse::<i64>().ok()?;
        if start < 1 || end < start {
            return None;
        }
        return Some((Some(start - 1), Some(end - start + 1)));
    }
    let line = range.parse::<i64>().ok()?;
    if line < 1 {
        return None;
    }
    Some((Some(line - 1), Some(1)))
}

pub(super) fn normalize_tool_name_key(raw_name: &str) -> String {
    raw_name
        .trim()
        .strip_prefix("mcp_orgii_")
        .unwrap_or_else(|| raw_name.trim())
        .chars()
        .map(|ch| match ch {
            '-' | ' ' | '.' => '_',
            _ => ch.to_ascii_lowercase(),
        })
        .collect()
}

fn rg_search_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    if command.is_empty() {
        return None;
    }

    let tokens = shell_tokens(command);
    // The caller splits safe exploration chains first. This parser still
    // requires the individual segment itself to begin with `rg`.
    if !tokens.first().is_some_and(|token| is_rg_executable(token)) {
        return None;
    }
    let rg_index = 0usize;

    let query =
        rg_pattern_from_tokens(&tokens[(rg_index + 1)..]).unwrap_or_else(|| command.to_string());
    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Some(json!({
        "action": "grep",
        "query": query.clone(),
        "pattern": query,
        "command": command,
        "cwd": cwd,
        "payload": shell_args.clone(),
    }))
}

/// Decompose a shell chain only when every segment is a known read-only
/// exploration operation. Context probes (`pwd`, `wc -l`) are omitted; their
/// meaningful read/search successor represents the action in chat. Any
/// unknown or potentially mutating segment keeps the entire call in Terminal.
fn exploration_tool_calls_from_shell_args(shell_args: &Value) -> Option<Vec<(String, Value)>> {
    let source_command = shell_args.get("command").and_then(Value::as_str)?.trim();
    if source_command.is_empty() {
        return None;
    }

    let command_parts = split_shell_read_command_chain(source_command)?;
    let command_count = command_parts.len();
    let mut calls = Vec::new();

    for (command_index, command) in command_parts.iter().enumerate() {
        let part_args = shell_args_for_command_part(shell_args, command);
        let tokens = shell_tokens(command);
        if is_exploration_context_probe(&tokens) {
            continue;
        }

        let (canonical_name, mut args) =
            if let Some(read_args) = read_file_args_from_shell_args(&part_args) {
                (imported_history::FUNCTION_READ_FILE.to_string(), read_args)
            } else if let Some(glob_args) = rg_files_args_from_shell_args(&part_args) {
                (
                    imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
                    glob_args,
                )
            } else if let Some(search_args) = rg_search_args_from_shell_args(&part_args) {
                (
                    imported_history::FUNCTION_CODE_SEARCH.to_string(),
                    search_args,
                )
            } else if let Some(glob_args) = find_args_from_shell_args(&part_args) {
                (
                    imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
                    glob_args,
                )
            } else {
                return None;
            };

        if command_count > 1 {
            if let Some(object) = args.as_object_mut() {
                object.insert(
                    "source_command".to_string(),
                    Value::String(source_command.to_string()),
                );
                object.insert("command_index".to_string(), json!(command_index));
                object.insert("command_count".to_string(), json!(command_count));
            }
        }
        calls.push((canonical_name, args));
    }

    (!calls.is_empty()).then_some(calls)
}

fn shell_args_for_command_part(shell_args: &Value, command: &str) -> Value {
    let mut part_args = shell_args.clone();
    if let Some(object) = part_args.as_object_mut() {
        object.insert("command".to_string(), Value::String(command.to_string()));
        object.insert("cmd".to_string(), Value::String(command.to_string()));
    }
    part_args
}

fn is_exploration_context_probe(tokens: &[String]) -> bool {
    let Some(executable) = tokens
        .first()
        .map(|token| token.rsplit('/').next().unwrap_or(token))
    else {
        return false;
    };
    match executable {
        "pwd" => tokens.len() == 1,
        "wc" => {
            tokens.len() == 3
                && matches!(tokens[1].as_str(), "-l" | "--lines")
                && !tokens[2].starts_with('-')
        }
        _ => false,
    }
}

fn rg_files_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    let tokens = shell_tokens(command);
    if !tokens.first().is_some_and(|token| is_rg_executable(token))
        || !tokens.iter().any(|token| token == "--files")
        || !has_only_output_limiter_pipeline(&tokens)
    {
        return None;
    }

    let patterns = option_values(&tokens, "-g", "--glob")
        .into_iter()
        .filter(|pattern| !pattern.starts_with('!'))
        .collect::<Vec<_>>();
    let pattern = if patterns.is_empty() {
        "*".to_string()
    } else {
        patterns.join(", ")
    };
    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Some(json!({
        "action": "find_files",
        "pattern": pattern.clone(),
        "glob": pattern,
        "path": cwd,
        "command": command,
        "cwd": shell_args.get("cwd").cloned().unwrap_or_else(|| json!("")),
        "payload": shell_args.clone(),
    }))
}

fn find_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    let tokens = shell_tokens(command);
    let executable = tokens
        .first()?
        .rsplit('/')
        .next()
        .unwrap_or(tokens.first()?.as_str());
    if executable != "find"
        || tokens.iter().any(|token| {
            matches!(
                token.as_str(),
                "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" | "-fprint" | "-fprintf"
            )
        })
        || !has_only_output_limiter_pipeline(&tokens)
    {
        return None;
    }

    let pattern = option_values(&tokens, "-name", "-path")
        .into_iter()
        .next()
        .unwrap_or_else(|| "*".to_string());
    let path = tokens
        .get(1)
        .filter(|token| !token.starts_with('-'))
        .cloned()
        .unwrap_or_else(|| ".".to_string());
    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Some(json!({
        "action": "find_files",
        "pattern": pattern.clone(),
        "glob": pattern,
        "path": path,
        "command": command,
        "cwd": cwd,
        "payload": shell_args.clone(),
    }))
}

fn option_values(tokens: &[String], short: &str, long: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0usize;
    while index + 1 < tokens.len() {
        if tokens[index] == short || tokens[index] == long {
            values.push(tokens[index + 1].clone());
            index += 2;
        } else {
            index += 1;
        }
    }
    values
}

fn has_only_output_limiter_pipeline(tokens: &[String]) -> bool {
    let separators = tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| is_shell_separator(token))
        .collect::<Vec<_>>();
    match separators.as_slice() {
        [] => true,
        [(index, separator)] if separator.as_str() == "|" => tokens
            .get(index + 1)
            .is_some_and(|token| matches!(token.as_str(), "head" | "tail" | "sed")),
        _ => false,
    }
}

fn shell_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' && active_quote == '"' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                push_shell_token(&mut tokens, &mut current);
                tokens.push("&&".to_string());
            }
            '|' if chars.peek() == Some(&'|') => {
                chars.next();
                push_shell_token(&mut tokens, &mut current);
                tokens.push("||".to_string());
            }
            ';' | '|' => {
                push_shell_token(&mut tokens, &mut current);
                tokens.push(ch.to_string());
            }
            ch if ch.is_whitespace() => push_shell_token(&mut tokens, &mut current),
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            _ => current.push(ch),
        }
    }

    push_shell_token(&mut tokens, &mut current);
    tokens
}

fn push_shell_token(tokens: &mut Vec<String>, current: &mut String) {
    if current.is_empty() {
        return;
    }
    tokens.push(std::mem::take(current));
}

fn is_shell_separator(token: &str) -> bool {
    matches!(token, "&&" | "||" | ";" | "|")
}

fn is_rg_executable(token: &str) -> bool {
    let executable = token.rsplit('/').next().unwrap_or(token);
    matches!(executable, "rg" | "ripgrep" | "grep")
}

fn rg_pattern_from_tokens(tokens: &[String]) -> Option<String> {
    let mut index = 0usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if is_shell_separator(token) {
            return None;
        }
        if token == "--" {
            return tokens.get(index + 1).cloned();
        }
        if token == "-e" || token == "--regexp" {
            return tokens.get(index + 1).cloned();
        }
        if let Some(rest) = token.strip_prefix("-e") {
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
        if rg_flag_consumes_next(token) {
            index += 2;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        return Some(token.to_string());
    }
    None
}

fn rg_flag_consumes_next(token: &str) -> bool {
    matches!(
        token,
        "-g" | "--glob"
            | "-t"
            | "--type"
            | "-T"
            | "--type-not"
            | "-C"
            | "--context"
            | "-A"
            | "--after-context"
            | "-B"
            | "--before-context"
            | "-m"
            | "--max-count"
            | "--sort"
            | "--sort-files"
    )
}

fn first_apply_patch_file_path(patch: &str) -> Option<String> {
    for line in patch.lines() {
        if let Some(path) = patch_file_path_from_line(line) {
            if path != "/dev/null" {
                return Some(path);
            }
        }
    }
    None
}
