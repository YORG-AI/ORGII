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
    /// Session Journey command; execution stays in the shared application
    /// service and never invokes a provider.
    Journey(crate::core::journey_lifecycle::JourneyCommand),
    /// A recognized Journey prefix with invalid arguments.  This must be
    /// consumed by the gateway so a malformed control command never becomes
    /// provider input.
    JourneyInvalid(String),
    /// Drop the binding for the current chat. Next message re-routes.
    NewSession,
    /// Show the current channel binding and active Work Item context.
    SessionCurrent,
    /// List recent sessions that can be bound to this chat.
    SessionList,
    /// Start the durable Workspace -> Project -> Work Item -> Session tree.
    SessionTree,
    /// Start a durable snapshot of recent terminal sessions.
    SessionRecent,
    /// Move the current browse snapshot forward one page.
    BrowseNext,
    /// Move the current browse snapshot backward one page.
    BrowsePrev,
    /// Return from the current browse level to its parent.
    BrowseBack,
    /// Switch this chat to an existing ORG2 session id.
    SessionSwitch(String),
    /// Create a fresh versioned session and bind this chat to it immediately.
    SessionNew,
    /// Natural-language channel request to create and bind a fresh session,
    /// optionally with a display name (for example: `新建会话，名称为test`).
    SessionNewNamed(Option<String>),
    /// Create a fresh named session and optionally dispatch an initial prompt.
    /// Syntax: `/newsession <session_name> [prompt...]`.
    NewSessionWithPrompt {
        name: String,
        prompt: Option<String>,
    },
    /// Semantic search across indexed Session Memory summaries.
    SessionSearch(String),
    /// Bind the current chat/session to a Project or Work Item context.
    SessionBind { target: String, value: String },
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
        return parse_natural_language_command(trimmed);
    }
    let first_line = trimmed.lines().next().unwrap_or("").trim();
    let mut parts = first_line.splitn(2, char::is_whitespace);
    let head = parts.next()?.to_ascii_lowercase();
    let rest = parts.next().map(str::trim).unwrap_or("");

    match head.as_str() {
        "/new" | "/reset" => bare_command(rest, GatewayCommand::NewSession),
        "/status" => bare_command(rest, GatewayCommand::Status),
        "/model" => Some(GatewayCommand::Model(
            (!rest.is_empty()).then(|| rest.to_string()),
        )),
        "/compact" => bare_command(rest, GatewayCommand::Compact),
        "/next" => bare_command(rest, GatewayCommand::BrowseNext),
        "/prev" => bare_command(rest, GatewayCommand::BrowsePrev),
        "/0" => bare_command(rest, GatewayCommand::BrowseBack),
        "/session" | "/ctx" => parse_session_command(rest),
        "/newsession" => parse_newsession_command(rest),
        "/task" => Some(
            parse_journey_task(rest)
                .map(GatewayCommand::Journey)
                .unwrap_or_else(|| GatewayCommand::JourneyInvalid(task_usage().into())),
        ),
        "/fork" => Some(
            parse_journey_fork(rest)
                .map(GatewayCommand::Journey)
                .unwrap_or_else(|| GatewayCommand::JourneyInvalid(fork_usage().into())),
        ),
        "/review" => Some(
            parse_journey_review(rest)
                .map(GatewayCommand::Journey)
                .unwrap_or_else(|| GatewayCommand::JourneyInvalid(review_usage().into())),
        ),
        "/journey" => Some(
            bare_command(
                rest,
                GatewayCommand::Journey(crate::core::journey_lifecycle::JourneyCommand::Status),
            )
            .unwrap_or_else(|| GatewayCommand::JourneyInvalid("用法：`/journey`。".into())),
        ),
        "/help" | "/commands" => bare_command(rest, GatewayCommand::Help),
        _ => None,
    }
}

fn parse_journey_task(rest: &str) -> Option<crate::core::journey_lifecycle::JourneyCommand> {
    use crate::core::journey_lifecycle::{JourneyCommand, TaskOutcome};
    let (verb, tail) = rest.trim().split_once(char::is_whitespace)?;
    match verb.to_ascii_lowercase().as_str() {
        "start" => {
            let (name, position) = split_optional_position(tail)?;
            Some(JourneyCommand::TaskStart {
                task_id: deterministic_id("task", &name),
                name,
                start_from_recent: position == "recent",
            })
        }
        "checkpoint" => {
            let (name, message_id) = split_name_and_exact_anchor(tail)?;
            Some(JourneyCommand::TaskCheckpoint {
                checkpoint_id: deterministic_id("checkpoint", &format!("{name}:{message_id}")),
                message_id,
                name,
            })
        }
        "finish" => {
            let outcome = match tail.trim() {
                "完成" => TaskOutcome::Completed,
                "部分完成" => TaskOutcome::PartiallyCompleted,
                "暂停" => TaskOutcome::Paused,
                "放弃" => TaskOutcome::Abandoned,
                "转向" => TaskOutcome::Redirected,
                _ => return None,
            };
            Some(JourneyCommand::TaskFinish {
                outcome,
                message_id: "@latest".into(),
            })
        }
        _ => None,
    }
}

fn parse_journey_fork(rest: &str) -> Option<crate::core::journey_lifecycle::JourneyCommand> {
    use crate::core::journey_lifecycle::JourneyCommand;
    let (verb, tail) = rest.trim().split_once(char::is_whitespace)?;
    match verb.to_ascii_lowercase().as_str() {
        "start" => {
            let (task_name, anchor_message_id) = split_name_and_exact_anchor(tail)?;
            Some(JourneyCommand::ForkStart {
                fork_id: deterministic_id("fork", &task_name),
                task_id: deterministic_id("task", &task_name),
                anchor_message_id,
                task_name,
            })
        }
        "close" => Some(JourneyCommand::ForkClose {
            fork_id: "@active".into(),
            review_id: "@active".into(),
            message_id: "@latest".into(),
            outcome: parse_outcome(tail.trim())?,
        }),
        "compare" => tail
            .trim()
            .is_empty()
            .then_some(JourneyCommand::ForkCompare),
        _ => None,
    }
}

fn parse_journey_review(rest: &str) -> Option<crate::core::journey_lifecycle::JourneyCommand> {
    use crate::core::journey_lifecycle::JourneyCommand;
    let mut parts = rest.split_whitespace();
    match parts.next()?.to_ascii_lowercase().as_str() {
        "list" => parts.next().is_none().then_some(JourneyCommand::ReviewList),
        "discard" => {
            let review_id = parts.next()?.to_string();
            (parts.next().is_none()).then_some(JourneyCommand::ReviewDiscard { review_id })
        }
        "promote" | "confirm" => {
            let review_id = parts.next()?.to_string();
            let fact_id = parts.next()?.to_string();
            let evidence_start_message_id = parts.next()?.to_string();
            let evidence_end_message_id = parts.next()?.to_string();
            let text = parts.collect::<Vec<_>>().join(" ");
            (!text.is_empty()).then_some(JourneyCommand::ReviewPromote {
                review_id,
                fact_id,
                evidence_start_message_id,
                evidence_end_message_id,
                text,
            })
        }
        _ => None,
    }
}

fn parse_outcome(value: &str) -> Option<crate::core::journey_lifecycle::TaskOutcome> {
    use crate::core::journey_lifecycle::TaskOutcome;
    match value {
        "完成" => Some(TaskOutcome::Completed),
        "部分完成" => Some(TaskOutcome::PartiallyCompleted),
        "暂停" => Some(TaskOutcome::Paused),
        "放弃" => Some(TaskOutcome::Abandoned),
        "转向" => Some(TaskOutcome::Redirected),
        _ => None,
    }
}

fn split_optional_position(tail: &str) -> Option<(String, &'static str)> {
    let words: Vec<_> = tail.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    let position = match words.last().copied() {
        Some("recent") => "recent",
        Some("next") => "next",
        _ => "recent",
    };
    let name_words = if position == "recent" || position == "next" {
        &words[..words.len() - 1]
    } else {
        &words[..]
    };
    let name = name_words.join(" ");
    (!name.trim().is_empty()).then_some((name, position))
}

fn split_name_and_exact_anchor(tail: &str) -> Option<(String, String)> {
    let mut words: Vec<_> = tail.split_whitespace().collect();
    let anchor = words.pop()?.to_string();
    let name = words.join(" ");
    (!name.trim().is_empty() && !anchor.trim().is_empty()).then_some((name, anchor))
}

fn deterministic_id(prefix: &str, value: &str) -> String {
    // Stable across retries. IDs are an adapter detail; user-controlled text
    // remains the durable display name and is never inferred by an LLM.
    let hash = value.bytes().fold(0xcbf29ce484222325_u64, |state, byte| {
        (state ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("{prefix}-{hash:016x}")
}

fn task_usage() -> &'static str {
    "用法：`/task start <名称> [recent|next]`、`/task checkpoint <名称> <精确消息ID>`、`/task finish <完成|部分完成|暂停|放弃|转向>`。"
}
fn fork_usage() -> &'static str {
    "用法：`/fork start <名称> <精确锚点消息ID>`、`/fork close <完成|部分完成|暂停|放弃|转向>`、`/fork compare`。"
}
fn review_usage() -> &'static str {
    "用法：`/review list`、`/review discard <id>`、`/review promote|confirm <review_id> <fact_id> <证据起始消息ID> <证据结束消息ID> <事实文本>`。"
}

fn parse_newsession_command(rest: &str) -> Option<GatewayCommand> {
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    let mut parts = rest.splitn(2, char::is_whitespace);
    let name = parts.next()?.trim();
    if name.is_empty() {
        return None;
    }
    let prompt = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Some(GatewayCommand::NewSessionWithPrompt {
        name: name.chars().take(80).collect(),
        prompt,
    })
}

fn parse_natural_language_command(trimmed: &str) -> Option<GatewayCommand> {
    let first_line = trimmed.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        return None;
    }
    parse_new_session_zh(first_line).map(GatewayCommand::SessionNewNamed)
}

fn parse_new_session_zh(line: &str) -> Option<Option<String>> {
    let normalized = line
        .trim()
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '“' | '”' | '‘' | '’'));
    if !(normalized.contains("新建会话")
        || normalized.contains("创建会话")
        || normalized.contains("开一个新会话")
        || normalized.contains("开新会话"))
    {
        return None;
    }

    let name_markers = ["名称为", "名字为", "命名为", "名为", "叫做", "叫"];
    for marker in name_markers {
        if let Some((_, tail)) = normalized.split_once(marker) {
            let name = clean_requested_session_name(tail);
            return Some(name.filter(|s| !s.is_empty()));
        }
    }
    Some(None)
}

fn clean_requested_session_name(raw: &str) -> Option<String> {
    let stop_chars = ['，', ',', '。', '.', '\n', '\r', ';', '；'];
    let before_stop = raw
        .split(|c| stop_chars.contains(&c))
        .next()
        .unwrap_or(raw)
        .trim();
    let cleaned = before_stop
        .trim_matches(|c: char| {
            c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '“' | '”' | '‘' | '’' | ':' | '：')
        })
        .trim()
        .to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.chars().take(80).collect())
    }
}

fn parse_session_command(rest: &str) -> Option<GatewayCommand> {
    let mut parts = rest.split_whitespace();
    let sub = parts.next().unwrap_or("current").to_ascii_lowercase();
    match sub.as_str() {
        "current" | "status" => {
            if parts.next().is_none() {
                Some(GatewayCommand::SessionCurrent)
            } else {
                None
            }
        }
        "list" | "ls" => {
            if parts.next().is_none() {
                Some(GatewayCommand::SessionList)
            } else {
                None
            }
        }
        "tree" => bare_command(
            &parts.collect::<Vec<_>>().join(" "),
            GatewayCommand::SessionTree,
        ),
        "recent" => bare_command(
            &parts.collect::<Vec<_>>().join(" "),
            GatewayCommand::SessionRecent,
        ),
        "new" => {
            let rest = parts.collect::<Vec<_>>().join(" ");
            if rest.trim().is_empty() {
                Some(GatewayCommand::SessionNew)
            } else {
                Some(GatewayCommand::SessionNewNamed(Some(
                    rest.trim().chars().take(80).collect(),
                )))
            }
        }
        "search" | "find" => {
            let query = parts.collect::<Vec<_>>().join(" ");
            if query.trim().is_empty() {
                None
            } else {
                Some(GatewayCommand::SessionSearch(query))
            }
        }
        "switch" | "use" => {
            let sid = parts.next()?;
            if parts.next().is_none() {
                Some(GatewayCommand::SessionSwitch(sid.to_string()))
            } else {
                None
            }
        }
        "bind" => {
            let target = parts.next()?.to_ascii_lowercase();
            let value = parts.next()?.to_string();
            if parts.next().is_none()
                && matches!(
                    target.as_str(),
                    "project" | "workitem" | "work_item" | "item"
                )
            {
                Some(GatewayCommand::SessionBind { target, value })
            } else {
                None
            }
        }
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
    fn parses_journey_commands_without_guessing_anchors() {
        use crate::core::journey_lifecycle::{JourneyCommand, TaskOutcome};

        assert_eq!(
            parse("/task start 中文任务 recent"),
            Some(GatewayCommand::Journey(JourneyCommand::TaskStart {
                task_id: deterministic_id("task", "中文任务"),
                name: "中文任务".into(),
                start_from_recent: true,
            }))
        );
        assert_eq!(
            parse("/fork start 调查问题 message-7"),
            Some(GatewayCommand::Journey(JourneyCommand::ForkStart {
                fork_id: deterministic_id("fork", "调查问题"),
                task_id: deterministic_id("task", "调查问题"),
                anchor_message_id: "message-7".into(),
                task_name: "调查问题".into(),
            }))
        );
        assert_eq!(
            parse("/task finish 部分完成"),
            Some(GatewayCommand::Journey(JourneyCommand::TaskFinish {
                outcome: TaskOutcome::PartiallyCompleted,
                message_id: "@latest".into(),
            }))
        );
        assert!(matches!(
            parse("/fork start 调查"),
            Some(GatewayCommand::JourneyInvalid(_))
        ));
    }

    #[test]
    fn parses_chinese_named_session_request() {
        assert_eq!(
            parse("新建会话，名称为test"),
            Some(GatewayCommand::SessionNewNamed(Some("test".to_string())))
        );
        assert_eq!(
            parse("创建会话，名字为 测试任务。"),
            Some(GatewayCommand::SessionNewNamed(Some(
                "测试任务".to_string()
            )))
        );
        assert_eq!(
            parse("开新会话"),
            Some(GatewayCommand::SessionNewNamed(None))
        );
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

    #[test]
    fn parses_session_commands() {
        assert_eq!(parse("/session"), Some(GatewayCommand::SessionCurrent));
        assert_eq!(
            parse("/session current"),
            Some(GatewayCommand::SessionCurrent)
        );
        assert_eq!(parse("/session list"), Some(GatewayCommand::SessionList));
        assert_eq!(parse("/session tree"), Some(GatewayCommand::SessionTree));
        assert_eq!(
            parse("/session recent"),
            Some(GatewayCommand::SessionRecent)
        );
        assert_eq!(parse("/session new"), Some(GatewayCommand::SessionNew));
        assert_eq!(
            parse("/newsession 测试会话 请回答 ok"),
            Some(GatewayCommand::NewSessionWithPrompt {
                name: "测试会话".into(),
                prompt: Some("请回答 ok".into())
            })
        );
        assert_eq!(
            parse("/session search feishu image bug"),
            Some(GatewayCommand::SessionSearch("feishu image bug".into()))
        );
        assert_eq!(
            parse("/session switch osagent-feishu-x"),
            Some(GatewayCommand::SessionSwitch("osagent-feishu-x".into()))
        );
        assert_eq!(
            parse("/session bind project org2"),
            Some(GatewayCommand::SessionBind {
                target: "project".into(),
                value: "org2".into()
            })
        );
        assert_eq!(
            parse("/session bind workitem ORG-1"),
            Some(GatewayCommand::SessionBind {
                target: "workitem".into(),
                value: "ORG-1".into()
            })
        );
        assert_eq!(parse("/ctx ls"), Some(GatewayCommand::SessionList));
    }

    #[test]
    fn parses_browse_paging_commands() {
        assert_eq!(parse("/next"), Some(GatewayCommand::BrowseNext));
        assert_eq!(parse("/prev"), Some(GatewayCommand::BrowsePrev));
        assert_eq!(parse("/0"), Some(GatewayCommand::BrowseBack));
    }

    #[test]
    fn parses_model_command() {
        assert_eq!(parse("/model"), Some(GatewayCommand::Model(None)));
        assert_eq!(
            parse("  /MODEL  gpt-5.5  "),
            Some(GatewayCommand::Model(Some("gpt-5.5".into())))
        );
        assert_eq!(
            parse("/model sonnet please"),
            Some(GatewayCommand::Model(Some("sonnet please".into())))
        );
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
