/* global describe, before, it */
import {
  CLAUDE_CODE_AGENT_TYPE,
  CODEX_AGENT_TYPE,
  CURSOR_AGENT_TYPE,
  PREFERRED_CLAUDE_CODE_MODEL_ID,
  PREFERRED_CODEX_MODEL_ID,
  PREFERRED_API_MODEL_ID,
  CURSOR_NATIVE_MODEL_ID,
  CURSOR_CLI_MODEL_ID,
  CURSOR_NATIVE_HARNESS_TYPE,
  GEMINI_MODEL_CHAIN,
  PROMPT_PREFIX,
  getApiAccount,
  getClaudeCodeAccount,
  getCodexAccount,
  getCursorCliAccount,
  getCursorNativeAccount,
  getGeminiAccount,
  runRenderedToolScenario,
  selectModelFromChain,
  selectPreferredModel,
  waitForApp,
} from "../../support/core/session/sessionMatrixDriver.mjs";

describe("Live rendered UI tool-call matrix", () => {
  let claudeCodeAccount;
  let cursorNativeAccount;
  let cursorCliAccount;
  let codexAccount;
  let geminiAccount;
  let apiAccount;

  before(async () => {
    await waitForApp();
    claudeCodeAccount = await getClaudeCodeAccount();
    cursorNativeAccount = await getCursorNativeAccount();
    cursorCliAccount = await getCursorCliAccount();
    codexAccount = await getCodexAccount();
    geminiAccount = await getGeminiAccount();
    apiAccount = await getApiAccount();
  });

  it("renders tool UI for Claude Code through Rust native", async function () {
    await runRenderedToolScenario(
      {
        label: "cc-rust-native",
        account: claudeCodeAccount,
        model: selectPreferredModel(
          claudeCodeAccount,
          PREFERRED_CLAUDE_CODE_MODEL_ID
        ),
        category: "rust_agent",
        agentDefinitionId: "builtin:sde",
        expectedToolNames: ["read_file", "Read", "list_dir", "Ls", "Glob"],
        sessionIdPattern: /^sdeagent-|^osagent-|^agent-|^rustagent-/,
        prompt: `${PROMPT_PREFIX}_CC_RUST You must call the read_file tool exactly once with path "package.json" before answering. Then reply with the package name you found and mention Rust native.`,
      },
      this
    );
  });

  it("renders tool UI for Claude Code through CLI agent", async function () {
    await runRenderedToolScenario(
      {
        label: "cc-cli-agent",
        account: claudeCodeAccount,
        model: selectPreferredModel(
          claudeCodeAccount,
          PREFERRED_CLAUDE_CODE_MODEL_ID
        ),
        category: "cli_agent",
        cliAgentType: CLAUDE_CODE_AGENT_TYPE,
        expectedToolNames: ["Shell", "run_shell", "Bash"],
        sessionIdPattern: /^cliagent-/,
        prompt: `${PROMPT_PREFIX}_CC_CLI Run exactly one read-only shell command to print the package name from package.json in the current workspace before answering. Then reply with the package name you found and mention Claude Code CLI.`,
      },
      this
    );
  });

  it("renders tool UI for Codex through Rust native", async function () {
    await runRenderedToolScenario(
      {
        label: "codex-rust-native",
        account: codexAccount,
        model: selectPreferredModel(codexAccount, PREFERRED_CODEX_MODEL_ID),
        category: "rust_agent",
        agentDefinitionId: "builtin:sde",
        expectedToolNames: ["read_file", "Read", "list_dir", "Ls", "Glob"],
        sessionIdPattern: /^sdeagent-|^osagent-|^agent-|^rustagent-/,
        prompt: `${PROMPT_PREFIX}_CODEX_RUST You must call the read_file tool exactly once with path "package.json" before answering. Then reply with the package name you found and mention Codex Rust native.`,
      },
      this
    );
  });

  it("renders tool UI for Codex through CLI agent", async function () {
    await runRenderedToolScenario(
      {
        label: "codex-cli-agent",
        account: codexAccount,
        model: selectPreferredModel(codexAccount, PREFERRED_CODEX_MODEL_ID),
        category: "cli_agent",
        cliAgentType: CODEX_AGENT_TYPE,
        expectedToolNames: ["Shell", "run_shell", "command_execution"],
        sessionIdPattern: /^cliagent-/,
        prompt: `${PROMPT_PREFIX}_CODEX_CLI Run exactly one read-only shell command to print the package name from package.json in the current workspace before answering. Then reply with the package name you found and mention Codex CLI.`,
      },
      this
    );
  });

  it("renders tool UI for Cursor through Rust native", async function () {
    const model = (cursorNativeAccount.enabled_models ?? []).includes(
      CURSOR_NATIVE_MODEL_ID
    )
      ? CURSOR_NATIVE_MODEL_ID
      : cursorNativeAccount.enabled_models[0];
    await runRenderedToolScenario(
      {
        label: "cursor-rust-native",
        account: cursorNativeAccount,
        model,
        category: "rust_agent",
        agentDefinitionId: "builtin:sde",
        nativeHarnessType: CURSOR_NATIVE_HARNESS_TYPE,
        expectedToolNames: ["read_file", "Read", "list_dir", "Ls", "Glob"],
        sessionIdPattern: /^sdeagent-|^osagent-|^agent-|^rustagent-/,
        prompt: `${PROMPT_PREFIX}_CURSOR_RUST You must call the read_file tool exactly once with path "package.json" before answering. Then reply with the package name you found and mention Cursor Rust native.`,
      },
      this
    );
  });

  it("renders tool UI for Cursor CLI agent", async function () {
    const model = (cursorCliAccount.enabled_models ?? []).includes(
      CURSOR_CLI_MODEL_ID
    )
      ? CURSOR_CLI_MODEL_ID
      : cursorCliAccount.enabled_models[0];
    await runRenderedToolScenario(
      {
        label: "cursor-cli-agent",
        account: cursorCliAccount,
        model,
        category: "cli_agent",
        cliAgentType: CURSOR_AGENT_TYPE,
        expectedToolNames: ["Shell", "run_shell", "terminal_execute"],
        sessionIdPattern: /^cliagent-/,
        prompt: `${PROMPT_PREFIX}_CURSOR_CLI Run exactly one read-only shell command to print the package name from package.json in the current workspace before answering. Then reply with the package name you found and mention Cursor CLI.`,
      },
      this
    );
  });

  it("renders tool UI for Gemini through Rust native", async function () {
    await runRenderedToolScenario(
      {
        label: "gemini-rust-native",
        account: geminiAccount,
        model: selectModelFromChain(geminiAccount, GEMINI_MODEL_CHAIN),
        category: "rust_agent",
        agentDefinitionId: "builtin:sde",
        expectedToolNames: ["read_file", "Read", "list_dir", "Ls", "Glob"],
        sessionIdPattern: /^sdeagent-|^osagent-|^agent-|^rustagent-/,
        prompt: `${PROMPT_PREFIX}_GEMINI_RUST You must call the read_file tool exactly once with path "package.json" before answering. Then reply with the package name you found and mention Gemini Rust native.`,
      },
      this
    );
  });

  it("renders tool UI for API account through Rust agent", async function () {
    await runRenderedToolScenario(
      {
        label: "openai-api-rust-agent",
        account: apiAccount,
        model: selectPreferredModel(apiAccount, PREFERRED_API_MODEL_ID),
        category: "rust_agent",
        agentDefinitionId: "builtin:sde",
        expectedToolNames: ["read_file", "Read", "list_dir", "Ls", "Glob"],
        sessionIdPattern: /^sdeagent-|^osagent-|^agent-|^rustagent-/,
        prompt: `${PROMPT_PREFIX}_API_RUST You must call the read_file tool exactly once with path "package.json" before answering. Then reply with the package name you found and mention the API Rust agent.`,
      },
      this
    );
  });

});
