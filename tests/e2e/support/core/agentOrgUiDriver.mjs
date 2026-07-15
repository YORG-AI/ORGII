/* global browser, describe, before, it, process, fetch */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOUNT_TIMEOUT_MS = 60_000;
export const RENDER_TIMEOUT_MS = 20_000;
const PERSIST_TIMEOUT_MS = 20_000;
export const REPLY_TIMEOUT_MS = 120_000;
const SLOW_WAIT_TRACE_THRESHOLD_MS = 3_000;
const TRACE_WAITS = process.env.E2E_TRACE_WAITS === "1";
export const RUN_ID = Date.now();
export const AGENT_ORG_SCENARIO_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_AGENT_ORG_SCENARIO_TIMEOUT_MS ?? "240000",
  10
);

function withTimeout(operation, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    operation(),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function runAgentOrgScenarioWithTimeout(label, operation) {
  console.log(`[agent-org-stage] ${label} start`);
  const startedAt = Date.now();
  return withTimeout(operation, AGENT_ORG_SCENARIO_TIMEOUT_MS, label).finally(
    () => {
      console.log(
        `[agent-org-stage] ${label} end elapsed=${Date.now() - startedAt}ms`
      );
    }
  );
}
const WORKSTATION_CODE_PATH = "/orgii/workstation/code";
const API_ACCOUNT_NAME = process.env.E2E_OPENAI_ACCOUNT;
export const API_AGENT_TYPE = process.env.E2E_API_AGENT_TYPE ?? "openai_api";
const PREFERRED_API_MODEL_ID = process.env.E2E_OPENAI_MODEL ?? "op-4.6-relay";
export const DEFAULT_AGENT_ORG_ID = "default:sde-feature-team";
export const BUILTIN_SDE_AGENT_ID = "builtin:sde";
export const SHARED_CLI_AGENT_TYPE =
  process.env.E2E_AGENT_ORG_SHARED_CLI_TYPE ?? "claude_code";
export const SHARED_CLI_AGENT_ID = `cli:${SHARED_CLI_AGENT_TYPE}`;
export const AGENT_ORG_COORDINATOR_MEMBER_ID = "coordinator";
export const DEFAULT_AGENT_ORG_MEMBER_IDS = {
  PLANNER: "sde-planner",
  IMPLEMENTER: "sde-implementer",
  REVIEWER: "sde-reviewer",
  TESTER: "sde-tester",
};
export const AGENT_ORG_TASK_STATUS = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
};
const AGENT_SESSION_ACTIVE_STATUSES = new Set([
  "running",
  "waiting_for_user",
  "waiting_for_funds",
]);
const AGENT_ORG_INTERVENTION_STATUS = {
  USER_INTERVENTION: "user_intervention",
};
const DEFAULT_E2E_REPO_PATH =
  process.platform === "win32"
    ? join(tmpdir(), "orgii-e2e-workspace-repo")
    : "/tmp/orgii-e2e-workspace-repo";
export const E2E_REPO_PATH = process.env.E2E_REPO_PATH ?? DEFAULT_E2E_REPO_PATH;

async function traceSlowWait(label, operation) {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    const elapsedMs = Date.now() - startedAt;
    if (TRACE_WAITS && elapsedMs >= SLOW_WAIT_TRACE_THRESHOLD_MS) {
      console.warn(`[e2e:slow-wait] ${label} ${elapsedMs}ms`);
    }
  }
}

export function assertE2ERepoFixture() {
  const requiredPaths = [
    E2E_REPO_PATH,
    join(E2E_REPO_PATH, ".git"),
    join(E2E_REPO_PATH, "README.md"),
    join(E2E_REPO_PATH, "package.json"),
  ];
  const missingPath = requiredPaths.find((path) => !existsSync(path));
  if (missingPath) {
    throw new Error(
      `E2E workspace fixture is missing ${missingPath}; rerun through tests/e2e/wdio.conf.mjs`
    );
  }
}

export async function execJS(script) {
  return browser.executeScript(script, []);
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

export async function invokeE2E(method, ...args) {
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

export function unwrap(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed: ${result?.error ?? "unknown"}`);
  }
  return result;
}

export const js = {
  exists: (selector) =>
    `return !!document.querySelector(${JSON.stringify(selector)});`,
  text: (selector) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    return element ? (element.textContent || "") : "";
  `,
  click: (selector) => `
    const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visible = candidates.filter((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const element = visible[visible.length - 1] ?? candidates[candidates.length - 1] ?? null;
    if (!element) return "missing";
    if (element.disabled) return "disabled";
    element.click();
    return "clicked";
  `,
  inputValue: (selector, value) => `
    const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visible = candidates.filter((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const element = visible[visible.length - 1] ?? candidates[candidates.length - 1] ?? null;
    if (!element) return "missing";
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return "not-input";
    element.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    const previousValue = element.value;
    setter?.call(element, ${JSON.stringify(value)});
    element._valueTracker?.setValue?.(previousValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value === ${JSON.stringify(value)} ? "typed" : element.value;
  `,
  visibleClick: (selector) => `
    const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
      const rect = inputShell.getBoundingClientRect();
      const style = window.getComputedStyle(inputShell);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const activeInputShell = visibleInputShells[visibleInputShells.length - 1] ?? null;
    const scopedElements = activeInputShell
      ? Array.from(activeInputShell.querySelectorAll(${JSON.stringify(selector)}))
      : [];
    const elements = scopedElements.length > 0
      ? scopedElements
      : Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visibleElements = elements.filter((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const element = visibleElements[visibleElements.length - 1] ?? null;
    if (!element) return "missing";
    if (element.disabled) return "disabled";
    element.scrollIntoView({ block: "center", inline: "center" });
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    element.click();
    return "clicked";
  `,
  type: (selector, text) => `
    const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
      const rect = inputShell.getBoundingClientRect();
      const style = window.getComputedStyle(inputShell);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const activeInputShell = visibleInputShells[visibleInputShells.length - 1] ?? null;
    const scopedEditors = activeInputShell
      ? Array.from(activeInputShell.querySelectorAll(${JSON.stringify(selector)}))
      : [];
    const editors = scopedEditors.length > 0
      ? scopedEditors
      : Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const editor = editors[editors.length - 1] ?? null;
    if (!editor) return "missing";
    editor.focus();
    document.execCommand("selectAll", false, null);
    const ok = document.execCommand("insertText", false, ${JSON.stringify(text)});
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
    return ok ? "typed" : "insert-failed";
  `,
  editorText: (selector) => `
    const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
      const rect = inputShell.getBoundingClientRect();
      const style = window.getComputedStyle(inputShell);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const activeInputShell = visibleInputShells[visibleInputShells.length - 1] ?? null;
    const scopedEditors = activeInputShell
      ? Array.from(activeInputShell.querySelectorAll(${JSON.stringify(selector)}))
      : [];
    const editors = scopedEditors.length > 0
      ? scopedEditors
      : Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const editor = editors[editors.length - 1] ?? null;
    return editor ? (editor.textContent || "") : null;
  `,
  sendState: `
    const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
      const rect = inputShell.getBoundingClientRect();
      const style = window.getComputedStyle(inputShell);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const activeInputShell = visibleInputShells[visibleInputShells.length - 1] ?? null;
    const scopedButtons = activeInputShell
      ? Array.from(activeInputShell.querySelectorAll('[data-testid="chat-send-button"]'))
      : [];
    const buttons = scopedButtons.length > 0
      ? scopedButtons
      : Array.from(document.querySelectorAll('[data-testid="chat-send-button"]'));
    const button = buttons[buttons.length - 1] ?? null;
    if (!button) return null;
    return { state: button.getAttribute("data-state"), disabled: button.disabled };
  `,
  mode: `
    const creator = document.querySelector(".session-creator-chat-panel");
    const history = document.querySelector('[data-testid="chat-message-list"]');
    return creator ? "creator" : history ? "chat" : "unknown";
  `,
};

export async function waitForApp() {
  await waitForFrontendReady();
  await browser.setTimeout({ script: 10_000 });
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return document.readyState === "complete" || document.readyState === "interactive";`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: "app document never became script-readable",
      interval: 500,
    }
  );
  await execJS(`
    try {
      window.localStorage.setItem("orgii:auth_skipped", "1");
      return true;
    } catch {
      return false;
    }
  `);
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!(window.__e2e
            && window.__e2e.navigateTo
            && window.__e2e.resetToNewSession
            && window.__e2e.configureWithExistingKey
            && window.__e2e.inspectCreatorSelection
            && window.__e2e.setAgentOrgMemberDraftConfig
            && window.__e2e.getActiveSessionId
            && window.__e2e.getSessionAggregateRow
            && window.__e2e.promptDump
            && window.__e2e.agentOrgSessionRunView
            && window.__e2e.agentOrgSessionInterventionState
            && window.__e2e.agentOrgSendGroupChatMessage
            && window.__e2e.agentOrgRunList
            && window.__e2e.debugSessionExecuteOrgTool);`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: 30_000,
      timeoutMsg: "required __e2e helpers never exposed",
    }
  );
  let shellState = null;
  await browser.waitUntil(
    async () => {
      try {
        shellState = await execJS(`
          const bodyText = document.body?.innerText || "";
          return {
            initializing: bodyText.includes("Initializing"),
            hasCreator: Boolean(document.querySelector('[data-testid="session-creator-chat-panel"]')),
            hasChat: Boolean(document.querySelector('[data-testid="chat-panel"]')),
            hasLogin: Boolean(document.querySelector('.login-page, [data-testid="login-page"]')),
            hasAppError: bodyText.includes("App error"),
            bodyText: bodyText.slice(0, 700),
          };
        `);
        return (
          shellState.hasCreator ||
          shellState.hasChat ||
          shellState.hasLogin ||
          shellState.hasAppError
        );
      } catch {
        return false;
      }
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `app shell never left initializing state: ${JSON.stringify(shellState)}`,
    }
  );
}

async function listAccounts() {
  return unwrap(await invokeE2E("listAccounts"), "listAccounts").accounts;
}

function accountDisplayName(account) {
  return account.name || account.id;
}

function matchesOptionalAccountName(account, requestedName) {
  if (!requestedName) return true;
  return account.id === requestedName || account.name === requestedName;
}

export async function getApiAccount() {
  const accounts = await listAccounts();
  const account = accounts.find(
    (row) =>
      row.agent_type === API_AGENT_TYPE &&
      row.enabled &&
      row.has_api_key &&
      (row.enabled_models ?? []).length > 0 &&
      matchesOptionalAccountName(row, API_ACCOUNT_NAME)
  );
  if (!account) {
    throw new Error(
      `No enabled API account found. requested=${API_ACCOUNT_NAME ?? "<any>"} agentType=${API_AGENT_TYPE}`
    );
  }
  return account;
}

export function selectPreferredModel(account) {
  const enabledModels = account.enabled_models ?? [];
  return enabledModels.includes(PREFERRED_API_MODEL_ID)
    ? PREFERRED_API_MODEL_ID
    : enabledModels[0];
}

export function selectMemberOverrideModel(account, fallbackModel) {
  const enabledModels = account.enabled_models ?? [];
  return (
    enabledModels.find((model) => model !== fallbackModel) ?? fallbackModel
  );
}

async function typeRenderedInput(selector, value, label) {
  await browser.waitUntil(async () => execJS(js.exists(selector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: `${label} input never rendered`,
  });
  const result = await execJS(js.inputValue(selector, value));
  if (result !== "typed") {
    throw new Error(`${label} input did not accept value: ${result}`);
  }
}

async function selectRenderedOption(triggerSelector, optionSelector, label) {
  await browser.waitUntil(async () => execJS(js.exists(triggerSelector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: `${label} trigger never rendered`,
  });
  const openResult = await execJS(js.click(triggerSelector));
  if (openResult !== "clicked") {
    throw new Error(`${label} trigger did not open: ${openResult}`);
  }
  await browser.waitUntil(async () => execJS(js.exists(optionSelector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: `${label} option never rendered: ${optionSelector}`,
  });
  const clickResult = await execJS(js.click(optionSelector));
  if (clickResult !== "clicked") {
    throw new Error(`${label} option did not click: ${clickResult}`);
  }
}

async function navigateToWorkstationCode(label) {
  unwrap(
    await invokeE2E("navigateTo", WORKSTATION_CODE_PATH),
    `navigateTo workstation ${label}`
  );
  await browser.waitUntil(
    async () =>
      execJS(
        `return window.location.pathname === ${JSON.stringify(WORKSTATION_CODE_PATH)};`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `WorkStation code route did not render for ${label}`,
    }
  );
}

export async function configureCreatorForAgentOrg({
  account,
  model,
  agentOrgId = DEFAULT_AGENT_ORG_ID,
}) {
  await navigateToWorkstationCode("before configure creator");
  unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
  unwrap(
    await invokeE2E("setAgentOrgMemberDraftConfig", {}, agentOrgId),
    "clear agent org member draft config"
  );
  const result = unwrap(
    await invokeE2E("configureWithExistingKey", {
      accountName: accountDisplayName(account),
      model,
      agentType: account.agent_type,
      category: "rust_agent",
      agentDefinitionId: BUILTIN_SDE_AGENT_ID,
      agentOrgId,
      repoPath: E2E_REPO_PATH,
    }),
    "configureWithExistingKey(default Agent Org)"
  );
  if (result.modelId !== model) {
    throw new Error(
      `configured model mismatch: ${result.modelId} !== ${model}`
    );
  }
  await browser.pause(500);
}

export async function removeAgentOrgsByName(name) {
  const orgs = unwrap(await invokeE2E("listAgentOrgs"), "listAgentOrgs").orgs;
  for (const org of orgs) {
    if (org?.name === name && typeof org.id === "string") {
      unwrap(
        await invokeE2E("removeAgentOrg", org.id),
        `removeAgentOrg(${name})`
      );
    }
  }
}

export async function waitForAgentOrgByName(name, label) {
  let org = null;
  await browser.waitUntil(
    async () => {
      const orgs = unwrap(
        await invokeE2E("listAgentOrgs"),
        `listAgentOrgs(${label})`
      ).orgs;
      org = orgs.find((candidate) => candidate?.name === name) ?? null;
      return Boolean(org);
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `Agent Org ${name} did not persist for ${label}: ${JSON.stringify(org)}`,
    }
  );
  return org;
}

export async function createRenderedStrictTwoMemberAgentOrg({
  orgName,
  leadName,
  childName,
  prefix,
  memberAgentId = BUILTIN_SDE_AGENT_ID,
  planApprovalPolicy = "coordinator",
}) {
  const tag = prefix ?? "org";
  if (!orgName) orgName = `E2E ${tag} ${RUN_ID}`;
  if (!leadName) leadName = `E2E ${tag} Lead ${RUN_ID}`;
  if (!childName) childName = `E2E ${tag} Child ${RUN_ID}`;
  unwrap(
    await invokeE2E("navigateTo", "/orgii/app/settings/agent-orgs/agents"),
    "navigateTo Agent Org settings"
  );
  await browser.waitUntil(
    async () =>
      !(await execJS(js.exists('[data-testid="agent-orgs-org-wizard-root"]'))),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "previous Agent Org wizard did not unmount",
    }
  );
  unwrap(
    await invokeE2E(
      "navigateTo",
      "/orgii/app/settings/agent-orgs/agents?wizard=org-add"
    ),
    "navigateTo Agent Org add wizard"
  );
  await browser.waitUntil(
    async () => execJS(js.exists('[data-testid="agent-orgs-org-wizard-root"]')),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "Agent Org add wizard never rendered",
    }
  );

  await typeRenderedInput(
    '[data-testid="agent-orgs-org-name-input"]',
    orgName,
    "Agent Org name"
  );
  await selectRenderedOption(
    '[data-testid="agent-orgs-org-coordinator-select"]',
    '[data-testid="agent-option-builtin:sde"]',
    "Agent Org coordinator"
  );
  await selectRenderedOption(
    '[data-testid="agent-orgs-hierarchy-mode-select"]',
    '[data-testid="agent-orgs-hierarchy-mode-strict"]',
    "Agent Org strict hierarchy mode"
  );
  await selectRenderedOption(
    '[data-testid="agent-orgs-plan-approval-policy-select"]',
    `[data-testid="agent-orgs-plan-approval-policy-${planApprovalPolicy}"]`,
    `Agent Org ${planApprovalPolicy} plan approval policy`
  );

  const addMember = async (name, role) => {
    const addResult = await execJS(
      js.click('[data-testid="agent-orgs-member-add-member-button"]')
    );
    if (addResult !== "clicked") {
      throw new Error(`Add member did not click for ${name}: ${addResult}`);
    }
    const row = await browser.waitUntil(
      async () =>
        execJS(`
          const inputs = Array.from(document.querySelectorAll('[data-testid^="agent-orgs-member-"][data-testid$="-name-input"]'));
          const input = inputs[inputs.length - 1] ?? null;
          if (!input) return null;
          const testId = input.getAttribute('data-testid');
          const rowId = testId?.replace('agent-orgs-member-', '').replace('-name-input', '') ?? null;
          return rowId ? { rowId, nameSelector: '[data-testid="' + testId + '"]' } : null;
        `),
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: `Member row for ${name} never rendered`,
      }
    );
    await typeRenderedInput(row.nameSelector, name, `${name} member name`);
    await typeRenderedInput(
      `[data-testid="agent-orgs-member-${row.rowId}-role-input"]`,
      role,
      `${name} member role`
    );
    await selectRenderedOption(
      `[data-testid="agent-orgs-member-${row.rowId}-agent-select"]`,
      `[data-testid="agent-option-${memberAgentId}"]`,
      `${name} member agent`
    );
    return row.rowId;
  };

  const leadId = await addMember(leadName, "Lead planner");
  const childId = await addMember(childName, "Child implementer");
  const reportsToTriggerClick = await execJS(
    js.click(`[data-testid="agent-orgs-member-${childId}-reports-to-select"]`)
  );
  if (reportsToTriggerClick !== "clicked") {
    throw new Error(
      `child reports-to trigger did not click: ${reportsToTriggerClick}`
    );
  }
  let reportsToContract = null;
  await browser.waitUntil(
    async () => {
      reportsToContract = await execJS(`
        return {
          hasCoordinator: !!document.querySelector('[data-testid="agent-orgs-member-reports-to-coordinator"]'),
          hasLead: !!document.querySelector('[data-testid="agent-orgs-member-reports-to-${leadId}"]'),
          hasUser: !!document.querySelector('[data-testid="agent-orgs-member-reports-to-user"]'),
          options: Array.from(document.querySelectorAll('[data-testid^="agent-orgs-member-reports-to-"]')).map((option) => ({
            testId: option.getAttribute('data-testid'),
            text: option.textContent || '',
          })),
        };
      `);
      return (
        reportsToContract.hasCoordinator &&
        reportsToContract.hasLead &&
        !reportsToContract.hasUser
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 100,
      timeoutMsg: `Reports-to dropdown contract mismatch: ${JSON.stringify(reportsToContract)}`,
    }
  );
  const reportsToLeadClick = await execJS(
    js.click(`[data-testid="agent-orgs-member-reports-to-${leadId}"]`)
  );
  if (reportsToLeadClick !== "clicked") {
    throw new Error(
      `child reports-to lead option did not click: ${reportsToLeadClick}`
    );
  }

  let saveState = null;
  try {
    await browser.waitUntil(
      async () => {
        saveState = await execJS(`
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const visibleLast = (selector) => Array.from(document.querySelectorAll(selector)).filter(isVisible).at(-1) ?? null;
        const valueOf = (selector) => visibleLast(selector)?.value ?? null;
        const textOf = (selector) => visibleLast(selector)?.textContent?.trim() ?? null;
        const button = visibleLast('[data-testid="agent-orgs-org-wizard-save-button"]');
        return {
          enabled: !!button && !button.disabled,
          orgName: valueOf('[data-testid="agent-orgs-org-name-input"]'),
          coordinatorText: textOf('[data-testid="agent-orgs-org-coordinator-select"]'),
          memberInputs: Array.from(document.querySelectorAll('[data-testid^="agent-orgs-member-"][data-testid$="-name-input"], [data-testid^="agent-orgs-member-"][data-testid$="-role-input"], [data-testid^="agent-orgs-member-"][data-testid$="-agent-select"]')).filter(isVisible).map((element) => ({
              testId: element.getAttribute('data-testid'),
              value: element.value ?? null,
              text: element.textContent?.trim() ?? null,
            })),
          };
        `);
        return saveState?.enabled === true;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 100,
        timeoutMsg: "Agent Org save button never became enabled",
      }
    );
  } catch (error) {
    throw new Error(
      `Agent Org save button never became enabled: ${JSON.stringify(saveState)}`,
      { cause: error }
    );
  }
  const saveResult = await execJS(
    js.click('[data-testid="agent-orgs-org-wizard-save-button"]')
  );
  if (saveResult !== "clicked") {
    throw new Error(`Agent Org save did not click: ${saveResult}`);
  }
  const org = await waitForAgentOrgByName(orgName, "rendered org create");
  if (org?.hierarchyMode !== "strict") {
    throw new Error(
      `Created org did not persist strict hierarchy: ${JSON.stringify(org)}`
    );
  }
  if (org?.planApprovalPolicy !== planApprovalPolicy) {
    throw new Error(
      `Created org did not persist plan approval policy ${planApprovalPolicy}: ${JSON.stringify(org)}`
    );
  }
  const lead = (org.children ?? []).find((member) => member.name === leadName);
  const child = lead?.children?.find((member) => member.name === childName);
  if (!lead || !child) {
    throw new Error(
      `Created org did not persist nested members: ${JSON.stringify(org)}`
    );
  }
  return org;
}

export async function configureCreatorForDefaultAgentOrg({ account, model }) {
  await configureCreatorForAgentOrg({ account, model });
}

export async function selectRenderedExecMode(mode) {
  const pillSelector = '[data-testid="agent-exec-mode-pill"]';
  const pillRendered = await execJS(js.exists(pillSelector));
  if (pillRendered) {
    const expectedLabels = mode === "ask" ? ["ask"] : [mode];
    const currentText = await execJS(js.text(pillSelector));
    if (
      expectedLabels.some((label) =>
        String(currentText).toLowerCase().includes(label)
      )
    ) {
      return;
    }
    const openResult = await execJS(js.visibleClick(pillSelector));
    if (openResult !== "clicked") {
      throw new Error(`Agent exec mode pill did not open: ${openResult}`);
    }
    // The composer pill is rendered with `resetToDefaultOnClick`: when the
    // current mode is non-default, clicking RESETS to build and closes —
    // no dropdown opens. Detect that: if the pill vanished (hideWhenDefault)
    // or now shows the default, the reset happened. When the caller wanted
    // the default mode we are done; otherwise fall through to the slash
    // menu path below to pick the explicit mode.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
    const pillStillRendered = await execJS(js.exists(pillSelector));
    const optionsOpened = await execJS(
      `return !!document.querySelector('[data-testid^="agent-exec-mode-option-"]');`
    );
    if (!optionsOpened) {
      const postClickText = pillStillRendered
        ? String(await execJS(js.text(pillSelector))).toLowerCase()
        : "";
      const resetLanded =
        !pillStillRendered ||
        postClickText.includes(DEFAULT_AGENT_EXEC_MODE_LABEL);
      if (resetLanded && mode === "build") return;
      if (resetLanded) {
        await selectExecModeViaSlashMenu(mode);
        return;
      }
    }
    const optionSelector = `[data-testid="agent-exec-mode-option-${mode}"]`;
    let renderedOptions = [];
    await browser.waitUntil(
      async () => {
        renderedOptions = await execJS(`
          return Array.from(document.querySelectorAll('[data-testid^="agent-exec-mode-option-"]')).map((element) => ({
            testId: element.getAttribute('data-testid'),
            text: element.textContent || '',
          }));
        `);
        return renderedOptions.some(
          (option) => option.testId === `agent-exec-mode-option-${mode}`
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: `Agent exec mode option ${mode} never rendered: ${JSON.stringify(renderedOptions)}`,
      }
    );
    const clickResult = await execJS(js.click(optionSelector));
    if (clickResult !== "clicked") {
      throw new Error(
        `Agent exec mode option ${mode} did not click: ${clickResult}`
      );
    }
    await browser.waitUntil(
      async () => {
        const text = await execJS(js.text(pillSelector));
        return expectedLabels.some((label) =>
          String(text).toLowerCase().includes(label)
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: `Agent exec mode pill did not show ${mode}: ${await execJS(js.text(pillSelector))}`,
      }
    );
    return;
  }

  await selectExecModeViaSlashMenu(mode);
}

const DEFAULT_AGENT_EXEC_MODE_LABEL = "build";

async function selectExecModeViaSlashMenu(mode) {
  const skillsToolsButtonSelector =
    '[data-testid="composer-skills-tools-button"]';
  await browser.waitUntil(
    async () => execJS(js.exists(skillsToolsButtonSelector)),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "Composer skills/tools button never rendered",
    }
  );
  const openSlashResult = await execJS(
    js.visibleClick(skillsToolsButtonSelector)
  );
  if (openSlashResult !== "clicked") {
    throw new Error(
      `Composer skills/tools button did not open: ${openSlashResult}`
    );
  }
  // The slash menu renders ModeRow entries flat (showModeRows) — there is
  // no "Mode" flyout trigger anymore. Click the mode option directly.
  // ModeRow commits on mousedown (visibleClick dispatches it).
  const slashModeOptionSelector = `[data-testid="slash-command-mode-option-${mode}"]`;
  await browser.waitUntil(
    async () => execJS(js.exists(slashModeOptionSelector)),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `Slash command mode option ${mode} never rendered`,
    }
  );
  const slashModeClickResult = await execJS(
    js.visibleClick(slashModeOptionSelector)
  );
  if (slashModeClickResult !== "clicked") {
    throw new Error(
      `Slash command mode option ${mode} did not click: ${slashModeClickResult}`
    );
  }
}

export async function selectRenderedAgentOrg(agentOrgId) {
  await navigateToWorkstationCode("before agent selector");
  await browser.waitUntil(
    async () =>
      execJS(js.exists('[data-testid="session-creator-agent-selector"]')),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: "SessionCreator agent selector never rendered",
    }
  );
  const openResult = await execJS(
    js.click('[data-testid="session-creator-agent-selector"]')
  );
  if (openResult !== "clicked") {
    throw new Error(`agent selector did not open: ${openResult}`);
  }
  const optionSelector = `[data-testid="session-creator-agent-option-org-${agentOrgId}"]`;
  // The dispatch palette virtualizes when there are >30 options, so a
  // far-down org row may never exist in the DOM. Narrow the list through
  // the spotlight search input first. Search matches name+desc (not id),
  // so resolve the org's display name via the e2e bridge.
  if (!(await execJS(js.exists(optionSelector)))) {
    const orgsResult = unwrap(
      await invokeE2E("listAgentOrgs"),
      `listAgentOrgs for ${agentOrgId}`
    );
    const targetOrg = (orgsResult.orgs ?? []).find(
      (org) => org.id === agentOrgId
    );
    if (targetOrg?.name) {
      const typeResult = await execJS(
        js.inputValue('[data-spotlight-input="true"]', targetOrg.name)
      );
      if (typeResult !== "typed") {
        throw new Error(
          `Spotlight search input rejected org name filter: ${typeResult}`
        );
      }
    }
  }
  await browser.waitUntil(async () => execJS(js.exists(optionSelector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: `Agent Org option ${agentOrgId} never rendered`,
  });
  const clickResult = await execJS(js.click(optionSelector));
  if (clickResult !== "clicked") {
    throw new Error(
      `Agent Org option ${agentOrgId} did not click: ${clickResult}`
    );
  }
  const selection = unwrap(
    await invokeE2E("inspectCreatorSelection"),
    `inspectCreatorSelection(${agentOrgId})`
  ).creator;
  if (selection.selectedAgentOrgId !== agentOrgId) {
    throw new Error(
      `Agent Org selector mismatch for ${agentOrgId}: ${JSON.stringify(selection)}`
    );
  }
}

export async function selectRenderedDefaultAgentOrg() {
  await selectRenderedAgentOrg(DEFAULT_AGENT_ORG_ID);
}

export async function selectRenderedOrgMemberAgentDefinition({
  memberId,
  agentDefinitionId,
  expectedText,
  label,
}) {
  const panelSelector = '[data-testid="session-creator-org-members-panel"]';
  const toggleSelector = '[data-testid="session-creator-org-members-toggle"]';
  if (!(await execJS(js.exists(panelSelector)))) {
    const toggleClick = await execJS(js.visibleClick(toggleSelector));
    if (toggleClick !== "clicked") {
      throw new Error(
        `Org members toggle did not click for ${label}: ${toggleClick}`
      );
    }
  }
  await browser.waitUntil(async () => execJS(js.exists(panelSelector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: `Org members panel never rendered for ${label}`,
  });

  const memberState = await execJS(`
    const row = Array.from(document.querySelectorAll('[data-testid="session-creator-org-member-row"]')).find(
      (candidate) => candidate.getAttribute('data-member-id') === ${JSON.stringify(memberId)}
    );
    if (!row) {
      return {
        found: false,
        rows: Array.from(document.querySelectorAll('[data-testid="session-creator-org-member-row"]')).map((candidate) => ({
          memberId: candidate.getAttribute('data-member-id'),
          text: candidate.textContent || '',
        })),
      };
    }
    const pill = row.querySelector('[data-testid="session-creator-org-member-agent-pill"]');
    if (!pill) return { found: true, clicked: false, reason: 'missing-agent-pill' };
    pill.scrollIntoView({ block: 'center', inline: 'center' });
    pill.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    pill.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    pill.click();
    return { found: true, clicked: true, text: row.textContent || '' };
  `);
  if (!memberState?.clicked) {
    throw new Error(
      `Org member agent pill did not click for ${label}: ${JSON.stringify(memberState)}`
    );
  }

  const optionSelector = `[data-testid="session-creator-agent-option-def-${agentDefinitionId}"]`;
  let renderedOptions = [];
  await browser.waitUntil(
    async () => {
      renderedOptions = await execJS(`
        return Array.from(document.querySelectorAll('[data-testid^="session-creator-agent-option-"]')).map((element) => ({
          testId: element.getAttribute('data-testid'),
          text: element.textContent || '',
        }));
      `);
      return renderedOptions.some(
        (option) =>
          option.testId ===
          `session-creator-agent-option-def-${agentDefinitionId}`
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `Org member AgentDefinition option ${agentDefinitionId} never rendered for ${label}: ${JSON.stringify(renderedOptions)}`,
    }
  );
  const cliOptions = renderedOptions.filter((option) =>
    option.testId?.startsWith("session-creator-agent-option-cli-")
  );
  if (cliOptions.length > 0) {
    throw new Error(
      `Agent Org member picker exposed unsupported CLI agents for ${label}: ${JSON.stringify(cliOptions)}`
    );
  }
  const optionClick = await execJS(js.visibleClick(optionSelector));
  if (optionClick !== "clicked") {
    throw new Error(
      `Org member AgentDefinition option did not click for ${label}: ${optionClick}`
    );
  }

  await browser.waitUntil(
    async () => {
      const rowText = await execJS(`
        const row = Array.from(document.querySelectorAll('[data-testid="session-creator-org-member-row"]')).find(
          (candidate) => candidate.getAttribute('data-member-id') === ${JSON.stringify(memberId)}
        );
        return row ? (row.textContent || '') : '';
      `);
      return String(rowText).includes(expectedText ?? agentDefinitionId);
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `Org member row did not reflect AgentDefinition override for ${label}`,
    }
  );
}

export async function sendRenderedChatPrompt(prompt) {
  const inputSelector = '[data-testid="chat-input"] [contenteditable="true"]';
  console.log("[agent-org-send] waiting for chat input");
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: MOUNT_TIMEOUT_MS,
    timeoutMsg: `chat input (${inputSelector}) never mounted`,
  });
  console.log("[agent-org-send] chat input mounted, typing");
  const typeResult = await execJS(js.type(inputSelector, prompt));
  if (typeResult !== "typed") {
    throw new Error(`chat input did not accept typed prompt: ${typeResult}`);
  }
  await browser.pause(300);
  const editorText = await execJS(js.editorText(inputSelector));
  if (!String(editorText ?? "").includes(prompt)) {
    throw new Error(`chat input text mismatch: ${editorText}`);
  }
  console.log("[agent-org-send] typed, waiting for send button");
  await browser.waitUntil(
    async () => {
      const sendState = await execJS(js.sendState);
      return sendState?.state === "submit" && !sendState.disabled;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `chat-send-button never became ready: ${JSON.stringify(await execJS(js.sendState))}`,
    }
  );
  console.log("[agent-org-send] send button ready, clicking");
  const clickResult = await execJS(`
    const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
      const rect = inputShell.getBoundingClientRect();
      const style = window.getComputedStyle(inputShell);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const activeInputShell = visibleInputShells[visibleInputShells.length - 1] ?? null;
    const button = activeInputShell?.querySelector('[data-testid="chat-send-button"]') ?? null;
    if (!button) return "missing";
    if (button.disabled) return "disabled";
    button.scrollIntoView({ block: "center", inline: "center" });
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    button.click();
    return "clicked";
  `);
  if (clickResult !== "clicked") {
    throw new Error(
      `chat-send-button did not click: ${clickResult} ${JSON.stringify(await execJS(js.sendState))}`
    );
  }
}

export async function waitForRenderedGroupChatActive(label) {
  const triggerSelector = '[data-testid="agent-org-member-switcher-trigger"]';
  await browser.waitUntil(
    async () => {
      const triggerLabel = await execJS(`
        const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
        return trigger ? (trigger.textContent || "") : "";
      `);
      return String(triggerLabel).toLowerCase().includes("group");
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `group chat view did not become active for ${label}`,
    }
  );
}

export async function assertRenderedGroupChatComposerResponsive(label) {
  // Since cfe19aab ("align Stop with Cursor queue semantics") the composer
  // intentionally shows Stop while a run is active — typed sends queue as
  // non-interrupting inbox messages and Stop is the explicit interrupt.
  // The pin is therefore NOT "no Stop"; it is "the composer is never in
  // the disabled dead-end" (button missing or working-cannot-stop).
  await waitForRenderedGroupChatActive(label);
  const state = await execJS(`
    const inputShell = document.querySelector('[data-chat-input-shell]');
    const sendButton = inputShell?.querySelector('[data-testid="chat-send-button"]') ?? null;
    return {
      present: !!sendButton,
      sendState: sendButton?.getAttribute('data-state') ?? null,
      sendDisabled: sendButton?.hasAttribute('disabled') ?? null,
    };
  `);
  if (!state.present || state.sendDisabled === true) {
    throw new Error(
      `group chat composer not responsive for ${label}: ${JSON.stringify(state)}`
    );
  }
}

export async function assertAgentOrgOverviewHasRunControl(label) {
  await openAgentOrgOverviewPanel(label);
  const state = await execJS(`
    return {
      overviewPause: Boolean(document.querySelector('[data-testid="agent-org-overview-pause-button"]')),
      overviewResume: Boolean(document.querySelector('[data-testid="agent-org-overview-resume-button"]')),
    };
  `);
  if (!state.overviewPause && !state.overviewResume) {
    throw new Error(
      `Agent Org overview did not expose Pause/Resume for ${label}: ${JSON.stringify(state)}`
    );
  }
}

export async function openRenderedGroupChatView() {
  const triggerSelector = '[data-testid="agent-org-member-switcher-trigger"]';
  const toggleSelector = '[data-testid="agent-org-group-chat-toggle"]';
  await browser.waitUntil(async () => execJS(js.exists(triggerSelector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: "agent org member switcher trigger never mounted",
  });
  const initialLabel = await execJS(`
    const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
    return trigger ? (trigger.textContent || "") : "";
  `);
  if (String(initialLabel).toLowerCase().includes("group")) return;

  const triggerClick = await execJS(js.visibleClick(triggerSelector));
  if (triggerClick !== "clicked") {
    throw new Error(`member switcher trigger did not click: ${triggerClick}`);
  }
  await browser.waitUntil(async () => execJS(js.exists(toggleSelector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: "group chat toggle never appeared in member switcher",
  });
  const toggleClick = await execJS(js.visibleClick(toggleSelector));
  if (toggleClick !== "clicked") {
    throw new Error(`group chat toggle did not click: ${toggleClick}`);
  }
  await waitForRenderedGroupChatActive("manual open");
}

export async function assertRenderedGroupChatToggleIsIdempotent(
  sessionId,
  label
) {
  const triggerSelector = '[data-testid="agent-org-member-switcher-trigger"]';
  const toggleSelector = '[data-testid="agent-org-group-chat-toggle"]';
  const triggerClick = await execJS(js.visibleClick(triggerSelector));
  if (triggerClick !== "clicked") {
    throw new Error(
      `member switcher trigger did not click for ${label}: ${triggerClick}`
    );
  }
  await browser.waitUntil(async () => execJS(js.exists(toggleSelector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: `group chat toggle never appeared for ${label}`,
  });
  const toggleClick = await execJS(js.visibleClick(toggleSelector));
  if (toggleClick !== "clicked") {
    throw new Error(
      `active group chat toggle did not click for ${label}: ${toggleClick}`
    );
  }
  await browser.waitUntil(
    async () => {
      const activeSessionId = unwrap(
        await invokeE2E("getActiveSessionId"),
        `getActiveSessionId(${label})`
      ).sessionId;
      const triggerLabel = await execJS(`
        const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
        return trigger ? (trigger.textContent || "") : "";
      `);
      return (
        activeSessionId === sessionId &&
        String(triggerLabel).toLowerCase().includes("group")
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `clicking active group chat switched away for ${label}`,
    }
  );
}

export async function waitForRenderedGroupChatMessage({
  sender,
  recipient,
  text,
  label,
  timeout = RENDER_TIMEOUT_MS,
}) {
  let state = null;
  await browser.waitUntil(
    async () => {
      try {
        state = await execJS(`
          const messages = Array.from(document.querySelectorAll('[data-testid="agent-org-group-chat-message"]'));
          return {
            groupChatMessageCount: messages.length,
            groupChatText: document.querySelector('[data-testid="agent-org-group-chat"]')?.textContent || '',
            bodyText: document.body?.textContent?.slice(0, 1200) || '',
            messages: messages.map((element) => ({
              sender: element.getAttribute('data-sender-name') || '',
              recipient: element.getAttribute('data-recipient-name') || '',
              text: element.textContent || '',
            })),
          };
        `);
      } catch (err) {
        state = { error: String(err?.message || err) };
        return false;
      }
      return (state?.messages ?? []).some((message) => {
        const senderMatches = !sender || message.sender === sender;
        const recipientMatches =
          !recipient ||
          message.recipient === recipient ||
          message.text.includes(`@${recipient}`) ||
          message.text.includes(`@ ${recipient}`);
        const mentionMatches = !recipient || recipientMatches;
        return (
          senderMatches &&
          recipientMatches &&
          mentionMatches &&
          message.text.includes(text)
        );
      });
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `rendered group chat message did not appear for ${label}: ${JSON.stringify(state)}`,
    }
  );
}

function normalizeRenderedText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function waitForRenderedGroupChatUserTurn({ text, label }) {
  let state = null;
  const normalizedExpectedText = normalizeRenderedText(text);
  try {
    await browser.waitUntil(
      async () => {
        try {
          state = await execJS(`
            const userHeaders = Array.from(document.querySelectorAll('[data-testid="chat-message-user-editable"], [data-testid="chat-message-user"]')).map((element) => ({
              text: element.textContent || '',
            }));
            const userBubbles = Array.from(document.querySelectorAll('[data-testid="agent-org-group-chat-message"][data-sender-name="User"]')).map((element) => ({
              text: element.textContent || '',
              recipient: element.getAttribute('data-recipient-name') || '',
            }));
            const groupChatText = document.querySelector('[data-testid="agent-org-group-chat"]')?.textContent || '';
            const historyText = document.querySelector('[data-testid="chat-message-list"]')?.textContent || '';
            return {
              userHeaders,
              userBubbles,
              groupChatText,
              historyText,
              bodyText: document.body?.textContent?.slice(0, 1600) || '',
            };
          `);
        } catch (err) {
          state = { error: String(err?.message || err) };
          return false;
        }
        const textSurfaces = [
          ...(state?.userHeaders ?? []).map((row) => String(row.text ?? "")),
          String(state?.groupChatText ?? ""),
          String(state?.historyText ?? ""),
        ];
        return textSurfaces.some((surface) =>
          normalizeRenderedText(surface).includes(normalizedExpectedText)
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `rendered group chat user turn did not appear for ${label}`,
      }
    );
  } catch (_err) {
    throw new Error(
      `rendered group chat user turn did not appear for ${label}: ${JSON.stringify(state)}`
    );
  }
  const duplicateBubble = (state?.userBubbles ?? []).find((row) =>
    normalizeRenderedText(row.text).includes(normalizedExpectedText)
  );
  if (duplicateBubble) {
    throw new Error(
      `group chat user message rendered as bubble instead of turn header for ${label}: ${JSON.stringify(state)}`
    );
  }
}

export async function assertRenderedGroupChatNoQuoteOrUnreadPreview(label) {
  const state = await execJS(`
    const suspiciousSelectors = [
      '[data-testid*="quote"]',
      '[data-testid*="unread"]',
      '[class*="agent-org-group-chat-flash"]',
      '[data-testid="agent-org-group-chat-message"][data-sender-name="User"]'
    ];
    return {
      matches: suspiciousSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)).map((element) => ({
          selector,
          testId: element.getAttribute('data-testid') || '',
          className: element.getAttribute('class') || '',
          senderName: element.getAttribute('data-sender-name') || '',
          text: element.textContent || '',
        }))
      ),
      groupChatText: document.querySelector('[data-testid="agent-org-group-chat"]')?.textContent || '',
    };
  `);
  if ((state?.matches ?? []).length > 0) {
    throw new Error(
      `quote/unread/user-bubble group chat UI should not render for ${label}: ${JSON.stringify(state)}`
    );
  }
}

async function assertTurnPageListShowsPreview(previewSnippet, label) {
  const triggerSelector = '[data-testid="turn-pagination-current-round"]';
  await browser.waitUntil(async () => execJS(js.exists(triggerSelector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: `turn pagination trigger missing for ${label}`,
  });
  const openClick = await execJS(js.visibleClick(triggerSelector));
  if (openClick !== "clicked") {
    throw new Error(
      `turn pagination trigger did not click for ${label}: ${openClick}`
    );
  }
  let state = null;
  await browser.waitUntil(
    async () => {
      try {
        state = await execJS(`
          const isVisible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const buttons = Array.from(document.querySelectorAll('button'))
            .filter(isVisible)
            .map((button) => ({ text: button.textContent || '' }));
          return {
            rows: buttons.filter((button) => button.text.trim().startsWith('#')),
            bodyText: document.body?.textContent?.slice(0, 1600) ?? "",
          };
        `);
      } catch (err) {
        state = { error: String(err?.message || err) };
        return false;
      }
      return (state?.rows ?? []).some((row) =>
        String(row.text ?? "").includes(previewSnippet)
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `turn page list did not show preview for ${label}: ${JSON.stringify(state)}`,
    }
  );
  const matchingRows = (state?.rows ?? []).filter((row) =>
    String(row.text ?? "").includes(previewSnippet)
  );
  if (matchingRows.length !== 1) {
    throw new Error(
      `turn page list rendered duplicate preview rows for ${label}: ${JSON.stringify(state)}`
    );
  }
  const brokenRow = (state?.rows ?? []).find((row) => {
    const text = String(row.text ?? "").trim();
    return text.startsWith("#") && /^#\d+\s+Round \d+\s*$/.test(text);
  });
  if (brokenRow) {
    throw new Error(
      `turn page list rendered fallback-only row for ${label}: ${JSON.stringify(state)}`
    );
  }
  const closeClick = await execJS(
    js.visibleClick('[title="Close"], [aria-label="Close"]')
  );
  if (closeClick !== "clicked" && closeClick !== "missing") {
    throw new Error(`turn page list close failed for ${label}: ${closeClick}`);
  }
}

async function waitForAgentOrgMentionMenuOption(memberName, label) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const menu = document.querySelector('.context-menu');
        const options = Array.from(document.querySelectorAll('[data-testid="agent-org-mention-option"]'));
        return {
          menuText: menu?.textContent || '',
          options: options.map((option) => ({
            text: option.textContent || '',
            mentionId: option.getAttribute('data-mention-id') || '',
          })),
        };
      `);
      const hasMember = (state?.options ?? []).some((option) =>
        String(option.text ?? "").includes(memberName)
      );
      const hasNormalContextEntry = String(state?.menuText ?? "").includes(
        "Files & Folders"
      );
      return hasMember && hasNormalContextEntry;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `Agent Org mention menu did not include both member and normal context options for ${label}: ${JSON.stringify(state)}`,
    }
  );
}

export async function sendRenderedGroupChatMentionPrompt(
  memberName,
  message,
  label
) {
  const inputSelector = '[data-testid="chat-input"] [contenteditable="true"]';
  const messageInsertion = ` ${message}`;
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: MOUNT_TIMEOUT_MS,
    timeoutMsg: `chat input (${inputSelector}) never mounted for ${label}`,
  });
  const clearResult = await execJS(js.type(inputSelector, ""));
  if (clearResult !== "typed") {
    throw new Error(`chat input did not clear for ${label}: ${clearResult}`);
  }
  await browser.keys("@");
  await waitForAgentOrgMentionMenuOption(memberName, label);
  const clickResult = await execJS(`
    const options = Array.from(document.querySelectorAll('[data-testid="agent-org-mention-option"]'));
    const option = options.find((candidate) => (candidate.textContent || '').includes(${JSON.stringify(memberName)}));
    if (!option) return "missing";
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    option.click();
    return "clicked";
  `);
  if (clickResult !== "clicked") {
    throw new Error(
      `Agent Org mention option click failed for ${label}: ${clickResult}`
    );
  }
  const appendState = await execJS(`
    const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
      const rect = inputShell.getBoundingClientRect();
      const style = window.getComputedStyle(inputShell);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const shellWithMemberPill = visibleInputShells.find((inputShell) => {
      const pill = inputShell.querySelector('[data-composer-pill="true"][data-icon-type="member"]');
      return (pill?.getAttribute('data-file-name') || '') === ${JSON.stringify(memberName)};
    }) ?? null;
    const activeInputShell = shellWithMemberPill ?? visibleInputShells[visibleInputShells.length - 1] ?? null;
    const editor = activeInputShell?.querySelector('[contenteditable="true"]') ?? null;
    if (!activeInputShell || !editor) return { status: "missing" };
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand("insertText", false, ${JSON.stringify(messageInsertion)});
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(messageInsertion)} }));
    const pill = activeInputShell.querySelector('[data-composer-pill="true"][data-icon-type="member"]');
    return {
      status: ok ? "typed" : "insert-failed",
      shellIndex: visibleInputShells.indexOf(activeInputShell),
      shellCount: visibleInputShells.length,
      editorText: editor.textContent || '',
      memberPillState: pill ? {
        fileName: pill.getAttribute('data-file-name') || '',
        filePath: pill.getAttribute('data-file-path') || '',
        text: pill.textContent || '',
      } : null,
    };
  `);
  if (appendState?.status !== "typed") {
    throw new Error(
      `group chat mention message append failed for ${label}: ${JSON.stringify(appendState)}`
    );
  }
  if (
    appendState.memberPillState?.fileName !== memberName ||
    !String(appendState.memberPillState?.filePath ?? "").startsWith(
      "member://"
    ) ||
    !String(appendState.editorText ?? "").includes(message)
  ) {
    throw new Error(
      `group chat mention editor pill mismatch for ${label}: ${JSON.stringify(appendState)}`
    );
  }
  let targetSendState = null;
  await browser.waitUntil(
    async () => {
      targetSendState = await execJS(`
        const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
          const rect = inputShell.getBoundingClientRect();
          const style = window.getComputedStyle(inputShell);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        });
        const shell = visibleInputShells.find((inputShell) => {
          const pill = inputShell.querySelector('[data-composer-pill="true"][data-icon-type="member"]');
          return (pill?.getAttribute('data-file-name') || '') === ${JSON.stringify(memberName)};
        }) ?? null;
        const button = shell?.querySelector('[data-testid="chat-send-button"]') ?? null;
        return button ? {
          shellIndex: visibleInputShells.indexOf(shell),
          shellCount: visibleInputShells.length,
          state: button.getAttribute("data-state"),
          disabled: button.disabled,
          editorText: shell.querySelector('[contenteditable="true"]')?.textContent || '',
        } : null;
      `);
      return targetSendState?.state === "submit" && !targetSendState.disabled;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `chat-send-button never became ready for ${label}: ${JSON.stringify(targetSendState)}`,
    }
  );
  const sendClickResult = await execJS(`
    const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
      const rect = inputShell.getBoundingClientRect();
      const style = window.getComputedStyle(inputShell);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const shell = visibleInputShells.find((inputShell) => {
      const pill = inputShell.querySelector('[data-composer-pill="true"][data-icon-type="member"]');
      return (pill?.getAttribute('data-file-name') || '') === ${JSON.stringify(memberName)};
    }) ?? null;
    const button = shell?.querySelector('[data-testid="chat-send-button"]') ?? null;
    if (!button) return "missing";
    if (button.disabled) return "disabled";
    button.scrollIntoView({ block: "center", inline: "center" });
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    button.click();
    return "clicked";
  `);
  if (sendClickResult !== "clicked") {
    throw new Error(
      `chat-send-button did not click for ${label}: ${sendClickResult}`
    );
  }
  let afterClickState = null;
  try {
    await browser.waitUntil(
      async () => {
        afterClickState = await execJS(`
          const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
            const rect = inputShell.getBoundingClientRect();
            const style = window.getComputedStyle(inputShell);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          });
          const shells = visibleInputShells.map((inputShell, index) => {
            const pill = inputShell.querySelector('[data-composer-pill="true"][data-icon-type="member"]');
            const editor = inputShell.querySelector('[contenteditable="true"]');
            const button = inputShell.querySelector('[data-testid="chat-send-button"]');
            return {
              index,
              editorText: editor?.textContent || '',
              pillFileName: pill?.getAttribute('data-file-name') || '',
              pillPath: pill?.getAttribute('data-file-path') || '',
              sendState: button?.getAttribute('data-state') || null,
              disabled: button ? Boolean(button.disabled) : null,
            };
          });
          const pending = document.querySelector('[data-testid="agent-org-group-chat-pending"]');
          return {
            shells,
            pendingText: pending?.textContent || '',
            bodyText: document.body?.textContent?.slice(0, 1200) ?? '',
          };
        `);
        return (afterClickState?.shells ?? []).every(
          (shell) => !String(shell.editorText ?? "").includes(message)
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `group chat mention submit did not clear composer for ${label}`,
      }
    );
  } catch (_err) {
    throw new Error(
      `group chat mention submit did not clear composer for ${label}: ${JSON.stringify(afterClickState)}`
    );
  }
}

export async function waitForGroupChatPendingTarget(targetName, label) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const element = document.querySelector('[data-testid="agent-org-group-chat-pending"]');
        return element ? {
          target: element.getAttribute('data-target-name') || '',
          text: element.textContent || '',
        } : null;
      `);
      return (
        state?.target === targetName &&
        String(state?.text ?? "").includes(targetName) &&
        String(state?.text ?? "")
          .toLowerCase()
          .includes("message")
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `group chat pending target did not render for ${label}: ${state}`,
    }
  );
}

export async function waitForGroupChatPausedBanner(label) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const banner = document.querySelector('[data-testid="agent-org-group-chat-paused-banner"]');
        const resume = document.querySelector('[data-testid="agent-org-group-chat-resume-button"]');
        return {
          bannerText: banner ? (banner.textContent || '') : '',
          resumeVisible: Boolean(resume),
          resumeDisabled: resume ? Boolean(resume.disabled) : null,
        };
      `);
      const text = String(state?.bannerText ?? "").toLowerCase();
      return (
        text.includes("new work is paused") &&
        text.includes("pause stops active replies") &&
        state?.resumeVisible === true &&
        state?.resumeDisabled === false
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `group chat paused banner did not render for ${label}: ${JSON.stringify(state)}`,
    }
  );
}

export async function clickGroupChatResumeButton(label) {
  const clickResult = await execJS(
    js.click('[data-testid="agent-org-group-chat-resume-button"]')
  );
  if (clickResult !== "clicked") {
    throw new Error(
      `group chat Resume click failed for ${label}: ${clickResult}`
    );
  }
}

export async function sendFromRenderedCreator(prompt) {
  console.log(`[agent-org-send] begin prompt=${prompt.slice(0, 80)}`);
  const previousSessionId = unwrap(
    await invokeE2E("getActiveSessionId"),
    "getActiveSessionId(before creator send)"
  ).sessionId;
  console.log(`[agent-org-send] before previousSessionId=${previousSessionId}`);
  await sendRenderedChatPrompt(prompt);
  console.log("[agent-org-send] clicked send, waiting for new active session");
  let activeSessionId = null;
  await browser.waitUntil(
    async () => {
      activeSessionId = unwrap(
        await invokeE2E("getActiveSessionId"),
        "getActiveSessionId(after creator send)"
      ).sessionId;
      return (
        (await execJS(js.mode)) === "chat" &&
        activeSessionId &&
        activeSessionId !== previousSessionId
      );
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: `session never transitioned to a new chat view; previous=${previousSessionId} active=${activeSessionId}`,
    }
  );
  console.log(`[agent-org-send] activeSessionId=${activeSessionId}`);
  return activeSessionId;
}

export async function openRenderedSidebarSession(sessionId) {
  const selector = `[data-testid="sidebar-session-item-${sessionId}"]`;
  await browser.waitUntil(async () => execJS(js.exists(selector)), {
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: `Sidebar session ${sessionId} did not appear`,
  });
  const clickResult = await execJS(js.visibleClick(selector));
  if (clickResult !== "clicked") {
    throw new Error(
      `Sidebar session ${sessionId} did not click: ${clickResult}`
    );
  }
  await browser.waitUntil(
    async () => {
      const activeSessionId = unwrap(
        await invokeE2E("getActiveSessionId"),
        "getActiveSessionId(after sidebar open)"
      ).sessionId;
      const mode = await execJS(js.mode);
      return activeSessionId === sessionId && mode === "chat";
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `Sidebar session ${sessionId} did not become active chat`,
    }
  );
}

export async function assertCrashRecoveryBannerAbsent(label) {
  const bannerVisible = await execJS(
    `return document.body.textContent.includes("Session interrupted");`
  );
  if (bannerVisible) {
    throw new Error(`Crash recovery banner appeared for ${label}`);
  }
}

function coordinatorRuntimeStatus(view) {
  const coordinator = view?.members?.find(
    (member) => member.memberId === AGENT_ORG_COORDINATOR_MEMBER_ID
  );
  return coordinator?.sessionRuntime?.status ?? null;
}

export async function waitForCoordinatorRuntimeStatus(
  sessionId,
  predicate,
  label
) {
  let latestView = null;
  await waitForAgentOrgRunView(
    sessionId,
    (view) => {
      latestView = view;
      return predicate(coordinatorRuntimeStatus(view), view);
    },
    label
  );
  return latestView;
}

export async function waitForRenderedAssistantReply(label) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const assistantRows = Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]'));
        const groupChatRows = Array.from(document.querySelectorAll('[data-testid="agent-org-group-chat-message"]'));
        const userRows = Array.from(document.querySelectorAll('[data-testid="chat-message-user-editable"]'));
        const assistantTexts = assistantRows.map((row) => row.textContent || "");
        const groupChatAssistantTexts = groupChatRows
          .filter((row) => (row.getAttribute('data-sender-name') || '') !== 'User')
          .map((row) => row.textContent || "");
        return {
          assistantTexts: [...assistantTexts, ...groupChatAssistantTexts].filter((text) => text.trim().length > 0),
          userTexts: userRows.map((row) => row.textContent || ""),
          historyText: document.querySelector('[data-testid="chat-message-list"]')?.textContent || "",
          groupChatText: document.querySelector('[data-testid="agent-org-group-chat"]')?.textContent || "",
        };
      `);
      return state.assistantTexts.some((text) => text.trim().length > 0);
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 1000,
      timeoutMsg: `No rendered assistant reply appeared for ${label}: ${JSON.stringify(state)}`,
    }
  );
}

export async function waitForAgentOrgRunViewByOrg(orgId, predicate, label) {
  let latestState = null;
  try {
    await browser.waitUntil(
      async () => {
        const allRuns = unwrap(
          await invokeE2E("agentOrgRunList", 100),
          `agentOrgRunList(${label})`
        ).runs;
        const runs = allRuns.filter(
          (run) => run?.orgId === orgId && run?.rootSessionId
        );
        latestState = { orgId, allRuns, matchingRuns: runs, viewAttempts: [] };
        for (const run of runs) {
          const view = unwrap(
            await invokeE2E("agentOrgSessionRunView", run.rootSessionId),
            `agentOrgSessionRunView(${label}:${run.rootSessionId})`
          ).view;
          latestState.viewAttempts.push({ run, view });
          if (view && predicate(view, run)) {
            latestState = { orgId, run, view };
            return true;
          }
        }
        return false;
      },
      {
        timeout: PERSIST_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `Agent Org run view did not match ${label}`,
      }
    );
  } catch (err) {
    throw new Error(
      `Agent Org run view did not match ${label}: ${JSON.stringify(latestState)}`
    );
  }
  return latestState;
}

export async function waitForAgentOrgRunView(
  sessionId,
  predicate,
  label,
  timeout = PERSIST_TIMEOUT_MS
) {
  let latestState = null;
  try {
    await traceSlowWait(`Agent Org run view: ${label}`, () =>
      browser.waitUntil(
        async () => {
          const runViewResult = unwrap(
            await invokeE2E("agentOrgSessionRunView", sessionId),
            `agentOrgSessionRunView(${label})`
          );
          const activeSessionResult = await invokeE2E("getActiveSessionId");
          latestState = {
            sessionId,
            activeSessionId: activeSessionResult?.sessionId ?? null,
            view: runViewResult.view,
          };
          return Boolean(runViewResult.view && predicate(runViewResult.view));
        },
        {
          timeout,
          interval: 500,
          timeoutMsg: `Agent Org run view did not match ${label}`,
        }
      )
    );
  } catch (_err) {
    const runListResult = await invokeE2E("agentOrgRunList", 10);
    throw new Error(
      `Agent Org run view did not match ${label}: ${JSON.stringify({
        ...latestState,
        runs: runListResult?.runs ?? null,
      })}`
    );
  }
  return latestState.view;
}

export async function waitForInboxRow(sessionId, predicate, label) {
  let latestRow = null;
  await waitForAgentOrgRunView(
    sessionId,
    (view) => {
      latestRow = (view?.inbox ?? []).find((row) => predicate(row)) ?? null;
      return Boolean(latestRow);
    },
    label
  );
  return latestRow;
}

export async function waitForInboxRowRead(
  sessionId,
  rowId,
  label,
  timeout = PERSIST_TIMEOUT_MS
) {
  let latestRow = null;
  await waitForAgentOrgRunView(
    sessionId,
    (view) => {
      latestRow = (view?.inbox ?? []).find((row) => row.id === rowId) ?? null;
      return Boolean(latestRow?.readAt);
    },
    label,
    timeout
  );
  return latestRow;
}

export async function waitForMemberPostMessageActivity(
  sessionId,
  memberId,
  baselineUpdatedAt,
  label,
  timeout = PERSIST_TIMEOUT_MS
) {
  let latestMember = null;
  await waitForAgentOrgRunView(
    sessionId,
    (view) => {
      latestMember = (view?.members ?? []).find(
        (member) => member.memberId === memberId
      );
      const updatedAt = latestMember?.sessionRuntime?.updatedAt ?? null;
      return Boolean(updatedAt && updatedAt > baselineUpdatedAt);
    },
    label,
    timeout
  );
  return latestMember;
}

export async function waitForSessionAggregateRow(sessionId, predicate, label) {
  let latestSession = null;
  await browser.waitUntil(
    async () => {
      const result = await invokeE2E("getSessionAggregateRow", sessionId);
      if (!result?.ok) return false;
      latestSession = result.session;
      return Boolean(latestSession && predicate(latestSession));
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `Session aggregate row did not match ${label}: ${JSON.stringify(latestSession)}`,
    }
  );
  return latestSession;
}

export async function waitForActiveSessionExecMode(
  sessionId,
  expectedMode,
  label
) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = unwrap(
        await invokeE2E("inspectChatState"),
        `inspectChatState(${label})`
      );
      return (
        state.activeSessionId === sessionId &&
        state.activeSession?.agentExecMode === expectedMode
      );
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `session row did not persist ${expectedMode} mode for ${label}: ${JSON.stringify(state)}`,
    }
  );
}

export function parseInboxPayload(row, label) {
  try {
    return JSON.parse(String(row?.payloadJson ?? "{}"));
  } catch (err) {
    throw new Error(
      `failed to parse inbox payload for ${label}: ${String(err)} ${JSON.stringify(row)}`
    );
  }
}

export async function waitForSessionOrgRuntimeSnapshot(
  sessionId,
  predicate,
  label
) {
  let latest = null;
  try {
    await browser.waitUntil(
      async () => {
        const result = await invokeE2E(
          "debugSessionOrgRuntimeSnapshot",
          sessionId
        );
        if (!result?.ok) {
          latest = { ok: false, sessionId, error: result?.error ?? "unknown" };
          return false;
        }
        latest = { ok: true, sessionId, snapshot: result.snapshot ?? null };
        return Boolean(result.snapshot && predicate(result.snapshot));
      },
      {
        timeout: PERSIST_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `session org runtime snapshot did not match ${label}`,
      }
    );
  } catch (err) {
    throw new Error(
      `session org runtime snapshot did not match ${label}: ${JSON.stringify(latest)}: ${String(err)}`
    );
  }
  return latest.snapshot;
}

export async function sendCoordinatorOrgMessage(sessionId, params, label) {
  const result = unwrap(
    await invokeE2E(
      "debugSessionExecuteOrgTool",
      sessionId,
      "org_send_message",
      params
    ),
    `debugSessionExecuteOrgTool(org_send_message ${label})`
  ).result;
  if (result?.ok !== true) {
    throw new Error(
      `org_send_message ${label} failed: ${JSON.stringify(result)}`
    );
  }
  return result;
}

export async function assertNoMemberIntervention(sessionId, label) {
  const state = unwrap(
    await invokeE2E("agentOrgSessionInterventionState", sessionId),
    `agentOrgSessionInterventionState(${label})`
  ).state;
  if (state?.intervention) {
    throw new Error(
      `unexpected Agent Org member intervention during ${label}: ${JSON.stringify(state)}`
    );
  }
}

export async function executeCreatePlanAsMember(
  memberSessionId,
  title,
  content,
  label
) {
  const result = unwrap(
    await invokeE2E(
      "debugSessionExecuteOrgTool",
      memberSessionId,
      "create_plan",
      {
        title,
        content,
        new_plan: false,
      }
    ),
    `debugSessionExecuteOrgTool(create_plan ${label})`
  ).result;
  if (result?.ok !== true) {
    throw new Error(`create_plan ${label} failed: ${JSON.stringify(result)}`);
  }
  const text = String(result.result?.text ?? "");
  if (!text.includes("PLAN_SUBMITTED_END_TURN:")) {
    throw new Error(
      `create_plan ${label} did not submit plan: ${JSON.stringify(result)}`
    );
  }
  return result;
}

export async function waitForPlanApprovalRequest(
  sessionId,
  memberId,
  title,
  content,
  label
) {
  let requestRow = null;
  await browser.waitUntil(
    async () => {
      const view = unwrap(
        await invokeE2E("agentOrgSessionRunView", sessionId),
        `agentOrgSessionRunView(plan approval request ${label})`
      ).view;
      requestRow = (view?.inbox ?? []).find((row) => {
        const payload = parseInboxPayload(row, label);
        return (
          row.payloadKind === "plan_approval_request" &&
          row.senderMemberId === memberId &&
          row.recipientMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          payload.plan_title === title &&
          String(payload.plan_content ?? "").includes(content)
        );
      });
      return Boolean(requestRow);
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `plan approval request did not appear for ${label}: ${JSON.stringify(requestRow)}`,
    }
  );
  return requestRow;
}

export async function waitForPromptDump(sessionId) {
  let dump = null;
  await browser.waitUntil(
    async () => {
      const result = await invokeE2E("promptDump", sessionId);
      if (!result?.ok) return false;
      dump = result.dump;
      return Boolean(dump);
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      timeoutMsg: `promptDump never became available for ${sessionId}`,
    }
  );
  return dump;
}

export async function assertNoCurrentPlanBuildSurface(label) {
  const state = await execJS(`
    const currentCards = Array.from(document.querySelectorAll('[data-testid="create-plan-card"][data-plan-surface="current"]')).map((card) => ({
      ready: card.getAttribute('data-plan-ready'),
      status: card.getAttribute('data-plan-approval-status'),
      text: card.textContent || '',
      buildPresent: Boolean(card.querySelector('[data-testid="create-plan-build"]')),
    }));
    const currentBuildButtons = Array.from(document.querySelectorAll('[data-testid="create-plan-card"][data-plan-surface="current"] [data-testid="create-plan-build"]')).map((button) => ({
      disabled: Boolean(button.disabled),
      text: button.textContent || '',
    }));
    return { currentCards, currentBuildButtons };
  `);
  if ((state?.currentBuildButtons ?? []).length > 0) {
    throw new Error(
      `unexpected user-facing current plan Build surface during ${label}: ${JSON.stringify(state)}`
    );
  }
}

export async function assertRenderedInboxPinBarAbsent(label) {
  const state = await execJS(`
    const elements = Array.from(document.querySelectorAll('[data-testid^="agent-org-inbox-pin-bar"]')).map((element) => ({
      testId: element.getAttribute('data-testid') || '',
      text: element.textContent || '',
    }));
    return { elements };
  `);
  if ((state?.elements ?? []).length > 0) {
    throw new Error(
      `agent org inbox pin bar should not render for ${label}: ${JSON.stringify(state)}`
    );
  }
}

export async function openAgentOrgOverviewPanel(label) {
  let overviewState = null;
  await browser.waitUntil(
    async () => {
      overviewState = await execJS(`
        const panel = document.querySelector('[data-agent-org-overview-panel="true"]');
        if (panel) return { open: true, trigger: true };
        const trigger = document.querySelector('[data-agent-org-overview-trigger="true"]');
        if (!trigger) {
          return { open: false, trigger: false, bodyText: document.body?.textContent?.slice(0, 600) ?? "" };
        }
        trigger.click();
        return { open: Boolean(document.querySelector('[data-agent-org-overview-panel="true"]')), trigger: true };
      `);
      return overviewState?.open === true;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `Agent Org overview panel did not open for ${label}: ${JSON.stringify(overviewState)}`,
    }
  );
}

export async function ensureMemberHasSwitchableInbox(
  sessionId,
  memberId,
  label
) {
  await sendCoordinatorOrgMessage(
    sessionId,
    {
      recipient_member_id: memberId,
      kind: "plain",
      summary: `E2E switchable member ${RUN_ID}`,
      text: `E2E switchable member ${label} ${RUN_ID}`,
    },
    `make ${label} switchable`
  );
  await waitForAgentOrgRunView(
    sessionId,
    (view) => {
      const member = (view?.members ?? []).find(
        (candidate) => candidate.memberId === memberId
      );
      return Boolean(member?.inboxActivityCount > 0);
    },
    `${label} has inbox activity for switching`
  );
  await refreshRenderedAgentOrgOverview(`${label} switchable inbox refresh`);
}

export async function clickRenderedMemberSwitcher(memberId, expectedSessionId) {
  const optionSelector = `[data-testid="agent-org-member-switcher-option-${memberId}"]`;
  const startedAt = Date.now();
  let optionState = null;
  while (Date.now() - startedAt < RENDER_TIMEOUT_MS) {
    optionState = await execJS(`
      try {
        const optionSelector = ${JSON.stringify(optionSelector)};
        const option = document.querySelector(optionSelector);
        const trigger = document.querySelector('[data-testid="agent-org-member-switcher-trigger"]');
        const options = Array.from(document.querySelectorAll('[data-testid^="agent-org-member-switcher-option-"]')).map((candidate) => ({
          testId: candidate.getAttribute('data-testid'),
          disabled: Boolean(candidate.disabled),
          ariaDisabled: candidate.getAttribute('aria-disabled'),
          text: candidate.textContent || '',
        }));
        if (!option && trigger && !trigger.disabled) {
          trigger.click();
        }
        return {
          present: Boolean(option),
          disabled: Boolean(option?.disabled),
          ariaDisabled: option?.getAttribute('aria-disabled') || null,
          text: option?.textContent || "",
          triggerPresent: Boolean(trigger),
          triggerDisabled: Boolean(trigger?.disabled),
          triggerText: trigger?.textContent || "",
          options,
          bodyText: document.body?.textContent?.slice(0, 1200) ?? "",
        };
      } catch (error) {
        return { error: String(error && error.message || error) };
      }
    `);
    if (optionState?.present === true && optionState?.disabled !== true) {
      break;
    }
    await browser.pause(250);
  }
  if (optionState?.present !== true || optionState?.disabled === true) {
    throw new Error(
      `member switch option was not clickable: ${JSON.stringify(optionState)}`
    );
  }
  const clicked = await execJS(`
    const option = document.querySelector(${JSON.stringify(optionSelector)});
    if (!option || option.disabled) return false;
    option.click();
    return true;
  `);
  if (clicked !== true) {
    throw new Error(
      `member switch option click failed after option became clickable: ${JSON.stringify(optionState)}`
    );
  }
  await browser.waitUntil(
    async () => {
      const activeSessionId = unwrap(
        await invokeE2E("getActiveSessionId"),
        "getActiveSessionId(after member switch)"
      ).sessionId;
      return activeSessionId === expectedSessionId;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `member switch did not navigate to ${expectedSessionId}`,
    }
  );
}

export async function waitForIntervention(sessionId, memberId, label) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = unwrap(
        await invokeE2E("agentOrgSessionInterventionState", sessionId),
        `agentOrgSessionInterventionState(${label})`
      ).state;
      return state?.intervention?.memberId === memberId;
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `intervention did not appear for ${label}: ${JSON.stringify(state)}`,
    }
  );
  return state.intervention;
}

export async function waitForRenderedInterventionPin(memberId, label) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const element = document.querySelector('[data-testid="agent-org-intervention-pin-bar"]');
        if (!element) return { exists: false };
        return {
          exists: true,
          memberId: element.getAttribute('data-member-id') || '',
          text: element.textContent || '',
          hasReturnButton: !!element.querySelector('[data-testid="agent-org-return-to-work-button"]'),
        };
      `);
      return (
        state?.exists === true &&
        state.memberId === memberId &&
        state.hasReturnButton === true
      );
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `rendered intervention pin did not appear for ${label}: ${JSON.stringify(state)}`,
    }
  );
}

export async function refreshRenderedAgentOrgOverview(label) {
  await openAgentOrgOverviewPanel(label);
  const refreshState = await execJS(`
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const panels = Array.from(document.querySelectorAll('[data-agent-org-overview-panel="true"]')).filter(isVisible);
    const panel = panels[panels.length - 1] ?? null;
    const buttons = panel
      ? Array.from(panel.querySelectorAll('[data-testid="agent-org-overview-refresh-button"]'))
      : Array.from(document.querySelectorAll('[data-testid="agent-org-overview-refresh-button"]')).filter(isVisible);
    const button = buttons.find((candidate) => !candidate.disabled) ?? buttons[0] ?? null;
    if (!button) return { clicked: false, reason: "missing", panelCount: panels.length };
    button.click();
    return { clicked: true, panelCount: panels.length, buttonCount: buttons.length };
  `);
  if (refreshState?.clicked !== true) {
    throw new Error(
      `Agent Org overview refresh did not click for ${label}: ${JSON.stringify(refreshState)}`
    );
  }
}

export async function waitForRenderedReleasedTask(taskId, subject, label) {
  await refreshRenderedAgentOrgOverview(label);
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const row = document.querySelector('[data-testid="agent-org-overview-task-row"][data-task-id="${taskId}"]');
        if (!row) {
          return {
            exists: false,
            rows: Array.from(document.querySelectorAll('[data-testid="agent-org-overview-task-row"]')).map((candidate) => ({
              taskId: candidate.getAttribute('data-task-id') || '',
              status: candidate.getAttribute('data-task-status') || '',
              text: candidate.textContent || '',
            })),
          };
        }
        const owner = row.querySelector('[data-testid="agent-org-task-owner-meta"]');
        return {
          exists: true,
          status: row.getAttribute('data-task-status') || '',
          ownerMemberId: owner?.getAttribute('data-owner-member-id') || '',
          text: row.textContent || '',
        };
      `);
      return (
        state?.exists === true &&
        state.status === AGENT_ORG_TASK_STATUS.PENDING &&
        state.ownerMemberId === "" &&
        String(state.text ?? "").includes(subject)
      );
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `rendered released task did not match ${label}: ${JSON.stringify(state)}`,
    }
  );
}

export async function clickReturnToWorkAndWaitCleared(sessionId, label) {
  const clickState = await execJS(`
    const button = document.querySelector('[data-testid="agent-org-return-to-work-button"]');
    if (!button) return { clicked: false, reason: "missing" };
    if (button.disabled) return { clicked: false, reason: "disabled" };
    button.click();
    return { clicked: true };
  `);
  if (clickState?.clicked !== true) {
    throw new Error(
      `Return to work did not click for ${label}: ${JSON.stringify(clickState)}`
    );
  }

  let state = null;
  await browser.waitUntil(
    async () => {
      state = unwrap(
        await invokeE2E("agentOrgSessionInterventionState", sessionId),
        `agentOrgSessionInterventionState(clear ${label})`
      ).state;
      return !state?.intervention;
    },
    {
      timeout: PERSIST_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `intervention did not clear for ${label}: ${JSON.stringify(state)}`,
    }
  );
}

export async function createLongTaskPrecondition(
  sessionId,
  taskId,
  subject,
  memberId
) {
  const result = unwrap(
    await invokeE2E("debugSessionExecuteOrgTool", sessionId, "task_create", {
      id: taskId,
      subject,
      description: subject,
      owner_member_id: memberId,
      status: AGENT_ORG_TASK_STATUS.PENDING,
      dispatch_policy: "immediate",
      execution_mode: "build",
    }),
    "debugSessionExecuteOrgTool(long task precondition)"
  ).result;
  if (!result?.ok) {
    throw new Error(`long task precondition failed: ${JSON.stringify(result)}`);
  }
}

export async function assertLongTaskRenderedCollapsed(taskId, subject) {
  await openAgentOrgOverviewPanel("long task collapse");
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const row = document.querySelector('[data-testid="agent-org-overview-task-row"][data-task-id="${taskId}"]');
        if (!row) return { exists: false };
        const button = row.querySelector('button[aria-expanded]');
        return {
          exists: true,
          rowHeight: row.getBoundingClientRect().height,
          text: row.textContent || '',
          hasToggle: Boolean(button),
          expanded: button ? button.getAttribute('aria-expanded') : null,
          toggleTextHeight: button ? button.getBoundingClientRect().height : null,
        };
      `);
      return (
        state.exists === true &&
        state.hasToggle === true &&
        state.expanded === "false" &&
        state.rowHeight < 80 &&
        String(state.text).includes(subject.slice(0, 40))
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `long task row did not render collapsed: ${JSON.stringify(state)}`,
    }
  );
  const clickState = await execJS(`
    const row = document.querySelector('[data-testid="agent-org-overview-task-row"][data-task-id="${taskId}"]');
    const button = row?.querySelector('button[aria-expanded]');
    if (!row || !button) return { clicked: false, reason: "missing" };
    button.click();
    return { clicked: true };
  `);
  if (clickState?.clicked !== true) {
    throw new Error(
      `long task toggle did not click: ${JSON.stringify(clickState)}`
    );
  }

  let expandedState = null;
  await browser.waitUntil(
    async () => {
      expandedState = await execJS(`
        const row = document.querySelector('[data-testid="agent-org-overview-task-row"][data-task-id="${taskId}"]');
        const button = row?.querySelector('button[aria-expanded]');
        if (!row || !button) return { exists: false };
        return {
          exists: true,
          expanded: button.getAttribute('aria-expanded'),
          rowHeight: row.getBoundingClientRect().height,
          text: row.textContent || '',
        };
      `);
      return (
        expandedState.exists === true &&
        expandedState.expanded === "true" &&
        String(expandedState.text ?? "").includes(subject)
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `long task row did not expand correctly: ${JSON.stringify(expandedState)}`,
    }
  );
}

export async function assertNoFalseFinality(sessionId, runId, label) {
  const view = unwrap(
    await invokeE2E("agentOrgSessionRunView", sessionId),
    `agentOrgSessionRunView(finality ${label})`
  ).view;
  const runs = unwrap(
    await invokeE2E("agentOrgRunList", 50),
    "agentOrgRunList"
  ).runs;
  const run = runs.find(
    (candidate) => (candidate.id ?? candidate.runId) === runId
  );
  if (!run) {
    throw new Error(`run ${runId} missing for ${label}`);
  }
  const tasks = view?.tasks ?? [];
  const members = view?.members ?? [];
  const ownerlessInProgress = tasks.filter(
    (task) => task.status === AGENT_ORG_TASK_STATUS.IN_PROGRESS && !task.owner
  );
  if (ownerlessInProgress.length > 0) {
    throw new Error(
      `${label} has ownerless in_progress tasks: ${JSON.stringify(ownerlessInProgress)}`
    );
  }
  const openTasks = tasks.filter(
    (task) => task.status !== AGENT_ORG_TASK_STATUS.COMPLETED
  );
  const activeMembers = members.filter(
    (member) =>
      AGENT_SESSION_ACTIVE_STATUSES.has(member.sessionRuntime?.status ?? "") ||
      member.intervention?.status ===
        AGENT_ORG_INTERVENTION_STATUS.USER_INTERVENTION ||
      member.sessionRuntime?.intervention?.status ===
        AGENT_ORG_INTERVENTION_STATUS.USER_INTERVENTION
  );
  const unreadInbox = (view?.inbox ?? []).filter((row) => !row.readAt);
  if (
    openTasks.length > 0 &&
    activeMembers.length === 0 &&
    unreadInbox.length === 0
  ) {
    throw new Error(
      `${label} has stalled open work with no active member or unread wake: ${JSON.stringify({ run, openTasks, members })}`
    );
  }
}
