//! Recognizing file reads hidden inside Codex shell commands and chains.

use serde_json::{json, Value};

use super::shell_read_commands::{
    read_file_args_from_cat, read_file_args_from_head_tail, read_file_args_from_nl_sed_pipeline,
    read_file_args_from_sed,
};
use super::shell_tokenizer::{is_shell_separator, shell_tokens};

pub(super) fn read_file_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    read_file_arg_values_from_shell_args(shell_args)?
        .into_iter()
        .next()
}

pub(super) fn read_file_arg_values_from_shell_args(shell_args: &Value) -> Option<Vec<Value>> {
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

pub(super) struct ShellReadArgs {
    pub(super) path: String,
    pub(super) offset: Option<i64>,
    pub(super) limit: Option<i64>,
}

pub(super) fn split_shell_read_command_chain(command: &str) -> Option<Vec<String>> {
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
