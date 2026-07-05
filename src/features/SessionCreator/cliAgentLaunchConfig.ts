import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";

export type CliLaunchSurface = "gui" | "tui";

export const CLI_AGENT_GUI_DEFAULT_LAUNCH_ARGS: Partial<
  Record<CliAgentType, string>
> = {
  claude_code: "--dangerously-skip-permissions",
  cursor_cli: "--force --approve-mcps",
  gemini_cli: "--yolo",
  copilot: "--allow-all-tools --no-ask-user",
  opencode: "",
  kiro: "",
};

export const CLI_AGENT_TUI_DEFAULT_LAUNCH_ARGS: Partial<
  Record<CliAgentType, string>
> = {
  claude_code: "--dangerously-skip-permissions",
  cursor_cli: "--yolo",
  gemini_cli: "--yolo",
  copilot: "--yolo",
  opencode: "",
  kiro: "--trust-all-tools",
};

export const CLI_AGENT_GUI_COMMAND_LABELS: Partial<
  Record<CliAgentType, string>
> = {
  claude_code: "claude --output-format stream-json --verbose",
  cursor_cli: "cursor-agent agent --output-format stream-json",
  codex: "codex exec --json --skip-git-repo-check --sandbox workspace-write",
  gemini_cli: "gemini --output-format stream-json",
  copilot: "copilot --acp",
  opencode: "opencode acp",
  kiro: "kiro acp",
};

export const CLI_AGENT_TUI_COMMAND_LABELS: Partial<
  Record<CliAgentType, string>
> = {
  claude_code: "claude",
  cursor_cli: "cursor",
  codex: "codex",
  gemini_cli: "gemini",
  copilot: "copilot",
  opencode: "opencode",
  kiro: "kiro-cli-chat",
};

export const CLI_AGENT_DOCS_URLS: Partial<Record<CliAgentType, string>> = {
  claude_code: "https://docs.anthropic.com/claude/docs/claude-code",
  codex: "https://github.com/openai/codex",
  gemini_cli: "https://github.com/google-gemini/gemini-cli",
  cursor_cli: "https://cursor.com/cli",
  copilot:
    "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
  opencode: "https://opencode.ai/docs/cli/",
  kiro: "https://kiro.dev/docs/cli/",
  openclaude: "https://openclaude.gitlawb.com/",
  aider: "https://aider.chat/docs/",
  goose: "https://block.github.io/goose/docs/quickstart/",
  amp: "https://ampcode.com/manual#install",
  cline: "https://docs.cline.bot/cline-cli/overview",
  kilo: "https://kilo.ai/docs/cli",
  grok_cli: "https://x.ai/cli",
  devin: "https://devin.ai/cli",
  rovo: "https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/",
  hermes: "https://hermes-agent.nousresearch.com/docs/",
  openclaw: "https://github.com/openclaw/openclaw",
  crush: "https://github.com/charmbracelet/crush",
  aug: "https://docs.augmentcode.com/cli/overview",
  codebuff: "https://www.codebuff.com/docs/help/quick-start",
  command_code: "https://commandcode.ai/docs/quickstart",
  qwen_code: "https://github.com/QwenLM/qwen-code",
  mimo_code: "https://mimo.xiaomi.com/coder",
  antigravity: "https://antigravity.google/docs/cli-overview",
  continue_cli: "https://docs.continue.dev/guides/cli",
  droid: "https://docs.factory.ai/cli/getting-started/quickstart",
  mistral_vibe: "https://github.com/mistralai/mistral-vibe",
  ante: "https://github.com/AntigmaLabs/ante-preview",
  autohand: "https://github.com/autohandai/code-cli",
  omp: "https://omp.sh",
  pi: "https://pi.dev",
  kimi_cli:
    "https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html",
};

export function getCliAgentDefaultLaunchArgs(
  agent: CliAgentType | undefined,
  surface: CliLaunchSurface
): string {
  if (!agent) return "";
  const defaults =
    surface === "gui"
      ? CLI_AGENT_GUI_DEFAULT_LAUNCH_ARGS
      : CLI_AGENT_TUI_DEFAULT_LAUNCH_ARGS;
  return defaults[agent] ?? "";
}

export function getCliAgentCommandLabel(
  agent: CliAgentType | undefined,
  surface: CliLaunchSurface,
  tuiCommand?: string
): string {
  if (!agent) return "";
  if (surface === "tui" && tuiCommand?.trim()) return tuiCommand.trim();
  const labels =
    surface === "gui"
      ? CLI_AGENT_GUI_COMMAND_LABELS
      : CLI_AGENT_TUI_COMMAND_LABELS;
  return labels[agent] ?? agent;
}

export function getCliAgentDocsUrl(
  agent: CliAgentType | undefined
): string | undefined {
  return agent ? CLI_AGENT_DOCS_URLS[agent] : undefined;
}

export interface CliLaunchArgsValidationResult {
  valid: boolean;
  validated: boolean;
  message?: string;
  severity?: "error" | "warning";
}

const OPENCODE_ACP_BOOLEAN_FLAGS = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
  "--print-logs",
  "--pure",
  "--mdns",
]);

const OPENCODE_ACP_VALUE_FLAGS = new Set([
  "--port",
  "--hostname",
  "--mdns-domain",
  "--cors",
  "--cwd",
]);

const OPENCODE_ACP_LOG_LEVELS = new Set(["DEBUG", "INFO", "WARN", "ERROR"]);

export function parseCliLaunchArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

export function quoteCliArg(arg: string): string {
  if (!arg) return '""';
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function appendCliArgsToCommand(command: string, args: string): string {
  const tokens = parseCliLaunchArgs(args);
  if (tokens.length === 0) return command.trim();
  return `${command.trim()} ${tokens.map(quoteCliArg).join(" ")}`;
}

function validateOpenCodeAcpLaunchArgs(
  value: string
): CliLaunchArgsValidationResult {
  const tokens = parseCliLaunchArgs(value.trim());
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (OPENCODE_ACP_BOOLEAN_FLAGS.has(token)) continue;

    if (token === "--log-level") {
      const level = tokens[index + 1];
      if (!level || level.startsWith("-")) {
        return {
          valid: false,
          validated: true,
          severity: "error",
          message: "--log-level requires a value: DEBUG, INFO, WARN, or ERROR",
        };
      }
      if (!OPENCODE_ACP_LOG_LEVELS.has(level)) {
        return {
          valid: false,
          validated: true,
          severity: "error",
          message: "--log-level must be one of DEBUG, INFO, WARN, ERROR",
        };
      }
      index += 1;
      continue;
    }

    if (OPENCODE_ACP_VALUE_FLAGS.has(token)) {
      const next = tokens[index + 1];
      if (!next || next.startsWith("-")) {
        return {
          valid: false,
          validated: true,
          severity: "error",
          message: `${token} requires a value`,
        };
      }
      if (token === "--port" && !/^\d+$/.test(next)) {
        return {
          valid: false,
          validated: true,
          severity: "error",
          message: "--port requires a numeric value",
        };
      }
      index += 1;
      continue;
    }

    return {
      valid: false,
      validated: true,
      severity: "error",
      message: `Unknown OpenCode ACP argument: ${token}`,
    };
  }

  return { valid: true, validated: true };
}

export function validateCliLaunchArgs(
  agent: CliAgentType | undefined,
  surface: CliLaunchSurface,
  value: string
): CliLaunchArgsValidationResult {
  if (agent === "opencode" && surface === "gui") {
    return validateOpenCodeAcpLaunchArgs(value);
  }
  return { valid: true, validated: false };
}
