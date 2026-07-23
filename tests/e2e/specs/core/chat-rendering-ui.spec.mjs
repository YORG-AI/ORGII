/**
 * chat-rendering-ui.spec.mjs
 *
 * Rendered UI compatibility ledger for Rust tool-call metadata.
 * Pulls the same `list_all_tools` rows used by the app, seeds transcript
 * events through the real EventStore path, and verifies every selected
 * tool sentinel appears in ChatHistory. Tools are checked in small batches so
 * virtualization does not hide off-screen rows from the assertion.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { e2eUrl } from "../../support/core/e2eBaseUrl.mjs";

const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 12_000;
const RUN_ID = Date.now();
const BATCH_SIZE = 6;
const E2E_REPO_PATH =
  process.env.E2E_REPO_PATH ?? "/tmp/orgii-e2e-workspace-repo";
const SCENARIO_FILTER = (process.env.E2E_CHAT_RENDERING_SCENARIOS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function shouldRunScenario(name) {
  return SCENARIO_FILTER.length === 0 || SCENARIO_FILTER.includes(name);
}

const SKIP_CHAT_TOOLS = new Set([
  "agent",
  "create_plan",
  "manage_todo",
  "ask_user_questions",
  "suggest_mode_switch",
  "ask_user_permissions",
  "thinking",
  "agent_message",
  "user_message",
  "subagent",
  "mcp_tool",
  "tool_call",
]);

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function invokeTauriCommand(command, args = {}) {
  const envelope = await browser.executeAsyncScript(
    `
      const cb = arguments[arguments.length - 1];
      const command = arguments[0];
      const args = arguments[1];
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== "function") {
        cb({ ok: false, error: "Tauri invoke is unavailable" });
        return;
      }
      Promise.resolve(invoke(command, args))
        .then((result) => cb({ ok: true, result }))
        .catch((error) => cb({ ok: false, error: String(error?.message || error) }));
    `,
    [command, args]
  );
  if (envelope?.ok !== true) {
    throw new Error(
      `Tauri ${command} failed: ${envelope?.error ?? "unknown error"}`
    );
  }
  return envelope.result;
}

async function waitForFrontendReady() {
  const port = process.env.E2E_FRONTEND_PORT ?? "1998";
  const url = `http://127.0.0.1:${port}`;
  await browser.waitUntil(
    async () => {
      try {
        const response = await fetch(url, { method: "GET" });
        return response.ok;
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: `frontend dev server never became ready at ${url}`,
    }
  );
}

async function postJson(pathname, body) {
  const response = await fetch(e2eUrl(pathname), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `POST ${pathname} returned non-JSON ${response.status}: ${text}`
    );
  }
  if (!response.ok) {
    throw new Error(`POST ${pathname} failed ${response.status}: ${text}`);
  }
  return payload;
}

async function invokeE2E(method, ...args) {
  return browser.executeAsyncScript(
    `
    const cb = arguments[arguments.length - 1];
    const method = arguments[0];
    const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
    if (!window.__e2e || typeof window.__e2e[method] !== "function") {
      cb({ ok: false, error: "window.__e2e." + method + " not available" });
      return;
    }
    Promise.resolve(window.__e2e[method].apply(null, rest))
      .then(cb)
      .catch((e) => cb({ ok: false, error: String(e && e.message || e) }));
  `,
    [method, ...args]
  );
}

function makeUserEvent(sessionId, batchIndex) {
  return {
    id: `user-tool-ledger-${batchIndex}`,
    chunk_id: `user-tool-ledger-${batchIndex}`,
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {
      type: "user",
      message: `Render tool ledger batch ${batchIndex}`,
      is_delta: false,
    },
    source: "user",
    displayText: `Render tool ledger batch ${batchIndex}`,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

function makeToolEvent(sessionId, batchIndex, toolIndex, tool) {
  const sentinel = `TOOL_LEDGER_${batchIndex}_${toolIndex}_${tool.name}`;
  const actionName =
    tool.name === "agent"
      ? "delegate"
      : Array.isArray(tool.actions) && tool.actions.length > 0
        ? tool.actions[0].name
        : "run";
  const args = {
    action: actionName,
    command: `printf '${sentinel}'`,
    query: sentinel,
    path: `/tmp/${tool.name}.txt`,
    content: sentinel,
    url: "https://example.com",
    description: `Delegate ${sentinel}`,
    subagent_type: "explore",
    subagentSessionId: `${sessionId}-child-${toolIndex}`,
    prompt: sentinel,
  };
  const result = {
    success: true,
    status: "completed",
    is_delta: false,
    observation: sentinel,
    output: sentinel,
    stdout: sentinel,
    content: sentinel,
  };

  if (tool.chatBlock === "diff" || tool.name === "apply_patch") {
    args.patch_text = [
      "*** Begin Patch",
      `*** Add File: src/${tool.name}-${batchIndex}-${toolIndex}.ts`,
      `+export const marker = \"${sentinel}\";`,
      "*** End Patch",
    ].join("\n");
    result.content = `Applied patch ${sentinel}`;
    result.observation = result.content;
  }

  if (tool.chatBlock === "sent_message") {
    args.recipient_name = `Recipient ${toolIndex}`;
    args.kind = "plain";
    args.summary = sentinel;
    args.text = sentinel;
  }

  if (tool.name === "read_file") {
    result.content = `export const marker = "${sentinel}";`;
    result.observation = result.content;
  }

  return {
    id: `tool-ledger-${batchIndex}-${toolIndex}-${tool.name}`,
    chunk_id: `tool-ledger-${batchIndex}-${toolIndex}-${tool.name}`,
    sessionId,
    createdAt: new Date(Date.now() + toolIndex).toISOString(),
    functionName: tool.name,
    uiCanonical: tool.name,
    actionType: "tool_call",
    args,
    result,
    source: "assistant",
    displayText: sentinel,
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    isDelta: false,
  };
}

function makeAssistantEvent(sessionId, batchIndex) {
  const content = `Tool render ledger batch ${batchIndex} complete.`;
  return {
    id: `assistant-tool-ledger-${batchIndex}`,
    chunk_id: `assistant-tool-ledger-${batchIndex}`,
    sessionId,
    createdAt: new Date(Date.now() + 10_000).toISOString(),
    functionName: "assistant_message",
    uiCanonical: "agent_message",
    actionType: "assistant",
    args: {},
    result: {
      content,
      observation: content,
      is_delta: false,
      role: "assistant",
    },
    source: "assistant",
    displayText: content,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: false,
  };
}

function renderableToolsFromMetadata(tools) {
  return tools
    .filter(
      (tool) =>
        typeof tool.name === "string" &&
        !tool.hidden &&
        !SKIP_CHAT_TOOLS.has(tool.name)
    )
    .filter(
      (tool) =>
        tool.chatBlock &&
        tool.chatBlock !== "diff" &&
        tool.chatBlock !== "title_only" &&
        tool.appSubtool !== "file_write" &&
        tool.appSubtool !== "todo" &&
        tool.appSubtool !== "other_interactions"
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function waitForApp() {
  await waitForFrontendReady();
  await browser.setTimeout({ script: 5_000 });
  await execJS(`localStorage.setItem('orgii:auth_skipped', '1'); return true;`);
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return document.readyState === 'complete' || document.readyState === 'interactive';`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: "app document never became script-readable",
    }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!document.querySelector('[data-testid="chat-panel"]');`
        );
      } catch {
        return false;
      }
    },
    { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "chat-panel never mounted" }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!(window.__e2e && window.__e2e.seedChatEvents && window.__e2e.listAllTools);`
        );
      } catch {
        return false;
      }
    },
    { timeout: 20_000, timeoutMsg: "window.__e2e tool helpers never exposed" }
  );
}

async function renderedToolState(expectedEntries, assistantText) {
  return execJS(`
    const expectedEntries = ${JSON.stringify(expectedEntries)};
    const assistantText = ${JSON.stringify(assistantText)};
    const body = document.body.innerText || '';
    const history = document.querySelector('[data-testid="chat-message-list"]');
    const renderedToolNames = Array.from(document.querySelectorAll('[data-tool-call-name]'))
      .map((node) => node.getAttribute('data-tool-call-name'))
      .filter(Boolean);
    const missing = expectedEntries.filter((entry) => {
      if (body.includes(entry.sentinel)) return false;
      if (entry.fallbackTexts && entry.fallbackTexts.some((text) => body.includes(text))) return false;
      return !renderedToolNames.includes(entry.name);
    });
    return {
      missing: missing.map((entry) => entry.sentinel),
      renderedToolNames,
      visibleCount: expectedEntries.length - missing.length,
      bodyLength: body.length,
      historyText: history ? history.innerText || '' : '',
      chatHistoryCount: history ? history.getAttribute('data-chat-history-count') : null,
      optimizedCount: history ? history.getAttribute('data-optimized-count') : null,
      flatCount: history ? history.getAttribute('data-flat-count') : null,
      groupCounts: history ? history.getAttribute('data-group-counts') : null,
      assistant: body.includes(assistantText),
    };
  `);
}

async function assertBatchRendered(batchIndex, tools) {
  const sessionId = `e2e-render-tools-${RUN_ID}-${batchIndex}`;
  const baseTime = Date.now();
  const userEvent = {
    ...makeUserEvent(sessionId, batchIndex),
    createdAt: new Date(baseTime).toISOString(),
  };
  const toolEvents = tools.map((tool, toolIndex) => ({
    ...makeToolEvent(sessionId, batchIndex, toolIndex, tool),
    createdAt: new Date(baseTime + 1_000 + toolIndex).toISOString(),
  }));
  const assistantEvent = {
    ...makeAssistantEvent(sessionId, batchIndex),
    createdAt: new Date(baseTime + 10_000).toISOString(),
  };
  const expectedEntries = toolEvents.map((event) => ({
    name: event.functionName,
    sentinel: event.displayText,
    fallbackTexts:
      event.functionName === "read_file"
        ? ["Read 1 file", "1 file", event.args?.path].filter(Boolean)
        : event.functionName === "query_lsp"
          ? ["1 LSP query", "LSP query"]
          : event.functionName === "render_inline_canvas"
            ? ["Agent Preview"]
            : undefined,
  }));
  const assistantText = `Tool render ledger batch ${batchIndex} complete.`;
  const seed = await invokeE2E("seedChatEvents", sessionId, [
    userEvent,
    ...toolEvents,
    assistantEvent,
  ]);
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for batch ${batchIndex}: ${seed?.error ?? "unknown"}`
    );
  }

  try {
    await browser.waitUntil(
      async () => {
        const state = await renderedToolState(expectedEntries, assistantText);
        return state.missing.length === 0 && state.assistant;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: `metadata-ledger batch ${batchIndex} did not render all expected sentinels`,
      }
    );
  } catch (error) {
    const state = await renderedToolState(expectedEntries, assistantText);
    const metadata = tools.map((tool) => ({
      name: tool.name,
      chatBlock: tool.chatBlock,
      appSubtool: tool.appSubtool,
    }));
    throw new Error(`${error.message}: ${JSON.stringify({ state, metadata })}`);
  }

  const finalState = await renderedToolState(expectedEntries, assistantText);
  expect(finalState.missing).toEqual([]);
  expect(finalState.assistant).toBe(true);
}

const DEDUP_SESSION_ID = `e2e-render-dedup-${Date.now()}`;
const DEDUP_THOUGHT_TEXT = "Can we chat?";
const DEDUP_ANSWER_TEXT =
  "可以。我能用中文和你聊天，也能帮你写代码、查资料、解释技术问题，或一起梳理需求。\n\n你想聊什么？";
const ORDER_SESSION_ID = `e2e-render-thinking-order-${Date.now()}`;
const ORDER_TEXTS = {
  userA: "ORDER_USER_A_chat_first",
  thinkA: "ORDER_THINK_A_before_answer",
  answerA: "ORDER_ANSWER_A_after_thinking",
  userB: "ORDER_USER_B_second_turn",
  thinkB: "ORDER_THINK_B_before_second_answer",
  answerB: "ORDER_ANSWER_B_after_second_thinking",
};

// This fixture validates the normalized chat renderer and persisted-cache
// reload only. A native id keeps it from pretending to exercise OpenCode's
// provider database or bounded-replay adapter.
const OPENCODE_RELOAD_SESSION_ID = `sdeagent-e2e-opencode-render-reload-${Date.now()}`;
const OPENCODE_RELOAD_USER_PROMPT =
  "启动一个（subagent），让它帮我分析当前项目里有多少个 .rs 文件，并生成一份报告。必须要用subagent，然后要让我看到过程";
const OPENCODE_RELOAD_ASSIGNMENT_PROMPT =
  "在当前工作目录下分析 Rust 源文件数量：统计所有 **/*.rs 文件，排除 target/ 目录；生成一份报告，包含总文件数、按目录分布、最大文件 Top 5，并在过程中持续汇报进展。";
const OPENCODE_RELOAD_FINAL_REPORT =
  "Now I have all the data. Here is the comprehensive report.";
const OPENCODE_RELOAD_ASSISTANT_ANSWER =
  "Subagent 已完成分析：当前项目共有 260 个 .rs 文件，并已生成报告。";
const ISSUE_443_REAL_CODEX_SESSION_ID =
  process.env.E2E_ISSUE_443_REAL_CODEX_SESSION_ID ?? "";
const MIB = 1024 * 1024;

function withCreatedAt(event, timestampMs) {
  return {
    ...event,
    createdAt: new Date(timestampMs).toISOString(),
  };
}

function makeDedupEvent(id, functionName, actionType, displayVariant, content) {
  return {
    id,
    chunk_id: id,
    sessionId: DEDUP_SESSION_ID,
    createdAt: new Date().toISOString(),
    functionName,
    uiCanonical: functionName,
    actionType,
    args: {},
    result: {
      content,
      observation: content,
      is_delta: false,
      role: functionName === "assistant_message" ? "assistant" : undefined,
    },
    source: "assistant",
    displayText: content,
    displayStatus: "completed",
    displayVariant,
    activityStatus: "agent",
    isDelta: false,
  };
}

function makeDedupUserEvent() {
  return {
    id: "user-1",
    chunk_id: "user-1",
    sessionId: DEDUP_SESSION_ID,
    createdAt: new Date().toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "user",
    args: {},
    result: { content: "能聊天吗", observation: "能聊天吗", is_delta: false },
    source: "user",
    displayText: "能聊天吗",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

function makeOrderUserEvent(id, content) {
  return {
    id,
    chunk_id: id,
    sessionId: ORDER_SESSION_ID,
    createdAt: new Date().toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "user",
    args: {},
    result: { content, observation: content, is_delta: false },
    source: "user",
    displayText: content,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

function makeOpenCodeReloadUserEvent(id, content) {
  return {
    id,
    chunk_id: id,
    sessionId: OPENCODE_RELOAD_SESSION_ID,
    createdAt: new Date().toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "user",
    args: {},
    result: { content, observation: content, is_delta: false },
    source: "user",
    displayText: content,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

function makeOpenCodeReloadSubagentEvent() {
  return {
    id: "opencode-reload-subagent",
    chunk_id: "opencode-reload-subagent",
    sessionId: OPENCODE_RELOAD_SESSION_ID,
    createdAt: new Date().toISOString(),
    functionName: "subagent",
    uiCanonical: "subagent",
    actionType: "tool_call",
    args: {
      action: "delegate",
      description: OPENCODE_RELOAD_ASSIGNMENT_PROMPT,
      prompt: OPENCODE_RELOAD_ASSIGNMENT_PROMPT,
      subagentSessionId: `${OPENCODE_RELOAD_SESSION_ID}-child`,
    },
    result: {
      content: OPENCODE_RELOAD_FINAL_REPORT,
      summary: "Subagent 已完成分析，结果如下",
      success: true,
      is_delta: false,
    },
    source: "assistant",
    displayText: "Assigned task to subagent",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    isDelta: false,
  };
}

function makeOpenCodeReloadAssistantEvent() {
  return {
    id: "opencode-reload-assistant-answer",
    chunk_id: "opencode-reload-assistant-answer",
    sessionId: OPENCODE_RELOAD_SESSION_ID,
    createdAt: new Date().toISOString(),
    functionName: "assistant_message",
    uiCanonical: "agent_message",
    actionType: "assistant",
    args: {},
    result: {
      content: OPENCODE_RELOAD_ASSISTANT_ANSWER,
      observation: OPENCODE_RELOAD_ASSISTANT_ANSWER,
      is_delta: false,
      role: "assistant",
    },
    source: "assistant",
    displayText: OPENCODE_RELOAD_ASSISTANT_ANSWER,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: false,
  };
}

function makeOrderAssistantEvent(id, displayVariant, content) {
  const isThinking = displayVariant === "thinking";
  return {
    id,
    chunk_id: id,
    sessionId: ORDER_SESSION_ID,
    createdAt: new Date().toISOString(),
    functionName: isThinking ? "thinking" : "assistant_message",
    uiCanonical: isThinking ? "thinking" : "assistant_message",
    actionType: isThinking ? "llm_thinking" : "assistant",
    args: {},
    result: {
      content,
      observation: content,
      is_delta: false,
      role: isThinking ? undefined : "assistant",
    },
    source: "assistant",
    displayText: content,
    displayStatus: "completed",
    displayVariant,
    activityStatus: "agent",
    isDelta: false,
  };
}

async function renderedDedupCounts() {
  const chatState = await invokeE2E("inspectChatState");
  const domState = await execJS(`
    const body = document.body.innerText || "";
    const thoughtMatches = body.match(new RegExp(${JSON.stringify(DEDUP_THOUGHT_TEXT)}, "g")) || [];
    const answerMatches = body.match(new RegExp(${JSON.stringify("可以。我能用中文和你聊天")}, "g")) || [];
    const history = document.querySelector('[data-testid="chat-message-list"]');
    return {
      thought: thoughtMatches.length,
      answer: answerMatches.length,
      assistantBubbles: document.querySelectorAll('[data-testid="chat-message-assistant"]').length,
      body: body.slice(0, 2000),
      chatHistoryDebug: history ? {
        chatHistoryCount: history.getAttribute('data-chat-history-count'),
        optimizedCount: history.getAttribute('data-optimized-count'),
        flatCount: history.getAttribute('data-flat-count'),
        groupCounts: history.getAttribute('data-group-counts'),
        text: (history.innerText || '').slice(0, 500),
      } : null,
      location: window.location.pathname,
    };
  `);
  return { ...domState, chatState };
}

async function assertDedupRenderedOnce() {
  const baseTime = Date.now();
  const seed = await invokeE2E("seedChatEvents", DEDUP_SESSION_ID, [
    withCreatedAt(makeDedupUserEvent(), baseTime),
    withCreatedAt(
      makeDedupEvent(
        "think-1",
        "thinking",
        "llm_thinking",
        "thinking",
        DEDUP_THOUGHT_TEXT
      ),
      baseTime + 1_000
    ),
    withCreatedAt(
      makeDedupEvent(
        "msg-1",
        "assistant_message",
        "assistant",
        "message",
        DEDUP_ANSWER_TEXT
      ),
      baseTime + 2_000
    ),
    withCreatedAt(
      makeDedupEvent(
        "think-2",
        "thinking",
        "llm_thinking",
        "thinking",
        DEDUP_THOUGHT_TEXT
      ),
      baseTime + 3_000
    ),
    withCreatedAt(
      makeDedupEvent(
        "msg-2",
        "assistant_message",
        "assistant",
        "message",
        DEDUP_ANSWER_TEXT
      ),
      baseTime + 4_000
    ),
  ]);
  if (!seed || seed.ok !== true) {
    throw new Error(`seedChatEvents failed: ${seed?.error ?? "unknown"}`);
  }

  try {
    await browser.waitUntil(
      async () => {
        const counts = await renderedDedupCounts();
        return counts.thought === 1 && counts.answer === 1;
      },
      {
        timeout: 10_000,
        timeoutMsg:
          "duplicate thought/answer pair was not collapsed in rendered chat",
      }
    );
  } catch (error) {
    throw new Error(
      `${error.message}: ${JSON.stringify(await renderedDedupCounts())}`
    );
  }

  const finalCounts = await execJS(`
    const body = document.body.innerText || "";
    return {
      thought: (body.match(new RegExp(${JSON.stringify(DEDUP_THOUGHT_TEXT)}, "g")) || []).length,
      answer: (body.match(new RegExp(${JSON.stringify("可以。我能用中文和你聊天")}, "g")) || []).length,
      assistantBubbles: document.querySelectorAll('[data-testid="chat-message-assistant"]').length,
    };
  `);
  expect(finalCounts).toEqual({ thought: 1, answer: 1, assistantBubbles: 1 });
}

async function assertMultiRepoGrepTargetsExplicitRepoPath() {
  const root = await mkdtemp(
    path.join(tmpdir(), `orgii-e2e-multirepo-grep-${RUN_ID}-`)
  );
  const primaryRepo = path.join(root, "primary");
  const siblingRepo = path.join(root, "sibling");
  const primarySentinel = `ORGII_MULTI_REPO_GREP_PRIMARY_${RUN_ID}`;
  const siblingSentinel = `ORGII_MULTI_REPO_GREP_SIBLING_${RUN_ID}`;

  try {
    await mkdir(path.join(primaryRepo, "src"), { recursive: true });
    await mkdir(path.join(siblingRepo, "src"), { recursive: true });
    await writeFile(
      path.join(primaryRepo, "src", "sentinel.ts"),
      `export const primary = ${JSON.stringify(primarySentinel)};\n`
    );
    await writeFile(
      path.join(siblingRepo, "src", "sentinel.ts"),
      `export const sibling = ${JSON.stringify(siblingSentinel)};\n`
    );

    const result = await postJson("/agent/test/tool/code-search", {
      default_repo: primaryRepo,
      params: {
        action: "grep",
        pattern: siblingSentinel,
        repo_path: siblingRepo,
        max_results: 20,
      },
    });

    if (!result?.ok) {
      throw new Error(
        `multi-repo grep endpoint failed: ${result?.error ?? "unknown"}`
      );
    }

    const output = String(result.output ?? "");
    if (!output.includes(siblingSentinel)) {
      throw new Error(`multi-repo grep missed sibling sentinel: ${output}`);
    }
    if (output.includes(primarySentinel)) {
      throw new Error(
        `multi-repo grep leaked primary sentinel while targeting sibling: ${output}`
      );
    }
    if (!output.includes(siblingRepo)) {
      throw new Error(
        `multi-repo grep output did not identify sibling repo/path: ${output}`
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertMultiRepoSearchTargetRendered() {
  const sessionId = `e2e-render-multirepo-search-target-${Date.now()}`;
  const baseTime = Date.now();
  const repoA = `/tmp/orgii-e2e-search-target-a-${RUN_ID}/app`;
  const repoB = `/tmp/orgii-e2e-search-target-b-${RUN_ID}/app`;
  const expectedRepoB = `in orgii-e2e-search-target-b-${RUN_ID}/app`;
  const events = [
    {
      ...withCreatedAt(
        makeOrderUserEvent("multi-search-target-user", "Search sibling repo"),
        baseTime
      ),
      sessionId,
    },
    {
      id: "multi-search-target-tool",
      chunk_id: "multi-search-target-tool",
      sessionId,
      createdAt: new Date(baseTime + 1_000).toISOString(),
      functionName: "code_search",
      uiCanonical: "code_search",
      actionType: "tool_call",
      args: {
        action: "grep",
        pattern: "sharedSymbol",
        repo_path: repoB,
        path: `${repoA}/src/index.ts`,
      },
      result: {
        content: `${repoB}/src/index.ts:1:sharedSymbol`,
        observation: "matched",
        is_delta: false,
      },
      repoPath: repoA,
      source: "assistant",
      displayText: "Search sharedSymbol",
      displayStatus: "completed",
      displayVariant: "tool_call",
      activityStatus: "agent",
      isDelta: false,
    },
    {
      ...withCreatedAt(
        makeOrderAssistantEvent(
          "multi-search-target-assistant",
          "message",
          "Search complete"
        ),
        baseTime + 2_000
      ),
      sessionId,
    },
  ];

  const seed = await invokeE2E("seedChatEvents", sessionId, events);
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for multi-repo search target: ${seed?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const history = document.querySelector('[data-testid="chat-message-list"]');
        const body = history ? (history.innerText || "") : (document.body.innerText || "");
        return {
          body,
          hasPattern: body.includes("sharedSymbol"),
          hasTarget: body.includes(${JSON.stringify(expectedRepoB)}),
          hasWrongTarget: body.includes(${JSON.stringify(`in orgii-e2e-search-target-a-${RUN_ID}/app`)}),
          leakedAbsoluteRepo: body.includes(${JSON.stringify(repoB)}),
        };
      `);
      return (
        state.hasPattern &&
        state.hasTarget &&
        !state.hasWrongTarget &&
        !state.leakedAbsoluteRepo
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `multi-repo search target did not render explicit repo_path compactly: ${JSON.stringify(
        await execJS(
          `return { body: (document.body.innerText || "").slice(0, 5000) };`
        )
      )}`,
    }
  );
}

async function assertMultiRepoRenderedPathContext() {
  const sessionId = `e2e-render-multirepo-context-${Date.now()}`;
  const baseTime = Date.now();
  const repoA = `/tmp/orgii-e2e-collision-a-${RUN_ID}/app`;
  const repoB = `/tmp/orgii-e2e-collision-b-${RUN_ID}/app`;
  const fileA = `${repoA}/src/index.ts`;
  const fileB = `${repoB}/src/index.ts`;
  const expectedA = `orgii-e2e-collision-a-${RUN_ID}/app/src/index.ts`;
  const expectedB = `orgii-e2e-collision-b-${RUN_ID}/app/src/index.ts`;
  const events = [
    {
      ...withCreatedAt(
        makeOrderUserEvent("multi-context-user", "Use both app repos"),
        baseTime
      ),
      sessionId,
    },
    {
      id: "multi-context-read-a",
      chunk_id: "multi-context-read-a",
      sessionId,
      createdAt: new Date(baseTime + 1_000).toISOString(),
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      args: { file_path: fileA },
      result: { content: "read A", observation: "read A", is_delta: false },
      repoPath: repoA,
      source: "assistant",
      displayText: `Read ${fileA}`,
      displayStatus: "completed",
      displayVariant: "tool_call",
      activityStatus: "agent",
      isDelta: false,
    },
    {
      id: "multi-context-edit-b",
      chunk_id: "multi-context-edit-b",
      sessionId,
      createdAt: new Date(baseTime + 2_000).toISOString(),
      functionName: "edit_file_by_replace",
      uiCanonical: "edit_file",
      actionType: "tool_call",
      args: { path: fileB, old_string: "old", new_string: "new" },
      result: {
        content: "@@ -1 +1\n-old\n+new",
        observation: "edited",
        is_delta: false,
      },
      repoPath: repoB,
      source: "assistant",
      displayText: `Edit ${fileB}`,
      displayStatus: "completed",
      displayVariant: "tool_call",
      activityStatus: "agent",
      isDelta: false,
    },
    {
      id: "multi-context-search-b",
      chunk_id: "multi-context-search-b",
      sessionId,
      createdAt: new Date(baseTime + 3_000).toISOString(),
      functionName: "code_search",
      uiCanonical: "code_search",
      actionType: "tool_call",
      args: { action: "grep", pattern: "sharedSymbol", repo_path: repoB },
      result: {
        content: `${fileB}:1:sharedSymbol`,
        observation: "matched",
        is_delta: false,
      },
      repoPath: repoB,
      source: "assistant",
      displayText: "Search sharedSymbol",
      displayStatus: "completed",
      displayVariant: "tool_call",
      activityStatus: "agent",
      isDelta: false,
    },
    {
      id: "multi-context-shell-a",
      chunk_id: "multi-context-shell-a",
      sessionId,
      createdAt: new Date(baseTime + 4_000).toISOString(),
      functionName: "run_shell",
      uiCanonical: "run_shell",
      actionType: "tool_call",
      args: { command: "npm test", cwd: repoA },
      result: {
        output: "ok",
        content: "ok",
        observation: "ok",
        is_delta: false,
      },
      repoPath: repoA,
      source: "assistant",
      displayText: "Run npm test",
      displayStatus: "completed",
      displayVariant: "tool_call",
      activityStatus: "agent",
      isDelta: false,
    },
    {
      ...withCreatedAt(
        makeOrderAssistantEvent("multi-context-assistant", "message", "Done"),
        baseTime + 5_000
      ),
      sessionId,
    },
  ];

  const seed = await invokeE2E("seedChatEvents", sessionId, events);
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for multi-repo context: ${seed?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const body = document.body.innerText || "";
        return {
          body,
          hasA: body.includes(${JSON.stringify(expectedA)}),
          hasB: body.includes(${JSON.stringify(expectedB)}),
          leakedAmbiguous: body.includes(" app/src/index.ts") && !body.includes(${JSON.stringify(expectedA)}),
        };
      `);
      return state.hasA && state.hasB && !state.leakedAmbiguous;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `multi-repo rendered path context missing: ${JSON.stringify(
        await execJS(
          `return { body: (document.body.innerText || "").slice(0, 5000) };`
        )
      )}`,
    }
  );
}

async function assertBackgroundProcessPinnedToChatSession() {
  const sessionId = `e2e-render-bg-process-chat-${Date.now()}`;
  const command = `sleep 120 # E2E_BG_PROCESS_PIN_${RUN_ID}`;
  const baseTime = Date.now();
  const events = [
    {
      id: "bg-process-user",
      chunk_id: "bg-process-user",
      sessionId,
      createdAt: new Date(baseTime).toISOString(),
      functionName: "user_message",
      uiCanonical: "user_message",
      actionType: "raw",
      args: {},
      result: {
        type: "user",
        message: "Start a background process",
        is_delta: false,
      },
      source: "user",
      displayText: "Start a background process",
      displayStatus: "completed",
      displayVariant: "message",
      activityStatus: "processed",
      isDelta: false,
    },
  ];

  const seed = await invokeE2E("seedChatEvents", sessionId, events, {
    chatPanelMaximized: true,
    stationMode: "my-station",
  });
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for bg process pin: ${seed?.error ?? "unknown"}`
    );
  }

  const processSeed = await invokeE2E("seedShellProcess", {
    sessionId,
    pid: 90321,
    command,
    status: "background",
  });
  if (!processSeed || processSeed.ok !== true) {
    throw new Error(
      `seedShellProcess failed: ${processSeed?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const body = document.body.innerText || "";
        const pills = Array.from(document.querySelectorAll('[data-testid="composer-section-process"]'))
          .map((el) => el.textContent || "");
        return {
          body,
          pills,
          hasProcessPill: pills.some((text) => text.includes("1")),
        };
      `);
      return state.hasProcessPill;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `background process pill did not render: ${JSON.stringify(
        await execJS(`
          return {
            body: (document.body.innerText || "").slice(0, 5000),
            pills: Array.from(document.querySelectorAll('[data-testid="composer-section-process"]')).map((el) => el.textContent || ""),
          };
        `)
      )}`,
    }
  );

  const sendState = await execJS(`
    const button = document.querySelector('[data-testid="chat-send-button"]');
    return button ? button.getAttribute("data-state") : null;
  `);
  if (sendState !== "submit") {
    throw new Error(
      `background process must not keep composer in stop state: ${sendState}`
    );
  }

  const clickResult = await execJS(`
    const pill = document.querySelector('[data-testid="composer-section-process"]');
    if (!pill) return "missing";
    pill.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
    pill.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
    pill.click();
    return "clicked";
  `);
  if (clickResult !== "clicked") {
    throw new Error(`failed to click process pill: ${clickResult}`);
  }

  await browser.waitUntil(
    async () => {
      const body = await execJS(`return document.body.innerText || "";`);
      return body.includes(command);
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `expanded background process command missing: ${JSON.stringify(
        await execJS(
          `return { body: (document.body.innerText || "").slice(0, 5000) };`
        )
      )}`,
    }
  );
}

async function assertBackgroundSubagentPinnedToChatSession() {
  const sessionId = `e2e-render-bg-subagent-chat-${Date.now()}`;
  const agentName = `E2E Worker ${RUN_ID}`;
  const handle = `agent-builtin:general-e2e-${RUN_ID}`;
  const baseTime = Date.now();
  const events = [
    {
      id: "bg-subagent-user",
      chunk_id: "bg-subagent-user",
      sessionId,
      createdAt: new Date(baseTime).toISOString(),
      functionName: "user_message",
      uiCanonical: "user_message",
      actionType: "raw",
      args: {},
      result: {
        type: "user",
        message: "Launch a background worker",
        is_delta: false,
      },
      source: "user",
      displayText: "Launch a background worker",
      displayStatus: "completed",
      displayVariant: "message",
      activityStatus: "processed",
      isDelta: false,
    },
  ];

  const seed = await invokeE2E("seedChatEvents", sessionId, events, {
    chatPanelMaximized: true,
    stationMode: "my-station",
  });
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for bg subagent pin: ${seed?.error ?? "unknown"}`
    );
  }

  const jobSeed = await invokeE2E("seedSubagentJob", {
    sessionId,
    handle,
    agentName,
    subagentType: "delegate",
    status: "running",
  });
  if (!jobSeed || jobSeed.ok !== true) {
    throw new Error(`seedSubagentJob failed: ${jobSeed?.error ?? "unknown"}`);
  }

  // Pill renders with count 1 (the subagent contributes to the same
  // process section as shell jobs).
  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const pills = Array.from(document.querySelectorAll('[data-testid="composer-section-process"]'))
          .map((el) => el.textContent || "");
        return { pills, hasProcessPill: pills.some((text) => text.includes("1")) };
      `);
      return state.hasProcessPill;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `background subagent pill did not render: ${JSON.stringify(
        await execJS(`
          return {
            body: (document.body.innerText || "").slice(0, 5000),
            pills: Array.from(document.querySelectorAll('[data-testid="composer-section-process"]')).map((el) => el.textContent || ""),
          };
        `)
      )}`,
    }
  );

  // Expand and assert the worker row shows agent name + type label.
  const clickResult = await execJS(`
    const pill = document.querySelector('[data-testid="composer-section-process"]');
    if (!pill) return "missing";
    pill.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
    pill.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
    pill.click();
    return "clicked";
  `);
  if (clickResult !== "clicked") {
    throw new Error(`failed to click process pill: ${clickResult}`);
  }

  await browser.waitUntil(
    async () => {
      const body = await execJS(`return document.body.innerText || "";`);
      return body.includes(agentName) && body.includes("delegate");
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `expanded subagent row missing name/type: ${JSON.stringify(
        await execJS(
          `return { body: (document.body.innerText || "").slice(0, 5000) };`
        )
      )}`,
    }
  );

  // Terminal status removes the row: seed "completed" and assert the pin
  // bar empties (Rule-9 negative — no ghost rows for finished workers).
  const completeSeed = await invokeE2E("seedSubagentJob", {
    sessionId,
    handle,
    agentName,
    subagentType: "delegate",
    status: "completed",
  });
  if (!completeSeed || completeSeed.ok !== true) {
    throw new Error(
      `seedSubagentJob(completed) failed: ${completeSeed?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const body = document.body.innerText || "";
        const pills = Array.from(document.querySelectorAll('[data-testid="composer-section-process"]'));
        return { pillCount: pills.length, hasAgentRow: body.includes(${JSON.stringify(agentName)}) };
      `);
      return state.pillCount === 0 && !state.hasAgentRow;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `completed subagent row did not disappear: ${JSON.stringify(
        await execJS(
          `return { body: (document.body.innerText || "").slice(0, 5000) };`
        )
      )}`,
    }
  );
}

/**
 * Full wire-path variant: unlike `assertBackgroundSubagentPinnedToChatSession`
 * (which writes the frontend atom directly), this drives the PRODUCTION
 * Rust path — `debug_seed_subagent_job` calls `registry::register_subagent`,
 * whose `agent:subagent_job_changed` broadcast must travel bus → IPC
 * channel → `handleSubagentJobChanged` → atom → pin bar. The only
 * substituted link is the LLM deciding to launch a worker. Kill goes
 * through the same Tauri command the Stop button invokes, and the
 * resulting "killed" broadcast must remove the row.
 */
function makeSubagentEvent({
  sessionId,
  eventId,
  subagentSessionId,
  agentName,
  prompt,
  displayStatus = "running",
  activityStatus = "agent",
  result = { success: false, status: "running", is_delta: false },
}) {
  return {
    id: eventId,
    chunk_id: eventId,
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: "agent",
    uiCanonical: "agent",
    actionType: "tool_call",
    args: {
      action: "delegate",
      description: agentName,
      subagentSessionId,
      prompt,
    },
    result,
    source: "assistant",
    displayText: prompt,
    displayStatus,
    displayVariant: "tool_call",
    activityStatus,
    isDelta: false,
  };
}

function makeRunningSubagentEvent({
  sessionId,
  eventId,
  subagentSessionId,
  agentName,
  prompt,
}) {
  return makeSubagentEvent({
    sessionId,
    eventId,
    subagentSessionId,
    agentName,
    prompt,
  });
}

async function assertCompletedSubagentCardIsTerminal() {
  const sessionId = `sdeagent-e2e-subagent-card-terminal-${Date.now()}`;
  const agentName = `E2E Terminal Worker ${RUN_ID}`;
  const subagentSessionId = `agent-builtin:general-card-terminal-${RUN_ID}`;
  const prompt = `Terminal subagent should not keep Stop ${subagentSessionId}`;
  const userEvent = {
    id: "subagent-card-terminal-user",
    chunk_id: "subagent-card-terminal-user",
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {
      type: "user",
      message: "Launch a worker and let it finish",
      is_delta: false,
    },
    source: "user",
    displayText: "Launch a worker and let it finish",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
  const subagentEventId = "subagent-card-terminal-event";

  const seedRunning = await invokeE2E(
    "seedChatEvents",
    sessionId,
    [
      userEvent,
      makeRunningSubagentEvent({
        sessionId,
        eventId: subagentEventId,
        subagentSessionId,
        agentName,
        prompt,
      }),
    ],
    {
      chatPanelMaximized: true,
      runtimeStatus: "running",
      stationMode: "my-station",
    }
  );
  if (!seedRunning || seedRunning.ok !== true) {
    throw new Error(
      `seedChatEvents failed for running terminal fixture: ${seedRunning?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const body = document.body.innerText || "";
        const card = document.querySelector('[data-tool-call-event-id=${JSON.stringify(subagentEventId)}]');
        const stopButton = card?.querySelector('[data-testid="subagent-card-stop-button"]');
        return {
          hasPrompt: body.includes(${JSON.stringify(prompt)}),
          hasStopButton: Boolean(stopButton),
          stopDisabled: stopButton ? stopButton.disabled : null,
          cardText: card?.textContent || "",
        };
      `);
      return (
        state.hasPrompt && state.hasStopButton && state.stopDisabled === false
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `running subagent card did not expose Stop: ${JSON.stringify(
        await execJS(
          `return { body: (document.body.innerText || "").slice(0, 3000) };`
        )
      )}`,
    }
  );

  const seedCompleted = await invokeE2E(
    "seedChatEvents",
    sessionId,
    [
      userEvent,
      makeSubagentEvent({
        sessionId,
        eventId: subagentEventId,
        subagentSessionId,
        agentName,
        prompt,
        displayStatus: "completed",
        activityStatus: "processed",
        result: {
          success: true,
          status: "completed",
          summary: "Terminal worker completed",
          is_delta: false,
        },
      }),
    ],
    {
      chatPanelMaximized: true,
      runtimeStatus: "idle",
      stationMode: "my-station",
    }
  );
  if (!seedCompleted || seedCompleted.ok !== true) {
    throw new Error(
      `seedChatEvents failed for completed terminal fixture: ${seedCompleted?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const card = document.querySelector('[data-tool-call-event-id=${JSON.stringify(subagentEventId)}]');
        const stopButton = card?.querySelector('[data-testid="subagent-card-stop-button"]');
        const text = card?.textContent || "";
        return {
          hasCard: Boolean(card),
          hasStopButton: Boolean(stopButton),
          text,
          hasRunningText: text.toLowerCase().includes("running"),
          hasSpinClass: Boolean(card?.querySelector('.animate-spin')),
        };
      `);
      return (
        state.hasCard &&
        !state.hasStopButton &&
        !state.hasRunningText &&
        !state.hasSpinClass
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `completed subagent card still looked active: ${JSON.stringify(
        await execJS(`
          const card = document.querySelector('[data-tool-call-event-id=${JSON.stringify(subagentEventId)}]');
          return {
            body: (document.body.innerText || "").slice(0, 3000),
            cardText: card?.textContent || null,
            hasStopButton: Boolean(card?.querySelector('[data-testid="subagent-card-stop-button"]')),
            hasSpinClass: Boolean(card?.querySelector('.animate-spin')),
          };
        `)
      )}`,
    }
  );
}
async function assertSubagentCardStopUsesJobRegistryFallback() {
  const sessionId = `sdeagent-e2e-subagent-card-stop-${Date.now()}`;
  const agentName = `E2E Card Stop Worker ${RUN_ID}`;
  const subagentSessionId = `agent-builtin:general-card-stop-${RUN_ID}`;
  const prompt = `Card stop should cancel ${subagentSessionId}`;
  const userEvent = {
    id: "subagent-card-stop-user",
    chunk_id: "subagent-card-stop-user",
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {
      type: "user",
      message: "Launch a worker, then stop it from the card",
      is_delta: false,
    },
    source: "user",
    displayText: "Launch a worker, then stop it from the card",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
  const subagentEventId = "subagent-card-stop-running";
  const seed = await invokeE2E(
    "seedChatEvents",
    sessionId,
    [
      userEvent,
      makeRunningSubagentEvent({
        sessionId,
        eventId: subagentEventId,
        subagentSessionId,
        agentName,
        prompt,
      }),
    ],
    {
      chatPanelMaximized: true,
      runtimeStatus: "running",
      stationMode: "my-station",
    }
  );
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for subagent card stop: ${seed?.error ?? "unknown"}`
    );
  }

  await browser.pause(500);
  const wireSeed = await invokeE2E("debugSeedSubagentJobWire", {
    sessionId,
    handle: subagentSessionId,
    agentName,
    subagentType: "delegate",
  });
  if (!wireSeed || wireSeed.ok !== true) {
    throw new Error(
      `debugSeedSubagentJobWire failed: ${wireSeed?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const body = document.body.innerText || "";
        const card = document.querySelector('[data-tool-call-name="agent"]');
        const stopButton = card?.querySelector('[data-testid="subagent-card-stop-button"]');
        return {
          hasPrompt: body.includes(${JSON.stringify(prompt)}),
          hasStopButton: Boolean(stopButton),
          body: body.slice(0, 3000),
        };
      `);
      return state.hasPrompt && state.hasStopButton;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `subagent card stop fixture did not render: ${JSON.stringify(
        await execJS(`
          const body = document.body.innerText || "";
          return {
            body: body.slice(0, 3000),
            cards: document.querySelectorAll('[data-tool-call-name="agent"]').length,
            buttons: Array.from(document.querySelectorAll('button')).map((button) => ({ title: button.title, aria: button.getAttribute('aria-label') })).slice(0, 50),
            pills: Array.from(document.querySelectorAll('[data-testid="composer-section-process"]')).map((el) => el.textContent || ""),
          };
        `)
      )}`,
    }
  );

  const clicked = await execJS(`
    const card = document.querySelector('[data-tool-call-name="agent"]');
    const stopButton = card?.querySelector('[data-testid="subagent-card-stop-button"]');
    if (!stopButton) return false;
    stopButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
    stopButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
    stopButton.click();
    return true;
  `);
  if (!clicked) {
    throw new Error("subagent card Stop button was not clickable");
  }

  await browser.waitUntil(
    async () => {
      const jobsResult = await invokeE2E("listRunningSubagentJobsWire");
      const jobs = jobsResult?.jobs ?? [];
      const state = await execJS(`
        const card = document.querySelector('[data-tool-call-name="agent"]');
        const stopButton = card?.querySelector('[data-testid="subagent-card-stop-button"]');
        return { stopDisabled: stopButton ? stopButton.disabled : false };
      `);
      return (
        jobsResult?.ok === true &&
        !jobs.some((job) => job && job.handle === subagentSessionId) &&
        state.stopDisabled
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `subagent card Stop did not cancel registry job: ${JSON.stringify(
        await invokeE2E("listRunningSubagentJobsWire")
      )}`,
    }
  );
}

async function assertBackgroundSubagentWirePath() {
  // MUST be `sdeagent-` prefixed: getAdapterForSession resolves the rust
  // agent adapter (and thus the channel event handler) by id prefix —
  // an unprefixed id mounts the surface but drops every wire event.
  const sessionId = `sdeagent-e2e-bg-subagent-wire-${Date.now()}`;
  const agentName = `E2E Wire Worker ${RUN_ID}`;
  const handle = `agent-builtin:general-wire-${RUN_ID}`;
  const baseTime = Date.now();
  const events = [
    {
      id: "bg-subagent-wire-user",
      chunk_id: "bg-subagent-wire-user",
      sessionId,
      createdAt: new Date(baseTime).toISOString(),
      functionName: "user_message",
      uiCanonical: "user_message",
      actionType: "raw",
      args: {},
      result: {
        type: "user",
        message: "Launch a background worker over the wire",
        is_delta: false,
      },
      source: "user",
      displayText: "Launch a background worker over the wire",
      displayStatus: "completed",
      displayVariant: "message",
      activityStatus: "processed",
      isDelta: false,
    },
  ];

  const seed = await invokeE2E("seedChatEvents", sessionId, events, {
    chatPanelMaximized: true,
    stationMode: "my-station",
  });
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for wire path: ${seed?.error ?? "unknown"}`
    );
  }

  // The session surface must be mounted so useSessionChannel has
  // subscribed to the backend IPC channel before we fire the broadcast.
  // seedChatEvents waits for the surface; give the subscribe invoke a
  // brief settle window on top.
  await browser.pause(500);

  const wireSeed = await invokeE2E("debugSeedSubagentJobWire", {
    sessionId,
    handle,
    agentName,
    subagentType: "delegate",
  });
  if (!wireSeed || wireSeed.ok !== true) {
    throw new Error(
      `debugSeedSubagentJobWire failed: ${wireSeed?.error ?? "unknown"}`
    );
  }

  // The row must arrive via the real broadcast — no frontend store write
  // happened in this spec.
  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const pills = Array.from(document.querySelectorAll('[data-testid="composer-section-process"]'))
          .map((el) => el.textContent || "");
        return { pills, hasProcessPill: pills.some((text) => text.includes("1")) };
      `);
      return state.hasProcessPill;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `wire-path subagent pill did not render (broadcast chain broken?): ${JSON.stringify(
        await execJS(`
          return {
            body: (document.body.innerText || "").slice(0, 3000),
            pills: Array.from(document.querySelectorAll('[data-testid="composer-section-process"]')).map((el) => el.textContent || ""),
          };
        `)
      )}`,
    }
  );

  // Expand and verify the row content came from the Rust payload.
  await execJS(`
    const pill = document.querySelector('[data-testid="composer-section-process"]');
    if (pill) {
      pill.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
      pill.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
      pill.click();
    }
  `);
  await browser.waitUntil(
    async () => {
      const body = await execJS(`return document.body.innerText || "";`);
      return body.includes(agentName);
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "wire-path subagent row missing agent name after expand",
    }
  );

  // Kill via the SAME Tauri command the Stop button calls. The "killed"
  // broadcast must travel the wire and remove the row.
  const killResult = await invokeE2E("killSubagentJobWire", handle);
  if (!killResult || killResult.ok !== true) {
    throw new Error(
      `killSubagentJobWire failed: ${killResult?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const body = document.body.innerText || "";
        const pills = Array.from(document.querySelectorAll('[data-testid="composer-section-process"]'));
        return { pillCount: pills.length, hasAgentRow: body.includes(${JSON.stringify(agentName)}) };
      `);
      return state.pillCount === 0 && !state.hasAgentRow;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `killed wire-path subagent row did not disappear: ${JSON.stringify(
        await execJS(
          `return { body: (document.body.innerText || "").slice(0, 3000) };`
        )
      )}`,
    }
  );
}

function makeHiddenRunningEvents(sessionId, baseTime) {
  return [
    {
      id: "hidden-running-user",
      chunk_id: "hidden-running-user",
      sessionId,
      createdAt: new Date(baseTime).toISOString(),
      functionName: "user_message",
      uiCanonical: "user_message",
      actionType: "raw",
      args: {},
      result: {
        type: "user",
        message: "Keep working",
        is_delta: false,
      },
      source: "user",
      displayText: "Keep working",
      displayStatus: "completed",
      displayVariant: "message",
      activityStatus: "processed",
      isDelta: false,
    },
    {
      id: "hidden-running-status",
      chunk_id: "hidden-running-status",
      sessionId,
      createdAt: new Date(baseTime + 1_000).toISOString(),
      functionName: "hidden_status",
      uiCanonical: "hidden_status",
      actionType: "raw",
      args: {},
      result: { status: "running", is_delta: false },
      source: "assistant",
      displayText: "",
      displayStatus: "running",
      displayVariant: "session",
      activityStatus: "agent",
      isDelta: false,
    },
  ];
}

async function assertWorkingFooterShownForHiddenRunningEvent() {
  const sessionId = `e2e-render-working-footer-${Date.now()}`;
  const baseTime = Date.now();
  const events = makeHiddenRunningEvents(sessionId, baseTime);

  const seed = await invokeE2E("seedChatEvents", sessionId, events, {
    chatPanelMaximized: true,
    runtimeStatus: "running",
    stationMode: "my-station",
  });
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for working footer: ${seed?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const footer = await execJS(`
        const el = document.querySelector('[data-testid="planning-footer"]');
        return el ? el.textContent || "" : "";
      `);
      return /Planning next step|Working on|Thinking|working/i.test(footer);
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `working footer did not render for hidden running event: ${JSON.stringify(
        await execJS(
          `return { body: (document.body.innerText || "").slice(0, 5000) };`
        )
      )}; state=${JSON.stringify(await invokeE2E("inspectChatState"))}`,
    }
  );
}

async function assertStaleHiddenRunningEventDoesNotHoldStopButton() {
  const sessionId = `e2e-render-stale-hidden-running-${Date.now()}`;
  const baseTime = Date.now();
  const seed = await invokeE2E(
    "seedChatEvents",
    sessionId,
    makeHiddenRunningEvents(sessionId, baseTime),
    {
      chatPanelMaximized: true,
      stationMode: "my-station",
    }
  );
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for stale hidden running event: ${seed?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const sendState = await execJS(`
        const button = document.querySelector('[data-testid="chat-send-button"]');
        return button ? button.getAttribute("data-state") : null;
      `);
      return sendState === "submit";
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `stale hidden running event kept composer in stop state: ${JSON.stringify(
        await execJS(`
          const button = document.querySelector('[data-testid="chat-send-button"]');
          return {
            sendState: button ? button.getAttribute("data-state") : null,
            body: (document.body.innerText || "").slice(0, 5000),
          };
        `)
      )}`,
    }
  );
}

async function assertEarlyCancelStopNavigatesToPreviousTurnPage() {
  const sessionId = `e2e-render-early-cancel-turnpage-${Date.now()}`;
  const baseTime = Date.now();
  const draftText = `Early cancel draft marker ${RUN_ID}`;

  // Build 2 completed turns + 1 running turn (user-only, no assistant output)
  const turn1User = {
    id: "ec-t1-user",
    chunk_id: "ec-t1-user",
    sessionId,
    createdAt: new Date(baseTime).toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message: "Turn 1 prompt", is_delta: false },
    source: "user",
    displayText: "Turn 1 prompt",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
  const turn1Assistant = {
    id: "ec-t1-assist",
    chunk_id: "ec-t1-assist",
    sessionId,
    createdAt: new Date(baseTime + 1_000).toISOString(),
    functionName: "agent_message",
    uiCanonical: "agent_message",
    actionType: "raw",
    args: {},
    result: { type: "assistant", message: "Turn 1 answer", is_delta: false },
    source: "assistant",
    displayText: "Turn 1 answer",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
  const turn2User = {
    id: "ec-t2-user",
    chunk_id: "ec-t2-user",
    sessionId,
    createdAt: new Date(baseTime + 2_000).toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message: "Turn 2 prompt", is_delta: false },
    source: "user",
    displayText: "Turn 2 prompt",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
  const turn2Assistant = {
    id: "ec-t2-assist",
    chunk_id: "ec-t2-assist",
    sessionId,
    createdAt: new Date(baseTime + 3_000).toISOString(),
    functionName: "agent_message",
    uiCanonical: "agent_message",
    actionType: "raw",
    args: {},
    result: { type: "assistant", message: "Turn 2 answer", is_delta: false },
    source: "assistant",
    displayText: "Turn 2 answer",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
  const turn3User = {
    id: "ec-t3-user",
    chunk_id: "ec-t3-user",
    sessionId,
    createdAt: new Date(baseTime + 4_000).toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message: draftText, is_delta: false },
    source: "user",
    displayText: draftText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };

  const seed = await invokeE2E(
    "seedChatEvents",
    sessionId,
    [turn1User, turn1Assistant, turn2User, turn2Assistant, turn3User],
    {
      chatPanelMaximized: true,
      stationMode: "my-station",
      runtimeStatus: "running",
      lastUserMessage: { displayContent: draftText },
    }
  );
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for early-cancel turn page: ${seed?.error ?? "unknown"}`
    );
  }

  // Wait for the send button to show stop state (runtime is running)
  await browser.waitUntil(
    async () => {
      const sendState = await execJS(`
        const button = document.querySelector('[data-testid="chat-send-button"]');
        return button ? button.getAttribute("data-state") : null;
      `);
      return sendState === "stop";
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg:
        "send button did not enter stop state for early-cancel turn page test",
    }
  );

  // Verify we're on the latest round before clicking Stop
  await browser.waitUntil(
    async () => {
      const roundLabel = await execJS(`
        const node = document.querySelector('[data-testid="turn-pagination-current-round"]');
        return node ? node.textContent.trim() : null;
      `);
      return roundLabel !== null && /latest/i.test(roundLabel);
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "turn pagination did not show Latest round before Stop",
    }
  );

  // Click Stop
  await execJS(`
    const button = document.querySelector('[data-testid="chat-send-button"]');
    if (button) {
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      button.click();
    }
    return !!button;
  `);

  // Assert turn page navigated back to the previous round (Round 2)
  await browser.waitUntil(
    async () => {
      const roundLabel = await execJS(`
        const node = document.querySelector('[data-testid="turn-pagination-current-round"]');
        return node ? node.textContent.trim() : null;
      `);
      return roundLabel !== null && /round\s+2/i.test(roundLabel);
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `early-cancel Stop did not navigate to previous turn page; roundLabel=${JSON.stringify(await execJS(`return document.querySelector('[data-testid="turn-pagination-current-round"]')?.textContent || null;`))}`,
    }
  );
}

async function assertMultiRepoReadPathRendered() {
  const sessionId = `e2e-render-multirepo-read-${Date.now()}`;
  const baseTime = Date.now();
  const primaryPath = `/tmp/orgii-e2e-multirepo-primary-${RUN_ID}/src/index.tsx`;
  const secondaryPath = `/tmp/orgii-e2e-multirepo-secondary-${RUN_ID}/src/index.tsx`;
  const tertiaryPath = `/tmp/orgii-e2e-multirepo-tertiary-${RUN_ID}/README.md`;
  const userEvent = {
    ...withCreatedAt(
      makeOrderUserEvent("multi-read-user", "Read two files"),
      baseTime
    ),
    sessionId,
  };
  const readPayloads = [
    {
      path: primaryPath,
      args: { targetFile: primaryPath },
      result: {},
    },
    {
      path: secondaryPath,
      args: { file_path: secondaryPath },
      result: {},
    },
    {
      path: tertiaryPath,
      args: {},
      result: { success: { filePath: tertiaryPath } },
    },
  ];
  const readEvents = readPayloads.map(
    ({ path: targetPath, args, result }, index) => ({
      id: `multi-read-${index}`,
      chunk_id: `multi-read-${index}`,
      sessionId,
      createdAt: new Date(baseTime + 1_000 + index).toISOString(),
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      args,
      result: {
        ...result,
        content: `content for ${targetPath}`,
        observation: `content for ${targetPath}`,
        is_delta: false,
      },
      source: "assistant",
      displayText: `Read ${targetPath}`,
      displayStatus: "completed",
      displayVariant: "tool_call",
      activityStatus: "agent",
      isDelta: false,
    })
  );
  const assistantEvent = {
    ...withCreatedAt(
      makeOrderAssistantEvent(
        "multi-read-assistant",
        "message",
        "Read complete"
      ),
      baseTime + 3_000
    ),
    sessionId,
  };

  const seed = await invokeE2E("seedChatEvents", sessionId, [
    userEvent,
    ...readEvents,
    assistantEvent,
  ]);
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedChatEvents failed for multi-root read path: ${seed?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const paths = Array.from(document.querySelectorAll('[data-testid="read-file-path"]'))
          .map((node) => node.textContent || "");
        const body = document.body.innerText || "";
        return {
          paths,
          body: body.slice(0, 3000),
          expectedPaths: ${JSON.stringify([primaryPath, secondaryPath, tertiaryPath])},
          hasGenericOnly: paths.some((path) => path.trim() === "file"),
        };
      `);
      return (
        state.expectedPaths.every(
          (expectedPath) =>
            state.body.includes(expectedPath) ||
            state.paths.some((renderedPath) =>
              renderedPath.includes(expectedPath)
            )
        ) && !state.hasGenericOnly
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `multi-root read file paths did not render: ${JSON.stringify(
        await execJS(`
          const paths = Array.from(document.querySelectorAll('[data-testid="read-file-path"]'))
            .map((node) => node.textContent || "");
          return { paths, body: (document.body.innerText || "").slice(0, 3000) };
        `)
      )}`,
    }
  );
}

async function assertThinkingChronologicalOrder() {
  const orderedEventIds = [
    "order-user-a",
    "order-think-a",
    "order-answer-a",
    "order-user-b",
    "order-think-b",
    "order-answer-b",
  ];
  const visibleLatestRoundTexts = [
    ORDER_TEXTS.userB,
    ORDER_TEXTS.thinkB,
    ORDER_TEXTS.answerB,
  ];
  const baseTime = Date.now();
  const seed = await invokeE2E("seedChatEvents", ORDER_SESSION_ID, [
    withCreatedAt(
      makeOrderUserEvent("order-user-a", ORDER_TEXTS.userA),
      baseTime
    ),
    withCreatedAt(
      makeOrderAssistantEvent("order-think-a", "thinking", ORDER_TEXTS.thinkA),
      baseTime + 1_000
    ),
    withCreatedAt(
      makeOrderAssistantEvent("order-answer-a", "message", ORDER_TEXTS.answerA),
      baseTime + 2_000
    ),
    withCreatedAt(
      makeOrderUserEvent("order-user-b", ORDER_TEXTS.userB),
      baseTime + 3_000
    ),
    withCreatedAt(
      makeOrderAssistantEvent("order-think-b", "thinking", ORDER_TEXTS.thinkB),
      baseTime + 4_000
    ),
    withCreatedAt(
      makeOrderAssistantEvent("order-answer-b", "message", ORDER_TEXTS.answerB),
      baseTime + 5_000
    ),
  ]);
  if (!seed || seed.ok !== true) {
    throw new Error(`seedChatEvents failed: ${seed?.error ?? "unknown"}`);
  }

  await browser.waitUntil(
    async () => {
      const chatState = await invokeE2E("inspectChatState");
      const events = chatState.chatEvents ?? chatState.value?.chatEvents ?? [];
      const eventIds = events.map((event) => event.id);
      const relevantIds = eventIds.filter((eventId) =>
        orderedEventIds.includes(eventId)
      );
      return JSON.stringify(relevantIds) === JSON.stringify(orderedEventIds);
    },
    {
      timeout: 10_000,
      timeoutMsg: `thinking events were not stored in chronological turn order: ${JSON.stringify(
        await invokeE2E("inspectChatState")
      )}`,
    }
  );

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const history = document.querySelector('[data-testid="chat-message-list"]');
        const body = history ? (history.innerText || "") : (document.body.innerText || "");
        const texts = ${JSON.stringify(visibleLatestRoundTexts)};
        const indices = texts.map((text) => body.indexOf(text));
        const counts = texts.map((text) => (body.match(new RegExp(text, "g")) || []).length);
        return {
          indices,
          counts,
          inOrder: indices.every((index) => index >= 0) && indices.every((index, idx) => idx === 0 || index > indices[idx - 1]),
          body: body.slice(0, 3000),
        };
      `);
      return state.inOrder && state.counts.every((count) => count === 1);
    },
    {
      timeout: 10_000,
      timeoutMsg: `latest visible thinking round did not render chronologically: ${JSON.stringify(
        await execJS(`
        const history = document.querySelector('[data-testid="chat-message-list"]');
        const body = history ? (history.innerText || "") : (document.body.innerText || "");
        const texts = ${JSON.stringify(visibleLatestRoundTexts)};
        return { indices: texts.map((text) => body.indexOf(text)), body: body.slice(0, 3000) };
      `)
      )}`,
    }
  );
}

async function assertOpenCodeSubagentReloadKeepsAnswerAndAssignment() {
  const baseTime = Date.now();
  const events = [
    withCreatedAt(
      makeOpenCodeReloadUserEvent(
        "opencode-reload-user",
        OPENCODE_RELOAD_USER_PROMPT
      ),
      baseTime
    ),
    withCreatedAt(makeOpenCodeReloadSubagentEvent(), baseTime + 1_000),
    withCreatedAt(makeOpenCodeReloadAssistantEvent(), baseTime + 2_000),
  ];
  const seed = await invokeE2E("seedPersistedCachedSession", {
    sessionId: OPENCODE_RELOAD_SESSION_ID,
    name: OPENCODE_RELOAD_USER_PROMPT,
    userInput: OPENCODE_RELOAD_USER_PROMPT,
    category: "rust_agent",
    events,
  });
  if (!seed || seed.ok !== true) {
    throw new Error(
      `seedPersistedCachedSession failed: ${seed?.error ?? "unknown"}`
    );
  }

  const firstOpen = await invokeE2E("openSession", OPENCODE_RELOAD_SESSION_ID);
  if (!firstOpen || firstOpen.ok !== true) {
    throw new Error(`openSession failed: ${firstOpen?.error ?? "unknown"}`);
  }

  await browser.waitUntil(
    async () => {
      const body = await execJS(`return document.body.innerText || "";`);
      return (
        body.includes(OPENCODE_RELOAD_ASSIGNMENT_PROMPT) &&
        body.includes(OPENCODE_RELOAD_ASSISTANT_ANSWER) &&
        !body.includes(OPENCODE_RELOAD_FINAL_REPORT)
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `OpenCode fixture did not render assignment+answer before reload: ${JSON.stringify(
        await execJS(`return (document.body.innerText || "").slice(0, 4000);`)
      )}`,
    }
  );

  await browser.refresh();
  await waitForApp();
  const navigation = await invokeE2E("navigateTo", "/orgii/workstation/code");
  if (!navigation || navigation.ok !== true) {
    throw new Error(
      `navigateTo after reload failed: ${navigation?.error ?? "unknown"}`
    );
  }
  // `openSession` may legitimately wait for the post-reload session surface
  // for up to 20 seconds. Temporarily widen `waitForApp`'s short script timeout
  // for this one async helper, then restore the fail-fast default.
  let reopened;
  await browser.setTimeout({ script: 30_000 });
  try {
    reopened = await invokeE2E("openSession", OPENCODE_RELOAD_SESSION_ID);
  } finally {
    await browser.setTimeout({ script: 5_000 });
  }
  if (!reopened || reopened.ok !== true) {
    throw new Error(
      `openSession after reload failed: ${reopened?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const state = await invokeE2E("inspectChatState");
      const body = await execJS(`return document.body.innerText || "";`);
      return (
        state.activeSessionId === OPENCODE_RELOAD_SESSION_ID &&
        state.chatEventCount >= 3 &&
        body.includes(OPENCODE_RELOAD_ASSIGNMENT_PROMPT) &&
        body.includes(OPENCODE_RELOAD_ASSISTANT_ANSWER) &&
        !body.includes(OPENCODE_RELOAD_FINAL_REPORT)
      );
    },
    {
      timeout: 30_000,
      interval: 1_000,
      timeoutMsg: `OpenCode fixture did not preserve rendered answer/assignment after reload: ${JSON.stringify(
        {
          state: await invokeE2E("inspectChatState"),
          body: await execJS(
            `return (document.body.innerText || "").slice(0, 4000);`
          ),
        }
      )}`,
    }
  );
}

async function assertIssue443RealCodexSessionStaysBounded() {
  if (!ISSUE_443_REAL_CODEX_SESSION_ID) {
    throw new Error(
      "E2E_ISSUE_443_REAL_CODEX_SESSION_ID is required for the real Codex acceptance scenario"
    );
  }

  const memoryBefore = await invokeTauriCommand("get_app_memory_snapshot_v1");
  const baselineBytes = Number(memoryBefore?.effective_total_bytes ?? 0);
  if (!(baselineBytes > 0)) {
    throw new Error(`native memory baseline is unavailable: ${JSON.stringify(memoryBefore)}`);
  }

  const samples = [];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const startedAt = Date.now();
    let opened;
    await browser.setTimeout({ script: 180_000 });
    try {
      opened = await invokeE2E("openSession", ISSUE_443_REAL_CODEX_SESSION_ID);
    } finally {
      await browser.setTimeout({ script: 5_000 });
    }
    if (!opened || opened.ok !== true) {
      throw new Error(
        `real Codex open cycle ${cycle} failed: ${opened?.error ?? "unknown"}`
      );
    }

    const state = await invokeE2E("inspectChatState");
    if (!state || state.ok !== true) {
      throw new Error(
        `real Codex state cycle ${cycle} failed: ${state?.error ?? "unknown"}`
      );
    }
    if (state.activeSessionId !== ISSUE_443_REAL_CODEX_SESSION_ID) {
      throw new Error(
        `real Codex cycle ${cycle} opened the wrong session: ${state.activeSessionId}`
      );
    }
    if (state.snapshotEventCount > 200) {
      throw new Error(
        `real Codex cycle ${cycle} hydrated ${state.snapshotEventCount} events; hard cap is 200`
      );
    }

    const memoryOpen = await invokeTauriCommand("get_app_memory_snapshot_v1");
    const openBytes = Number(memoryOpen?.effective_total_bytes ?? 0);
    samples.push({
      cycle,
      elapsedMs: Date.now() - startedAt,
      eventCount: state.snapshotEventCount,
      openBytes,
    });

    const reset = await invokeE2E("resetToNewSession");
    if (!reset || reset.ok !== true) {
      throw new Error(
        `real Codex release cycle ${cycle} failed: ${reset?.error ?? "unknown"}`
      );
    }
    await browser.pause(250);
  }

  const firstGrowth = Math.max(0, samples[0].openBytes - baselineBytes);
  const lastGrowth = Math.max(0, samples.at(-1).openBytes - baselineBytes);
  const stepGrowth = Math.max(0, samples.at(-1).openBytes - samples[0].openBytes);
  if (firstGrowth > 400 * MIB) {
    throw new Error(
      `real Codex first open grew Physical Footprint by ${(firstGrowth / MIB).toFixed(1)} MiB`
    );
  }
  if (stepGrowth > 64 * MIB) {
    throw new Error(
      `five real Codex open/release cycles grew another ${(stepGrowth / MIB).toFixed(1)} MiB`
    );
  }

  console.log(
    `[issue-443-real-codex] baseline=${(baselineBytes / MIB).toFixed(1)} MiB firstGrowth=${(firstGrowth / MIB).toFixed(1)} MiB lastGrowth=${(lastGrowth / MIB).toFixed(1)} MiB samples=${JSON.stringify(samples)}`
  );
}

async function assertTurnMetadataFooterRendered() {
  const sessionId = `sdeagent-e2e-turn-metadata-${RUN_ID}`;
  const baseTime = Date.now();
  const user = withCreatedAt(
    makeUserEvent(sessionId, `metadata-${RUN_ID}`),
    baseTime
  );
  const edit = {
    id: `${sessionId}-edit`,
    chunk_id: `${sessionId}-edit`,
    sessionId,
    createdAt: new Date(baseTime + 1_000).toISOString(),
    functionName: "edit_file",
    uiCanonical: "edit_file",
    actionType: "tool_call",
    args: {
      file_path: "src/features/metadata/sessionMetadata.ts",
      old_string: "old line",
      new_string: "new line\nsecond line\nthird line",
    },
    result: {
      output: "Updated src/features/metadata/sessionMetadata.ts",
      linesAdded: 3,
      linesRemoved: 1,
    },
    source: "assistant",
    displayText: "Updated sessionMetadata.ts",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    isDelta: false,
  };
  const read = {
    ...edit,
    id: `${sessionId}-read`,
    chunk_id: `${sessionId}-read`,
    createdAt: new Date(baseTime + 500).toISOString(),
    functionName: "read_file",
    uiCanonical: "read_file",
    args: { file_path: "src/features/metadata/source.ts" },
    result: { output: "source contents" },
    displayText: "Read source.ts",
  };
  const search = {
    ...edit,
    id: `${sessionId}-search`,
    chunk_id: `${sessionId}-search`,
    createdAt: new Date(baseTime + 750).toISOString(),
    functionName: "search_files",
    uiCanonical: "search_files",
    args: { path: "src/features/metadata" },
    result: {
      results: [{ file: "src/features/metadata/sessionMetadata.ts" }],
    },
    displayText: "Searched metadata files",
  };
  const commit = {
    ...edit,
    id: `${sessionId}-commit`,
    chunk_id: `${sessionId}-commit`,
    createdAt: new Date(baseTime + 2_000).toISOString(),
    functionName: "run_shell",
    uiCanonical: "run_shell",
    args: { command: "git commit -m 'feat: session metadata'" },
    result: {
      success: {
        command: "git commit -m 'feat: session metadata'",
        stdout: "[feature/session-metadata abc1234] feat: session metadata",
        exitCode: 0,
      },
    },
    displayText: "Committed session metadata",
  };
  const pullRequest = {
    ...commit,
    id: `${sessionId}-pr`,
    chunk_id: `${sessionId}-pr`,
    createdAt: new Date(baseTime + 3_000).toISOString(),
    args: { command: "gh pr create --title 'Session metadata'" },
    result: {
      success: {
        command: "gh pr create --title 'Session metadata'",
        stdout: "https://github.com/yorgai/ORG2/pull/387",
        exitCode: 0,
      },
    },
    displayText: "Created pull request 387",
  };
  const assistant = withCreatedAt(
    makeAssistantEvent(sessionId, `metadata-${RUN_ID}`),
    baseTime + 4_000
  );

  const seed = await invokeE2E("seedPersistedCachedSession", {
    sessionId,
    name: "Turn metadata E2E",
    userInput: "Edit a file, commit it, and open a PR",
    category: "rust_agent",
    status: "completed",
    events: [user, read, search, edit, commit, pullRequest, assistant],
  });
  if (!seed || seed.ok !== true) {
    throw new Error(`turn metadata seed failed: ${seed?.error ?? "unknown"}`);
  }
  const opened = await invokeE2E("openSession", sessionId);
  if (!opened || opened.ok !== true) {
    throw new Error(`turn metadata open failed: ${opened?.error ?? "unknown"}`);
  }

  await browser.waitUntil(
    async () =>
      execJS(`
        const footer = document.querySelector('[data-testid="turn-metadata-footer"]');
        return !!footer &&
          !!footer.querySelector('[data-testid="turn-metadata-edits-tab"][data-active="true"]') &&
          !!footer.querySelector('[data-testid="turn-metadata-reads-count"]') &&
          footer.querySelectorAll('[data-testid="turn-metadata-commit"]').length === 1 &&
          footer.querySelectorAll('[data-testid="turn-metadata-pr"]').length === 1 &&
          footer.querySelectorAll('[data-testid="turn-metadata-read"]').length === 0 &&
          (footer.innerText || '').includes('sessionMetadata.ts') &&
          (footer.innerText || '').includes('abc1234') &&
          (footer.innerText || '').includes('#387');
      `),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `turn metadata footer did not render: ${JSON.stringify(
        await execJS(`return (document.body.innerText || '').slice(-5000);`)
      )}`,
    }
  );

  await execJS(`
    document.querySelector('[data-testid="turn-metadata-reads-tab"]')?.click();
  `);
  await browser.waitUntil(
    async () =>
      execJS(`
        const footer = document.querySelector('[data-testid="turn-metadata-footer"]');
        return !!footer &&
          !!footer.querySelector('[data-testid="turn-metadata-reads-tab"][data-active="true"]') &&
          footer.querySelectorAll('[data-testid="turn-metadata-read"]').length === 1 &&
          footer.querySelectorAll('[data-testid="turn-metadata-commit"]').length === 0 &&
          footer.querySelectorAll('[data-testid="turn-metadata-pr"]').length === 0;
      `),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "read rows did not lazy-render after selecting Reads",
    }
  );

  const emptySessionId = `sdeagent-e2e-turn-metadata-empty-${RUN_ID}`;
  const emptySeed = await invokeE2E("seedPersistedCachedSession", {
    sessionId: emptySessionId,
    name: "Empty turn metadata E2E",
    category: "rust_agent",
    status: "completed",
    events: [
      withCreatedAt(makeUserEvent(emptySessionId, `empty-${RUN_ID}`), baseTime),
      withCreatedAt(
        makeAssistantEvent(emptySessionId, `empty-${RUN_ID}`),
        baseTime + 1_000
      ),
    ],
  });
  if (!emptySeed || emptySeed.ok !== true) {
    throw new Error(
      `empty turn metadata seed failed: ${emptySeed?.error ?? "unknown"}`
    );
  }
  const emptyOpened = await invokeE2E("openSession", emptySessionId);
  if (!emptyOpened || emptyOpened.ok !== true) {
    throw new Error(
      `empty turn metadata open failed: ${emptyOpened?.error ?? "unknown"}`
    );
  }
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!document.querySelector('[data-testid="turn-metadata-empty"]');`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg:
        "completed no-edit round did not render its empty metadata state",
    }
  );
}

async function assertKanbanFileSearchRendered() {
  const opened = await invokeE2E("openWorkManagementTab");
  if (!opened || opened.ok !== true) {
    throw new Error(
      `open work management failed: ${opened?.error ?? "unknown"}`
    );
  }
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!document.querySelector('[data-testid="kanban-file-search-input"] input');`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "Kanban file search input did not render",
    }
  );

  const alphaTitle = `Metadata alpha ${RUN_ID}`;
  const betaTitle = `Metadata beta ${RUN_ID}`;
  for (const fixture of [
    {
      sessionId: `sdeagent-e2e-file-search-alpha-${RUN_ID}`,
      name: alphaTitle,
      touchedFiles: ["src/features/metadata/SessionRoundMetadata.tsx"],
    },
    {
      sessionId: `sdeagent-e2e-file-search-beta-${RUN_ID}`,
      name: betaTitle,
      touchedFiles: ["src/engines/kanban/searchIndex.rs"],
    },
  ]) {
    const seed = await invokeE2E("seedSidebarSession", fixture);
    if (!seed || seed.ok !== true) {
      throw new Error(`Kanban search seed failed: ${seed?.error ?? "unknown"}`);
    }
  }

  const cardTitles = () =>
    execJS(`
      return Array.from(document.querySelectorAll('.kanban-task-card'))
        .map((card) => card.innerText || '');
    `);
  const setFileSearch = async (value) => {
    const nextValue = await execJS(`
      const input = document.querySelector('[data-testid="kanban-file-search-input"] input');
      if (!(input instanceof HTMLInputElement)) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) return null;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: ${JSON.stringify(value)},
        inputType: 'insertText',
      }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value;
    `);
    if (nextValue !== value) {
      throw new Error(`failed to set Kanban file search to ${value}`);
    }
  };
  await browser.waitUntil(
    async () => {
      const titles = await cardTitles();
      return (
        titles.some((title) => title.includes(alphaTitle)) &&
        titles.some((title) => title.includes(betaTitle))
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "seeded Kanban search cards did not render",
    }
  );

  await setFileSearch("roundmetadata");
  try {
    await browser.waitUntil(
      async () => {
        const titles = await cardTitles();
        return (
          titles.some((title) => title.includes(alphaTitle)) &&
          !titles.some((title) => title.includes(betaTitle))
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: "basename fragment did not filter Kanban sessions",
      }
    );
  } catch (error) {
    throw new Error(
      `${error.message}: ${JSON.stringify({
        inputValue: await execJS(
          `return document.querySelector('[data-testid="kanban-file-search-input"] input')?.value ?? null;`
        ),
        titles: await cardTitles(),
        body: await execJS(
          `return (document.body.innerText || '').slice(-3000);`
        ),
      })}`
    );
  }

  await setFileSearch("ENGINES\\KANBAN");
  await browser.waitUntil(
    async () => {
      const titles = await cardTitles();
      return (
        !titles.some((title) => title.includes(alphaTitle)) &&
        titles.some((title) => title.includes(betaTitle))
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "normalized partial path did not filter Kanban sessions",
    }
  );

  await setFileSearch("definitely-not-a-touched-file");
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!document.querySelector('[data-testid="kanban-file-search-empty"]');`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "Kanban file search empty state did not render",
    }
  );

  await setFileSearch("");
  await browser.waitUntil(
    async () => {
      const titles = await cardTitles();
      return (
        titles.some((title) => title.includes(alphaTitle)) &&
        titles.some((title) => title.includes(betaTitle))
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "clearing Kanban file search did not restore all sessions",
    }
  );
}

describe("Core chat rendering UI", () => {
  before(async () => {
    await waitForApp();
    const repo = await invokeE2E("ensureRepoSelected", {
      repoPath: E2E_REPO_PATH,
      repoName: "E2E Fixture Repo",
    });
    if (!repo || repo.ok !== true) {
      throw new Error(`ensureRepoSelected failed: ${repo?.error ?? "unknown"}`);
    }
    const navigation = await invokeE2E("navigateTo", "/orgii/workstation/code");
    if (!navigation || navigation.ok !== true) {
      throw new Error(`navigateTo failed: ${navigation?.error ?? "unknown"}`);
    }
  });

  it("renders all metadata-ledger tool-call classes from seeded history", async function () {
    if (!shouldRunScenario("metadata-ledger")) {
      this.skip();
      return;
    }

    const toolsResult = await invokeE2E("listAllTools");
    if (!toolsResult || toolsResult.ok !== true) {
      throw new Error(
        `listAllTools failed: ${toolsResult?.error ?? "unknown"}`
      );
    }

    const tools = renderableToolsFromMetadata(toolsResult.tools || []);
    const coveredBlocks = new Set(tools.map((tool) => tool.chatBlock));
    for (const requiredBlock of ["search", "read_file", "shell"]) {
      if (!coveredBlocks.has(requiredBlock)) {
        throw new Error(
          `tool render ledger missing ${requiredBlock}: ${tools.map((tool) => tool.name).join(", ")}`
        );
      }
    }
    const toolNames = new Set(tools.map((tool) => tool.name));
    for (const requiredTool of ["control_browser_with_agent_browser"]) {
      if (!toolNames.has(requiredTool)) {
        throw new Error(
          `tool render ledger missing ${requiredTool}: ${tools.map((tool) => tool.name).join(", ")}`
        );
      }
    }
    if (tools.length < 20) {
      throw new Error(
        `tool render ledger unexpectedly small: ${tools.map((tool) => tool.name).join(", ")}`
      );
    }

    const batches = chunk(tools, BATCH_SIZE);
    for (const [batchIndex, batchTools] of batches.entries()) {
      await assertBatchRendered(batchIndex, batchTools);
    }
  });

  it("pins background shell processes for the rendered chat session", async function () {
    if (!shouldRunScenario("background-process-pin")) {
      this.skip();
      return;
    }

    await assertBackgroundProcessPinnedToChatSession();
  });

  it("pins background subagent workers and drops them on completion", async function () {
    if (!shouldRunScenario("background-subagent-pin")) {
      this.skip();
      return;
    }

    await assertBackgroundSubagentPinnedToChatSession();
  });

  it("delivers subagent job events over the real broadcast wire and kills via the Stop command", async function () {
    if (!shouldRunScenario("background-subagent-pin-wire")) {
      this.skip();
      return;
    }

    await assertBackgroundSubagentWirePath();
  });

  it("does not show Stop or loading chrome for completed subagent cards", async function () {
    if (!shouldRunScenario("subagent-card-terminal")) {
      this.skip();
      return;
    }

    await assertCompletedSubagentCardIsTerminal();
  });

  it("cancels a running subagent from the rendered card Stop button", async function () {
    if (!shouldRunScenario("subagent-card-stop-wire")) {
      this.skip();
      return;
    }

    await assertSubagentCardStopUsesJobRegistryFallback();
  });

  it("shows the working footer when running events are hidden from chat", async function () {
    if (!shouldRunScenario("working-footer-hidden-running")) {
      this.skip();
      return;
    }

    await assertWorkingFooterShownForHiddenRunningEvent();
  });

  it("does not keep Stop active for stale hidden running events", async function () {
    if (!shouldRunScenario("stale-hidden-running-stop-state")) {
      this.skip();
      return;
    }

    await assertStaleHiddenRunningEventDoesNotHoldStopButton();
  });

  it("navigates to previous turn page on early-cancel Stop", async function () {
    if (!shouldRunScenario("early-cancel-turnpage-nav")) {
      this.skip();
      return;
    }

    await assertEarlyCancelStopNavigatesToPreviousTurnPage();
  });

  it("renders multi-repo read file targets as paths instead of generic file labels", async function () {
    if (!shouldRunScenario("multi-repo-read-path")) {
      this.skip();
      return;
    }

    await assertMultiRepoReadPathRendered();
  });

  it("greps the explicitly targeted sibling repo in a multi-repo workspace", async function () {
    if (!shouldRunScenario("multi-repo-grep-path")) {
      this.skip();
      return;
    }

    await assertMultiRepoGrepTargetsExplicitRepoPath();
  });

  it("renders explicit multi-repo search targets with root-qualified labels", async function () {
    if (!shouldRunScenario("multi-repo-search-target")) {
      this.skip();
      return;
    }

    await assertMultiRepoSearchTargetRendered();
  });

  it("renders repo-disambiguated paths for multi-repo tool rows", async function () {
    if (!shouldRunScenario("multi-repo-rendered-path-context")) {
      this.skip();
      return;
    }

    await assertMultiRepoRenderedPathContext();
  });

  it("renders a duplicated thought/answer segment pair only once", async function () {
    if (!shouldRunScenario("dedup")) {
      this.skip();
      return;
    }

    await assertDedupRenderedOnce();
  });

  it("preserves normalized OpenCode subagent rows after a native cache reload", async function () {
    if (!shouldRunScenario("opencode-subagent-reload")) {
      this.skip();
      return;
    }

    await assertOpenCodeSubagentReloadKeepsAnswerAndAssignment();
  });

  it("opens and releases the real #443 Codex session without full hydration or staircase growth", async function () {
    if (!shouldRunScenario("issue-443-real-codex")) {
      this.skip();
      return;
    }

    await assertIssue443RealCodexSessionStaysBounded();
  });

  it("renders thinking in chronological turn position without duplicates", async function () {
    if (!shouldRunScenario("thinking-order")) {
      this.skip();
      return;
    }

    await assertThinkingChronologicalOrder();
  });

  it("renders DB-materialized files, commits, PRs, and the no-change state per round", async function () {
    if (!shouldRunScenario("turn-metadata")) {
      this.skip();
      return;
    }

    await assertTurnMetadataFooterRendered();
  });

  it("filters rendered Kanban sessions by basename and partial file path", async function () {
    if (!shouldRunScenario("kanban-file-search")) {
      this.skip();
      return;
    }

    await assertKanbanFileSearchRendered();
  });
});
