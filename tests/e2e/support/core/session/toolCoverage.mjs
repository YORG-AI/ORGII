import { e2eUrl } from "../e2eBaseUrl.mjs";

export const WRITE_EFFECT_TOOL_NAMES = Object.freeze([
  "edit_file",
  "delete_file",
  "apply_patch",
  "write_file",
  "create_file",
  "edit_file_by_replace",
  "append_file",
  "file_range_edit",
  "insert_content_at_line",
  "Edit",
  "Write",
  "Create",
  "Patch",
]);

export const PLAN_FORBIDDEN_PROMPT_TOOL_NAMES = Object.freeze([
  ...WRITE_EFFECT_TOOL_NAMES,
  "run_shell",
  "await_output",
  "worktree",
  "manage_lsp",
  "setup_repo",
  "suggest_mode_switch",
  "manage_nodes",
  "db_run",
]);

export const ASK_FORBIDDEN_PROMPT_TOOL_NAMES = Object.freeze([
  ...PLAN_FORBIDDEN_PROMPT_TOOL_NAMES,
  "create_plan",
]);

export const CANONICAL_TOOL_NAMES = Object.freeze([
  "read_file",
  "list_dir",
  "run_shell",
  "await_output",
  "code_search",
  "edit_file",
  "delete_file",
  "apply_patch",
  "write_file",
  "create_file",
  "edit_file_by_replace",
  "append_file",
  "file_range_edit",
  "insert_content_at_line",
  "manage_workspace",
  "query_lsp",
  "manage_lsp",
  "manage_todo",
  "manage_file_history",
  "setup_repo",
  "ask_user_questions",
  "ask_user_permissions",
  "manage_project",
  "manage_work_item",
  "web_search",
  "web_fetch",
  "control_browser_with_agent_browser",
  "control_browser_with_playwright",
  "control_external_browser",
  "control_internal_browser",
  "control_orgii",
  "control_desktop_with_peekaboo",
  "db_explore",
  "db_run",
  "manage_session",
  "send_message",
  "manage_nodes",
  "manage_agent_def",
  "task_create",
  "task_update",
  "task_list",
  "task_get",
  "list_known_workspaces",
  "add_workspace_directory",
  "remove_workspace_directory",
  "list_session_workspace",
  "agent",
  "worktree",
  "send_to_inbox",
  "suggest_mode_switch",
  "tool_search",
  "render_inline_canvas",
  "create_plan",
  "plan_approval",
]);

const TOOL_RENDER_SCRIPT = `
  return Array.from(document.querySelectorAll('[data-tool-call-name]')).map((block) => ({
    name: block.getAttribute('data-tool-call-name') || '',
    eventId: block.getAttribute('data-tool-call-event-id') || '',
    text: (block.textContent || block.innerText || '').trim().slice(0, 1000),
  })).filter((block) => block.name.length > 0);
`;

function normalizeToolName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toolNameFromStateCall(call) {
  return normalizeToolName(
    call?.name ?? call?.toolName ?? call?.tool_name ?? call?.function?.name
  );
}

function uniqueSorted(values) {
  return Array.from(
    new Set(values.map(normalizeToolName).filter(Boolean))
  ).sort();
}

export async function fetchToolInventory(sessionId) {
  const response = await fetch(
    e2eUrl(`/agent/test/effective-tools/${encodeURIComponent(sessionId)}`)
  );
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(
      `effective tools fetch failed for ${sessionId}: ${payload.error}`
    );
  }
  const promptVisibleNames = uniqueSorted(payload?.promptToolNames ?? []);
  const registeredNames = uniqueSorted(payload?.registeredToolNames ?? []);
  return {
    registeredNames,
    readyNames: registeredNames,
    deferredNames: uniqueSorted(payload?.deferredToolNames ?? []),
    promptVisibleNames,
  };
}

export async function fetchRegisteredToolNames(sessionId) {
  return (await fetchToolInventory(sessionId)).registeredNames;
}

export async function renderedToolBlocks() {
  return browser.executeScript(TOOL_RENDER_SCRIPT, []);
}

export function extractExecutedToolNames(chatState) {
  const directCalls = Array.isArray(chatState?.toolCalls)
    ? chatState.toolCalls
    : [];
  const directNames = directCalls.map(toolNameFromStateCall);
  const eventNames = Array.isArray(chatState?.events)
    ? chatState.events.map((event) =>
        toolNameFromStateCall(event?.toolCall ?? event)
      )
    : [];
  const messageNames = Array.isArray(chatState?.messages)
    ? chatState.messages.flatMap((message) => {
        const calls = Array.isArray(message?.toolCalls)
          ? message.toolCalls
          : [];
        return calls.map(toolNameFromStateCall);
      })
    : [];
  return uniqueSorted([...directNames, ...eventNames, ...messageNames]);
}

export async function assertExecutedToolsRendered(label, chatState) {
  const executedNames = extractExecutedToolNames(chatState);
  const blocks = await renderedToolBlocks();
  const renderedNames = uniqueSorted(blocks.map((block) => block.name));
  const missingRendered = executedNames.filter(
    (name) => !renderedNames.includes(name)
  );
  if (missingRendered.length > 0) {
    throw new Error(
      `${label} executed tools are missing rendered DOM blocks; missing=${JSON.stringify(missingRendered)} executed=${JSON.stringify(executedNames)} rendered=${JSON.stringify(renderedNames)} blocks=${JSON.stringify(blocks)}`
    );
  }
  return { executedNames, renderedNames };
}

function deniedOrDeferredNames(inventory, promptVisibleNames) {
  const promptVisible = new Set(promptVisibleNames);
  return uniqueSorted([
    ...CANONICAL_TOOL_NAMES.filter((name) => !promptVisible.has(name)),
    ...(inventory.deferredNames ?? []),
  ]);
}

export async function buildCanonicalToolCoverageSummary(
  label,
  sessionId,
  chatState
) {
  const inventory = await fetchToolInventory(sessionId);
  const blocks = await renderedToolBlocks();
  const executedNames = extractExecutedToolNames(chatState);
  const renderedNames = uniqueSorted(blocks.map((block) => block.name));
  const promptVisibleNames = inventory.promptVisibleNames;
  const deniedNames = deniedOrDeferredNames(inventory, promptVisibleNames);
  const summary = {
    canonicalTotal: CANONICAL_TOOL_NAMES.length,
    registered: inventory.registeredNames,
    promptVisible: promptVisibleNames,
    called: CANONICAL_TOOL_NAMES.filter((name) => executedNames.includes(name)),
    rendered: CANONICAL_TOOL_NAMES.filter((name) =>
      renderedNames.includes(name)
    ),
    deniedOrDeferred: CANONICAL_TOOL_NAMES.filter((name) =>
      deniedNames.includes(name)
    ),
    missingCalled: CANONICAL_TOOL_NAMES.filter(
      (name) =>
        inventory.readyNames.includes(name) && !executedNames.includes(name)
    ),
    missingRendered: CANONICAL_TOOL_NAMES.filter(
      (name) => executedNames.includes(name) && !renderedNames.includes(name)
    ),
  };
  console.log(`[canonical-tool-coverage] ${label} ${JSON.stringify(summary)}`);
  return summary;
}

export async function assertAllReadyToolsExecutedAndRendered(
  label,
  sessionId,
  chatState
) {
  const inventory = await fetchToolInventory(sessionId);
  const { executedNames, renderedNames } = await assertExecutedToolsRendered(
    label,
    chatState
  );
  const missingExecuted = inventory.readyNames.filter(
    (name) => !executedNames.includes(name)
  );
  const missingRendered = inventory.readyNames.filter(
    (name) => !renderedNames.includes(name)
  );
  if (missingExecuted.length > 0 || missingRendered.length > 0) {
    throw new Error(
      `${label} did not cover every ready registered tool; missingExecuted=${JSON.stringify(missingExecuted)} missingRendered=${JSON.stringify(missingRendered)} inventory=${JSON.stringify(inventory)} executed=${JSON.stringify(executedNames)} rendered=${JSON.stringify(renderedNames)}`
    );
  }
  return { ...inventory, executedNames, renderedNames };
}
