/* global describe, before, it */
/**
 * mcp-injection-live.spec.mjs
 *
 * Live rendered coverage for MCP injection into external CLI sessions:
 * servers from `.orgii/mcp-servers.json` must reach the spawned CLI
 * (claude `--mcp-config`, codex `-c mcp_servers.*`) so the agent can
 * actually SEE and CALL the tool. The probe server is a dependency-free
 * Node stdio JSON-RPC stub exposing one tool (`orgii_probe_ping`) whose
 * reply carries a marker string; the scenario passes only when the
 * rendered transcript shows the MCP tool block AND the assistant echoes
 * the marker — proving config resolution, transport wiring, spawn-time
 * injection, and the tool round-trip on the production session path.
 *
 * The probe server is written into the E2E ORGII home's global
 * `mcp-servers.json` in `before` (deterministic precondition); the
 * session launch, prompt send, tool call, and reply all ride the
 * production creator path.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_CODE_AGENT_TYPE,
  CODEX_AGENT_TYPE,
  PREFERRED_CLAUDE_CODE_MODEL_ID,
  PREFERRED_CODEX_MODEL_ID,
  PROMPT_PREFIX,
  getClaudeCodeAccount,
  getCodexAccount,
  runRenderedToolScenario,
  selectPreferredModel,
  waitForApp,
} from "../../support/core/session/sessionMatrixDriver.mjs";

const RUN_ID = Date.now();
const PROBE_SERVER = "orgii-probe";
const PROBE_TOOL = "orgii_probe_ping";
const PROBE_MARKER = "ORGII-MCP-PROBE-OK-20260821";

const PROBE_SOURCE = `const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
const TOOL = {
  name: ${JSON.stringify(PROBE_TOOL)},
  description: "ORGII MCP injection live-test probe. Call to receive the probe marker.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: {
      protocolVersion: (req.params && req.params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: ${JSON.stringify(PROBE_SERVER)}, version: "1.0.0" },
    } });
  } else if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [TOOL] } });
  } else if (req.method === "tools/call") {
    send({ jsonrpc: "2.0", id: req.id, result: {
      content: [{ type: "text", text: ${JSON.stringify(PROBE_MARKER)} }],
    } });
  } else if (req.method === "ping") {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  } else if (typeof req.id !== "undefined") {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } });
  }
});`;

function orgiiHome() {
  return process.env.E2E_ORGII_HOME || join(homedir(), ".orgii");
}

function seedProbeServer() {
  const home = orgiiHome();
  const probeDir = join(home, ".tmp", "mcp-injection-e2e");
  mkdirSync(probeDir, { recursive: true });
  const probePath = join(probeDir, `probe-server-${RUN_ID}.cjs`);
  writeFileSync(probePath, PROBE_SOURCE);
  const configPath = join(home, "mcp-servers.json");
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[PROBE_SERVER] = {
    type: "stdio",
    command: process.execPath,
    args: [probePath],
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * The driver can sample the assistant reply while it still renders a
 * loading placeholder; the marker must be asserted against the SETTLED
 * rendered chat body, not the first sampled text.
 */
async function waitForRenderedMarker(firstSample) {
  if ((firstSample ?? "").includes(PROBE_MARKER)) return;
  await browser.waitUntil(
    async () => {
      const body = await browser.executeScript(
        "return document.body.innerText || '';",
        []
      );
      return body.includes(PROBE_MARKER);
    },
    {
      timeout: 30_000,
      timeoutMsg: `Probe marker ${PROBE_MARKER} never rendered in the chat body`,
    }
  );
}

describe("MCP injection into external CLI sessions (live)", () => {
  before(async () => {
    await waitForApp();
    seedProbeServer();
  });

  it("claude-code CLI session sees and calls the injected MCP tool", async function () {
    let claudeCodeAccount;
    try {
      claudeCodeAccount = await getClaudeCodeAccount();
    } catch (error) {
      console.warn(
        `[mcp-inject] BLOCKED: no usable Claude Code OAuth account: ${String(error?.message ?? error).slice(0, 300)}`
      );
      this.skip();
      return;
    }
    const result = await runRenderedToolScenario(
      {
        label: "mcp-inject-cc-cli",
        account: claudeCodeAccount,
        model: selectPreferredModel(
          claudeCodeAccount,
          PREFERRED_CLAUDE_CODE_MODEL_ID
        ),
        category: "cli_agent",
        cliAgentType: CLAUDE_CODE_AGENT_TYPE,
        expectedToolNames: [
          `mcp__${PROBE_SERVER}__${PROBE_TOOL}`,
          PROBE_TOOL,
        ],
        sessionIdPattern: /^cliagent-/,
        prompt: `${PROMPT_PREFIX}_MCP_CC You must call the MCP tool ${PROBE_TOOL} (from the ${PROBE_SERVER} MCP server) exactly once before answering. Then reply with the exact text the tool returned and nothing else.`,
      },
      this
    );
    if (result.status === "passed") {
      await waitForRenderedMarker(result.assistantText);
    }
  });

  it("codex CLI session sees and calls the injected MCP tool", async function () {
    let codexAccount;
    try {
      codexAccount = await getCodexAccount();
    } catch (error) {
      console.warn(
        `[mcp-inject] BLOCKED: no usable Codex account: ${String(error?.message ?? error).slice(0, 300)}`
      );
      this.skip();
      return;
    }
    const result = await runRenderedToolScenario(
      {
        label: "mcp-inject-codex-cli",
        account: codexAccount,
        model: selectPreferredModel(codexAccount, PREFERRED_CODEX_MODEL_ID),
        category: "cli_agent",
        cliAgentType: CODEX_AGENT_TYPE,
        expectedToolNames: [
          `mcp__${PROBE_SERVER}__${PROBE_TOOL}`,
          `${PROBE_SERVER}.${PROBE_TOOL}`,
          `${PROBE_SERVER}__${PROBE_TOOL}`,
          PROBE_TOOL,
        ],
        sessionIdPattern: /^cliagent-/,
        prompt: `${PROMPT_PREFIX}_MCP_CODEX You must call the MCP tool ${PROBE_TOOL} (from the ${PROBE_SERVER} MCP server) exactly once before answering. Then reply with the exact text the tool returned and nothing else.`,
      },
      this
    );
    if (result.status === "passed") {
      await waitForRenderedMarker(result.assistantText);
    }
  });
});
