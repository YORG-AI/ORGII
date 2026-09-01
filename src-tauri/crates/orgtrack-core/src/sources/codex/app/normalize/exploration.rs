//! Decomposing read-only shell exploration chains into search/glob tool calls.

use serde_json::{json, Value};

use crate::sources::imported_history;

use super::shell_read::{read_file_args_from_shell_args, split_shell_read_command_chain};
use super::shell_tokenizer::{is_shell_separator, shell_tokens};

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
pub(super) fn exploration_tool_calls_from_shell_args(
    shell_args: &Value,
) -> Option<Vec<(String, Value)>> {
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
            } else {
                let glob_args = find_args_from_shell_args(&part_args)?;
                (
                    imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
                    glob_args,
                )
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
