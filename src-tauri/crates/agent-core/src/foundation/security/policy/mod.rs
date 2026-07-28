//! Security policy for command and path validation.
//!
//! Provides defense-in-depth for tool execution using blocked commands, optional
//! explicit confirmation patterns, risk classification, and path
//! traversal prevention.

mod paths;
mod risk;

pub use risk::{
    default_high_risk_patterns, default_medium_risk_patterns, requires_user_confirmation,
    CommandRiskRules,
};

use serde::{Deserialize, Serialize};

use self::risk::{classify_command_with_rules, command_pattern_matches};

/// Normalize shell pipeline/chain separators to \x00 for segment splitting.
///
/// Replaces `&&`, `||`, newlines, `;`, and `|` so callers can `.split('\x00')`
/// to iterate individual sub-commands.
pub(crate) fn normalize_command_pipeline(command: &str) -> String {
    command
        .replace("&&", "\x00")
        .replace("||", "\x00")
        .replace(['\n', ';', '|'], "\x00")
}

// ============================================
// Enums
// ============================================

/// Agent autonomy level — controls what the agent can do without approval.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutonomyLevel {
    /// Can observe but not mutate files or run shell commands.
    ReadOnly,
    /// Can read, write, and run commands within command-policy bounds.
    #[default]
    Full,
}

/// Canonical write/side-effect tool deny set for ALL read-only surfaces:
/// `AutonomyLevel::ReadOnly` (per-agent access mode) and the read-only
/// `AgentExecMode`s (Ask / Debug / Review / Plan) both derive from this
/// single list. Three divergent copies previously existed (this enum
/// missed worktree/manage_lsp/setup_repo; the mode list missed
/// apply_patch).
pub const READ_ONLY_DENY_TOOLS: &[&str] = &[
    crate::tools::names::RUN_SHELL,
    crate::tools::names::AWAIT_OUTPUT,
    crate::tools::names::EDIT_FILE,
    crate::tools::names::DELETE_FILE,
    crate::tools::names::APPLY_PATCH,
    crate::tools::names::WORKTREE,
    crate::tools::names::MANAGE_LSP,
    crate::tools::names::SETUP_REPO,
];

impl AutonomyLevel {
    pub fn ask_tools(&self) -> Vec<String> {
        Vec::new()
    }

    /// Tool names blocked by the selected access mode.
    pub fn deny_tools(&self) -> Vec<String> {
        match self {
            Self::ReadOnly => READ_ONLY_DENY_TOOLS
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
            Self::Full => Vec::new(),
        }
    }
}

/// Risk classification for a shell command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandRiskLevel {
    Low,
    Medium,
    High,
}

/// Result of command validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationResult {
    /// Command is allowed to execute.
    Allowed(CommandRiskLevel),
    /// Command requires user approval before execution.
    NeedsApproval(CommandRiskLevel, String),
    /// Command is denied.
    Denied(String),
}

// ============================================
// Security Policy
// ============================================

/// Execution-time security policy for agent tools.
///
/// Owns command policy (blocklist, confirmation, risk classification)
/// and path *syntax* validation (`validate_path_syntax`).
/// Path containment is NOT decided here — the single source of truth
/// is `core::session::workspace::SessionWorkspace::is_path_allowed`;
/// callers combine it with `workspace_only` from this policy.
pub struct SecurityPolicy {
    pub autonomy: AutonomyLevel,
    pub workspace_only: bool,
    /// Commands that are always blocked (blacklist). Matches base command name.
    pub blocked_commands: Vec<String>,
    /// Commands requiring user confirmation. Format: "cmd", "cmd subcmd", or
    /// longer token pattern such as "git push --force".
    pub confirmation_commands: Vec<String>,
    pub forbidden_paths: Vec<String>,
    pub block_high_risk_commands: bool,
    pub risk_rules: CommandRiskRules,
}

impl SecurityPolicy {
    /// Create a new security policy with the given configuration.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        autonomy: AutonomyLevel,
        workspace_only: bool,
        blocked_commands: Vec<String>,
        confirmation_commands: Vec<String>,
        forbidden_paths: Vec<String>,
        block_high_risk_commands: bool,
        risk_rules: CommandRiskRules,
    ) -> Self {
        Self {
            autonomy,
            workspace_only,
            blocked_commands,
            confirmation_commands,
            forbidden_paths,
            block_high_risk_commands,
            risk_rules,
        }
    }

    /// Create a permissive policy (for testing or full-autonomy mode).
    pub fn permissive() -> Self {
        Self {
            autonomy: AutonomyLevel::Full,
            workspace_only: false,
            blocked_commands: Vec::new(),
            confirmation_commands: Vec::new(),
            forbidden_paths: Vec::new(),
            block_high_risk_commands: false,
            risk_rules: CommandRiskRules::default(),
        }
    }

    // ── Command validation ──

    /// Check if a command is blocked by the blacklist.
    ///
    /// Returns `Err` if the command matches any entry in `blocked_commands`.
    /// Also blocks dangerous shell injection operators.
    pub fn is_command_blocked(&self, command: &str) -> Result<(), String> {
        // ReadOnly blocks everything
        if self.autonomy == AutonomyLevel::ReadOnly {
            return Err("Agent is in read-only mode — command execution is disabled.".into());
        }

        if let Some(substitution) = executable_substitution(command) {
            return Err(shell_substitution_denial_reason(substitution));
        }

        // If no blocked commands configured, allow all
        if self.blocked_commands.is_empty() {
            return Ok(());
        }

        let normalized = normalize_command_pipeline(command);

        for segment in normalized.split('\x00') {
            let trimmed = segment.trim();
            if trimmed.is_empty() {
                continue;
            }

            // Strip leading env-var assignments (FOO=bar CMD ...)
            let cmd_part = skip_env_assignments(trimmed);
            if cmd_part.is_empty() {
                continue;
            }

            // Extract the base command name (after last /)
            let base_cmd = cmd_part
                .split_whitespace()
                .next()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("");

            if base_cmd.is_empty() {
                continue;
            }

            // Check if base command is in the blocklist
            if self
                .blocked_commands
                .iter()
                .any(|blocked| blocked == base_cmd)
            {
                return Err(format!(
                    "Command '{}' is blocked by security policy.",
                    base_cmd
                ));
            }
        }

        Ok(())
    }

    /// Check if a command requires user confirmation.
    ///
    /// Returns `Some(reason)` if the command matches any entry in `confirmation_commands`.
    /// Matches "cmd" (any subcommand), "cmd subcmd" (specific subcommand), and
    /// longer token patterns such as "git push --force".
    pub fn requires_confirmation(&self, command: &str) -> Option<String> {
        if self.confirmation_commands.is_empty() {
            return None;
        }

        let normalized = normalize_command_pipeline(command);

        for segment in normalized.split('\x00') {
            let trimmed = segment.trim();
            if trimmed.is_empty() {
                continue;
            }

            let cmd_part = skip_env_assignments(trimmed);
            let parts: Vec<&str> = cmd_part.split_whitespace().collect();
            if parts.is_empty() {
                continue;
            }

            let base_cmd = parts[0].rsplit('/').next().unwrap_or("");

            for confirm_pattern in &self.confirmation_commands {
                if command_pattern_matches(confirm_pattern, base_cmd, &parts) {
                    return Some(format!(
                        "\"{}\" requires confirmation before execution.",
                        crate::utils::safe_truncate_chars_to_string(&trimmed, 120)
                    ));
                }
            }
        }

        None
    }

    /// Classify the risk level of a command.
    ///
    /// Returns the highest risk level found across all pipeline segments.
    pub fn command_risk_level(&self, command: &str) -> CommandRiskLevel {
        let normalized = normalize_command_pipeline(command);

        let mut highest = CommandRiskLevel::Low;

        for segment in normalized.split('\x00') {
            let trimmed = segment.trim();
            if trimmed.is_empty() {
                continue;
            }

            let cmd_part = skip_env_assignments(trimmed);
            let base_cmd = cmd_part
                .split_whitespace()
                .next()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("");

            let risk = classify_command_with_rules(base_cmd, cmd_part, &self.risk_rules);
            if risk == CommandRiskLevel::High {
                return CommandRiskLevel::High; // short-circuit
            }
            if risk == CommandRiskLevel::Medium {
                highest = CommandRiskLevel::Medium;
            }
        }

        highest
    }

    /// Full validation: blocklist + confirmation + risk + autonomy.
    ///
    /// Call this before executing any shell command. The `approved` flag
    /// indicates whether the user has already approved this specific command
    /// (for always-ask command policy flows).
    pub fn validate_command_execution(&self, command: &str, approved: bool) -> ValidationResult {
        // Step 1: Check blocklist first — blocked commands are always denied
        if let Err(reason) = self.is_command_blocked(command) {
            return ValidationResult::Denied(reason);
        }

        // Step 2: Check explicit confirmation patterns.
        if !approved {
            if let Some(reason) = self.requires_confirmation(command) {
                let risk = self.command_risk_level(command);
                return ValidationResult::NeedsApproval(risk, reason);
            }
        }

        // Step 3: Classify risk for command-policy checks.
        let risk = self.command_risk_level(command);

        match risk {
            CommandRiskLevel::High => {
                if self.block_high_risk_commands {
                    return ValidationResult::Denied(format!(
                        "Command blocked by security policy: {}",
                        command
                    ));
                }
            }
            CommandRiskLevel::Medium => {
                if !approved {
                    return ValidationResult::NeedsApproval(
                        risk,
                        format!("Command requires approval: {}", command),
                    );
                }
            }
            CommandRiskLevel::Low => {}
        }

        ValidationResult::Allowed(risk)
    }
}

impl std::fmt::Debug for SecurityPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecurityPolicy")
            .field("autonomy", &self.autonomy)
            .field("workspace_only", &self.workspace_only)
            .field("blocked_commands_count", &self.blocked_commands.len())
            .field(
                "confirmation_commands_count",
                &self.confirmation_commands.len(),
            )
            .field("forbidden_paths_count", &self.forbidden_paths.len())
            .field("block_high_risk_commands", &self.block_high_risk_commands)
            .field("medium_risk_rules_count", &self.risk_rules.medium.len())
            .field("high_risk_rules_count", &self.risk_rules.high.len())
            .finish()
    }
}

// ============================================
// Helpers
// ============================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellSubstitution {
    Backtick,
    Command,
    Parameter,
}

fn shell_substitution_denial_reason(substitution: ShellSubstitution) -> String {
    let operator = match substitution {
        ShellSubstitution::Backtick => "Backtick subshell operators",
        ShellSubstitution::Command => "$() subshell operators",
        ShellSubstitution::Parameter => "${} parameter expansion",
    };
    format!(
        "{operator} are not allowed in run_shell commands. This is a shell-injection guard, not an agent autonomy/tool permission setting. If you need literal backticks or code fences, put the content in a single-quoted heredoc (for example: <<'EOF') or use edit_file/write_file instead of embedding it in an executable shell command."
    )
}

fn executable_substitution(command: &str) -> Option<ShellSubstitution> {
    let bytes = command.as_bytes();
    let mut index = 0;
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut heredoc_until: Option<String> = None;
    let mut at_line_start = true;

    while index < bytes.len() {
        if let Some(delimiter) = heredoc_until.as_deref() {
            let line_end = command[index..]
                .find('\n')
                .map(|offset| index + offset)
                .unwrap_or(bytes.len());
            let line = command[index..line_end].trim_end_matches('\r');
            if line == delimiter {
                heredoc_until = None;
            }
            index = (line_end + 1).min(bytes.len());
            at_line_start = true;
            continue;
        }

        // `index` advances byte-by-byte and may sit inside a multi-byte UTF-8
        // char; slicing `command[index..]` there panics. All shell syntax we
        // care about is ASCII, so non-boundary bytes can be skipped outright.
        if !command.is_char_boundary(index) {
            index += 1;
            at_line_start = false;
            continue;
        }

        if !in_single_quote && !in_double_quote {
            if let Some((delimiter, body_start)) = quoted_heredoc_start(&command[index..]) {
                heredoc_until = Some(delimiter);
                index += body_start;
                at_line_start = true;
                continue;
            }
        }

        let byte = bytes[index];
        match byte {
            b'\\' => {
                index = (index + 2).min(bytes.len());
                at_line_start = false;
                continue;
            }
            b'\'' if !in_double_quote => {
                in_single_quote = !in_single_quote;
            }
            b'"' if !in_single_quote => {
                in_double_quote = !in_double_quote;
            }
            b'`' if !in_single_quote => return Some(ShellSubstitution::Backtick),
            b'$' if !in_single_quote && index + 1 < bytes.len() => match bytes[index + 1] {
                b'(' => return Some(ShellSubstitution::Command),
                b'{' => return Some(ShellSubstitution::Parameter),
                _ => {}
            },
            b'\n' => {
                at_line_start = true;
                index += 1;
                continue;
            }
            _ => {}
        }

        if !byte.is_ascii_whitespace() || !at_line_start {
            at_line_start = false;
        }
        index += 1;
    }

    None
}

fn quoted_heredoc_start(input: &str) -> Option<(String, usize)> {
    let marker = input.strip_prefix("<<")?;
    let marker = marker.strip_prefix('-').unwrap_or(marker).trim_start();
    let quote = marker.as_bytes().first().copied()?;
    if quote != b'\'' && quote != b'"' {
        return None;
    }

    let rest = &marker[1..];
    let end_quote = rest.find(quote as char)?;
    let delimiter = &rest[..end_quote];
    if delimiter.is_empty() {
        return None;
    }

    let after = &rest[end_quote + 1..];
    let newline = after.find('\n')?;
    let consumed = input.len() - after[newline + 1..].len();
    Some((delimiter.to_string(), consumed))
}

/// Skip leading environment variable assignments in a command segment.
///
/// `FOO=bar BAZ=qux git commit` → `git commit`
pub(crate) fn skip_env_assignments(segment: &str) -> &str {
    let mut rest = segment;
    loop {
        let trimmed = rest.trim_start();
        // Check if the next token looks like VAR=value
        if let Some(eq_pos) = trimmed.find('=') {
            let before_eq = &trimmed[..eq_pos];
            // Must be a valid identifier (alphanumeric + underscore, not starting with digit)
            if !before_eq.is_empty()
                && before_eq
                    .chars()
                    .all(|ch| ch.is_alphanumeric() || ch == '_')
                && !before_eq.starts_with(|ch: char| ch.is_ascii_digit())
            {
                // Skip past the value (next whitespace-delimited token)
                let after_eq = &trimmed[eq_pos + 1..];
                // Value might be quoted
                if let Some(after_dq) = after_eq.strip_prefix('"') {
                    if let Some(end_quote) = after_dq.find('"') {
                        rest = &after_dq[end_quote + 1..];
                        continue;
                    }
                } else if let Some(after_sq) = after_eq.strip_prefix('\'') {
                    if let Some(end_quote) = after_sq.find('\'') {
                        rest = &after_sq[end_quote + 1..];
                        continue;
                    }
                }
                // Unquoted value: skip to next whitespace
                match after_eq.find(char::is_whitespace) {
                    Some(ws_pos) => {
                        rest = &after_eq[ws_pos..];
                        continue;
                    }
                    None => return "", // entire segment is env assignments
                }
            }
        }
        return trimmed;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_denies_write_tools() {
        let tools = AutonomyLevel::ReadOnly.deny_tools();
        assert!(tools.contains(&"run_shell".to_string()));
        assert!(tools.contains(&"edit_file".to_string()));
        assert!(tools.contains(&"apply_patch".to_string()));
    }

    #[test]
    fn read_write_ask_and_deny_tools_empty() {
        assert!(AutonomyLevel::Full.ask_tools().is_empty());
        assert!(AutonomyLevel::Full.deny_tools().is_empty());
    }

    #[test]
    fn default_autonomy_is_full() {
        assert_eq!(AutonomyLevel::default(), AutonomyLevel::Full);
    }

    #[test]
    fn configured_forbidden_path_denies_access() {
        let policy = SecurityPolicy::new(
            AutonomyLevel::Full,
            false,
            Vec::new(),
            Vec::new(),
            vec!["~/.ssh".to_string()],
            false,
            CommandRiskRules::default(),
        );

        assert!(policy.validate_path_syntax("~/.ssh/config").is_err());
    }

    #[test]
    fn full_autonomy_allows_plain_git_push_by_default() {
        let policy = SecurityPolicy::new(
            AutonomyLevel::Full,
            false,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            false,
            CommandRiskRules::default(),
        );

        assert!(matches!(
            policy.validate_command_execution("git push origin main", false),
            ValidationResult::Allowed(CommandRiskLevel::Low)
        ));
    }

    #[test]
    fn full_autonomy_allows_literal_backticks_inside_single_quotes() {
        let policy = SecurityPolicy::permissive();

        assert!(matches!(
            policy.validate_command_execution("python -c 'print(`not shell`)'", false),
            ValidationResult::Allowed(CommandRiskLevel::Low)
        ));
    }

    #[test]
    fn full_autonomy_allows_literal_backticks_in_quoted_heredoc_body() {
        let policy = SecurityPolicy::permissive();
        let command = "python <<'PY'\nprint(`not shell`)\nPY";

        assert!(matches!(
            policy.validate_command_execution(command, false),
            ValidationResult::Allowed(CommandRiskLevel::Low)
        ));
    }

    #[test]
    fn substitution_scan_handles_multibyte_chars_without_panicking() {
        let policy = SecurityPolicy::permissive();
        let command = "echo ===MenuRows mode 部分===; sed -n '90,130p' file.tsx";

        assert!(matches!(
            policy.validate_command_execution(command, false),
            ValidationResult::Allowed(CommandRiskLevel::Low)
        ));

        assert!(matches!(
            policy.validate_command_execution("echo 部分 $(whoami)", false),
            ValidationResult::Denied(reason) if reason.contains("$() subshell")
        ));
    }

    #[test]
    fn full_autonomy_still_denies_executable_subshells() {
        let policy = SecurityPolicy::permissive();

        assert!(matches!(
            policy.validate_command_execution("echo `whoami`", false),
            ValidationResult::Denied(reason) if reason.contains("Backtick subshell")
        ));
        assert!(matches!(
            policy.validate_command_execution("echo $(whoami)", false),
            ValidationResult::Denied(reason) if reason.contains("$() subshell")
        ));
        assert!(matches!(
            policy.validate_command_execution("echo ${HOME}", false),
            ValidationResult::Denied(reason) if reason.contains("parameter expansion")
        ));
    }

    #[test]
    fn full_autonomy_denies_subshells_inside_double_quotes() {
        let policy = SecurityPolicy::permissive();

        assert!(matches!(
            policy.validate_command_execution("echo \"`whoami`\"", false),
            ValidationResult::Denied(reason) if reason.contains("Backtick subshell")
        ));
    }

    #[test]
    fn shell_substitution_denial_explains_not_autonomy_permission() {
        let policy = SecurityPolicy::permissive();

        let result = policy.validate_command_execution("echo `whoami`", false);
        match result {
            ValidationResult::Denied(reason) => {
                assert!(reason.contains("shell-injection guard"));
                assert!(reason.contains("not an agent autonomy/tool permission"));
                assert!(reason.contains("single-quoted heredoc"));
                assert!(reason.contains("edit_file/write_file"));
            }
            other => panic!("expected denial, got {other:?}"),
        }
    }

    #[test]
    fn custom_risk_rules_classify_always_ask_command() {
        let policy = SecurityPolicy::new(
            AutonomyLevel::Full,
            false,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            false,
            CommandRiskRules {
                medium: vec!["git status".to_string()],
                high: Vec::new(),
            },
        );

        assert!(matches!(
            policy.validate_command_execution("git status", false),
            ValidationResult::NeedsApproval(CommandRiskLevel::Medium, _)
        ));
    }

    #[test]
    fn confirmation_patterns_match_flags_after_arguments() {
        let policy = SecurityPolicy::new(
            AutonomyLevel::Full,
            false,
            Vec::new(),
            vec!["git push --force".to_string()],
            Vec::new(),
            false,
            CommandRiskRules {
                medium: Vec::new(),
                high: Vec::new(),
            },
        );

        assert!(matches!(
            policy.validate_command_execution("git push origin main --force", false),
            ValidationResult::NeedsApproval(_, _)
        ));
        assert!(matches!(
            policy.validate_command_execution("git push origin main", false),
            ValidationResult::Allowed(CommandRiskLevel::Low)
        ));
    }

    #[test]
    fn custom_risk_rules_classify_high_command() {
        let policy = SecurityPolicy::new(
            AutonomyLevel::Full,
            false,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            true,
            CommandRiskRules {
                medium: Vec::new(),
                high: vec!["git status".to_string()],
            },
        );

        assert!(matches!(
            policy.validate_command_execution("git status", false),
            ValidationResult::Denied(_)
        ));
    }
}
