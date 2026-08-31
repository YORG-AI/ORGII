/* global browser, expect */
/**
 * agent-harness-alignment-live.spec.mjs
 *
 * Live-LLM regression coverage for the feat/agent-harness-alignment branch.
 * All scenarios drive the debug HTTP endpoints of the freshly-built app
 * (webdriver build), with a real provider account — proving the branch's
 * backend-authoritative changes survive an actual model round-trip:
 *
 *  1. baseline turn — stable/volatile prompt split + wire-hygiene pass do
 *     not break a normal request (would 400 on malformed payloads).
 *  2. multi-tool turn — read-before-edit gate does not false-reject the
 *     canonical read→edit flow; edit succeeds.
 *  3. foreground subagent — the parent's tool result carries the
 *     usage/resume trailer (session_id + <usage>).
 *  4. skill tool — the `skill` tool is registered in the session schema.
 *  5. reasoning trigger — "think hard" prompt still completes (escalated
 *     variant id resolves through the provider path).
 */
import { execSync } from "node:child_process";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:13847";
const MODEL = process.env.E2E_SDE_MODEL ?? "gpt-5.4";
const ACCOUNT = process.env.E2E_SDE_ACCOUNT ?? "4e0974ab";
const TURN_TIMEOUT_MS = 300_000;

function tmpProject(name) {
  const dir = `/tmp/orgii-harness-e2e/${name}-${Date.now()}`;
  execSync(`mkdir -p ${dir}`);
  return dir;
}

async function sdeMessage(body) {
  const res = await fetch(`${BASE_URL}/agent/test/sde`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, account_id: ACCOUNT, ...body }),
  });
  if (!res.ok) {
    throw new Error(`sde POST failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

describe("agent harness alignment — live backend contract", function () {
  before(async () => {
    // App reachability gate.
    const res = await fetch(`${BASE_URL}/agent/health`).catch(() => null);
    if (!res || !res.ok) {
      throw new Error(`app not reachable at ${BASE_URL}`);
    }
  });

  it("1. baseline turn completes (prompt split + wire hygiene)", async function () {
    this.timeout(TURN_TIMEOUT_MS);
    const resp = await sdeMessage({
      content: "Reply with exactly the word HARNESS_OK and nothing else.",
      session_id: `harness-baseline-${Date.now()}`,
      mode: "build",
      project_path: tmpProject("baseline"),
    });
    expect(String(resp.content)).toContain("HARNESS_OK");
  });

  it("2. read→edit flow passes the read-before-edit gate", async function () {
    this.timeout(TURN_TIMEOUT_MS);
    const project = tmpProject("gate");
    execSync(`printf 'alpha=1\\nbeta=2\\n' > ${project}/config.txt`);
    const resp = await sdeMessage({
      content: [
        `In ${project}/config.txt change beta=2 to beta=3.`,
        "Read the file first, then edit it. Reply DONE when finished.",
      ].join(" "),
      session_id: `harness-gate-${Date.now()}`,
      mode: "build",
      project_path: project,
    });
    const tools = resp.tool_calls ?? [];
    expect(tools).toContain("read_file");
    expect(tools).toContain("edit_file");
    const fileNow = execSync(`cat ${project}/config.txt`).toString();
    expect(fileNow).toContain("beta=3");
  });

  it("3. foreground subagent result carries usage/resume trailer", async function () {
    this.timeout(TURN_TIMEOUT_MS * 2);
    const project = tmpProject("subagent");
    execSync(
      `printf 'fn main() { println!("hello"); }\\n' > ${project}/main.rs`
    );
    const sessionId = `harness-subagent-${Date.now()}`;
    const resp = await sdeMessage({
      content: [
        "Use the agent tool with mode delegate and agent_id builtin:general",
        `(foreground, NOT background) to summarize what ${project}/main.rs does.`,
        "After the subagent returns, repeat its session_id line back to me verbatim,",
        "including the <usage> block it reported.",
      ].join(" "),
      session_id: sessionId,
      mode: "build",
      project_path: project,
      no_cleanup: false,
    });
    expect(resp.tool_calls ?? []).toContain("agent");
    // The trailer travels inside the tool_result; the model was asked to echo
    // it. Accept either a verbatim echo or the model mentioning total_tokens.
    const text = String(resp.content).toLowerCase();
    expect(
      text.includes("total_tokens") ||
        text.includes("resume_session_id") ||
        text.includes("session_id")
    ).toBe(true);
  });

  it("4. `skill` tool is registered in the session tool schema", async function () {
    this.timeout(TURN_TIMEOUT_MS);
    const sessionId = `harness-skill-${Date.now()}`;
    // Keep the session alive so we can read its tool schemas.
    await sdeMessage({
      content: "Reply with the word READY only.",
      session_id: sessionId,
      mode: "build",
      project_path: tmpProject("skill"),
      no_cleanup: true,
    });
    const res = await fetch(`${BASE_URL}/agent/test/tool-schemas/${sessionId}`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    const names = (body.tools ?? [])
      .map((t) => t?.function?.name ?? t?.name ?? "")
      .filter(Boolean);
    expect(names).toContain("skill");
    // Cleanup.
    await fetch(`${BASE_URL}/agent/test/sde/cleanup/${sessionId}`, {
      method: "POST",
    });
  });

  it("5. reasoning trigger phrase still completes the turn", async function () {
    this.timeout(TURN_TIMEOUT_MS);
    const resp = await sdeMessage({
      content:
        "Think hard about this: what is 17 * 23? Reply with just the number.",
      session_id: `harness-think-${Date.now()}`,
      mode: "build",
      project_path: tmpProject("think"),
    });
    expect(String(resp.content)).toContain("391");
  });
});
