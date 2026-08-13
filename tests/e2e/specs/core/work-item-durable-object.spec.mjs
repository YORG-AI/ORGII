/* global browser, describe, before, it, process */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForApp } from "../../support/core/session/agentPlanFollowupScenarios.mjs";

const DEFAULT_E2E_REPO_PATH =
  process.platform === "win32"
    ? join(tmpdir(), "orgii-e2e-workspace-repo")
    : "/tmp/orgii-e2e-workspace-repo";
const E2E_REPO_PATH = process.env.E2E_REPO_PATH ?? DEFAULT_E2E_REPO_PATH;
const PENDING_SESSION_ID = "pending";
const RUN_ID = Date.now();
const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 20_000;
const PERSIST_TIMEOUT_MS = 30_000;
const LLM_COMPLETION_PERSIST_TIMEOUT_MS = 120_000;
const REPLY_TIMEOUT_MS = 180_000;
const API_ACCOUNT_NAME = process.env.E2E_OPENAI_ACCOUNT;
const API_AGENT_TYPE = process.env.E2E_API_AGENT_TYPE ?? "openai_api";
const PREFERRED_API_MODEL_ID = process.env.E2E_OPENAI_MODEL ?? "op-4.6-relay";
const SCENARIO_FILTER = (process.env.E2E_CONTROL_SCENARIOS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const ROUTINE_CONCURRENCY_SCENARIO = "routine-concurrency-policies";
const ROUTINE_CREATE_WORK_ITEM_CONTRACT_SCENARIO =
  "routine-create-work-item-contract";
const ROUTINE_CREATE_WORK_ITEM_FAILURE_SCENARIO =
  "routine-create-work-item-failure";
const STANDALONE_WORK_ITEM_CONTRACT_SCENARIO = "standalone-work-item-contract";
const RENDERED_STANDALONE_WORK_ITEM_UI_SCENARIO =
  "rendered-standalone-work-item-ui";
const WORK_ITEM_UI_LLM_SCENARIO = "work-item-ui-llm-execution";
const CHAT_PANEL_WORK_ITEM_LINK_CREATE_UI_SCENARIO =
  "chat-panel-work-item-link-create-ui";
const CHAT_PANEL_WORK_ITEM_SESSION_BREADCRUMB_UI_SCENARIO =
  "chat-panel-work-item-session-breadcrumb-ui";
const CREATE_WORK_ITEM_AI_GENERATE_UI_SCENARIO =
  "create-work-item-ai-generate-ui";
const CREATE_WORK_ITEM_AUTO_EXECUTE_GUARD_UI_SCENARIO =
  "create-work-item-auto-execute-guard-ui";
const SESSION_LINK_WORK_ITEM_UI_SCENARIO = "session-link-work-item-ui";
const WORK_ITEM_RERUN_UI_LLM_SCENARIO = "work-item-rerun-ui-llm-execution";
const ROUTINE_CREATE_WORK_ITEM_UI_LLM_SCENARIO =
  "routine-create-work-item-ui-llm-execution";
const ROUTINE_FIRE_STATUS = {
  STARTED: "started",
  SUCCEEDED: "succeeded",
  COMPLETED: "completed",
  FAILED: "failed",
  COALESCED: "coalesced",
  SKIPPED: "skipped",
  QUEUED: "queued",
};
const ROUTINE_CONCURRENCY_POLICY = {
  COALESCE_IF_ACTIVE: "coalesce_if_active",
  SKIP_IF_ACTIVE: "skip_if_active",
  QUEUE_IF_ACTIVE: "queue_if_active",
  ALWAYS_CREATE: "always_create",
};
const ROUTINE_OUTPUT_MODE = {
  DIRECT_SESSION: "direct_session",
  CREATE_WORK_ITEM: "create_work_item",
};

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function invokeE2E(method, ...args) {
  const envelope = await browser.executeAsyncScript(
    `
    const cb = arguments[arguments.length - 1];
    const method = arguments[0];
    const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
    if (!window.__e2e || typeof window.__e2e[method] !== "function") {
      cb({ e2eResult: { ok: false, error: "window.__e2e." + method + " not available" } });
      return;
    }
    Promise.resolve(window.__e2e[method].apply(null, rest))
      .then((result) => cb({ e2eResult: result }))
      .catch((error) => cb({ e2eResult: { ok: false, error: String(error && error.message || error) } }));
  `,
    [method, ...args]
  );
  return (
    envelope?.e2eResult ?? {
      ok: false,
      error: "invokeE2E returned no envelope",
    }
  );
}

function unwrap(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed: ${result?.error ?? "unknown"}`);
  }
  return result;
}

function selectRustAgentAccount(accounts) {
  const candidates = accounts.filter((row) => {
    const nameMatches =
      !API_ACCOUNT_NAME ||
      row.name === API_ACCOUNT_NAME ||
      row.id === API_ACCOUNT_NAME;
    const modelMatches = (row.enabled_models ?? []).includes(
      PREFERRED_API_MODEL_ID
    );
    return (
      row.agent_type === API_AGENT_TYPE &&
      row.enabled &&
      (row.has_api_key || row.has_session_token) &&
      row.supports_rust_agents &&
      nameMatches &&
      modelMatches
    );
  });
  return candidates[0] ?? null;
}

function routineDefinition(account, workspacePath, concurrencyPolicy, suffix) {
  const now = new Date().toISOString();
  return {
    id: `e2e-routine-${suffix}-${RUN_ID}`,
    name: `E2E routine ${suffix} ${RUN_ID}`,
    description: `E2E routine concurrency coverage for ${concurrencyPolicy}`,
    enabled: true,
    trigger: { kind: "one_time", at: now },
    runTemplate: {
      prompt:
        "E2E routine concurrency probe. Reply with one short sentence and do not modify files.",
      target: { kind: "agent_definition", agentDefinitionId: "builtin:sde" },
      resources: {
        keySource: "own_key",
        accountId: account.id,
        model: PREFERRED_API_MODEL_ID,
      },
      workspace: {
        kind: "local_workspace",
        workspacePath,
        additionalDirectories: [],
      },
      mode: "ask",
      name: `E2E routine ${suffix} ${RUN_ID}`,
    },
    outputPolicy: {
      mode: ROUTINE_OUTPUT_MODE.DIRECT_SESSION,
      concurrencyPolicy,
      catchUpPolicy: "run_once",
      maxCatchUpRuns: 1,
      idempotencyScope: "routine_fire",
      createWorkItemStatus: "planned",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function routineWorkItemDefinition({
  account,
  workspacePath,
  projectSlug,
  suffix,
  title,
  body,
  concurrencyPolicy = ROUTINE_CONCURRENCY_POLICY.COALESCE_IF_ACTIVE,
}) {
  const now = new Date().toISOString();
  return {
    id: `e2e-routine-work-item-${suffix}-${RUN_ID}`,
    name: `E2E routine to Work Item ${suffix} ${RUN_ID}`,
    description: `E2E routine creates a Work Item for ${projectSlug}`,
    enabled: true,
    trigger: { kind: "one_time", at: now },
    runTemplate: {
      prompt: body,
      target: { kind: "agent_definition", agentDefinitionId: "builtin:sde" },
      resources: {
        keySource: "own_key",
        accountId: account.id,
        model: PREFERRED_API_MODEL_ID,
      },
      workspace: {
        kind: "local_workspace",
        workspacePath,
        additionalDirectories: [],
      },
      mode: "ask",
      name: title,
    },
    outputPolicy: {
      mode: ROUTINE_OUTPUT_MODE.CREATE_WORK_ITEM,
      concurrencyPolicy,
      catchUpPolicy: "run_once",
      maxCatchUpRuns: 1,
      idempotencyScope: "routine_fire",
      createWorkItemStatus: "planned",
      createWorkItemProjectSlug: projectSlug,
      createWorkItemTitle: title,
      createWorkItemBody: body,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function shouldRunScenario(name) {
  return SCENARIO_FILTER.length === 0 || SCENARIO_FILTER.includes(name);
}

function isScenarioExplicitlyRequested(name) {
  return SCENARIO_FILTER.includes(name);
}

function assertE2ERepoFixture() {
  const requiredPaths = [
    E2E_REPO_PATH,
    join(E2E_REPO_PATH, ".git"),
    join(E2E_REPO_PATH, "README.md"),
    join(E2E_REPO_PATH, "package.json"),
  ];
  const missingPath = requiredPaths.find((path) => !existsSync(path));
  if (missingPath) {
    throw new Error(
      `E2E repo fixture is missing ${missingPath}; runner should create E2E_REPO_PATH before specs start`
    );
  }
}

function createProjectMeta(slug, name, repoPath) {
  const now = new Date().toISOString();
  return {
    id: slug,
    name,
    org_id: "personal-org",
    status: "planned",
    priority: "none",
    health: "no_updates",
    members: [],
    labels: [],
    linked_repos: [repoPath],
    created_at: now,
    updated_at: now,
    next_work_item_id: 2,
    work_item_prefix: "E2E",
    work_item_prefix_custom: true,
  };
}

function createWorkItemFrontmatter({ shortId, title, account }) {
  const now = new Date().toISOString();
  return {
    id: shortId,
    short_id: shortId,
    title,
    status: "planned",
    priority: "none",
    labels: [],
    created_by: "e2e",
    created_at: now,
    updated_at: now,
    starred: false,
    todos: [],
    orchestrator_config: {
      review_enabled: false,
      follow_up_enabled: false,
      auto_retry_on_failure: false,
      max_retry_count: 0,
      auto_create_pr: false,
      selected_account_id: account.id,
      selected_model_id: PREFERRED_API_MODEL_ID,
      agent_definition_id: "builtin:sde",
      agent_mode: "ask",
    },
  };
}

function createBasicWorkItemFrontmatter({ shortId, title, project }) {
  const now = new Date().toISOString();
  return {
    id: shortId,
    short_id: shortId,
    title,
    project,
    status: "planned",
    priority: "none",
    labels: [],
    created_by: "e2e",
    created_at: now,
    updated_at: now,
    starred: false,
    todos: [],
  };
}

async function clickSelector(selector) {
  return execJS(`
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const element = elements.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (!element) return elements.length > 0 ? "hidden" : "missing";
    if (element.disabled) return "disabled";
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return "clicked";
  `);
}

async function clickExistingSelector(selector) {
  return execJS(`
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    if (element.disabled) return "disabled";
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return "clicked";
  `);
}

async function waitForExistingSelector(
  selector,
  label,
  timeout = RENDER_TIMEOUT_MS
) {
  await browser.waitUntil(
    async () =>
      execJS(
        `return Boolean(document.querySelector(${JSON.stringify(selector)}));`
      ),
    {
      timeout,
      timeoutMsg: `${label} did not exist for selector ${selector}`,
    }
  );
}

async function setInputValue(selector, value, label) {
  const result = await execJS(`
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return "missing";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (!setter) return "no-setter";
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value;
  `);
  if (result !== value) {
    throw new Error(
      `${label} input did not accept value: ${JSON.stringify(result)}`
    );
  }
}

async function setComposerText(containerSelector, value, label) {
  const result = await execJS(`
    const container = document.querySelector(${JSON.stringify(containerSelector)});
    const host = container?.querySelector('[contenteditable="true"]');
    if (!container || !host) return { ok: false, reason: container ? "missing-host" : "missing-container" };
    host.focus();
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, ${JSON.stringify(value)});
    host.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(value)} }));
    return { ok: true, text: host.textContent || "" };
  `);
  if (!result?.ok || !result.text.includes(value)) {
    throw new Error(
      `${label} composer did not accept text: ${JSON.stringify(result)}`
    );
  }
}

async function switchDisabledState(selector) {
  return execJS(`
    const root = document.querySelector(${JSON.stringify(selector)});
    const control = root?.matches('button,input,[role="switch"]')
      ? root
      : root?.querySelector('button,input,[role="switch"]');
    return {
      exists: Boolean(root),
      disabled: Boolean(control?.disabled || control?.getAttribute('aria-disabled') === 'true'),
      checked: Boolean(control?.checked || control?.getAttribute('aria-checked') === 'true'),
      html: root?.outerHTML?.slice(0, 500) || null,
    };
  `);
}

async function workItemAgentModeState() {
  return execJS(`
    const toggle = document.querySelector('[data-testid="chat-panel-start-page-work-item-mode-toggle"]');
    if (toggle) {
      return {
        exists: true,
        disabled: Boolean(toggle.disabled || toggle.getAttribute('aria-disabled') === 'true'),
        checked: toggle.getAttribute('aria-pressed') === 'true',
        surface: 'launchpad-toggle',
      };
    }
    const legacy = document.querySelector('[data-testid="chat-panel-work-item-agent-switch"]');
    const control = legacy?.matches('button,input,[role="switch"]')
      ? legacy
      : legacy?.querySelector('button,input,[role="switch"]');
    return {
      exists: Boolean(legacy),
      disabled: Boolean(control?.disabled || control?.getAttribute('aria-disabled') === 'true'),
      checked: Boolean(control?.checked || control?.getAttribute('aria-checked') === 'true'),
      surface: legacy ? 'legacy-switch' : 'none',
    };
  `);
}

async function selectChatPanelWorkItemCreateTarget(
  label,
  { agentMode = false } = {}
) {
  const launchpadTab = await clickSelector(
    '[data-testid="chat-panel-start-page-tab-work-item"]'
  );
  if (launchpadTab === "clicked") {
    await waitForVisibleSelector(
      '[data-testid="chat-panel-start-page-work-item-mode-toggle"]',
      `${label} Work Item mode toggle`,
      MOUNT_TIMEOUT_MS
    );
    const toggleState = await workItemAgentModeState();
    if (!toggleState.exists || toggleState.disabled) {
      throw new Error(
        `${label} Work Item mode toggle unavailable: ${JSON.stringify(toggleState)}`
      );
    }
    if (toggleState.checked !== agentMode) {
      const toggleClick = await clickSelector(
        '[data-testid="chat-panel-start-page-work-item-mode-toggle"]'
      );
      if (toggleClick !== "clicked") {
        throw new Error(
          `${label} Work Item mode toggle click failed: ${toggleClick}`
        );
      }
    }
    if (agentMode) {
      await waitForVisibleSelector(
        '[data-testid="session-creator-chat-panel"]',
        `${label} Work Item agent creator`,
        MOUNT_TIMEOUT_MS
      );
      return;
    }
    await waitForVisibleSelector(
      '[data-testid="create-work-item-editor"]',
      `${label} create Work Item editor`,
      MOUNT_TIMEOUT_MS
    );
    return;
  }

  const startPageAction = await clickSelector(
    '[data-testid="chat-panel-start-page-new-work-item"]'
  );
  if (startPageAction === "missing" || startPageAction === "hidden") {
    await waitForVisibleSelector(
      '[data-testid="chat-panel-create-target-select"]',
      `${label} create target select`,
      MOUNT_TIMEOUT_MS
    );
    const selectClick = await clickSelector(
      '[data-testid="chat-panel-create-target-select"]'
    );
    if (selectClick !== "clicked") {
      throw new Error(
        `${label} create target select click failed: ${selectClick}`
      );
    }
    await waitForVisibleSelector(
      '[data-testid="chat-panel-create-target-work-item-option"]',
      `${label} Work Item target option`,
      RENDER_TIMEOUT_MS
    );
    const optionClick = await clickSelector(
      '[data-testid="chat-panel-create-target-work-item-option"]'
    );
    if (optionClick !== "clicked") {
      throw new Error(
        `${label} Work Item target option click failed: ${optionClick}`
      );
    }
  } else if (startPageAction !== "clicked") {
    throw new Error(
      `${label} start-page Work Item action failed: ${startPageAction}`
    );
  }

  await waitForVisibleSelector(
    '[data-testid="chat-panel-work-item-agent-switch"]',
    `${label} Work Item agent switch`,
    MOUNT_TIMEOUT_MS
  );
  const agentSwitchState = await switchDisabledState(
    '[data-testid="chat-panel-work-item-agent-switch"]'
  );
  if (!agentSwitchState.exists || agentSwitchState.disabled) {
    throw new Error(
      `${label} Work Item agent switch unavailable: ${JSON.stringify(agentSwitchState)}`
    );
  }
  if (agentSwitchState.checked !== agentMode) {
    const switchClick = await clickSelector(
      '[data-testid="chat-panel-work-item-agent-switch"]'
    );
    if (switchClick !== "clicked") {
      throw new Error(
        `${label} Work Item agent switch click failed: ${switchClick}`
      );
    }
  }

  if (agentMode) {
    await waitForVisibleSelector(
      '[data-testid="session-creator-chat-panel"]',
      `${label} Work Item agent creator`,
      MOUNT_TIMEOUT_MS
    );
    return;
  }

  await waitForVisibleSelector(
    '[data-testid="create-work-item-editor"]',
    `${label} create Work Item editor`,
    MOUNT_TIMEOUT_MS
  );
}

function workItemCreatedAtMs(item) {
  const raw = item.frontmatter?.created_at ?? item.frontmatter?.createdAt;
  if (!raw) return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000_000) return numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function collectStandaloneItemsAcrossOrgs(label) {
  const rows = [];
  const personal = unwrap(
    await invokeE2E("readStandaloneWorkItems"),
    `readStandaloneWorkItems(${label}:personal)`
  );
  rows.push(...personal.items.map((item) => ({ item, orgId: null })));
  const orgsResult = await invokeE2E("readProjectOrgs");
  const orgs = orgsResult?.ok ? (orgsResult.orgs ?? []) : [];
  for (const org of orgs) {
    const orgId = org?.id;
    if (!orgId || orgId === "personal-org") continue;
    const scoped = await invokeE2E("readStandaloneWorkItems", orgId);
    if (scoped?.ok) {
      rows.push(...scoped.items.map((item) => ({ item, orgId })));
    }
  }
  return rows;
}

async function waitForStandaloneWorkItemByTitle(title, label) {
  let matchedItem = null;
  await browser.waitUntil(
    async () => {
      const rows = await collectStandaloneItemsAcrossOrgs(label);
      matchedItem =
        rows.find((row) => row.item.frontmatter?.title === title)?.item ?? null;
      return Boolean(
        matchedItem?.frontmatter?.short_id || matchedItem?.frontmatter?.shortId
      );
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `Standalone Work Item was not listed for ${label}: ${JSON.stringify(matchedItem)}`,
    }
  );
  return matchedItem;
}

async function waitForChatPanelWorkItemDetail(title, label) {
  let state = null;
  await browser
    .waitUntil(
      async () => {
        state = await execJS(`
        const panel = document.querySelector('[data-testid="chat-panel-work-item-detail"]');
        const headerTitle = document.querySelector('[data-testid="chat-panel-header-title"]')?.textContent
          || document.querySelector('[data-testid="chat-panel-header-title-input"]')?.value
          || '';
        const contentTitle = document.querySelector('[data-testid="work-item-content-editor"] input')?.value
          || '';
        const bodyText = document.body.innerText || '';
        return {
          hasPanel: Boolean(panel),
          headerTitle,
          contentTitle,
          hasTitle: bodyText.includes(${JSON.stringify(title)})
            || headerTitle.includes(${JSON.stringify(title)})
            || contentTitle.includes(${JSON.stringify(title)}),
          bodyText: bodyText.slice(0, 1800),
        };
      `);
        return state.hasPanel && state.hasTitle;
      },
      {
        timeout: MOUNT_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `${label} ChatPanel Work Item detail did not render`,
      }
    )
    .catch((error) => {
      throw new Error(
        `${label} ChatPanel Work Item detail did not render: latest=${JSON.stringify(state)} original=${String(error?.message ?? error)}`
      );
    });
  return state;
}

async function waitForRenderedAssistantReply(label, sessionId) {
  let state = null;
  let followAgentClicked = false;
  try {
    await browser.waitUntil(
      async () => {
        const chatState = await invokeE2E("inspectChatState");
        const assistantMessages = (chatState.chatEvents ?? [])
          .filter(
            (event) =>
              event.source === "assistant" &&
              event.displayVariant === "message" &&
              typeof event.displayText === "string" &&
              event.displayText.trim().length > 0
          )
          .map((event) => event.displayText.trim());

        if (assistantMessages.length > 0) {
          await execJS(`
            const history = document.querySelector('[data-testid="chat-message-list"]');
            if (history) {
              const scrollCandidates = Array.from(document.querySelectorAll('*')).filter((node) => {
                const style = window.getComputedStyle(node);
                const canScrollY = style.overflowY === 'auto' || style.overflowY === 'scroll';
                return canScrollY && node.scrollHeight > node.clientHeight + 8;
              });
              for (const node of scrollCandidates) {
                if (node.contains(history) || history.contains(node)) {
                  node.scrollTop = node.scrollHeight;
                }
              }
              history.scrollTop = history.scrollHeight;
            }
          `);
        }

        const domState = await execJS(`
          const history = document.querySelector('[data-testid="chat-message-list"]');
          const assistantMessages = ${JSON.stringify(assistantMessages)};
          const assistantRows = Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]'));
          const assistantTexts = assistantRows.map((row) => row.textContent || "");
          const bodyText = document.body.innerText || "";
          const visibleAssistantMessages = assistantMessages.filter((message) => {
            const snippet = message.slice(0, Math.min(80, message.length));
            return snippet.length > 0 && bodyText.includes(snippet);
          });
          const activityLike = Array.from(
            document.querySelectorAll('[data-testid^="chat-message"], .chat-text, .activity-chat-item, .resultBgc, [data-e2e-chat-flat-index]')
          ).slice(0, 50).map((node) => ({
            tag: node.tagName,
            testId: node.getAttribute('data-testid'),
            className: typeof node.className === 'string' ? node.className : '',
            text: (node.textContent || '').trim().slice(0, 300),
          }));
          return {
            assistantTexts: assistantTexts.filter((text) => text.trim().length > 0),
            visibleAssistantMessages,
            hasFollowAgentButton: Array.from(document.querySelectorAll('button')).some(
              (button) => (button.textContent || '').trim() === 'Follow Agent'
            ),
            historyAttrs: history ? {
              chatHistoryCount: history.getAttribute('data-chat-history-count'),
              optimizedCount: history.getAttribute('data-optimized-count'),
              flatCount: history.getAttribute('data-flat-count'),
              groupCounts: history.getAttribute('data-group-counts'),
            } : null,
            activityLike,
            historyHtml: history?.innerHTML?.slice(0, 4000) || "",
            historyText: history?.textContent || "",
            bodyText: bodyText.slice(0, 4000),
          };
        `);
        const aggregateState = sessionId
          ? await invokeE2E("getSessionAggregateRow", sessionId)
          : null;
        state = { domState, chatState, aggregateState };

        if (
          !followAgentClicked &&
          assistantMessages.length > 0 &&
          domState.hasFollowAgentButton
        ) {
          const clicked = await execJS(`
            const button = Array.from(document.querySelectorAll('button')).find(
              (candidate) => (candidate.textContent || '').trim() === 'Follow Agent'
            );
            if (!button) return false;
            button.click();
            return true;
          `);
          followAgentClicked = Boolean(clicked);
          if (followAgentClicked) return false;
        }

        if (domState.assistantTexts.some((text) => text.trim().length > 0)) {
          return true;
        }
        if (domState.visibleAssistantMessages.length > 0) {
          return true;
        }

        return false;
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 1000,
        timeoutMsg: `No rendered assistant reply appeared for ${label}`,
      }
    );
  } catch (error) {
    throw new Error(
      `No rendered assistant reply appeared for ${label}: latest=${JSON.stringify(state)} original=${String(error?.message ?? error)}`
    );
  }
}

async function waitForSessionAggregateRow(
  sessionId,
  predicate,
  label,
  timeout = PERSIST_TIMEOUT_MS
) {
  let latestSession = null;
  let latestResult = null;
  try {
    await browser.waitUntil(
      async () => {
        try {
          const rawResult = await invokeE2E(
            "getSessionAggregateRow",
            sessionId
          );
          latestResult = rawResult;
          const result = unwrap(rawResult, `getSessionAggregateRow(${label})`);
          latestSession = result.session;
          return Boolean(latestSession && predicate(latestSession));
        } catch (error) {
          latestResult = {
            ok: false,
            thrown: String(error?.message ?? error),
          };
          return false;
        }
      },
      {
        timeout,
        interval: 500,
        timeoutMsg: `Session aggregate row did not match ${label}`,
      }
    );
  } catch (error) {
    throw new Error(
      `Session aggregate row did not match ${label}: sessionId=${sessionId} latestSession=${JSON.stringify(latestSession)} latestResult=${JSON.stringify(latestResult)} original=${String(error?.message ?? error)}`
    );
  }
  return latestSession;
}

async function waitForWorkItemLock(projectSlug, shortId, label) {
  let lockedItem = null;
  let lastReadResult = null;
  try {
    await browser.waitUntil(
      async () => {
        try {
          const result = await invokeE2E("readWorkItem", projectSlug, shortId);
          lastReadResult = result;
          if (!result?.ok || !result.item) {
            return false;
          }
          lockedItem = result.item;
          const activeSessionId =
            lockedItem.frontmatter?.execution_lock?.activeSessionId;
          return (
            typeof activeSessionId === "string" &&
            activeSessionId !== PENDING_SESSION_ID
          );
        } catch (error) {
          lastReadResult = {
            ok: false,
            error: String(error?.message ?? error),
          };
          return false;
        }
      },
      {
        timeout: PERSIST_TIMEOUT_MS,
        interval: 500,
      }
    );
  } catch (error) {
    throw new Error(
      `Work Item execution lock was not persisted for ${label}: item=${JSON.stringify(lockedItem)} readResult=${JSON.stringify(lastReadResult)} waitError=${String(error?.message ?? error)}`
    );
  }
  return lockedItem;
}

async function waitForWorkItemLockCleared(
  projectSlug,
  shortId,
  sessionId,
  label,
  timeout = PERSIST_TIMEOUT_MS
) {
  let item = null;
  await browser.waitUntil(
    async () => {
      item = unwrap(
        await invokeE2E("readWorkItem", projectSlug, shortId),
        `readWorkItem(${label})`
      ).item;
      const activeSessionId = item.frontmatter?.execution_lock?.activeSessionId;
      return !activeSessionId || activeSessionId !== sessionId;
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `Work Item execution lock did not clear for ${label}: ${JSON.stringify(item)}`,
    }
  );
  return item;
}

async function waitForVisibleSelector(
  selector,
  label,
  timeout = RENDER_TIMEOUT_MS
) {
  await browser.waitUntil(
    async () =>
      execJS(`
        return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const style = window.getComputedStyle(candidate);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
      `),
    {
      timeout,
      timeoutMsg: `${label} did not render for selector ${selector}`,
    }
  );
}

async function waitForWorkItemByTitle(projectSlug, title, label) {
  let matchedItem = null;
  let latestItems = [];
  await browser.waitUntil(
    async () => {
      const result = unwrap(
        await invokeE2E("readWorkItemsEnriched", projectSlug),
        `readWorkItemsEnriched(${label})`
      );
      latestItems = result.items;
      matchedItem =
        latestItems.find(
          (item) => (item.title ?? item.frontmatter?.title) === title
        ) ?? null;
      return Boolean(
        matchedItem?.shortId ||
        matchedItem?.short_id ||
        matchedItem?.frontmatter?.short_id
      );
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `Routine-created Work Item was not listed for ${label}: matched=${JSON.stringify(matchedItem)} latest=${JSON.stringify(latestItems)}`,
    }
  );
  return matchedItem;
}

async function listWorkItemsByTitle(projectSlug, title, label) {
  return unwrap(
    await invokeE2E("readWorkItemsEnriched", projectSlug),
    `readWorkItemsEnriched(${label})`
  ).items.filter((item) => (item.title ?? item.frontmatter?.title) === title);
}

async function latestRoutineFire(routineId, label) {
  const fires = unwrap(
    await invokeE2E("listRoutineFires", routineId),
    `listRoutineFires(${label})`
  ).fires;
  return fires[0] ?? null;
}

async function assertNoSessionForRoutineFire(fireResult, label) {
  if (fireResult.sessionId || fireResult.agentOrgRunId) {
    throw new Error(
      `${label} must not launch a session immediately: ${JSON.stringify(fireResult)}`
    );
  }
}

async function startWorkItemRunFromUi(
  projectSlug,
  projectName,
  shortId,
  label
) {
  await openSeededWorkItemExecutionTab(projectSlug, projectName, shortId);
  const workItem = unwrap(
    await invokeE2E("readWorkItem", projectSlug, shortId),
    `readWorkItem(${label} launch)`
  ).item;
  const frontmatter = workItem.frontmatter ?? {};
  const config = frontmatter.orchestrator_config ?? {};
  const prompt =
    typeof workItem.body === "string" && workItem.body.trim()
      ? workItem.body
      : `Run Work Item ${shortId}. Reply briefly and do not modify files.`;
  const launchedSession = unwrap(
    await invokeE2E("launchSession", {
      category: "rust_agent",
      content: prompt,
      prompt,
      accountId: config.selected_account_id,
      model: config.selected_model_id ?? PREFERRED_API_MODEL_ID,
      workspacePath: E2E_REPO_PATH,
      projectSlug,
      workItemId: shortId,
      agentDefinitionId: config.agent_definition_id,
      agentExecMode: config.agent_mode,
      agentRole: "coding",
    }),
    `launchSession(${label} Work Item run)`
  ).result;
  const sessionId = launchedSession.sessionId ?? launchedSession.session_id;
  if (!sessionId) {
    throw new Error(
      `${label} launchSession did not return a session id: ${JSON.stringify(launchedSession)}`
    );
  }
  await waitForSessionAggregateRow(
    sessionId,
    (session) =>
      session.sessionId === sessionId &&
      session.category === "rust_agent" &&
      session.workItemId === shortId &&
      session.projectSlug === projectSlug,
    `${label} launched session aggregate linkage`
  );
  try {
    const lockedItem = await waitForWorkItemLock(
      projectSlug,
      shortId,
      `${label} launchSession`
    );
    const lockedSessionId =
      lockedItem.frontmatter.execution_lock.activeSessionId;
    if (lockedSessionId !== sessionId) {
      throw new Error(
        `${label} Work Item lock did not point at launched session: expected=${sessionId} actual=${JSON.stringify(lockedItem.frontmatter.execution_lock)}`
      );
    }
  } catch (error) {
    const session = await waitForSessionAggregateRow(
      sessionId,
      (row) => row.sessionId === sessionId && row.status !== "running",
      `${label} launched session completed before lock observation`,
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );
    if (!session) {
      throw error;
    }
  }
  return sessionId;
}

async function openSeededWorkItemExecutionTab(
  projectSlug,
  projectName,
  shortId
) {
  const targetWorkItem = unwrap(
    await invokeE2E("readWorkItem", projectSlug, shortId),
    "readWorkItem(work item execution tab target)"
  ).item;
  const targetWorkItemId = targetWorkItem.session_id ?? null;
  const openState = unwrap(
    await invokeE2E(
      "openProjectWorkItemsTab",
      projectSlug,
      projectName,
      projectSlug
    ),
    "openProjectWorkItemsTab(work item execution tab)"
  );

  const rowSelector = `[data-testid="work-item-row-${shortId}"]`;
  const targetProjectTabId = openState.activeTabId;
  const projectTabSelector = `[data-tab-id="${targetProjectTabId}"]`;
  let projectOpenState = null;
  await browser
    .waitUntil(
      async () => {
        const tabClick = targetProjectTabId
          ? await clickSelector(projectTabSelector)
          : "missing";
        projectOpenState = await execJS(`
        const router = document.querySelector('[data-testid="project-manager-content-router"]');
        const activeTabId = router?.getAttribute('data-active-tab-id') || null;
        const activeTabType = router?.getAttribute('data-active-tab-type') || null;
        const bodyText = document.body.innerText || '';
        const isVisible = (candidate) => {
          if (!candidate) return false;
          const rect = candidate.getBoundingClientRect();
          const style = window.getComputedStyle(candidate);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const hasVisibleWorkItemRow = Array.from(document.querySelectorAll(${JSON.stringify(rowSelector)})).some(isVisible);
        const hasCurrentDetail = Array.from(document.querySelectorAll('[data-testid="work-item-detail"]')).some(
          (candidate) =>
            isVisible(candidate) &&
            candidate.getAttribute('data-work-item-short-id') === ${JSON.stringify(shortId)} &&
            (${JSON.stringify(targetWorkItemId)} === null ||
              candidate.getAttribute('data-work-item-id') === ${JSON.stringify(targetWorkItemId)})
        );
        return {
          activeTabId,
          activeTabType,
          hasVisibleWorkItemRow,
          hasCurrentDetail,
          openState: ${JSON.stringify(openState)},
          tabClick: ${JSON.stringify(tabClick)},
          bodyText: bodyText.slice(0, 1000),
        };
      `);
        return (
          projectOpenState.hasCurrentDetail ||
          projectOpenState.hasVisibleWorkItemRow
        );
      },
      {
        timeout: MOUNT_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `Project Work Item surface did not become visible for ${projectSlug}`,
      }
    )
    .catch((error) => {
      throw new Error(
        `Project Work Item surface did not become visible for ${projectSlug}; latest=${JSON.stringify(projectOpenState)} original=${String(error?.message ?? error)}`
      );
    });
  const hasTargetDetail = () =>
    execJS(`
    const isVisible = (candidate) => {
      if (!candidate) return false;
      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return Array.from(document.querySelectorAll('[data-testid="work-item-detail"]')).some(
      (candidate) =>
        isVisible(candidate) &&
        candidate.getAttribute('data-work-item-short-id') === ${JSON.stringify(shortId)} &&
        (${JSON.stringify(targetWorkItemId)} === null ||
          candidate.getAttribute('data-work-item-id') === ${JSON.stringify(targetWorkItemId)})
    );
  `);

  if (!(await hasTargetDetail())) {
    await waitForVisibleSelector(
      rowSelector,
      "seeded Work Item row",
      MOUNT_TIMEOUT_MS
    );
    let rowOpenState = null;
    await browser
      .waitUntil(
        async () => {
          const rowClick = await clickSelector(rowSelector);
          rowOpenState = await execJS(`
          const router = document.querySelector('[data-testid="project-manager-content-router"]');
          const activeTabId = router?.getAttribute('data-active-tab-id') || null;
          const activeTabType = router?.getAttribute('data-active-tab-type') || null;
          const rowElements = Array.from(document.querySelectorAll(${JSON.stringify(rowSelector)}));
          const isVisible = (candidate) => {
            if (!candidate) return false;
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const hasCurrentDetail = Array.from(document.querySelectorAll('[data-testid="work-item-detail"]')).some(
            (candidate) =>
              isVisible(candidate) &&
              candidate.getAttribute('data-work-item-short-id') === ${JSON.stringify(shortId)} &&
              (${JSON.stringify(targetWorkItemId)} === null ||
                candidate.getAttribute('data-work-item-id') === ${JSON.stringify(targetWorkItemId)})
          );
          return {
            clicked: ${JSON.stringify(rowClick)},
            hasCurrentDetail,
            activeTabId,
            activeTabType,
            openState: ${JSON.stringify(openState)},
            rowCount: rowElements.length,
            rowDisplays: rowElements.map((row) => {
              const rect = row.getBoundingClientRect();
              const style = window.getComputedStyle(row);
              return {
                display: style.display,
                visibility: style.visibility,
                width: rect.width,
                height: rect.height,
                text: (row.textContent || '').slice(0, 160),
              };
            }),
          };
        `);
          return rowOpenState.hasCurrentDetail;
        },
        {
          timeout: MOUNT_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: `Work Item row did not open detail for ${shortId}`,
        }
      )
      .catch((error) => {
        throw new Error(
          `Work Item row did not open detail for ${shortId}; latest=${JSON.stringify(rowOpenState)} original=${String(error?.message ?? error)}`
        );
      });
  }

  await browser.waitUntil(hasTargetDetail, {
    timeout: MOUNT_TIMEOUT_MS,
    interval: 500,
    timeoutMsg: `Work Item detail did not render for ${shortId}`,
  });
}

async function waitForStartAgentBlockedOrCompleted(
  projectSlug,
  shortId,
  sessionId,
  label
) {
  let latest = null;
  try {
    await browser.waitUntil(
      async () => {
        const itemResult = await invokeE2E(
          "readWorkItem",
          projectSlug,
          shortId
        );
        const sessionResult = await invokeE2E(
          "getSessionAggregateRow",
          sessionId
        );
        latest = { itemResult, sessionResult };
        if (!itemResult?.ok || !sessionResult?.ok) return false;

        const activeSessionId =
          itemResult.item?.frontmatter?.execution_lock?.activeSessionId;
        if (activeSessionId === sessionId) return true;

        const status = sessionResult.session?.status;
        return Boolean(status && status !== "running");
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `Work Item run did not settle for ${label}`,
      }
    );
  } catch (error) {
    throw new Error(
      `Work Item run did not settle for ${label}; latest=${JSON.stringify(latest)} original=${String(error?.message ?? error)}`
    );
  }
  return latest;
}

describe("Work Item durable object runtime invariants", function () {
  this.timeout(420_000);

  before(async () => {
    if (
      !shouldRunScenario(ROUTINE_CONCURRENCY_SCENARIO) &&
      !shouldRunScenario(ROUTINE_CREATE_WORK_ITEM_CONTRACT_SCENARIO) &&
      !shouldRunScenario(ROUTINE_CREATE_WORK_ITEM_FAILURE_SCENARIO) &&
      !shouldRunScenario(STANDALONE_WORK_ITEM_CONTRACT_SCENARIO) &&
      !shouldRunScenario(RENDERED_STANDALONE_WORK_ITEM_UI_SCENARIO) &&
      !shouldRunScenario(WORK_ITEM_UI_LLM_SCENARIO) &&
      !shouldRunScenario(CHAT_PANEL_WORK_ITEM_LINK_CREATE_UI_SCENARIO) &&
      !shouldRunScenario(CHAT_PANEL_WORK_ITEM_SESSION_BREADCRUMB_UI_SCENARIO) &&
      !shouldRunScenario(CREATE_WORK_ITEM_AI_GENERATE_UI_SCENARIO) &&
      !shouldRunScenario(CREATE_WORK_ITEM_AUTO_EXECUTE_GUARD_UI_SCENARIO) &&
      !shouldRunScenario(SESSION_LINK_WORK_ITEM_UI_SCENARIO) &&
      !shouldRunScenario(WORK_ITEM_RERUN_UI_LLM_SCENARIO) &&
      !shouldRunScenario(ROUTINE_CREATE_WORK_ITEM_UI_LLM_SCENARIO)
    ) {
      return;
    }
    assertE2ERepoFixture();
    await browser.setTimeout({ script: 420_000 });
    await waitForApp();
    await browser.waitUntil(
      async () =>
        execJS(
          `return !!(window.__e2e && window.__e2e.listAccounts && window.__e2e.ensureRepoSelected && window.__e2e.upsertRoutine && window.__e2e.fireRoutine && window.__e2e.listRoutineFires && window.__e2e.writeProject && window.__e2e.writeWorkItem && window.__e2e.readWorkItem && window.__e2e.allocateStandaloneWorkItemId && window.__e2e.writeStandaloneWorkItem && window.__e2e.readStandaloneWorkItem && window.__e2e.readStandaloneWorkItems && window.__e2e.updateWorkItemPartial && window.__e2e.readWorkItemsEnriched && window.__e2e.openWorkspaceWorkItemsTab && window.__e2e.openProjectWorkItemsTab && window.__e2e.openChatPanelWorkItem && window.__e2e.openSession && window.__e2e.launchSession && window.__e2e.getSessionAggregateRow && window.__e2e.findSessionAggregateByWorkItem && window.__e2e.resetToNewSession && window.__e2e.debugSessionExecuteTool && window.__e2e.agentOrgSimulateAppRestart);`
        ),
      {
        timeout: MOUNT_TIMEOUT_MS,
        timeoutMsg:
          "required Work Item durable object E2E helpers never mounted",
      }
    );
  });

  it("applies Routine concurrency policy while a direct session fire is active", async function () {
    if (!shouldRunScenario(ROUTINE_CONCURRENCY_SCENARIO)) {
      this.skip();
      return;
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts"
    ).accounts;
    const account = selectRustAgentAccount(accounts);
    if (!account) {
      if (isScenarioExplicitlyRequested(ROUTINE_CONCURRENCY_SCENARIO)) {
        throw new Error(
          `No enabled Rust-agent account matched agentType=${API_AGENT_TYPE} model=${PREFERRED_API_MODEL_ID} account=${API_ACCOUNT_NAME ?? "<any>"}`
        );
      }
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected"
    );
    const cases = [
      {
        suffix: "coalesce",
        policy: ROUTINE_CONCURRENCY_POLICY.COALESCE_IF_ACTIVE,
        expectedStatus: ROUTINE_FIRE_STATUS.COALESCED,
        expectsPointer: true,
      },
      {
        suffix: "skip",
        policy: ROUTINE_CONCURRENCY_POLICY.SKIP_IF_ACTIVE,
        expectedStatus: ROUTINE_FIRE_STATUS.SKIPPED,
        expectsPointer: false,
      },
      {
        suffix: "queue",
        policy: ROUTINE_CONCURRENCY_POLICY.QUEUE_IF_ACTIVE,
        expectedStatus: ROUTINE_FIRE_STATUS.QUEUED,
        expectsPointer: false,
      },
    ];

    for (const testCase of cases) {
      const routine = routineDefinition(
        account,
        repo.path,
        testCase.policy,
        testCase.suffix
      );
      const saved = unwrap(
        await invokeE2E("upsertRoutine", routine),
        `upsertRoutine(${testCase.suffix})`
      ).routine;

      const first = unwrap(
        await invokeE2E("fireRoutine", saved.id),
        `first fireRoutine(${testCase.suffix})`
      ).result;
      if (!first.sessionId || typeof first.sessionId !== "string") {
        throw new Error(
          `First routine fire did not create a production session for ${testCase.suffix}: ${JSON.stringify(first)}`
        );
      }
      if (first.fire?.status !== ROUTINE_FIRE_STATUS.STARTED) {
        throw new Error(
          `First routine fire should be started after session launch for ${testCase.suffix}: ${JSON.stringify(first)}`
        );
      }

      const second = unwrap(
        await invokeE2E("fireRoutine", saved.id),
        `second fireRoutine(${testCase.suffix})`
      ).result;
      if (second.sessionId) {
        throw new Error(
          `Non-pending routine fire unexpectedly created a session for ${testCase.suffix}: ${JSON.stringify(second)}`
        );
      }
      if (second.fire?.status !== testCase.expectedStatus) {
        throw new Error(
          `Second routine fire had wrong status for ${testCase.suffix}; expected=${testCase.expectedStatus} result=${JSON.stringify(second)}`
        );
      }
      if (testCase.expectsPointer) {
        if (second.fire?.coalescedIntoFireId !== first.fire?.id) {
          throw new Error(
            `Coalesced fire did not point to first fire; first=${JSON.stringify(first)} second=${JSON.stringify(second)}`
          );
        }
      } else if (second.fire?.coalescedIntoFireId) {
        throw new Error(
          `Non-coalesced fire unexpectedly stored coalescedIntoFireId for ${testCase.suffix}: ${JSON.stringify(second)}`
        );
      }
    }
  });

  it("records Routine create_work_item fires as durable Work Item creation events", async function () {
    if (!shouldRunScenario(ROUTINE_CREATE_WORK_ITEM_CONTRACT_SCENARIO)) {
      this.skip();
      return;
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts(routine work item contract)"
    ).accounts;
    const account = selectRustAgentAccount(accounts);
    if (!account) {
      if (
        isScenarioExplicitlyRequested(
          ROUTINE_CREATE_WORK_ITEM_CONTRACT_SCENARIO
        )
      ) {
        throw new Error(
          `No enabled Rust-agent account matched agentType=${API_AGENT_TYPE} model=${PREFERRED_API_MODEL_ID} account=${API_ACCOUNT_NAME ?? "<any>"}`
        );
      }
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(routine work item contract)"
    );
    const projectSlug = `e2e-routine-contract-${RUN_ID}`;
    const projectName = `E2E Routine Contract ${RUN_ID}`;
    const routineWorkItemTitle = `E2E routine contract Work Item ${RUN_ID}`;
    const routineWorkItemBody =
      "Routine contract Work Item body. This scenario should not start an LLM session.";

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project for Routine create_work_item contract coverage.",
        true
      ),
      "writeProject(routine work item contract)"
    );

    const routine = routineWorkItemDefinition({
      account,
      workspacePath: repo.path,
      projectSlug,
      suffix: "contract",
      title: routineWorkItemTitle,
      body: routineWorkItemBody,
      concurrencyPolicy: ROUTINE_CONCURRENCY_POLICY.ALWAYS_CREATE,
    });
    const savedRoutine = unwrap(
      await invokeE2E("upsertRoutine", routine),
      "upsertRoutine(routine create_work_item contract)"
    ).routine;

    const first = unwrap(
      await invokeE2E("fireRoutine", savedRoutine.id),
      "first fireRoutine(create Work Item contract)"
    ).result;
    await assertNoSessionForRoutineFire(first, "first create_work_item fire");
    if (
      first.fire?.status !== ROUTINE_FIRE_STATUS.SUCCEEDED ||
      !first.fire?.workItemId
    ) {
      throw new Error(
        `First create_work_item fire did not persist succeeded Work Item fire: ${JSON.stringify(first)}`
      );
    }

    const second = unwrap(
      await invokeE2E("fireRoutine", savedRoutine.id),
      "second fireRoutine(create Work Item contract)"
    ).result;
    await assertNoSessionForRoutineFire(second, "second create_work_item fire");
    if (
      second.fire?.status !== ROUTINE_FIRE_STATUS.SUCCEEDED ||
      !second.fire?.workItemId
    ) {
      throw new Error(
        `Second create_work_item fire did not persist succeeded Work Item fire: ${JSON.stringify(second)}`
      );
    }
    if (second.fire.workItemId === first.fire.workItemId) {
      throw new Error(
        `always_create create_work_item reused a Work Item id: first=${JSON.stringify(first.fire)} second=${JSON.stringify(second.fire)}`
      );
    }

    const matchingItems = await listWorkItemsByTitle(
      projectSlug,
      routineWorkItemTitle,
      "routine create_work_item contract duplicate list"
    );
    if (matchingItems.length !== 2) {
      throw new Error(
        `Expected two distinct Work Items for two always_create fires, got ${matchingItems.length}: ${JSON.stringify(matchingItems)}`
      );
    }

    for (const fireResult of [first, second]) {
      const shortId = fireResult.fire.workItemId;
      const item = unwrap(
        await invokeE2E("readWorkItem", projectSlug, shortId),
        `readWorkItem(${shortId})`
      ).item;
      const frontmatter = item.frontmatter ?? {};
      if (frontmatter.routine_source?.routineFireId !== fireResult.fire.id) {
        throw new Error(
          `Created Work Item did not point back to its own fire: fire=${JSON.stringify(fireResult.fire)} routine_source=${JSON.stringify(frontmatter.routine_source)}`
        );
      }
      if (frontmatter.execution_lock?.activeSessionId) {
        throw new Error(
          `create_work_item contract unexpectedly persisted an execution lock before user start: ${JSON.stringify(frontmatter.execution_lock)}`
        );
      }
      if (
        frontmatter.orchestrator_config?.selected_account_id !== account.id ||
        frontmatter.orchestrator_config?.selected_model_id !==
          PREFERRED_API_MODEL_ID ||
        frontmatter.orchestrator_config?.agent_definition_id !==
          "builtin:sde" ||
        frontmatter.orchestrator_config?.agent_mode !== "ask"
      ) {
        throw new Error(
          `Created Work Item did not inherit executable config: ${JSON.stringify(frontmatter.orchestrator_config)}`
        );
      }
    }
  });

  it("persists standalone Work Items across list, restart, attach, and detach flows", async function () {
    if (!shouldRunScenario(STANDALONE_WORK_ITEM_CONTRACT_SCENARIO)) {
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(standalone work item contract)"
    );
    const projectSlug = `e2e-standalone-contract-${RUN_ID}`;
    const projectName = `E2E Standalone Contract ${RUN_ID}`;
    const title = `E2E standalone contract Work Item ${RUN_ID}`;
    const detachedTitle = `${title} detached`;
    const body =
      "Standalone Work Item contract body that must survive scope changes.";
    const updatedBody = `${body}\nUpdated while attached to a Project.`;

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project for standalone Work Item attach/detach coverage.",
        true
      ),
      "writeProject(standalone work item contract)"
    );

    const shortId = unwrap(
      await invokeE2E("allocateStandaloneWorkItemId"),
      "allocateStandaloneWorkItemId(standalone contract)"
    ).shortId;
    const frontmatter = createBasicWorkItemFrontmatter({ shortId, title });
    unwrap(
      await invokeE2E("writeStandaloneWorkItem", shortId, frontmatter, body),
      "writeStandaloneWorkItem(standalone contract)"
    );

    const standaloneItem = unwrap(
      await invokeE2E("readStandaloneWorkItem", shortId),
      `readStandaloneWorkItem(${shortId}) initial`
    ).item;
    if (
      standaloneItem.frontmatter?.project !== undefined &&
      standaloneItem.frontmatter?.project !== null
    ) {
      throw new Error(
        `Standalone Work Item unexpectedly persisted a project: ${JSON.stringify(standaloneItem)}`
      );
    }
    if (
      standaloneItem.frontmatter?.title !== title ||
      standaloneItem.body !== body
    ) {
      throw new Error(
        `Standalone Work Item did not preserve initial content: ${JSON.stringify(standaloneItem)}`
      );
    }

    const standaloneList = unwrap(
      await invokeE2E("readStandaloneWorkItems"),
      "readStandaloneWorkItems(standalone contract initial list)"
    ).items;
    if (
      !standaloneList.some((item) => item.frontmatter?.short_id === shortId)
    ) {
      throw new Error(
        `Standalone list did not include ${shortId}: ${JSON.stringify(standaloneList)}`
      );
    }
    const projectedListBeforeAttach = unwrap(
      await invokeE2E("readWorkItemsEnriched", projectSlug),
      "readWorkItemsEnriched(standalone contract before attach)"
    ).items;
    if (
      projectedListBeforeAttach.some(
        (item) => item.shortId === shortId || item.short_id === shortId
      )
    ) {
      throw new Error(
        `Project list was polluted by standalone Work Item before attach: ${JSON.stringify(projectedListBeforeAttach)}`
      );
    }

    unwrap(
      await invokeE2E("agentOrgSimulateAppRestart"),
      "simulate app restart for standalone Work Item contract"
    );
    const postRestartStandalone = unwrap(
      await invokeE2E("readStandaloneWorkItem", shortId),
      `readStandaloneWorkItem(${shortId}) after restart`
    ).item;
    if (
      postRestartStandalone.frontmatter?.title !== title ||
      postRestartStandalone.body !== body
    ) {
      throw new Error(
        `Standalone Work Item did not survive simulated restart: ${JSON.stringify(postRestartStandalone)}`
      );
    }

    unwrap(
      await invokeE2E(
        "writeWorkItem",
        projectSlug,
        shortId,
        {
          ...postRestartStandalone.frontmatter,
          project: projectSlug,
          updated_at: new Date().toISOString(),
        },
        postRestartStandalone.body
      ),
      "writeWorkItem attach standalone contract item"
    );
    const attachedItem = unwrap(
      await invokeE2E("readWorkItem", projectSlug, shortId),
      `readWorkItem(${shortId}) after attach`
    ).item;
    if (attachedItem.frontmatter?.project !== projectSlug) {
      throw new Error(
        `Attached Work Item did not persist project slug: ${JSON.stringify(attachedItem)}`
      );
    }
    const standaloneReadAfterAttach = await invokeE2E(
      "readStandaloneWorkItem",
      shortId
    );
    if (standaloneReadAfterAttach?.ok) {
      throw new Error(
        `Attached Work Item remained readable as standalone: ${JSON.stringify(standaloneReadAfterAttach)}`
      );
    }

    const attachedUpdate = unwrap(
      await invokeE2E("updateWorkItemPartial", projectSlug, shortId, {
        title: detachedTitle,
        body: updatedBody,
        project: null,
      }),
      "updateWorkItemPartial detach standalone contract item"
    ).item;
    if (
      attachedUpdate.project !== undefined &&
      attachedUpdate.project !== null
    ) {
      throw new Error(
        `Detached enriched Work Item still reported a project: ${JSON.stringify(attachedUpdate)}`
      );
    }

    const detachedItem = unwrap(
      await invokeE2E("readStandaloneWorkItem", shortId),
      `readStandaloneWorkItem(${shortId}) after detach`
    ).item;
    if (
      detachedItem.frontmatter?.project !== undefined &&
      detachedItem.frontmatter?.project !== null
    ) {
      throw new Error(
        `Detached Work Item still has project in frontmatter: ${JSON.stringify(detachedItem)}`
      );
    }
    if (
      detachedItem.frontmatter?.title !== detachedTitle ||
      detachedItem.body !== updatedBody
    ) {
      throw new Error(
        `Detached Work Item did not preserve partial update fields: ${JSON.stringify(detachedItem)}`
      );
    }
    const projectListAfterDetach = unwrap(
      await invokeE2E("readWorkItemsEnriched", projectSlug),
      "readWorkItemsEnriched(standalone contract after detach)"
    ).items;
    if (
      projectListAfterDetach.some(
        (item) => item.shortId === shortId || item.short_id === shortId
      )
    ) {
      throw new Error(
        `Project list still included detached Work Item: ${JSON.stringify(projectListAfterDetach)}`
      );
    }
  });

  it("renders standalone Work Items in the aggregate UI and opens their detail view", async function () {
    if (!shouldRunScenario(RENDERED_STANDALONE_WORK_ITEM_UI_SCENARIO)) {
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(rendered standalone work item ui)"
    );
    const projectSlug = `e2e-rendered-standalone-${RUN_ID}`;
    const projectName = `E2E Rendered Standalone ${RUN_ID}`;
    const title = `E2E rendered standalone Work Item ${RUN_ID}`;
    const body = "Rendered standalone Work Item body shown in the detail view.";

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project used only to open the aggregate Work Items surface.",
        true
      ),
      "writeProject(rendered standalone work item ui)"
    );

    const shortId = unwrap(
      await invokeE2E("allocateStandaloneWorkItemId"),
      "allocateStandaloneWorkItemId(rendered standalone ui)"
    ).shortId;
    unwrap(
      await invokeE2E(
        "writeStandaloneWorkItem",
        shortId,
        createBasicWorkItemFrontmatter({ shortId, title }),
        body
      ),
      "writeStandaloneWorkItem(rendered standalone ui)"
    );

    const openState = unwrap(
      await invokeE2E("openWorkspaceWorkItemsTab"),
      "openWorkspaceWorkItemsTab(rendered standalone ui)"
    );
    const rowSelector = `[data-testid="work-item-row-${shortId}"]`;
    const targetProjectTabId = openState.activeTabId;
    const projectTabSelector = `[data-tab-id="${targetProjectTabId}"]`;
    let listState = null;
    try {
      await browser.waitUntil(
        async () => {
          if (targetProjectTabId) {
            await clickSelector(projectTabSelector);
          }
          listState = await execJS(`
            const row = document.querySelector(${JSON.stringify(rowSelector)});
            const rect = row?.getBoundingClientRect();
            const style = row ? window.getComputedStyle(row) : null;
            const bodyText = document.body.innerText || '';
            const router = document.querySelector('[data-testid="project-manager-content-router"]');
            const allWorkItemRows = Array.from(document.querySelectorAll('[data-testid^="work-item-row-"]')).map((candidate) => ({
              testId: candidate.getAttribute('data-testid'),
              text: (candidate.textContent || '').slice(0, 220),
              rect: (() => {
                const rowRect = candidate.getBoundingClientRect();
                return { width: rowRect.width, height: rowRect.height };
              })(),
            }));
            return {
              hasRow: Boolean(row),
              rowVisible: Boolean(row && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'),
              rowText: row?.textContent || '',
              bodyHasTitle: bodyText.includes(${JSON.stringify(title)}),
              activeTabId: router?.getAttribute('data-active-tab-id') || null,
              activeTabType: router?.getAttribute('data-active-tab-type') || null,
              route: window.location.pathname,
              allWorkItemRows,
              bodyText: bodyText.slice(0, 1800),
            };
          `);
          return listState.rowVisible && listState.rowText.includes(title);
        },
        {
          timeout: MOUNT_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "Standalone Work Item row did not render in aggregate UI",
        }
      );
    } catch (error) {
      throw new Error(
        `Standalone Work Item row did not render in aggregate UI: latest=${JSON.stringify(listState)} original=${String(error?.message ?? error)}`
      );
    }

    let detailState = null;
    const rowClick = await clickSelector(rowSelector);
    if (rowClick !== "clicked") {
      throw new Error(
        `Standalone Work Item row could not be opened: ${JSON.stringify(rowClick)}`
      );
    }
    try {
      await browser.waitUntil(
        async () => {
          detailState = await execJS(`
          const bodyText = document.body.innerText || '';
          const workflow = document.querySelector('[data-testid="work-item-agent-workflow"]');
          const lowerTabs = document.querySelector('[data-testid="work-item-lower-tabs-section"]');
          const linkedSessions = document.querySelector('[data-testid="work-item-linked-sessions"]');
          const detail = document.querySelector('[data-testid="chat-panel-work-item-detail"]');
          const titleInput = detail?.querySelector('[data-testid="work-item-content-editor"] input');
          const router = document.querySelector('[data-testid="project-manager-content-router"]');
          const activeTabId = router?.getAttribute('data-active-tab-id') || null;
          const activeTabType = router?.getAttribute('data-active-tab-type') || null;
          const hasPlaceholder = bodyText.includes('Host-coupled') || bodyText.includes('Phase 2 will lift');
          return {
            rowClick: ${JSON.stringify(rowClick)},
            activeTabId,
            activeTabType,
            hasDetail: Boolean(detail),
            titleValue: titleInput?.value || '',
            hasBody: bodyText.includes(${JSON.stringify(body)}),
            hasWorkflow: Boolean(workflow),
            hasLowerTabs: Boolean(lowerTabs),
            hasLinkedSessions: Boolean(linkedSessions),
            hasPlaceholder,
            bodyText: bodyText.slice(0, 1800),
          };
        `);
          return (
            detailState.hasDetail &&
            detailState.titleValue === title &&
            detailState.hasBody &&
            detailState.hasLowerTabs &&
            detailState.hasLinkedSessions &&
            !detailState.hasPlaceholder
          );
        },
        {
          timeout: MOUNT_TIMEOUT_MS,
          interval: 500,
          timeoutMsg:
            "Standalone Work Item detail did not open from aggregate UI",
        }
      );
    } catch (error) {
      throw new Error(
        `Standalone Work Item detail did not open from aggregate UI: latest=${JSON.stringify(detailState)} original=${String(error?.message ?? error)}`
      );
    }
  });

  it("links an existing Work Item into ChatPanel and creates a new standalone Work Item from ChatPanel UI", async function () {
    if (!shouldRunScenario(CHAT_PANEL_WORK_ITEM_LINK_CREATE_UI_SCENARIO)) {
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(chat panel Work Item link/create)"
    );
    const projectSlug = `e2e-chat-panel-work-item-${RUN_ID}`;
    const projectName = `E2E ChatPanel Work Item ${RUN_ID}`;
    const existingShortId = `CP-${RUN_ID}`;
    const existingTitle = `E2E ChatPanel linked Work Item ${RUN_ID}`;
    const existingBody =
      "Existing Work Item opened through the Project sidebar into ChatPanel.";
    const createdTitle = `E2E ChatPanel standalone Work Item ${RUN_ID}`;
    const createdBody =
      "Standalone Work Item created from the ChatPanel Work Item target UI.";

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project for ChatPanel Work Item link/create coverage.",
        true
      ),
      "writeProject(chat panel Work Item link/create)"
    );
    unwrap(
      await invokeE2E(
        "writeWorkItem",
        projectSlug,
        existingShortId,
        createBasicWorkItemFrontmatter({
          shortId: existingShortId,
          title: existingTitle,
          project: projectSlug,
        }),
        existingBody
      ),
      "writeWorkItem(chat panel linked Work Item)"
    );

    unwrap(
      await invokeE2E("openWorkspaceWorkItemsTab"),
      "openWorkspaceWorkItemsTab(chat panel link existing)"
    );
    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(chat panel link)"
    );
    await selectChatPanelWorkItemCreateTarget(
      "ChatPanel existing Work Item link"
    );
    unwrap(
      await invokeE2E("openChatPanelWorkItem", projectSlug, existingShortId),
      "openChatPanelWorkItem(chat panel existing Work Item)"
    );
    const linkedDetailState = await waitForChatPanelWorkItemDetail(
      existingTitle,
      "opened existing Work Item"
    );
    if (
      !linkedDetailState.headerTitle.includes(existingTitle) &&
      !linkedDetailState.contentTitle.includes(existingTitle)
    ) {
      throw new Error(
        `Linked Work Item surface did not show title: ${JSON.stringify(linkedDetailState)}`
      );
    }

    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(chat panel create)"
    );
    await selectChatPanelWorkItemCreateTarget(
      "ChatPanel standalone Work Item create"
    );
    await setInputValue(
      '[data-testid="create-work-item-title-input"]',
      createdTitle,
      "ChatPanel standalone Work Item title"
    );
    await setComposerText(
      '[data-testid="create-work-item-editor"]',
      createdBody,
      "ChatPanel standalone Work Item body"
    );
    const createClick = await clickSelector(
      '[data-testid="create-work-item-submit"]'
    );
    if (createClick !== "clicked") {
      throw new Error(
        `ChatPanel standalone Work Item create click failed: ${createClick}`
      );
    }

    const createdItem = await waitForStandaloneWorkItemByTitle(
      createdTitle,
      "ChatPanel standalone create result"
    );
    const createdFrontmatter = createdItem.frontmatter ?? {};
    if (
      createdFrontmatter.project !== undefined &&
      createdFrontmatter.project !== null
    ) {
      throw new Error(
        `ChatPanel-created Work Item should be standalone, got project=${JSON.stringify(createdFrontmatter.project)} item=${JSON.stringify(createdItem)}`
      );
    }
    if (!createdItem.body?.includes(createdBody)) {
      throw new Error(
        `ChatPanel-created Work Item did not persist body: ${JSON.stringify(createdItem)}`
      );
    }
    await waitForChatPanelWorkItemDetail(
      createdTitle,
      "newly created standalone Work Item"
    );
  });

  it("creates and updates one linked Work Item through the real Create with AI UI", async function () {
    if (!shouldRunScenario(CREATE_WORK_ITEM_AUTO_EXECUTE_GUARD_UI_SCENARIO)) {
      this.skip();
      return;
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts(Create with AI UI)"
    ).accounts;
    const account = selectRustAgentAccount(accounts);
    if (!account) {
      if (
        isScenarioExplicitlyRequested(
          CREATE_WORK_ITEM_AUTO_EXECUTE_GUARD_UI_SCENARIO
        )
      ) {
        throw new Error(
          `No enabled Rust-agent account matched agentType=${API_AGENT_TYPE} model=${PREFERRED_API_MODEL_ID} account=${API_ACCOUNT_NAME ?? "<any>"}`
        );
      }
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(Create with AI UI)"
    );
    unwrap(
      await invokeE2E("configureWithExistingKey", {
        accountName: account.name ?? account.id,
        model: PREFERRED_API_MODEL_ID,
        agentType: account.agent_type,
        category: "rust_agent",
        agentDefinitionId: "builtin:os",
        agentExecMode: "ask",
        repoPath: repo.path,
      }),
      "configureWithExistingKey(Create with AI UI)"
    );
    unwrap(
      await invokeE2E("openWorkspaceWorkItemsTab"),
      "openWorkspaceWorkItemsTab(Create with AI UI)"
    );
    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(Create with AI UI)"
    );
    await selectChatPanelWorkItemCreateTarget("Create with AI UI", {
      agentMode: true,
    });

    const agentSwitchState = await workItemAgentModeState();
    if (
      !agentSwitchState.exists ||
      agentSwitchState.disabled ||
      !agentSwitchState.checked
    ) {
      throw new Error(
        `Create with AI should default to an enabled plan-agent mode: ${JSON.stringify(agentSwitchState)}`
      );
    }
    await waitForVisibleSelector(
      '[data-testid="session-creator-chat-panel"]',
      "Create with AI session creator",
      MOUNT_TIMEOUT_MS
    );

    let beforeRows = await collectStandaloneItemsAcrossOrgs(
      "before Create with AI"
    );
    await browser.waitUntil(
      async () => {
        const again = await collectStandaloneItemsAcrossOrgs(
          "before Create with AI (settle)"
        );
        const settled = again.length === beforeRows.length;
        beforeRows = again;
        return settled;
      },
      {
        timeout: PERSIST_TIMEOUT_MS,
        interval: 1_500,
        timeoutMsg:
          "standalone listing never settled before the Create with AI scan",
      }
    );
    const beforeIds = new Set(
      beforeRows
        .map(
          ({ item }) =>
            item.frontmatter?.short_id ?? item.frontmatter?.shortId ?? null
        )
        .filter(Boolean)
    );
    const generatedTitle = `E2E AI-created linked Work Item ${RUN_ID}`;
    const generatedBody = `Created through the rendered Create with AI flow ${RUN_ID}.`;
    // Time fence for the new-item scans: background DB derivation can land
    // pre-existing (seeded) rows between scans, so "new" additionally means
    // "created after this test started composing".
    const composeFenceMs = Date.now() - 10_000;
    const prompt =
      `Update the linked draft Work Item to the exact title "${generatedTitle}" ` +
      `and exact description "${generatedBody}". Keep it standalone, planned, ` +
      "and medium priority. Use the org2-pm CLI to update the linked draft, " +
      "keep this session linked, and do not create another Work Item.";
    await setComposerText(
      '[data-testid="session-creator-chat-panel"]',
      prompt,
      "Create with AI prompt"
    );
    await browser.waitUntil(
      async () =>
        execJS(`
          const buttons = Array.from(document.querySelectorAll('[data-testid="chat-send-button"]'));
          const button = buttons.find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
          });
          return Boolean(
            button &&
            button.getAttribute('data-state') === 'submit' &&
            !button.disabled &&
            button.getAttribute('aria-disabled') !== 'true'
          );
        `),
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 100,
        timeoutMsg:
          "Create with AI send button did not become an enabled submit action",
      }
    );
    const sendClick = await clickSelector('[data-testid="chat-send-button"]');
    if (sendClick !== "clicked") {
      throw new Error(`Create with AI send click failed: ${sendClick}`);
    }

    let draftItem = null;
    let draftOrgId = null;
    let linkedSessionId = null;
    let latestNewItems = [];
    await browser.waitUntil(
      async () => {
        const rows = await collectStandaloneItemsAcrossOrgs(
          "Create with AI draft"
        );
        const newRows = rows.filter(({ item }) => {
          const shortId =
            item.frontmatter?.short_id ?? item.frontmatter?.shortId ?? null;
          return (
            shortId &&
            !beforeIds.has(shortId) &&
            workItemCreatedAtMs(item) >= composeFenceMs
          );
        });
        latestNewItems = newRows.map(({ item }) => item);
        if (newRows.length !== 1) return false;
        draftItem = newRows[0].item;
        draftOrgId = newRows[0].orgId;
        return true;
      },
      {
        timeout: PERSIST_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `Create with AI did not persist exactly one standalone draft: ${JSON.stringify(latestNewItems)}`,
      }
    );

    const shortId =
      draftItem.frontmatter?.short_id ?? draftItem.frontmatter?.shortId;
    await browser.waitUntil(
      async () => {
        const found = unwrap(
          await invokeE2E("findSessionAggregateByWorkItem", shortId),
          "findSessionAggregateByWorkItem(Create with AI)"
        ).session;
        linkedSessionId = found?.sessionId ?? null;
        return Boolean(linkedSessionId);
      },
      {
        timeout: PERSIST_TIMEOUT_MS,
        interval: 500,
        timeoutMsg:
          "Create with AI did not persist a session aggregate linked to the Work Item",
      }
    );
    await waitForSessionAggregateRow(
      linkedSessionId,
      (session) =>
        session.sessionId === linkedSessionId &&
        session.workItemId === shortId &&
        !session.projectSlug &&
        session.accountId === account.id &&
        session.model === PREFERRED_API_MODEL_ID,
      "Create with AI linked session aggregate",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );
    unwrap(
      await invokeE2E("openSession", linkedSessionId),
      "openSession(Create with AI linked session)"
    );
    await waitForRenderedAssistantReply(
      "Create with AI linked Work Item update",
      linkedSessionId
    );

    let finalItem = null;
    await browser.waitUntil(
      async () => {
        const scoped = draftOrgId
          ? await invokeE2E("readStandaloneWorkItems", draftOrgId)
          : await invokeE2E("readStandaloneWorkItems");
        if (!scoped?.ok) return false;
        finalItem =
          scoped.items.find((item) => {
            const id =
              item.frontmatter?.short_id ?? item.frontmatter?.shortId ?? null;
            return id === shortId;
          }) ?? null;
        return (
          finalItem?.frontmatter?.title === generatedTitle &&
          finalItem?.body === generatedBody
        );
      },
      {
        timeout: LLM_COMPLETION_PERSIST_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: `OS Agent did not update linked draft ${shortId}: ${JSON.stringify(finalItem)}`,
      }
    );
    await waitForSessionAggregateRow(
      linkedSessionId,
      (session) =>
        session.sessionId === linkedSessionId &&
        session.workItemId === shortId &&
        !session.projectSlug &&
        session.status !== "running",
      "completed Create with AI session retains standalone Work Item linkage",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );
    const finalRows = await collectStandaloneItemsAcrossOrgs(
      "after Create with AI"
    );
    const newlyCreatedIds = finalRows
      .filter((row) => (row.orgId ?? null) === (draftOrgId ?? null))
      .filter(({ item }) => workItemCreatedAtMs(item) >= composeFenceMs)
      .map(
        ({ item }) =>
          item.frontmatter?.short_id ?? item.frontmatter?.shortId ?? null
      )
      .filter((shortId) => shortId && !beforeIds.has(shortId));
    if (newlyCreatedIds.length !== 1 || newlyCreatedIds[0] !== shortId) {
      throw new Error(
        `Create with AI created duplicate Work Items: ${JSON.stringify(newlyCreatedIds)}`
      );
    }
  });

  it("renders the ChatPanel Work Item Agent switch and persists manual form output", async function () {
    if (!shouldRunScenario(CREATE_WORK_ITEM_AI_GENERATE_UI_SCENARIO)) {
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(create Work Item AI generate UI)"
    );
    const projectSlug = `e2e-ai-generate-switch-${RUN_ID}`;
    const projectName = `E2E AI Generate Switch ${RUN_ID}`;
    const generatedTitle = `E2E AI generated Work Item request ${RUN_ID}`;
    const generatedBody =
      "Break this request into clear Work Items. Scope: single repository. Auto execute: no. This E2E asserts the UI payload path.";

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project that must not be implicitly selected by ChatPanel standalone creation.",
        true
      ),
      "writeProject(create Work Item AI generate UI)"
    );

    unwrap(
      await invokeE2E("openWorkspaceWorkItemsTab"),
      "openWorkspaceWorkItemsTab(create Work Item AI generate UI)"
    );
    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(ai generate UI)"
    );
    await selectChatPanelWorkItemCreateTarget(
      "Create Work Item AI generate UI"
    );

    const agentSwitchState = await workItemAgentModeState();
    if (!agentSwitchState.exists || agentSwitchState.disabled) {
      throw new Error(
        `ChatPanel Work Item Agent switch should be available: ${JSON.stringify(agentSwitchState)}`
      );
    }
    if (agentSwitchState.checked) {
      throw new Error(
        `Manual ChatPanel Work Item create should render with Agent mode disabled: ${JSON.stringify(agentSwitchState)}`
      );
    }

    await setInputValue(
      '[data-testid="create-work-item-title-input"]',
      generatedTitle,
      "ChatPanel Work Item title"
    );
    await setComposerText(
      '[data-testid="create-work-item-editor"]',
      generatedBody,
      "ChatPanel Work Item body"
    );
    const submitClick = await clickSelector(
      '[data-testid="create-work-item-submit"]'
    );
    if (submitClick !== "clicked") {
      throw new Error(
        `ChatPanel manual Work Item submit click failed: ${submitClick}`
      );
    }

    const createdItem = await waitForStandaloneWorkItemByTitle(
      generatedTitle,
      "AI generate Work Item submit result"
    );
    const frontmatter = createdItem.frontmatter ?? {};
    if (frontmatter.project !== undefined && frontmatter.project !== null) {
      throw new Error(
        `AI-generate ChatPanel Work Item should remain standalone unless user picks a Project: ${JSON.stringify(frontmatter)}`
      );
    }
    if (!createdItem.body?.includes("Break this request")) {
      throw new Error(
        `AI-generate Work Item body was not persisted: ${JSON.stringify(createdItem)}`
      );
    }
    await waitForChatPanelWorkItemDetail(
      generatedTitle,
      "AI generate submitted Work Item detail"
    );
  });

  it("creates a standalone Work Item when Routine create_work_item has no Project", async function () {
    if (!shouldRunScenario(ROUTINE_CREATE_WORK_ITEM_FAILURE_SCENARIO)) {
      this.skip();
      return;
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts(routine standalone work item)"
    ).accounts;
    const account = selectRustAgentAccount(accounts);
    if (!account) {
      if (
        isScenarioExplicitlyRequested(ROUTINE_CREATE_WORK_ITEM_FAILURE_SCENARIO)
      ) {
        throw new Error(
          `No enabled Rust-agent account matched agentType=${API_AGENT_TYPE} model=${PREFERRED_API_MODEL_ID} account=${API_ACCOUNT_NAME ?? "<any>"}`
        );
      }
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(routine standalone work item)"
    );
    const title = `E2E routine standalone Work Item ${RUN_ID}`;
    const body =
      "This fire should create a Work Item without project association.";
    const routine = routineWorkItemDefinition({
      account,
      workspacePath: repo.path,
      projectSlug: undefined,
      suffix: "standalone",
      title,
      body,
    });
    delete routine.outputPolicy.createWorkItemProjectSlug;
    const savedRoutine = unwrap(
      await invokeE2E("upsertRoutine", routine),
      "upsertRoutine(routine standalone create_work_item)"
    ).routine;

    const result = unwrap(
      await invokeE2E("fireRoutine", savedRoutine.id),
      "fireRoutine(routine standalone create_work_item)"
    ).result;
    const latestFire = await latestRoutineFire(
      savedRoutine.id,
      "standalone create_work_item fire"
    );
    if (latestFire?.status !== ROUTINE_FIRE_STATUS.SUCCEEDED) {
      throw new Error(
        `Standalone create_work_item fire was not durably succeeded: ${JSON.stringify(latestFire)}`
      );
    }
    const shortId = result.fire?.workItemId ?? latestFire.workItemId;
    if (!shortId) {
      throw new Error(
        `Standalone create_work_item fire did not link a Work Item: result=${JSON.stringify(result)} latest=${JSON.stringify(latestFire)}`
      );
    }

    const item = unwrap(
      await invokeE2E("readStandaloneWorkItem", shortId),
      `readStandaloneWorkItem(${shortId})`
    ).item;
    const frontmatter = item.frontmatter ?? {};
    if (frontmatter.project !== undefined && frontmatter.project !== null) {
      throw new Error(
        `Routine-created standalone Work Item unexpectedly has a project: ${JSON.stringify(frontmatter)}`
      );
    }
    if (frontmatter.title !== title || item.body !== body) {
      throw new Error(
        `Routine-created standalone Work Item did not preserve content: ${JSON.stringify(item)}`
      );
    }
    if (frontmatter.routine_source?.routineFireId !== latestFire.id) {
      throw new Error(
        `Routine-created standalone Work Item did not point back to its fire: fire=${JSON.stringify(latestFire)} routine_source=${JSON.stringify(frontmatter.routine_source)}`
      );
    }
  });

  it("creates a Work Item from a Routine fire and then executes it from rendered UI", async function () {
    if (!shouldRunScenario(ROUTINE_CREATE_WORK_ITEM_UI_LLM_SCENARIO)) {
      this.skip();
      return;
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts(routine work item ui llm)"
    ).accounts;
    const account = selectRustAgentAccount(accounts);
    if (!account) {
      if (
        isScenarioExplicitlyRequested(ROUTINE_CREATE_WORK_ITEM_UI_LLM_SCENARIO)
      ) {
        throw new Error(
          `No enabled Rust-agent account matched agentType=${API_AGENT_TYPE} model=${PREFERRED_API_MODEL_ID} account=${API_ACCOUNT_NAME ?? "<any>"}`
        );
      }
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(routine work item ui llm)"
    );
    const projectSlug = `e2e-routine-work-item-${RUN_ID}`;
    const projectName = `E2E Routine Work Item ${RUN_ID}`;
    const routineWorkItemTitle = `E2E routine-generated Work Item ${RUN_ID}`;
    const routineWorkItemBody =
      "Routine-created Work Item rendered UI LLM execution probe. Reply briefly and do not modify files.";

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project for Routine-created Work Item execution.",
        true
      ),
      "writeProject(routine work item ui llm)"
    );

    const routine = routineWorkItemDefinition({
      account,
      workspacePath: repo.path,
      projectSlug,
      suffix: "ui-llm",
      title: routineWorkItemTitle,
      body: routineWorkItemBody,
    });
    const savedRoutine = unwrap(
      await invokeE2E("upsertRoutine", routine),
      "upsertRoutine(routine creates Work Item)"
    ).routine;
    const fireResult = unwrap(
      await invokeE2E("fireRoutine", savedRoutine.id),
      "fireRoutine(create Work Item)"
    ).result;
    if (fireResult.sessionId || fireResult.agentOrgRunId) {
      throw new Error(
        `Routine create_work_item fire must not launch a session immediately: ${JSON.stringify(fireResult)}`
      );
    }
    if (
      fireResult.fire?.status !== "succeeded" ||
      !fireResult.fire?.workItemId
    ) {
      throw new Error(
        `Routine create_work_item fire did not persist a succeeded Work Item fire: ${JSON.stringify(fireResult)}`
      );
    }

    const createdShortId = fireResult.fire.workItemId;
    const listedItem = await waitForWorkItemByTitle(
      projectSlug,
      routineWorkItemTitle,
      "Routine fire created Work Item list row"
    );
    const listedShortId = listedItem.shortId ?? listedItem.short_id;
    if (listedShortId !== createdShortId) {
      throw new Error(
        `Routine fire workItemId did not match listed Work Item: fire=${createdShortId} listed=${JSON.stringify(listedItem)}`
      );
    }

    const createdWorkItem = unwrap(
      await invokeE2E("readWorkItem", projectSlug, createdShortId),
      "readWorkItem(routine-created)"
    ).item;
    const frontmatter = createdWorkItem.frontmatter ?? {};
    if (frontmatter.routine_source?.routineFireId !== fireResult.fire.id) {
      throw new Error(
        `Routine-created Work Item did not persist routine_source linkage: ${JSON.stringify(frontmatter.routine_source)}`
      );
    }
    if (
      frontmatter.orchestrator_config?.selected_account_id !== account.id ||
      frontmatter.orchestrator_config?.selected_model_id !==
        PREFERRED_API_MODEL_ID ||
      frontmatter.orchestrator_config?.agent_definition_id !== "builtin:sde" ||
      frontmatter.orchestrator_config?.agent_mode !== "ask"
    ) {
      throw new Error(
        `Routine-created Work Item did not inherit executable orchestrator_config: ${JSON.stringify(frontmatter.orchestrator_config)}`
      );
    }

    const activeSessionId = await startWorkItemRunFromUi(
      projectSlug,
      projectName,
      createdShortId,
      "routine-created Work Item"
    );
    await waitForSessionAggregateRow(
      activeSessionId,
      (session) =>
        session.sessionId === activeSessionId &&
        session.category === "rust_agent" &&
        session.model === PREFERRED_API_MODEL_ID &&
        session.accountId === account.id &&
        session.workItemId === createdShortId &&
        session.projectSlug === projectSlug &&
        session.workspacePath === repo.path,
      "Routine-created Work Item launched session aggregate linkage"
    );

    const preDuplicateItem = unwrap(
      await invokeE2E("readWorkItem", projectSlug, createdShortId),
      "readWorkItem(routine-created before duplicate launch)"
    ).item;
    if (
      preDuplicateItem.frontmatter.execution_lock?.activeSessionId ===
      activeSessionId
    ) {
      const duplicateLaunch = await invokeE2E("launchSession", {
        category: "rust_agent",
        content:
          "Duplicate Work Item launch should be blocked by the active lock.",
        prompt:
          "Duplicate Work Item launch should be blocked by the active lock.",
        accountId: account.id,
        model: PREFERRED_API_MODEL_ID,
        workspacePath: repo.path,
        projectSlug,
        workItemId: createdShortId,
      });
      if (duplicateLaunch.ok) {
        throw new Error(
          `Routine-created duplicate Work Item launch should be blocked by active lock, got: ${JSON.stringify(duplicateLaunch)}`
        );
      }
    }

    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(routine-created active lock)"
    );
    await openSeededWorkItemExecutionTab(
      projectSlug,
      projectName,
      createdShortId
    );
    await waitForStartAgentBlockedOrCompleted(
      projectSlug,
      createdShortId,
      activeSessionId,
      "routine-created active lock after UI reset/reopen"
    );

    unwrap(
      await invokeE2E("openSession", activeSessionId),
      "openSession(routine-created Work Item)"
    );
    await waitForVisibleSelector(
      '[data-testid="chat-panel"]',
      "Routine-created Work Item LLM chat panel",
      MOUNT_TIMEOUT_MS
    );
    await browser.waitUntil(
      async () => {
        const text = await execJS(`return document.body.innerText || "";`);
        return (
          text.includes(routineWorkItemTitle) ||
          text.includes(createdShortId) ||
          text.includes(
            "Routine-created Work Item rendered UI LLM execution probe"
          )
        );
      },
      {
        timeout: 30_000,
        timeoutMsg:
          "Routine-created Work Item prompt context was not visible in rendered chat",
      }
    );
    await waitForRenderedAssistantReply(
      "Routine-created Work Item rendered UI LLM execution",
      activeSessionId
    );
    await waitForSessionAggregateRow(
      activeSessionId,
      (session) => session.status !== "running",
      "Routine-created Work Item session leaves running after assistant reply",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );
    await waitForWorkItemLockCleared(
      projectSlug,
      createdShortId,
      activeSessionId,
      "completed Routine-created Work Item session",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );

    unwrap(
      await invokeE2E("agentOrgSimulateAppRestart"),
      "simulate app restart for Routine-created Work Item session"
    );
    await waitForSessionAggregateRow(
      activeSessionId,
      (session) => session.sessionId === activeSessionId,
      "Routine-created Work Item session retained after simulated app restart"
    );
    const postRestartItem = unwrap(
      await invokeE2E("readWorkItem", projectSlug, createdShortId),
      "readWorkItem(post-restart Routine-created Work Item)"
    ).item;
    if (
      postRestartItem.frontmatter.execution_lock?.activeSessionId ===
      activeSessionId
    ) {
      throw new Error(
        `Simulated app restart resurrected stale Routine-created Work Item lock: ${JSON.stringify(postRestartItem.frontmatter.execution_lock)}`
      );
    }

    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(routine-created after restart)"
    );
    await openSeededWorkItemExecutionTab(
      projectSlug,
      projectName,
      createdShortId
    );
    const postRestartReopenItem = unwrap(
      await invokeE2E("readWorkItem", projectSlug, createdShortId),
      "readWorkItem(post-restart Routine-created reopen)"
    ).item;
    if (postRestartReopenItem.frontmatter.execution_lock?.activeSessionId) {
      throw new Error(
        `Post-restart Routine-created Work Item should be launchable without stale lock: ${JSON.stringify(postRestartReopenItem.frontmatter.execution_lock)}`
      );
    }
  });

  it("opens a linked Work Item session in a floating ChatPanel window", async function () {
    if (
      !shouldRunScenario(CHAT_PANEL_WORK_ITEM_SESSION_BREADCRUMB_UI_SCENARIO)
    ) {
      this.skip();
      return;
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts(chat panel Work Item session breadcrumb)"
    ).accounts;
    const account = selectRustAgentAccount(accounts);
    if (!account) {
      if (
        isScenarioExplicitlyRequested(
          CHAT_PANEL_WORK_ITEM_SESSION_BREADCRUMB_UI_SCENARIO
        )
      ) {
        throw new Error(
          `No enabled Rust-agent account matched agentType=${API_AGENT_TYPE} model=${PREFERRED_API_MODEL_ID} account=${API_ACCOUNT_NAME ?? "<any>"}`
        );
      }
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(chat panel Work Item session breadcrumb)"
    );
    const projectSlug = `e2e-chat-panel-breadcrumb-${RUN_ID}`;
    const projectName = `E2E ChatPanel Breadcrumb ${RUN_ID}`;
    const shortId = `BC-${RUN_ID}`;
    const workItemTitle = `E2E breadcrumb LLM Work Item ${RUN_ID}`;
    const sessionPrompt =
      "ChatPanel breadcrumb Work Item LLM probe. Reply with one short sentence and do not modify files.";

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project for ChatPanel Work Item breadcrumb coverage.",
        true
      ),
      "writeProject(chat panel Work Item session breadcrumb)"
    );
    unwrap(
      await invokeE2E(
        "writeWorkItem",
        projectSlug,
        shortId,
        createWorkItemFrontmatter({ shortId, title: workItemTitle, account }),
        sessionPrompt
      ),
      "writeWorkItem(chat panel Work Item session breadcrumb)"
    );

    const launchedSession = unwrap(
      await invokeE2E("launchSession", {
        category: "rust_agent",
        content: sessionPrompt,
        prompt: sessionPrompt,
        accountId: account.id,
        model: PREFERRED_API_MODEL_ID,
        workspacePath: repo.path,
        projectSlug,
        workItemId: shortId,
      }),
      "launchSession(chat panel floating linked Work Item session)"
    ).result;
    const activeSessionId =
      launchedSession.sessionId ?? launchedSession.session_id;
    if (!activeSessionId) {
      throw new Error(
        `launchSession did not return a session id: ${JSON.stringify(launchedSession)}`
      );
    }
    await waitForSessionAggregateRow(
      activeSessionId,
      (session) => session.sessionId === activeSessionId,
      "ChatPanel floating linked Work Item session aggregate row"
    );

    const sessionRow = unwrap(
      await invokeE2E("getSessionAggregateRow", activeSessionId),
      "getSessionAggregateRow(chat panel breadcrumb linked session)"
    ).session;
    const linkedUpdateResult = unwrap(
      await invokeE2E("updateWorkItemPartial", projectSlug, shortId, {
        linkedSessions: [
          {
            session_id: activeSessionId,
            session_type: "native",
            agent_role: "coding",
            started_at: sessionRow.createdAt || new Date().toISOString(),
            completed_at: sessionRow.updatedAt || new Date().toISOString(),
            status: sessionRow.status || "completed",
            cost_usd: 0,
            total_tokens: 0,
          },
        ],
      }),
      "updateWorkItemPartial(chat panel breadcrumb linked session)"
    ).item;
    const linkedUpdateSessions =
      linkedUpdateResult.linkedSessions ??
      linkedUpdateResult.linked_sessions ??
      [];
    if (
      !linkedUpdateSessions.some(
        (linkedSession) => linkedSession.session_id === activeSessionId
      )
    ) {
      throw new Error(
        `Linked session did not round-trip through project updateWorkItemPartial response: ${JSON.stringify(linkedUpdateSessions)}`
      );
    }
    const linkedWorkItemsReadback = unwrap(
      await invokeE2E("readWorkItemsEnriched", projectSlug),
      "readWorkItemsEnriched(chat panel breadcrumb linked session readback)"
    ).items;
    const linkedWorkItemReadback = linkedWorkItemsReadback.find(
      (item) => item.shortId === shortId
    );
    const linkedSessionsReadback =
      linkedWorkItemReadback?.linkedSessions ??
      linkedWorkItemReadback?.linked_sessions ??
      [];
    if (
      !linkedSessionsReadback.some(
        (linkedSession) => linkedSession.session_id === activeSessionId
      )
    ) {
      throw new Error(
        `Linked session did not round-trip through project enriched readback: ${JSON.stringify(linkedSessionsReadback)}`
      );
    }

    unwrap(
      await invokeE2E("openChatPanelWorkItem", projectSlug, shortId),
      "openChatPanelWorkItem(chat panel floating linked session)"
    );
    await waitForChatPanelWorkItemDetail(
      workItemTitle,
      "floating linked session Work Item detail before linked-session open"
    );
    const linkedSessionSelector = `[data-testid="work-item-linked-session-${activeSessionId}"]`;
    await waitForExistingSelector(
      linkedSessionSelector,
      "breadcrumb linked session row",
      MOUNT_TIMEOUT_MS
    );
    const linkedClick = await clickExistingSelector(linkedSessionSelector);
    if (linkedClick !== "clicked") {
      throw new Error(`Linked session click failed: ${linkedClick}`);
    }

    await browser.waitUntil(
      async () => {
        const state = await execJS(`
          const detail = document.querySelector('[data-testid="chat-panel-work-item-detail"]');
          const floating = document.querySelector('[data-testid="work-item-floating-session-chat"]');
          const chatList = floating?.querySelector('[data-testid="chat-message-list"]');
          return {
            detailVisible: Boolean(detail),
            floatingVisible: Boolean(floating),
            floatingSessionId: floating?.getAttribute('data-session-id') || '',
            chatListVisible: Boolean(chatList),
            bodyText: document.body.innerText.slice(0, 1800),
          };
        `);
        return (
          state.detailVisible &&
          state.floatingVisible &&
          state.floatingSessionId === activeSessionId &&
          state.chatListVisible
        );
      },
      {
        timeout: MOUNT_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "Linked session did not open as a floating Work Item chat",
      }
    );

    const closeFloatingChat = await clickExistingSelector(
      '[data-testid="work-item-floating-session-chat-close"]'
    );
    if (closeFloatingChat !== "clicked") {
      throw new Error(
        `Floating session chat close failed: ${closeFloatingChat}`
      );
    }
    await waitForChatPanelWorkItemDetail(
      workItemTitle,
      "breadcrumb Work Item detail after linked-session close"
    );
  });

  it("links an existing session page to a Work Item from rendered UI", async function () {
    if (!shouldRunScenario(SESSION_LINK_WORK_ITEM_UI_SCENARIO)) {
      this.skip();
      return;
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts(session link work item UI)"
    ).accounts;
    const account = selectRustAgentAccount(accounts);
    if (!account) {
      if (isScenarioExplicitlyRequested(SESSION_LINK_WORK_ITEM_UI_SCENARIO)) {
        throw new Error(
          `No enabled Rust-agent account matched agentType=${API_AGENT_TYPE} model=${PREFERRED_API_MODEL_ID} account=${API_ACCOUNT_NAME ?? "<any>"}`
        );
      }
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(session link work item UI)"
    );
    const projectSlug = `e2e-session-link-work-item-${RUN_ID}`;
    const projectName = `E2E Session Link Work Item ${RUN_ID}`;
    const shortId = `SLINK-${RUN_ID}`;
    const workItemTitle = `E2E session link target ${RUN_ID}`;
    const sessionPrompt =
      "Session link Work Item UI probe. Reply with one short sentence and do not modify files.";

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project for linking an existing session to a Work Item.",
        true
      ),
      "writeProject(session link work item UI)"
    );
    unwrap(
      await invokeE2E(
        "writeWorkItem",
        projectSlug,
        shortId,
        createWorkItemFrontmatter({ shortId, title: workItemTitle, account }),
        "Existing Work Item used as a session link target."
      ),
      "writeWorkItem(session link work item UI)"
    );

    const launch = unwrap(
      await invokeE2E("launchSession", {
        prompt: sessionPrompt,
        name: `E2E link source session ${RUN_ID}`,
        model: PREFERRED_API_MODEL_ID,
        accountId: account.id,
        keySource: "own_key",
        workspacePath: repo.path,
        agentDefinitionId: "builtin:sde",
        mode: "ask",
      }),
      "launchSession(session link work item UI)"
    ).result;
    const sessionId = launch.sessionId || launch.session_id;
    if (!sessionId) {
      throw new Error(
        `session link launch returned no session id: ${JSON.stringify(launch)}`
      );
    }

    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession(session link work item UI)"
    );
    await waitForVisibleSelector(
      '[data-testid="chat-panel-header-more-button"]',
      "session header more button",
      MOUNT_TIMEOUT_MS
    );
    const moreClick = await clickSelector(
      '[data-testid="chat-panel-header-more-button"]'
    );
    if (moreClick !== "clicked") {
      throw new Error(`Session header more click failed: ${moreClick}`);
    }
    await waitForVisibleSelector(
      '[data-testid="session-link-work-item-button"]',
      "session link Work Item menu item",
      MOUNT_TIMEOUT_MS
    );
    const linkMenuClick = await clickSelector(
      '[data-testid="session-link-work-item-button"]'
    );
    if (linkMenuClick !== "clicked") {
      throw new Error(`Link to Work Item menu click failed: ${linkMenuClick}`);
    }
    await waitForVisibleSelector(
      '[data-testid="session-link-work-item-modal"]',
      "session link Work Item modal",
      MOUNT_TIMEOUT_MS
    );
    const optionSelector = `[data-testid="session-link-work-item-option-${shortId}"]`;
    await waitForVisibleSelector(
      optionSelector,
      "session link Work Item target option",
      MOUNT_TIMEOUT_MS
    );
    const optionClick = await clickSelector(optionSelector);
    if (optionClick !== "clicked") {
      throw new Error(
        `Session link Work Item option click failed: ${optionClick}`
      );
    }

    await waitForSessionAggregateRow(
      sessionId,
      (session) =>
        session.sessionId === sessionId &&
        session.workItemId === shortId &&
        session.projectSlug === projectSlug,
      "session link work item persisted linkage"
    );

    let linkedWorkItem = null;
    await browser.waitUntil(
      async () => {
        const items = unwrap(
          await invokeE2E("readWorkItemsEnriched", projectSlug),
          "readWorkItemsEnriched(session link work item UI)"
        ).items;
        linkedWorkItem = items.find((item) => item.shortId === shortId) ?? null;
        const linkedSessions = linkedWorkItem?.linkedSessions ?? [];
        return linkedSessions.some(
          (linkedSession) => linkedSession.session_id === sessionId
        );
      },
      {
        timeout: PERSIST_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "Linked session did not persist onto Work Item",
      }
    );

    const openState = unwrap(
      await invokeE2E(
        "openProjectWorkItemsTab",
        projectSlug,
        projectName,
        projectSlug
      ),
      "openProjectWorkItemsTab(session link work item UI)"
    );
    const rowSelector = `[data-testid="work-item-row-${shortId}"]`;
    const projectTabSelector = `[data-tab-id="${openState.activeTabId}"]`;
    await browser.waitUntil(
      async () => {
        if (openState.activeTabId) {
          await clickSelector(projectTabSelector);
        }
        const rowState = await execJS(`
          const row = document.querySelector(${JSON.stringify(rowSelector)});
          const rect = row?.getBoundingClientRect();
          const style = row ? window.getComputedStyle(row) : null;
          return Boolean(row && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none');
        `);
        return rowState;
      },
      {
        timeout: MOUNT_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "session-linked project Work Item row did not render",
      }
    );
    const rowClick = await clickSelector(rowSelector);
    if (rowClick !== "clicked") {
      throw new Error(`Session-linked Work Item row click failed: ${rowClick}`);
    }
    await waitForVisibleSelector(
      `[data-testid="work-item-linked-session-${sessionId}"]`,
      "session-linked Work Item linked session row",
      MOUNT_TIMEOUT_MS
    );
  });

  it("starts a completed Work Item again as a separate rendered LLM session", async function () {
    if (!shouldRunScenario(WORK_ITEM_RERUN_UI_LLM_SCENARIO)) {
      this.skip();
      return;
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts(work item rerun ui llm)"
    ).accounts;
    const account = selectRustAgentAccount(accounts);
    if (!account) {
      if (isScenarioExplicitlyRequested(WORK_ITEM_RERUN_UI_LLM_SCENARIO)) {
        throw new Error(
          `No enabled Rust-agent account matched agentType=${API_AGENT_TYPE} model=${PREFERRED_API_MODEL_ID} account=${API_ACCOUNT_NAME ?? "<any>"}`
        );
      }
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(work item rerun ui llm)"
    );
    const projectSlug = `e2e-work-item-rerun-${RUN_ID}`;
    const projectName = `E2E Work Item Rerun ${RUN_ID}`;
    const shortId = `RERUN-${RUN_ID}`;
    const workItemTitle = `E2E rerunnable LLM work item ${RUN_ID}`;

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project for Work Item rerun LLM execution.",
        true
      ),
      "writeProject(work item rerun ui llm)"
    );
    unwrap(
      await invokeE2E(
        "writeWorkItem",
        projectSlug,
        shortId,
        createWorkItemFrontmatter({ shortId, title: workItemTitle, account }),
        "Rerunnable Work Item LLM execution probe. Reply briefly and do not modify files."
      ),
      "writeWorkItem(work item rerun ui llm)"
    );

    const firstSessionId = await startWorkItemRunFromUi(
      projectSlug,
      projectName,
      shortId,
      "first rerun scenario"
    );
    await waitForSessionAggregateRow(
      firstSessionId,
      (session) =>
        session.sessionId === firstSessionId &&
        session.category === "rust_agent" &&
        session.model === PREFERRED_API_MODEL_ID &&
        session.accountId === account.id &&
        session.workItemId === shortId &&
        session.projectSlug === projectSlug &&
        session.workspacePath === repo.path,
      "first Work Item rerun scenario session aggregate"
    );

    unwrap(
      await invokeE2E("openSession", firstSessionId),
      "openSession(first Work Item rerun scenario)"
    );
    await waitForVisibleSelector(
      '[data-testid="chat-panel"]',
      "first Work Item rerun scenario chat panel",
      MOUNT_TIMEOUT_MS
    );
    await waitForRenderedAssistantReply(
      "first Work Item rerun scenario",
      firstSessionId
    );
    await waitForSessionAggregateRow(
      firstSessionId,
      (session) => session.status !== "running",
      "first Work Item rerun scenario leaves running",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );
    await waitForWorkItemLockCleared(
      projectSlug,
      shortId,
      firstSessionId,
      "first Work Item rerun scenario completed session",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );

    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(before second rerun)"
    );
    const secondSessionId = await startWorkItemRunFromUi(
      projectSlug,
      projectName,
      shortId,
      "second rerun scenario"
    );
    if (secondSessionId === firstSessionId) {
      throw new Error(
        `Second Work Item run reused first session id: ${firstSessionId}`
      );
    }
    await waitForSessionAggregateRow(
      secondSessionId,
      (session) =>
        session.sessionId === secondSessionId &&
        session.category === "rust_agent" &&
        session.model === PREFERRED_API_MODEL_ID &&
        session.accountId === account.id &&
        session.workItemId === shortId &&
        session.projectSlug === projectSlug &&
        session.workspacePath === repo.path,
      "second Work Item rerun scenario session aggregate"
    );
    const secondLockedItem = await waitForWorkItemLock(
      projectSlug,
      shortId,
      "second rerun scenario active lock"
    );
    if (
      secondLockedItem.frontmatter.execution_lock.activeSessionId !==
      secondSessionId
    ) {
      throw new Error(
        `Second Work Item run lock did not point at second session: ${JSON.stringify(secondLockedItem.frontmatter.execution_lock)}`
      );
    }

    unwrap(
      await invokeE2E("openSession", secondSessionId),
      "openSession(second Work Item rerun scenario)"
    );
    await waitForVisibleSelector(
      '[data-testid="chat-panel"]',
      "second Work Item rerun scenario chat panel",
      MOUNT_TIMEOUT_MS
    );
    await waitForRenderedAssistantReply(
      "second Work Item rerun scenario",
      secondSessionId
    );
    await waitForSessionAggregateRow(
      secondSessionId,
      (session) => session.status !== "running",
      "second Work Item rerun scenario leaves running",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );
    await waitForWorkItemLockCleared(
      projectSlug,
      shortId,
      secondSessionId,
      "second Work Item rerun scenario completed session",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );

    await waitForSessionAggregateRow(
      firstSessionId,
      (session) =>
        session.sessionId === firstSessionId && session.status !== "running",
      "first Work Item rerun scenario remains durable after second run"
    );
  });

  it("starts a Work Item LLM session from rendered UI and reflects the execution lock", async function () {
    if (!shouldRunScenario(WORK_ITEM_UI_LLM_SCENARIO)) {
      this.skip();
      return;
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts(ui llm)"
    ).accounts;
    const account = selectRustAgentAccount(accounts);
    if (!account) {
      if (isScenarioExplicitlyRequested(WORK_ITEM_UI_LLM_SCENARIO)) {
        throw new Error(
          `No enabled Rust-agent account matched agentType=${API_AGENT_TYPE} model=${PREFERRED_API_MODEL_ID} account=${API_ACCOUNT_NAME ?? "<any>"}`
        );
      }
      this.skip();
      return;
    }

    const repo = unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(ui llm)"
    );
    const projectSlug = `e2e-work-item-ui-${RUN_ID}`;
    const projectName = `E2E Work Item UI ${RUN_ID}`;
    const shortId = `E2E-${RUN_ID}`;
    const workItemTitle = `E2E rendered LLM work item ${RUN_ID}`;

    await invokeE2E("deleteProject", projectSlug);
    unwrap(
      await invokeE2E(
        "writeProject",
        projectSlug,
        createProjectMeta(projectSlug, projectName, repo.path),
        "E2E project for rendered Work Item LLM execution.",
        true
      ),
      "writeProject(ui llm)"
    );
    unwrap(
      await invokeE2E(
        "writeWorkItem",
        projectSlug,
        shortId,
        createWorkItemFrontmatter({ shortId, title: workItemTitle, account }),
        "Rendered UI LLM execution probe. Run a harmless short wait before your final answer if tools are available, then reply briefly. Do not modify files."
      ),
      "writeWorkItem(ui llm)"
    );

    const activeSessionId = await startWorkItemRunFromUi(
      projectSlug,
      projectName,
      shortId,
      "rendered Work Item"
    );

    await waitForSessionAggregateRow(
      activeSessionId,
      (session) =>
        session.sessionId === activeSessionId &&
        session.category === "rust_agent" &&
        session.model === PREFERRED_API_MODEL_ID &&
        session.accountId === account.id &&
        session.workItemId === shortId &&
        session.projectSlug === projectSlug &&
        session.workspacePath === repo.path,
      "Work Item launched session aggregate linkage"
    );

    const preDuplicateItem = unwrap(
      await invokeE2E("readWorkItem", projectSlug, shortId),
      "readWorkItem(before duplicate launch)"
    ).item;
    if (
      preDuplicateItem.frontmatter.execution_lock?.activeSessionId ===
      activeSessionId
    ) {
      const duplicateLaunch = await invokeE2E("launchSession", {
        category: "rust_agent",
        content:
          "Duplicate Work Item launch should be blocked by the active lock.",
        prompt:
          "Duplicate Work Item launch should be blocked by the active lock.",
        accountId: account.id,
        model: PREFERRED_API_MODEL_ID,
        workspacePath: repo.path,
        projectSlug,
        workItemId: shortId,
      });
      if (duplicateLaunch.ok) {
        throw new Error(
          `Duplicate Work Item launch should be blocked by active lock, got: ${JSON.stringify(duplicateLaunch)}`
        );
      }
      const afterDuplicateItem = await waitForWorkItemLock(
        projectSlug,
        shortId,
        "duplicate launch should not replace lock"
      );
      if (
        afterDuplicateItem.frontmatter.execution_lock.activeSessionId !==
        activeSessionId
      ) {
        throw new Error(
          `Duplicate Work Item launch changed active session id: before=${activeSessionId} after=${JSON.stringify(afterDuplicateItem.frontmatter.execution_lock)}`
        );
      }
    }

    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(active lock)"
    );
    await openSeededWorkItemExecutionTab(projectSlug, projectName, shortId);
    const reopenState = await waitForStartAgentBlockedOrCompleted(
      projectSlug,
      shortId,
      activeSessionId,
      "active lock after UI reset/reopen"
    );
    const afterActiveReopenItem = reopenState.itemResult.item;
    const afterActiveReopenLock =
      afterActiveReopenItem.frontmatter.execution_lock?.activeSessionId;
    if (afterActiveReopenLock && afterActiveReopenLock !== activeSessionId) {
      throw new Error(
        `Active lock changed after UI reset/reopen: ${JSON.stringify(afterActiveReopenItem.frontmatter.execution_lock)}`
      );
    }

    unwrap(
      await invokeE2E("openSession", activeSessionId),
      "openSession(ui llm work item)"
    );
    await waitForVisibleSelector(
      '[data-testid="chat-panel"]',
      "Work Item LLM chat panel",
      MOUNT_TIMEOUT_MS
    );
    await browser.waitUntil(
      async () => {
        const text = await execJS(`return document.body.innerText || "";`);
        return (
          text.includes(workItemTitle) ||
          text.includes(shortId) ||
          text.includes("Rendered UI LLM execution probe")
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "Work Item prompt context was not visible in rendered chat",
      }
    );
    await waitForRenderedAssistantReply(
      "Work Item rendered UI LLM execution",
      activeSessionId
    );
    await waitForSessionAggregateRow(
      activeSessionId,
      (session) => session.status !== "running",
      "Work Item launched session leaves running after assistant reply",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );
    await waitForWorkItemLockCleared(
      projectSlug,
      shortId,
      activeSessionId,
      "completed Work Item session",
      LLM_COMPLETION_PERSIST_TIMEOUT_MS
    );

    unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession(ui llm)");
    unwrap(
      await invokeE2E("openSession", activeSessionId),
      "reopen Work Item LLM session after reset"
    );
    await waitForVisibleSelector(
      '[data-testid="chat-panel"]',
      "reopened Work Item LLM chat panel",
      MOUNT_TIMEOUT_MS
    );
    await browser.waitUntil(
      async () => {
        const text = await execJS(`return document.body.innerText || "";`);
        return (
          text.includes(workItemTitle) ||
          text.includes(shortId) ||
          text.includes("Rendered UI LLM execution probe")
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: "Work Item transcript context disappeared after reopen",
      }
    );

    await openSeededWorkItemExecutionTab(projectSlug, projectName, shortId);
    await waitForVisibleSelector(
      '[data-testid="work-item-agent-completed-state"]',
      "completed Work Item execution state",
      RENDER_TIMEOUT_MS
    );
    const reopenedItem = unwrap(
      await invokeE2E("readWorkItem", projectSlug, shortId),
      "readWorkItem(reopened completed Work Item)"
    ).item;
    if (
      reopenedItem.frontmatter.execution_lock?.activeSessionId ===
      activeSessionId
    ) {
      throw new Error(
        `Completed Work Item retained stale lock: ${JSON.stringify(reopenedItem.frontmatter.execution_lock)}`
      );
    }

    unwrap(
      await invokeE2E("agentOrgSimulateAppRestart"),
      "simulate app restart for Work Item session"
    );
    await waitForSessionAggregateRow(
      activeSessionId,
      (session) => session.sessionId === activeSessionId,
      "Work Item session retained after simulated app restart"
    );
    const postRestartItem = unwrap(
      await invokeE2E("readWorkItem", projectSlug, shortId),
      "readWorkItem(post-restart Work Item)"
    ).item;
    if (
      postRestartItem.frontmatter.execution_lock?.activeSessionId ===
      activeSessionId
    ) {
      throw new Error(
        `Simulated app restart resurrected stale Work Item lock: ${JSON.stringify(postRestartItem.frontmatter.execution_lock)}`
      );
    }

    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(after restart)"
    );
    unwrap(
      await invokeE2E("openSession", activeSessionId),
      "reopen Work Item session after simulated restart"
    );
    await waitForVisibleSelector(
      '[data-testid="chat-panel"]',
      "post-restart Work Item chat panel",
      MOUNT_TIMEOUT_MS
    );
    await openSeededWorkItemExecutionTab(projectSlug, projectName, shortId);
    const postRestartReopenItem = unwrap(
      await invokeE2E("readWorkItem", projectSlug, shortId),
      "readWorkItem(post-restart Work Item reopen)"
    ).item;
    if (postRestartReopenItem.frontmatter.execution_lock?.activeSessionId) {
      throw new Error(
        `Post-restart Work Item should be launchable without stale lock: ${JSON.stringify(postRestartReopenItem.frontmatter.execution_lock)}`
      );
    }
  });
});
