//! Inbound command parsing.
//!
//! Recognizes explicit slash commands that control session binding behavior
//! before the message reaches the OS agent. Modeled on `hermes-agent`'s
//! gateway slash-command surface.
//!
//! | Command                  | Meaning                                                                  | Arg shape    |
//! |--------------------------|--------------------------------------------------------------------------|--------------|
//! | `/new`                   | Clear the current binding so the next message creates a fresh session.   | no args      |
//! | `/reset`                 | Alias of `/new`.                                                         | no args      |
//! | `/status`                | Report the current binding (if any) and active agent sessions.           | no args      |
//! | `/compact`               | Manually compact the current session's context and fork to a new id.     | no args      |
//! | `/help` / `/commands`    | List the available slash commands (static cheat-sheet).                   | no args      |
//!
//! Strict parsing: parameterless commands require the tail of the first
//! line to be empty or whitespace only — so prose that starts with
//! `/compact` is treated as plain chat, not as an invocation. Non-matching messages
//! are dispatched to the bound OS agent session.
//!
//! Workspace mutation is handled by the OS agent's workspace tools via
//! natural-language cues, not slash commands.
//!
//! Unknown `/foo ...` tokens are not consumed here — they pass through to
//! the OS agent as normal content.

/// Parsed explicit-command intent; `None` means the message is regular
/// content that should be dispatched to the bound OS agent session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayCommand {
    /// Drop the binding for the current chat. Next message re-routes.
    NewSession,
    /// Switch the bound channel session model without dispatching to the agent.
    Model(Option<String>),
    /// Emit the current binding + running-session summary back to the channel.
    Status,
    /// Manually compact the bound session's transcript and fork to a
    /// new versioned session id. Mirrors `hermes-agent`'s `/compress`
    /// slash command (`gateway/run.py:_handle_compress_command`).
    /// Any trailing argument is ignored in MVP (Hermes uses it as a
    /// focus-topic hint — see note in `manual_compact.rs`).
    Compact,
    /// Emit a static cheat-sheet of available Gateway slash commands.
    /// Mirrors `hermes-agent`'s `/help` (`gateway/run.py:
    /// _handle_help_command`). Keeps the cheat-sheet short (Telegram
    /// character budget) and does NOT invoke the LLM.
    Help,
}

/// Inspect the first line of user-provided text and classify it as a gateway
/// control command, if any. Commands are case-insensitive on the keyword;
/// arguments (session id) are preserved verbatim.
///
/// Parsing is **strict**: the tail of the first line after the command
/// keyword must match the command's expected arg shape, otherwise the
/// whole message falls through as normal content. This prevents
/// prose that starts with `/compact` from being misread as the command
/// with the rest as an ignored arg.
pub fn parse(content: &str) -> Option<GatewayCommand> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with('/') {
        return None;
    }
    let first_line = trimmed.lines().next().unwrap_or("").trim();
    let mut parts = first_line.splitn(2, char::is_whitespace);
    let head = parts.next()?.to_ascii_lowercase();
    let rest = parts.next().map(str::trim).unwrap_or("");

    match head.as_str() {
        "/new" | "/reset" => bare_command(rest, GatewayCommand::NewSession),
        "/status" => bare_command(rest, GatewayCommand::Status),
        "/model" => Some(GatewayCommand::Model((!rest.is_empty()).then(|| rest.to_string()))),
        "/compact" => bare_command(rest, GatewayCommand::Compact),
        "/help" | "/commands" => bare_command(rest, GatewayCommand::Help),
        _ => None,
    }
}

/// Accept `rest` only when it is empty (or whitespace-only). Prose that
/// happens to mention the command name still gets parsed as a keyword,
/// but because its tail is non-empty the whole message falls through
/// to the OS agent as normal content.
fn bare_command(rest: &str, cmd: GatewayCommand) -> Option<GatewayCommand> {
    if rest.is_empty() {
        Some(cmd)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_new_and_reset() {
        assert_eq!(parse("/new"), Some(GatewayCommand::NewSession));
        assert_eq!(parse("/reset"), Some(GatewayCommand::NewSession));
        assert_eq!(parse("  /NEW  "), Some(GatewayCommand::NewSession));
    }

    #[test]
    fn non_command_returns_none() {
        assert_eq!(parse("hello world"), None);
        assert_eq!(parse("/foobar do things"), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn parses_compact() {
        assert_eq!(parse("/compact"), Some(GatewayCommand::Compact));
        assert_eq!(parse("  /COMPACT  "), Some(GatewayCommand::Compact));
    }

    #[test]
    fn parses_model_command() {
        assert_eq!(parse("/model"), Some(GatewayCommand::Model(None)));
        assert_eq!(
            parse("/model gpt-5.5"),
            Some(GatewayCommand::Model(Some("gpt-5.5".to_string())))
        );
        assert_eq!(
            parse("  /MODEL fable  "),
            Some(GatewayCommand::Model(Some("fable".to_string())))
        );
    }

    /// Prose that mentions `/compact` must not fire the command.
    /// Regression: prose starting with `/compact` was parsed as Compact and
    /// triggered a "No session is bound" error instead of being treated as
    /// plain prose.
    #[test]
    fn rejects_compact_with_prose_tail() {
        assert_eq!(parse("/compact 命令是怎么实现的"), None);
        assert_eq!(parse("/compact focus topic"), None);
        assert_eq!(parse("/compact help"), None);
    }

    #[test]
    fn only_first_line_considered() {
        assert_eq!(
            parse("/new\nsome extra text"),
            Some(GatewayCommand::NewSession)
        );
    }

    #[test]
    fn parses_help_and_commands_alias() {
        assert_eq!(parse("/help"), Some(GatewayCommand::Help));
        assert_eq!(parse("  /HELP  "), Some(GatewayCommand::Help));
        assert_eq!(parse("/commands"), Some(GatewayCommand::Help));
    }

    /// Prose after /help / /status / /new must fall through to the
    /// router, not fire the command.
    #[test]
    fn rejects_parameterless_commands_with_prose_tail() {
        assert_eq!(parse("/help what is this"), None);
        assert_eq!(parse("/status report please"), None);
        assert_eq!(parse("/new topic"), None);
        assert_eq!(parse("/reset the conversation please"), None);
        assert_eq!(parse("/commands 说一下"), None);
    }

    /// After `/switch` was removed, `/switch ...` MUST fall through to
    /// the OS agent as plain prose rather than acting as a command.
    /// This prevents accidental pinning in chats that previously
    /// relied on the shortcut.
    #[test]
    fn switch_is_no_longer_a_command() {
        assert_eq!(parse("/switch sdeagent-yoyo-evolve"), None);
        assert_eq!(parse("/switch"), None);
        assert_eq!(parse("/agent osagent-default"), None);
        assert_eq!(parse("/agent"), None);
    }
}
