import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { e2eUrl } from "../e2eBaseUrl.mjs";
import {
  ensureAuthBypass as ensureBrowserAuthBypass,
  execJS,
  invokeE2E,
  unwrap,
} from "./e2eBrowserHelpers.mjs";

const MOUNT_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_REPLY_TIMEOUT_MS ?? "240000",
  10
);
const FIRST_TURN_TIMEOUT_MS = 60_000;
const QUEUE_TIMEOUT_MS = 20_000;
const CLAUDE_CODE_ACCOUNT_NAME = process.env.E2E_CLAUDE_CODE_ACCOUNT;
const CLAUDE_CODE_MODEL =
  process.env.E2E_CLAUDE_CODE_MODEL ?? "claude-sonnet-4-6";
const CODEX_ACCOUNT_NAME = process.env.E2E_CODEX_ACCOUNT;
const CODEX_MODEL = process.env.E2E_CODEX_MODEL ?? "gpt-5.5";
const CURSOR_NATIVE_ACCOUNT_NAME = process.env.E2E_CURSOR_NATIVE_ACCOUNT;
const CURSOR_NATIVE_MODEL =
  process.env.E2E_CURSOR_NATIVE_MODEL ?? "composer-2.5-fast";
const CURSOR_CLI_ACCOUNT_NAME = process.env.E2E_CURSOR_CLI_ACCOUNT;
const CURSOR_CLI_MODEL =
  process.env.E2E_CURSOR_CLI_MODEL ?? "composer-2.5-fast";
const API_ACCOUNT_NAME = process.env.E2E_OPENAI_ACCOUNT;
const API_MODEL = process.env.E2E_OPENAI_MODEL ?? "op-4.6-relay";
const API_AGENT_TYPE = process.env.E2E_API_AGENT_TYPE ?? "openai_api";
const GEMINI_ACCOUNT_NAME = process.env.E2E_GEMINI_ACCOUNT;
const DEFAULT_GEMINI_MODEL_CHAIN = [
  process.env.E2E_GEMINI_MODEL,
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-lite",
  "gemini-3-flash-lite-preview",
  "gemini-3-lite",
  "gemini-3-flash",
  "gemini-3.1-flash-preview",
  "gemini-3.1-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-pro",
  "gemini-3.1-pro-preview",
  "gemini-3-pro",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.0-pro",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro",
].filter(Boolean);
const CLAUDE_CODE_AGENT_TYPE = "claude_code";
const CODEX_AGENT_TYPE = "codex";
const CURSOR_AGENT_TYPE = "cursor_cli";
const GEMINI_AGENT_TYPE = "gemini_cli";
const RUST_AGENT_CATEGORY = "rust_agent";
const CLI_AGENT_CATEGORY = "cli_agent";
const CONTROL_LABEL_FILTER = (process.env.E2E_CONTROL_LABELS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const RUST_PLAN_LABELS = [
  "cursor-native-rust-agent",
  "claude-code-rust-agent",
  "codex-rust-agent",
  "gemini-rust-agent",
  "openai-api-rust-agent",
];
const CLI_PLAN_LABELS = [
  "claude-code-cli-agent",
  "codex-cli-agent",
  "cursor-cli-agent",
  "gemini-cli-agent",
];
const PLAN_CAPABLE_LABELS = [...RUST_PLAN_LABELS, ...CLI_PLAN_LABELS];
const GEMINI_MODEL_CHAIN = parseE2EChain(
  process.env.E2E_GEMINI_MODEL_CHAIN,
  DEFAULT_GEMINI_MODEL_CHAIN
);
const GEMINI_ACCOUNT_CHAIN = parseE2EChain(
  process.env.E2E_GEMINI_ACCOUNT_CHAIN,
  [GEMINI_ACCOUNT_NAME]
);
const CONTROL_SCENARIO_FILTER = (process.env.E2E_CONTROL_SCENARIOS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const WORKSTATION_CODE_PATH = "/orgii/workstation/code";

function parseE2EChain(rawValue, fallbackValues) {
  const parsed = (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const source = parsed.length > 0 ? parsed : fallbackValues;
  return Array.from(new Set(source.filter(Boolean)));
}

const js = {
  exists: (selector) =>
    `return !!document.querySelector(${JSON.stringify(selector)});`,
  click: (selector) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    if (element.disabled) return "disabled";
    element.click();
    return "clicked";
  `,
  visibleClick: (selector) => `
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const element = elements.find((candidate) => isVisible(candidate));
    if (!element) return "missing";
    if (element.disabled) return "disabled";
    element.scrollIntoView({ block: "center", inline: "center" });
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
    element.click();
    return "clicked";
  `,
  clearAndType: (selector, text) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    element.focus();
    document.execCommand("selectAll", false, null);
    const ok = document.execCommand("insertText", false, ${JSON.stringify(text)});
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
    return ok ? (element.textContent || "") : "insert-failed";
  `,
  sendState: `
    const button = document.querySelector('[data-testid="chat-send-button"]');
    const editor = document.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
    if (!button) return null;
    return {
      state: button.getAttribute("data-state"),
      disabled: button.disabled,
      editorText: editor ? (editor.textContent || "") : null,
    };
  `,
  editorText: `
    const editor = document.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
    return editor ? (editor.textContent || "") : null;
  `,
  mode: `
    const creator = document.querySelector(".session-creator-chat-panel");
    const history = document.querySelector('[data-testid="chat-message-list"]');
    return creator ? "creator" : history ? "chat" : "unknown";
  `,
  bodyText: `return document.body.innerText || "";`,
  assistantTexts: `
    return Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]'))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean);
  `,
  planningFooter: `
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const footer = document.querySelector('[data-testid="planning-footer"]');
    return {
      visible: !!footer && isVisible(footer),
      text: footer ? (footer.textContent || '').trim() : '',
    };
  `,
  fileChanges: `
    const filesPill = document.querySelector('[data-testid="composer-section-files"]');
    const undoAll = document.querySelector('[data-testid="file-changes-undo-all"]');
    const keepAll = document.querySelector('[data-testid="file-changes-keep-all"]');
    const review = document.querySelector('[data-testid="file-changes-review"]');
    return {
      filesPill: !!filesPill,
      filesPillText: filesPill ? (filesPill.textContent || '') : '',
      undoAll: !!undoAll,
      undoAllDisabled: undoAll ? !!undoAll.disabled : null,
      keepAll: !!keepAll,
      keepAllDisabled: keepAll ? !!keepAll.disabled : null,
      review: !!review,
      reviewDisabled: review ? !!review.disabled : null,
      bodyText: (document.body.innerText || '').slice(0, 3000),
    };
  `,
  planUi: `
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const cards = Array.from(document.querySelectorAll('[data-testid="create-plan-card"]'));
    const currentCards = cards.filter((card) => card.getAttribute('data-plan-surface') === 'current' && isVisible(card));
    const transcriptCards = cards.filter((card) => card.getAttribute('data-plan-surface') === 'transcript' && isVisible(card));
    const communicationRoot = document.querySelector('[data-testid="communication-message-viewer"]');
    const communicationCards = communicationRoot
      ? Array.from(communicationRoot.querySelectorAll('[data-testid="create-plan-card"], [data-testid="plan-interaction-row"]')).filter(isVisible)
      : [];
    const rawBuildButtons = Array.from(document.querySelectorAll('[data-testid="create-plan-build"]'));
    const rawSkipButtons = Array.from(document.querySelectorAll('[data-testid="create-plan-skip"]'));
    const rawEditButtons = Array.from(document.querySelectorAll('[data-testid="create-plan-edit"]'));
    const buildButtons = rawBuildButtons.filter(isVisible);
    const skipButtons = rawSkipButtons.filter(isVisible);
    const editButtons = rawEditButtons.filter(isVisible);
    const currentBuildButtons = currentCards.flatMap((card) => Array.from(card.querySelectorAll('[data-testid="create-plan-build"]')).filter(isVisible));
    const currentSkipButtons = currentCards.flatMap((card) => Array.from(card.querySelectorAll('[data-testid="create-plan-skip"]')).filter(isVisible));
    const transcriptBuildButtons = transcriptCards.flatMap((card) => Array.from(card.querySelectorAll('[data-testid="create-plan-build"]')).filter(isVisible));
    const transcriptSkipButtons = transcriptCards.flatMap((card) => Array.from(card.querySelectorAll('[data-testid="create-plan-skip"]')).filter(isVisible));
    const enabledBuildRevisionIds = cards
      .filter((card) => Array.from(card.querySelectorAll('[data-testid="create-plan-build"]')).some((button) => !button.disabled))
      .map((card) => card.getAttribute('data-plan-revision-id') || '')
      .filter(Boolean);
    const enabledSkipRevisionIds = cards
      .filter((card) => Array.from(card.querySelectorAll('[data-testid="create-plan-skip"]')).some((button) => !button.disabled))
      .map((card) => card.getAttribute('data-plan-revision-id') || '')
      .filter(Boolean);
    const planDocPanel = document.querySelector('[data-testid="plan-doc-panel"]');
    const planDocBuild = Array.from(document.querySelectorAll('[data-testid="plan-doc-build"]')).find(isVisible) || null;
    const planDocEdit = Array.from(document.querySelectorAll('[data-testid="plan-doc-edit"]')).find(isVisible) || null;
    const pinnedTodo = document.querySelector('[data-testid="plan-todo-pin-bar"]');
    return {
      cardCount: cards.length,
      currentCardCount: currentCards.length,
      transcriptCardCount: transcriptCards.length,
      communicationCardCount: communicationCards.length,
      readyCardCount: cards.filter((card) => card.getAttribute('data-plan-ready') === 'true').length,
      readyCurrentCardCount: currentCards.filter((card) => card.getAttribute('data-plan-ready') === 'true').length,
      currentCardCollapsedStates: currentCards.map((card) => card.getAttribute('data-plan-collapsed') || ''),
      transcriptCardCollapsedStates: transcriptCards.map((card) => card.getAttribute('data-plan-collapsed') || ''),
      cardRevisionIds: cards.map((card) => card.getAttribute('data-plan-revision-id') || '').filter(Boolean),
      currentCardRevisionIds: currentCards.map((card) => card.getAttribute('data-plan-revision-id') || ''),
      transcriptCardRevisionIds: transcriptCards.map((card) => card.getAttribute('data-plan-revision-id') || ''),
      communicationCardRevisionIds: communicationCards.map((card) => card.getAttribute('data-plan-revision-id') || ''),
      cardStatuses: cards.map((card) => ({
        revisionId: card.getAttribute('data-plan-revision-id') || '',
        surface: card.getAttribute('data-plan-surface') || '',
        status: card.getAttribute('data-plan-approval-status') || '',
        text: card.textContent || '',
      })),
      transcriptCardStatuses: transcriptCards.map((card) => ({
        revisionId: card.getAttribute('data-plan-revision-id') || '',
        status: card.getAttribute('data-plan-approval-status') || '',
        text: card.textContent || '',
      })),
      rawBuildButtonCount: rawBuildButtons.length,
      rawSkipButtonCount: rawSkipButtons.length,
      rawEditButtonCount: rawEditButtons.length,
      rawEnabledBuildButtonCount: rawBuildButtons.filter((button) => !button.disabled).length,
      rawEnabledSkipButtonCount: rawSkipButtons.filter((button) => !button.disabled).length,
      buildButtonCount: buildButtons.length,
      enabledBuildButtonCount: buildButtons.filter((button) => !button.disabled).length,
      currentBuildButtonCount: currentBuildButtons.length,
      enabledCurrentBuildButtonCount: currentBuildButtons.filter((button) => !button.disabled).length,
      transcriptBuildButtonCount: transcriptBuildButtons.length,
      enabledTranscriptBuildButtonCount: transcriptBuildButtons.filter((button) => !button.disabled).length,
      skipButtonCount: skipButtons.length,
      enabledSkipButtonCount: skipButtons.filter((button) => !button.disabled).length,
      currentSkipButtonCount: currentSkipButtons.length,
      enabledCurrentSkipButtonCount: currentSkipButtons.filter((button) => !button.disabled).length,
      transcriptSkipButtonCount: transcriptSkipButtons.length,
      enabledTranscriptSkipButtonCount: transcriptSkipButtons.filter((button) => !button.disabled).length,
      editButtonCount: editButtons.length,
      planDocBuild: !!planDocBuild,
      planDocBuildEnabled: !!planDocBuild && !planDocBuild.disabled,
      planDocEdit: !!planDocEdit,
      planDocPanel: !!planDocPanel,
      planDocRevisionId: planDocPanel ? (planDocPanel.getAttribute('data-plan-revision-id') || '') : '',
      planDocText: planDocPanel ? (planDocPanel.textContent || '') : '',
      cardTexts: cards.map((card) => card.textContent || ''),
      currentCardTexts: currentCards.map((card) => card.textContent || ''),
      enabledBuildRevisionIds,
      enabledSkipRevisionIds,
      pinnedTodo: !!pinnedTodo,
      bodyText: (document.body.innerText || '').slice(0, 4000),
    };
  `,
  modePillText: `
    const pill = document.querySelector('[data-testid="agent-exec-mode-pill"]');
    return pill ? (pill.textContent || '').trim() : null;
  `,
  modeSwitchUi: `
    const card = document.querySelector('[data-testid="mode-switch-card"]');
    const confirm = document.querySelector('[data-testid="mode-switch-confirm"]');
    const skip = document.querySelector('[data-testid="mode-switch-skip"]');
    const autoSkip = card ? card.querySelector('[data-testid="mode-switch-auto-skip-countdown"]') : null;
    return {
      card: !!card,
      targetMode: card ? card.getAttribute('data-target-mode') : null,
      confirm: !!confirm,
      confirmDisabled: confirm ? confirm.disabled : null,
      skip: !!skip,
      autoSkipText: autoSkip ? (autoSkip.textContent || '').trim() : '',
      autoSkipRemaining: autoSkip ? Number(autoSkip.getAttribute('data-auto-skip-remaining')) : null,
      text: card ? (card.textContent || '') : '',
      bodyText: (document.body.innerText || '').slice(0, 4000),
    };
  `,
  pageDump: `
    return {
      mode: (() => {
        const creator = document.querySelector(".session-creator-chat-panel");
        const history = document.querySelector('[data-testid="chat-message-list"]');
        return creator ? "creator" : history ? "chat" : "unknown";
      })(),
      pathname: window.location.pathname,
      hasChatViewRoot: !!document.querySelector('[data-chat-view-root]'),
      chatViewSessionIds: Array.from(document.querySelectorAll('[data-chat-view-root]')).map((node) => node.getAttribute('data-session-id') || ''),
      sendState: (() => {
        const button = document.querySelector('[data-testid="chat-send-button"]');
        return button ? { state: button.getAttribute("data-state"), disabled: button.disabled } : null;
      })(),
      assistantTexts: Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]')).map((node) => (node.textContent || "").trim()).slice(-3),
      bodyText: (document.body.innerText || "").slice(0, 4000),
    };
  `,
};

function truncateDiagnosticText(value, maxLength = 220) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeChatState(state) {
  if (!state) return null;
  return {
    activeSessionId: state.activeSessionId,
    coreSessionId: state.coreSessionId,
    runtimeStatus: state.runtimeStatus,
    runtimeError: state.runtimeError,
    stationMode: state.stationMode,
    isSessionActive: state.isSessionActive,
    chatEventCount: state.chatEventCount,
    fileChangesCount: state.fileChangesCount,
    pendingReviewCount: state.pendingReviewCount,
    pendingPlan: state.pendingPlan,
    pinnedTodoCount: state.pinnedTodoCount,
    snapshotCount: state.snapshotCount,
    chatEvents: (state.chatEvents ?? []).map((event) => ({
      id: event.id,
      source: event.source,
      displayVariant: event.displayVariant,
      displayText: truncateDiagnosticText(event.displayText),
    })),
    toolEvents: (state.toolEvents ?? []).map((event) => ({
      id: event.id,
      functionName: event.functionName,
      uiCanonical: event.uiCanonical,
    })),
  };
}

function summarizePageDump(dump) {
  if (!dump) return null;
  return {
    mode: dump.mode,
    pathname: dump.pathname,
    hasChatViewRoot: dump.hasChatViewRoot,
    chatViewSessionIds: dump.chatViewSessionIds,
    sendState: dump.sendState,
    assistantTexts: (dump.assistantTexts ?? []).map((text) =>
      truncateDiagnosticText(text)
    ),
    bodyText: truncateDiagnosticText(dump.bodyText, 700),
  };
}

function accountDisplayName(account) {
  return account.name || account.id;
}

function accountMatchesName(account, accountName) {
  return (
    !accountName || account.name === accountName || account.id === accountName
  );
}

function accountMatchesChain(account, accountChain) {
  return accountChain.length === 0
    ? true
    : accountChain.some((accountName) =>
        accountMatchesName(account, accountName)
      );
}

function accountSupportsModel(account, model) {
  return !model || (account.enabled_models ?? []).includes(model);
}

function selectModelFromChain(account, modelChain) {
  const model = modelChain.find((candidate) =>
    (account.enabled_models ?? []).includes(candidate)
  );
  if (!model) {
    throw new Error(
      `No model from chain ${JSON.stringify(modelChain)} is enabled for account ${accountDisplayName(account)}; enabled=${JSON.stringify(account.enabled_models ?? [])}`
    );
  }
  return model;
}

function geminiFallbackConfigs(accounts, baseConfig) {
  if (baseConfig.account?.agent_type !== GEMINI_AGENT_TYPE) return [];

  const configs = [];
  const requireRustAgentSupport = baseConfig.category === RUST_AGENT_CATEGORY;
  const seen = new Set([`${baseConfig.account.id}:${baseConfig.model}`]);
  const candidateAccounts = accounts.filter(
    (row) =>
      row.agent_type === GEMINI_AGENT_TYPE &&
      row.enabled &&
      row.has_session_token &&
      (!requireRustAgentSupport || row.supports_rust_agents) &&
      accountMatchesChain(row, GEMINI_ACCOUNT_CHAIN)
  );
  for (const account of candidateAccounts) {
    for (const model of GEMINI_MODEL_CHAIN) {
      if (!accountSupportsModel(account, model)) continue;
      const key = `${account.id}:${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      configs.push({
        ...baseConfig,
        account,
        model,
      });
    }
  }
  return configs;
}

function shouldRunScenario(name) {
  return (
    CONTROL_SCENARIO_FILTER.length === 0 ||
    CONTROL_SCENARIO_FILTER.includes(name)
  );
}

function assertKnownControlScenarios(knownScenarioNames) {
  const knownScenarios = new Set(knownScenarioNames);
  const unknownScenarios = CONTROL_SCENARIO_FILTER.filter(
    (scenarioName) => !knownScenarios.has(scenarioName)
  );
  if (unknownScenarios.length > 0) {
    throw new Error(
      `Unknown E2E_CONTROL_SCENARIOS=${JSON.stringify(unknownScenarios)}; known=${JSON.stringify(Array.from(knownScenarios))}`
    );
  }
}

function isControlScenarioExplicitlyRequested(scenarioName) {
  return CONTROL_SCENARIO_FILTER.includes(scenarioName);
}

async function ensureAuthBypass() {
  await ensureBrowserAuthBypass(
    process.env.E2E_BASE_URL ?? "http://127.0.0.1:13847"
  );
}

async function waitForApp() {
  await browser.setWindowSize(2400, 1200).catch(() => undefined);
  await ensureAuthBypass().catch(() => undefined);
  await browser.pause(500);
  await browser.waitUntil(
    async () => execJS(js.exists('[data-testid="chat-panel"]')),
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: `chat panel never mounted; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!(window.__e2e && window.__e2e.configureWithExistingKey && window.__e2e.openSession && window.__e2e.listAccounts && window.__e2e.resetToNewSession && window.__e2e.seedModeSwitchSession && window.__e2e.seedPlanCard && window.__e2e.inspectChatState);`
      ),
    {
      timeout: 10_000,
      timeoutMsg: `required __e2e helpers never mounted; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function listAccounts() {
  return unwrap(await invokeE2E("listAccounts"), "listAccounts").accounts;
}

function requireAccount(accounts, options) {
  const candidates = accounts.filter((row) => {
    const nameMatches =
      !options.accountName ||
      row.name === options.accountName ||
      row.id === options.accountName;
    const modelMatches =
      !options.model || (row.enabled_models ?? []).includes(options.model);
    const apiKeyMatches = !options.requireApiKey || row.has_api_key;
    const sessionTokenMatches =
      !options.requireSessionToken || row.has_session_token;
    const rustAgentMatches =
      !options.requireRustAgentSupport || row.supports_rust_agents;
    return (
      row.agent_type === options.agentType &&
      nameMatches &&
      modelMatches &&
      apiKeyMatches &&
      sessionTokenMatches &&
      rustAgentMatches
    );
  });
  const account = candidates.find((row) => row.enabled) ?? candidates[0];
  if (account) return account;

  const rows = accounts
    .filter((row) => row.agent_type === options.agentType)
    .map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      auth_method: row.auth_method,
      has_api_key: row.has_api_key,
      has_session_token: row.has_session_token,
      supports_rust_agents: row.supports_rust_agents,
      native_harness_type: row.native_harness_type,
      enabled_models: row.enabled_models,
    }));
  throw new Error(
    `No matching ${options.agentType} account for ${JSON.stringify(options)}. Rows=${JSON.stringify(rows)}`
  );
}

function scenarioConfigs(accounts) {
  const shouldIncludeLabel = (label) =>
    CONTROL_LABEL_FILTER.length === 0 || CONTROL_LABEL_FILTER.includes(label);
  const configs = [];

  if (shouldIncludeLabel(RUST_PLAN_LABELS[0])) {
    const account = requireAccount(accounts, {
      agentType: CURSOR_AGENT_TYPE,
      accountName: CURSOR_NATIVE_ACCOUNT_NAME,
      model: CURSOR_NATIVE_MODEL,
      requireSessionToken: true,
      requireRustAgentSupport: true,
    });
    configs.push({
      label: RUST_PLAN_LABELS[0],
      account,
      model: CURSOR_NATIVE_MODEL,
      category: RUST_AGENT_CATEGORY,
      agentDefinitionId: "builtin:sde",
      nativeHarnessType: "cursor_native",
    });
  }

  if (shouldIncludeLabel(RUST_PLAN_LABELS[1])) {
    const account = requireAccount(accounts, {
      agentType: CLAUDE_CODE_AGENT_TYPE,
      accountName: CLAUDE_CODE_ACCOUNT_NAME,
      model: CLAUDE_CODE_MODEL,
      requireSessionToken: true,
      requireRustAgentSupport: true,
    });
    configs.push({
      label: RUST_PLAN_LABELS[1],
      account,
      model: CLAUDE_CODE_MODEL,
      category: RUST_AGENT_CATEGORY,
      agentDefinitionId: "builtin:sde",
    });
  }

  if (shouldIncludeLabel(RUST_PLAN_LABELS[2])) {
    const account = requireAccount(accounts, {
      agentType: CODEX_AGENT_TYPE,
      accountName: CODEX_ACCOUNT_NAME,
      model: CODEX_MODEL,
      requireSessionToken: true,
      requireRustAgentSupport: true,
    });
    configs.push({
      label: RUST_PLAN_LABELS[2],
      account,
      model: CODEX_MODEL,
      category: RUST_AGENT_CATEGORY,
      agentDefinitionId: "builtin:sde",
    });
  }

  if (shouldIncludeLabel(RUST_PLAN_LABELS[3])) {
    const account = requireAccount(accounts, {
      agentType: GEMINI_AGENT_TYPE,
      accountName: GEMINI_ACCOUNT_NAME,
      requireSessionToken: true,
      requireRustAgentSupport: true,
    });
    configs.push({
      label: RUST_PLAN_LABELS[3],
      account,
      model: selectModelFromChain(account, GEMINI_MODEL_CHAIN),
      category: RUST_AGENT_CATEGORY,
      agentDefinitionId: "builtin:sde",
    });
  }

  if (shouldIncludeLabel(RUST_PLAN_LABELS[4])) {
    const account = requireAccount(accounts, {
      agentType: API_AGENT_TYPE,
      accountName: API_ACCOUNT_NAME,
      model: API_MODEL,
      requireApiKey: true,
      requireRustAgentSupport: true,
    });
    configs.push({
      label: RUST_PLAN_LABELS[4],
      account,
      model: API_MODEL,
      category: RUST_AGENT_CATEGORY,
      agentDefinitionId: "builtin:sde",
    });
  }

  if (shouldIncludeLabel(CLI_PLAN_LABELS[0])) {
    const account = requireAccount(accounts, {
      agentType: CLAUDE_CODE_AGENT_TYPE,
      accountName: CLAUDE_CODE_ACCOUNT_NAME,
      model: CLAUDE_CODE_MODEL,
      requireSessionToken: true,
    });
    configs.push({
      label: CLI_PLAN_LABELS[0],
      account,
      model: CLAUDE_CODE_MODEL,
      category: CLI_AGENT_CATEGORY,
      cliAgentType: CLAUDE_CODE_AGENT_TYPE,
    });
  }

  if (shouldIncludeLabel(CLI_PLAN_LABELS[1])) {
    const account = requireAccount(accounts, {
      agentType: CODEX_AGENT_TYPE,
      accountName: CODEX_ACCOUNT_NAME,
      model: CODEX_MODEL,
      requireSessionToken: true,
    });
    configs.push({
      label: CLI_PLAN_LABELS[1],
      account,
      model: CODEX_MODEL,
      category: CLI_AGENT_CATEGORY,
      cliAgentType: CODEX_AGENT_TYPE,
    });
  }

  if (shouldIncludeLabel(CLI_PLAN_LABELS[2])) {
    const account = requireAccount(accounts, {
      agentType: CURSOR_AGENT_TYPE,
      accountName: CURSOR_CLI_ACCOUNT_NAME,
      requireApiKey: true,
    });
    const model = (account.enabled_models ?? []).includes(CURSOR_CLI_MODEL)
      ? CURSOR_CLI_MODEL
      : account.enabled_models[0];
    configs.push({
      label: CLI_PLAN_LABELS[2],
      account,
      model,
      category: CLI_AGENT_CATEGORY,
      cliAgentType: CURSOR_AGENT_TYPE,
    });
  }

  if (shouldIncludeLabel(CLI_PLAN_LABELS[3])) {
    const account = requireAccount(accounts, {
      agentType: GEMINI_AGENT_TYPE,
      accountName: GEMINI_ACCOUNT_NAME,
      requireSessionToken: true,
    });
    configs.push({
      label: CLI_PLAN_LABELS[3],
      account,
      model: selectModelFromChain(account, GEMINI_MODEL_CHAIN),
      category: CLI_AGENT_CATEGORY,
      cliAgentType: GEMINI_AGENT_TYPE,
    });
  }

  for (const config of configs) {
    if (config.account?.agent_type === GEMINI_AGENT_TYPE) {
      config.fallbackConfigs = geminiFallbackConfigs(accounts, config);
      console.log(
        `[plan-gemini-chain] label=${config.label} primary=${accountDisplayName(config.account)}:${config.model} fallbacks=${JSON.stringify(
          config.fallbackConfigs.map(
            (fallbackConfig) =>
              `${accountDisplayName(fallbackConfig.account)}:${fallbackConfig.model}`
          )
        )}`
      );
    }
  }

  const availableLabels = new Set(configs.map((config) => config.label));
  const missingLabels = CONTROL_LABEL_FILTER.filter(
    (label) => !availableLabels.has(label)
  );
  if (missingLabels.length > 0) {
    throw new Error(
      `Requested E2E_CONTROL_LABELS are unavailable for Plan spec: ${missingLabels.join(", ")}; planCapableLabels=${PLAN_CAPABLE_LABELS.join(", ")}; selectedAvailable=${Array.from(availableLabels).join(", ")}`
    );
  }
  return configs;
}

async function inspectChatState(label) {
  return unwrap(
    await invokeE2E("inspectChatState"),
    `inspectChatState(${label})`
  );
}

async function postJsonFromNode(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function getJsonFromNode(url) {
  try {
    const response = await fetch(url);
    return response.json();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function launchSeedOnlySession(config, repoPath, label) {
  if (config.category !== RUST_AGENT_CATEGORY) {
    throw new Error(
      `${label} attempted to use Rust seed-only plan launcher for non-Rust category ${config.category}`
    );
  }

  const result = await postJsonFromNode(
    e2eUrl("/agent/test/session/launch-seed-only"),
    {
      workspace_path: repoPath,
      additional_directories: [],
      session_id_hint: label,
      agent_definition_id: config.agentDefinitionId,
      model: config.model,
      account_id: config.account.id,
      native_harness_type: config.nativeHarnessType,
      agent_exec_mode: "build",
    }
  );
  if (!result || result.ok !== true || !result.session_id) {
    throw new Error(
      `${label} seed-only launch failed: ${JSON.stringify(result)}`
    );
  }
  unwrap(
    await invokeE2E("openSession", result.session_id),
    `${label}-openSession`
  );
  return result.session_id;
}

async function seedBackendModeSwitchPending(
  config,
  sessionId,
  repoPath,
  targetMode,
  reason
) {
  const response = await postJsonFromNode(
    `${e2eUrl("/agent/test/sde/mode-switch/")}${encodeURIComponent(sessionId)}/seed`,
    {
      target_mode: targetMode,
      reason,
      tool_call_id: `${sessionId}-suggest-mode-switch`,
      workspace_path: repoPath,
      model: config.model,
      account_id: config.account.id,
      native_harness_type: config.nativeHarnessType,
    }
  );
  if (!response || response.ok !== true || response.pending !== true) {
    throw new Error(
      `seed backend mode-switch pending failed for ${sessionId}: ${JSON.stringify(response)}`
    );
  }
  return response;
}

async function assertBackendModeSwitchPending(
  sessionId,
  expectedPending,
  label
) {
  const response = await getJsonFromNode(
    `${e2eUrl("/agent/test/sde/mode-switch/")}${encodeURIComponent(sessionId)}`
  );
  if (!response || response.pending !== expectedPending) {
    throw new Error(
      `${label} backend mode-switch pending mismatch expected=${expectedPending} response=${JSON.stringify(response)}`
    );
  }
}

async function configurePlanScenario(config, repoPath, agentExecMode = "plan") {
  await ensureAuthBypass();
  unwrap(
    await invokeE2E("navigateTo", WORKSTATION_CODE_PATH),
    `${config.label}-navigate-workstation-code`
  );
  await ensureAuthBypass();
  unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
  const configured = unwrap(
    await invokeE2E("configureWithExistingKey", {
      accountName: accountDisplayName(config.account),
      model: config.model,
      agentType: config.account.agent_type,
      category: config.category,
      cliAgentType: config.cliAgentType,
      agentDefinitionId: config.agentDefinitionId,
      nativeHarnessType: config.nativeHarnessType,
      agentExecMode,
      repoPath,
    }),
    `configureWithExistingKey(${config.label})`
  );
  expect(configured.modelId).toBe(config.model);
  await waitForSessionCreatorReady(`${config.label}-configured`, repoPath);
}

async function selectConfiguredWorkspaceIfNeeded(repoPath) {
  const result = await execJS(`
    const repoPath = ${JSON.stringify(repoPath)};
    const repoName = repoPath.split(/[\\/]/).filter(Boolean).pop() || repoPath;
    const bodyText = document.body.innerText || "";
    const inWorkspaceSelector = bodyText.includes("Select a workspace") || bodyText.includes("Create Multi-repo Workspace");
    if (!inWorkspaceSelector) return { attempted: false, clicked: false, reason: "not-selector" };
    const isVisible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const matches = Array.from(document.querySelectorAll("div, button"))
      .filter(isVisible)
      .filter((node) => {
        const text = node.textContent || "";
        return text.includes(repoPath) || text.includes(repoName);
      })
      .sort((left, right) => (left.textContent || "").length - (right.textContent || "").length);
    const matched = matches[0] || null;
    const target = matched?.closest(".cursor-pointer") || matched;
    if (!target) return { attempted: true, clicked: false, reason: "missing", repoName, bodyText: bodyText.slice(0, 1000) };
    target.scrollIntoView({ block: "center", inline: "center" });
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
    target.click();
    return { attempted: true, clicked: true, repoName, text: (target.textContent || "").slice(0, 200) };
  `);
  if (result?.attempted && !result.clicked) {
    throw new Error(
      `configured workspace was not selectable: ${JSON.stringify(result)}`
    );
  }
}

async function waitForSessionCreatorReady(label, repoPath) {
  await browser.waitUntil(
    async () => {
      await selectConfiguredWorkspaceIfNeeded(repoPath);
      const mode = await execJS(js.mode);
      const sendState = await execJS(js.sendState);
      return mode === "creator" && sendState?.state === "submit";
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${label} session creator never became ready; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function readCurrentModeFromMenu(label) {
  const skillsToolsButtonSelector =
    '[data-testid="composer-skills-tools-button"]';
  // The slash menu renders mode entries as flat ModeRow items (the Mode
  // flyout trigger was removed in ddcbdbdd); the current mode row carries
  // a lucide Check icon via DropdownSelectedCheck.
  const modeOptionSelector = '[data-testid^="slash-command-mode-option-"]';
  const readCurrentModeRow = `
    const rows = Array.from(document.querySelectorAll('[data-testid^="slash-command-mode-option-"]'));
    const current = rows.find((row) => row.querySelector('svg.lucide-check'));
    return current ? (current.textContent || '').trim() : null;
  `;
  let triggerText = await execJS(readCurrentModeRow);
  if (!triggerText) {
    const opened = await execJS(js.visibleClick(skillsToolsButtonSelector));
    if (opened !== "clicked") {
      return { ok: false, reason: `skills/tools open failed: ${opened}` };
    }
    await browser.waitUntil(async () => execJS(js.exists(modeOptionSelector)), {
      timeout: 5_000,
      timeoutMsg: `${label} slash command mode rows never rendered`,
    });
    triggerText = await execJS(readCurrentModeRow);
  }
  return { ok: true, triggerText };
}

async function waitForModePill(label, expectedText) {
  await browser.waitUntil(
    async () => {
      const text = await execJS(js.modePillText);
      if (typeof text === "string" && text.includes(expectedText)) return true;
      const menuMode = await readCurrentModeFromMenu(label);
      return (
        menuMode.ok && String(menuMode.triggerText ?? "").includes(expectedText)
      );
    },
    {
      timeout: 15_000,
      timeoutMsg: `${label} mode selector never showed ${expectedText}; actual=${JSON.stringify(await execJS(js.modePillText))} menu=${JSON.stringify(await readCurrentModeFromMenu(label).catch((error) => ({ ok: false, reason: String(error?.message ?? error) })))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function assertEffectiveToolsForMode(sessionId, expectedMode, label) {
  const result = unwrap(
    await invokeE2E("listEffectiveToolsForSession", sessionId),
    `${label}-listEffectiveToolsForSession`
  );
  const tools = result.tools ?? {};
  const promptToolNames = Array.isArray(tools.promptToolNames)
    ? tools.promptToolNames
    : [];
  if (tools.agentExecMode !== expectedMode) {
    throw new Error(
      `${label} effective tools mode mismatch expected=${expectedMode} actual=${tools.agentExecMode} tools=${JSON.stringify(tools)}`
    );
  }
  if (expectedMode === "plan" && !promptToolNames.includes("create_plan")) {
    throw new Error(
      `${label} Plan mode effective tools did not include create_plan; tools=${JSON.stringify(tools)}`
    );
  }
  if (expectedMode !== "plan" && promptToolNames.includes("create_plan")) {
    throw new Error(
      `${label} non-Plan mode effective tools unexpectedly included create_plan; tools=${JSON.stringify(tools)}`
    );
  }
}

async function waitForModeSwitchCard(label, expectedReason) {
  await browser.waitUntil(
    async () => {
      const ui = await execJS(js.modeSwitchUi);
      const state = await inspectChatState(label);
      const hasSuggestEvent = state.rawEvents.some(
        (event) => event.functionName === "suggest_mode_switch"
      );
      const reasonMatches =
        !expectedReason || String(ui.text || "").includes(expectedReason);
      const countdownMatches =
        Number.isFinite(ui.autoSkipRemaining) &&
        ui.autoSkipRemaining >= 0 &&
        ui.autoSkipRemaining <= 300;
      return (
        ui.card &&
        ui.confirm &&
        ui.targetMode === "plan" &&
        reasonMatches &&
        countdownMatches &&
        hasSuggestEvent &&
        !ui.bodyText.includes(
          "Cursor native 'SwitchMode' is not accepted by ORGII"
        )
      );
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} mode-switch card never appeared; ui=${JSON.stringify(await execJS(js.modeSwitchUi))} page=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))}`,
    }
  );
}

async function clickModeSwitchConfirm(label) {
  await waitForModeSwitchCard(label);
  const clicked = await execJS(js.click('[data-testid="mode-switch-confirm"]'));
  if (clicked !== "clicked") {
    throw new Error(
      `${label} mode switch confirm click failed: ${clicked}; ui=${JSON.stringify(await execJS(js.modeSwitchUi))}`
    );
  }
}

async function waitForChatInput() {
  const selector = '[data-testid="chat-input"] [contenteditable="true"]';
  await browser.waitUntil(async () => execJS(js.exists(selector)), {
    timeout: 30_000,
    timeoutMsg: `chat input never appeared; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
  });
  return selector;
}

async function typeAndClickSend(inputSelector, prompt) {
  const typed = await execJS(js.clearAndType(inputSelector, prompt));
  if (typed === "missing" || typed === "insert-failed") {
    throw new Error(`failed to type prompt: ${typed}`);
  }
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.sendState);
      return state && state.state === "submit" && !state.disabled;
    },
    {
      timeout: 15_000,
      timeoutMsg: `send button never became submit after typing ${JSON.stringify(prompt.slice(0, 80))}; sendState=${JSON.stringify(await execJS(js.sendState))}; state=${JSON.stringify(summarizeChatState(await inspectChatState("send-timeout")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
  const clicked = await execJS(js.click('[data-testid="chat-send-button"]'));
  if (clicked !== "clicked") {
    throw new Error(`send click failed: ${clicked}`);
  }
}

async function assertSingleUserPromptInActiveTranscript(firstPrompt) {
  const promptPrefix = firstPrompt.slice(0, 120);
  const state = await inspectChatState("single-user-prompt-check");
  const matchingUserEvents = (state.chatEvents ?? []).filter(
    (event) =>
      event.source === "user" &&
      event.displayVariant === "message" &&
      String(event.displayText ?? "").includes(promptPrefix)
  );
  if (matchingUserEvents.length > 1) {
    throw new Error(
      `duplicate user prompt detected in active transcript; count=${matchingUserEvents.length} promptPrefix=${JSON.stringify(promptPrefix)} state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

async function waitForChatLaunched(firstPrompt) {
  await browser.waitUntil(
    async () => {
      const mode = await execJS(js.mode);
      const body = await execJS(js.bodyText);
      return mode === "chat" && body.includes(firstPrompt.slice(0, 80));
    },
    {
      timeout: FIRST_TURN_TIMEOUT_MS,
      timeoutMsg: `first prompt did not launch chat; mode=${JSON.stringify(await execJS(js.mode))}; state=${JSON.stringify(summarizeChatState(await inspectChatState("launch-timeout")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
  await assertSingleUserPromptInActiveTranscript(firstPrompt);
}

async function waitForIdleSendButton(label, timeout = REPLY_TIMEOUT_MS) {
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.sendState);
      const chat = await inspectChatState(label);
      return (
        state &&
        state.state !== "working" &&
        state.state !== "stop" &&
        chat.runtimeStatus !== "running" &&
        !chat.isSessionActive
      );
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `${label} session stayed active; state=${JSON.stringify(await execJS(js.sendState))} chat=${JSON.stringify(summarizeChatState(await inspectChatState(label)))}`,
    }
  );
}

function normalizeEventText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

async function assertNoDuplicateThinkingEvents(label) {
  const state = await inspectChatState(`${label}-thinking-dedup`);
  const eventById = new Map(
    (state.chatEvents ?? []).map((event) => [event.id, event])
  );
  const visibleEvents = (state.pipelineItems ?? [])
    .map((item) => (item.eventId ? eventById.get(item.eventId) : null))
    .filter(Boolean);
  let currentUserTurnIndex = 0;
  let seenInTurn = new Map();
  for (const event of visibleEvents) {
    if (event.source === "user") {
      currentUserTurnIndex += 1;
      seenInTurn = new Map();
      continue;
    }
    if (event.displayVariant !== "thinking") continue;
    const text = normalizeEventText(event.displayText);
    if (text.length < 20) continue;
    const existing = seenInTurn.get(text);
    if (existing) {
      throw new Error(
        `${label} duplicated visible thinking event in user turn ${currentUserTurnIndex}; first=${existing} second=${event.id} text=${JSON.stringify(text.slice(0, 180))} state=${JSON.stringify(summarizeChatState(state))}`
      );
    }
    seenInTurn.set(text, event.id);
  }
}

async function assertThinkingEventsChronological(label) {
  const state = await inspectChatState(`${label}-thinking-order`);
  const events = state.chatEvents ?? [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.displayVariant !== "thinking") continue;

    let previousUserIndex = -1;
    for (let scan = index - 1; scan >= 0; scan -= 1) {
      if (events[scan].source === "user") {
        previousUserIndex = scan;
        break;
      }
    }
    if (previousUserIndex < 0) {
      throw new Error(
        `${label} thinking event rendered before any user turn; event=${JSON.stringify(event)} state=${JSON.stringify(summarizeChatState(state))}`
      );
    }

    let nextUserIndex = events.length;
    for (let scan = index + 1; scan < events.length; scan += 1) {
      if (events[scan].source === "user") {
        nextUserIndex = scan;
        break;
      }
    }

    const laterAssistantOutput = events
      .slice(index + 1, nextUserIndex)
      .some(
        (candidate) =>
          candidate.source === "assistant" &&
          candidate.displayVariant !== "thinking" &&
          normalizeEventText(candidate.displayText).length > 0
      );
    const laterToolOutput = (state.toolEvents ?? []).length > 0;
    if (!laterAssistantOutput && !laterToolOutput) {
      throw new Error(
        `${label} thinking event rendered after the turn output or without a later output; event=${JSON.stringify(event)} state=${JSON.stringify(summarizeChatState(state))}`
      );
    }
  }
}

async function assertNoPlanningFooterAfterAssistantReply(label) {
  const footer = await execJS(js.planningFooter);
  if (footer.visible) {
    throw new Error(
      `${label} still showed planning footer after assistant reply; footer=${JSON.stringify(footer)} state=${JSON.stringify(summarizeChatState(await inspectChatState(`${label}-planning-footer`)))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
}

async function assertNoLongRunningStopAfterAssistantReply(label) {
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.sendState);
      return state?.state !== "stop";
    },
    {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: `${label} send button stayed in stop state after assistant reply; state=${JSON.stringify(await execJS(js.sendState))} chat=${JSON.stringify(summarizeChatState(await inspectChatState(`${label}-stop-after-reply`)))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function assertAgentTurnCompleted(label) {
  await waitForIdleSendButton(label);
  const state = await inspectChatState(`${label}-complete-final`);
  if (state.runtimeError) {
    throw new Error(
      `${label} completed with runtime error: ${state.runtimeError}; state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
  await assertNoDuplicateThinkingEvents(label);
  await assertThinkingEventsChronological(label);
}

async function assertPlanReadyTurnIdle(label) {
  await waitForIdleSendButton(`${label}-plan-ready-idle`, 15_000);
}

function planRevisionIdentity(pendingPlan) {
  return pendingPlan?.planRevisionId ?? pendingPlan?.toolCallId ?? null;
}

function retryableProviderOrModelRuntimeError(state) {
  const runtimeError = String(state?.runtimeError ?? "");
  const normalized = runtimeError.toLowerCase();
  if (
    !normalized.includes("rate limit") &&
    !normalized.includes("rate_limit") &&
    !normalized.includes("too many requests") &&
    !normalized.includes("quota") &&
    !normalized.includes("capacity") &&
    !normalized.includes("429") &&
    !normalized.includes("404 not found") &&
    !normalized.includes("model not found") &&
    !normalized.includes("requested entity was not found")
  ) {
    return null;
  }
  return runtimeError;
}

async function throwIfRetryableProviderOrModelBlocked(label) {
  const state = await inspectChatState(`${label}-provider-model-check`);
  const runtimeError = retryableProviderOrModelRuntimeError(state);
  if (!runtimeError) return;
  throw new Error(
    `${label} retryable provider/model issue blocked plan wait: ${runtimeError}; state=${JSON.stringify(summarizeChatState(state))}`
  );
}

async function waitForPlanShellVisible(label) {
  await browser.waitUntil(
    async () => {
      await throwIfRetryableProviderOrModelBlocked(label);
      const ui = await execJS(js.planUi);
      return ui.cardCount > 0 || ui.planDocPanel;
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} plan shell never became visible; ui=${JSON.stringify(await execJS(js.planUi))} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))}`,
    }
  );
}

async function waitForClaudeCodePlanStreamingSurface(label) {
  await browser.waitUntil(
    async () => {
      await throwIfRetryableProviderOrModelBlocked(label);
      const ui = await execJS(js.planUi);
      const hasStreamingPlanShell =
        ui.cardCount > 0 &&
        ui.readyCardCount === 0 &&
        ui.enabledBuildButtonCount === 0;
      const hasDurableReadyPlan =
        ui.readyCardCount > 0 || ui.planDocBuildEnabled;
      return hasStreamingPlanShell || hasDurableReadyPlan;
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${label} did not show a streaming or ready plan surface; ui=${JSON.stringify(await execJS(js.planUi))} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))}`,
    }
  );
}

async function waitForPlanCardReady(label) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(label);
      const runtimeError = retryableProviderOrModelRuntimeError(state);
      if (runtimeError) {
        throw new Error(
          `${label} retryable provider/model issue blocked plan readiness: ${runtimeError}; state=${JSON.stringify(summarizeChatState(state))}`
        );
      }
      const ui = await execJS(js.planUi);
      return (
        !!planRevisionIdentity(state.pendingPlan) &&
        ((ui.readyCardCount > 0 && ui.rawEnabledSkipButtonCount > 0) ||
          ui.planDocBuildEnabled)
      );
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} plan card never became buildable; ui=${JSON.stringify(await execJS(js.planUi))} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))}`,
    }
  );
}

async function waitForPendingPlanRevisionChange(label, previousRevisionId) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(label);
      const currentRevisionId = planRevisionIdentity(state.pendingPlan);
      return !!currentRevisionId && currentRevisionId !== previousRevisionId;
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} pending plan revision did not change from ${previousRevisionId}; state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))} ui=${JSON.stringify(await execJS(js.planUi))}`,
    }
  );
}

async function assertPlanPinnedCollapsed(label, expectedRevisionId) {
  const state = await inspectChatState(label);
  const ui = await execJS(js.planUi);
  const currentRevisionId = planRevisionIdentity(state.pendingPlan);
  const surfaceRevisionIds = [
    ...(ui.cardRevisionIds ?? []),
    ...ui.currentCardRevisionIds,
    ...ui.transcriptCardRevisionIds,
    ...ui.communicationCardRevisionIds,
    ui.planDocRevisionId,
  ].filter(Boolean);
  const hasExpectedSurface = surfaceRevisionIds.includes(expectedRevisionId);
  const collapsed =
    ui.currentCardCollapsedStates.length === 0 ||
    ui.currentCardCollapsedStates.every((value) => value === "true");
  const enabledBuildRevisionIds = ui.enabledBuildRevisionIds ?? [];
  const enabledSkipRevisionIds = ui.enabledSkipRevisionIds ?? [];
  const actionableBuildIsExpected =
    enabledBuildRevisionIds.length > 0 &&
    enabledBuildRevisionIds.every(
      (revisionId) => revisionId === expectedRevisionId
    );
  const actionableSkipIsExpected =
    enabledSkipRevisionIds.length > 0 &&
    enabledSkipRevisionIds.every(
      (revisionId) => revisionId === expectedRevisionId
    );
  if (
    currentRevisionId !== expectedRevisionId ||
    !hasExpectedSurface ||
    !collapsed ||
    !actionableBuildIsExpected ||
    !actionableSkipIsExpected
  ) {
    throw new Error(
      `${label} pending plan was not pinned collapsed as the only buildable plan; expected=${expectedRevisionId} ui=${JSON.stringify(ui)} state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

async function assertPlanLatestOnly(
  label,
  expectedRevisionId,
  expectedSurface = "pinned"
) {
  const state = await inspectChatState(label);
  const ui = await execJS(js.planUi);
  void expectedSurface;
  const currentRevisionId = planRevisionIdentity(state.pendingPlan);
  const allRevisionIds = [
    ...(ui.cardRevisionIds ?? []),
    ...ui.currentCardRevisionIds,
    ...ui.transcriptCardRevisionIds,
    ...ui.communicationCardRevisionIds,
    ui.planDocRevisionId,
  ].filter(Boolean);
  const enabledBuildRevisionIds = ui.enabledBuildRevisionIds ?? [];
  const enabledSkipRevisionIds = ui.enabledSkipRevisionIds ?? [];
  const planDocRevisionMismatch =
    ui.planDocBuildEnabled &&
    ui.planDocRevisionId &&
    ui.planDocRevisionId !== expectedRevisionId;
  const currentSurfaceIsExpected =
    ui.currentCardRevisionIds.length === 0 ||
    ui.currentCardRevisionIds.every(
      (revisionId) => revisionId === expectedRevisionId
    );
  const actionableBuildIsExpected =
    enabledBuildRevisionIds.length > 0 &&
    enabledBuildRevisionIds.every(
      (revisionId) => revisionId === expectedRevisionId
    );
  const actionableSkipIsExpected =
    enabledSkipRevisionIds.length === 0 ||
    enabledSkipRevisionIds.every(
      (revisionId) => revisionId === expectedRevisionId
    );
  if (
    currentRevisionId !== expectedRevisionId ||
    !allRevisionIds.includes(expectedRevisionId) ||
    !currentSurfaceIsExpected ||
    !actionableBuildIsExpected ||
    !actionableSkipIsExpected ||
    planDocRevisionMismatch
  ) {
    throw new Error(
      `${label} latest plan revision was not the only buildable plan; expectedRevision=${expectedRevisionId} ui=${JSON.stringify(ui)} state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

async function assertPlanRevisionReplaced(label, oldRevisionId, newRevisionId) {
  await execJS(`
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const button = document.querySelector('[data-testid="communication-load-more-messages"]');
      if (!button) break;
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
    }
    return true;
  `);
  const state = await inspectChatState(label);
  const ui = await execJS(js.planUi);
  const allCardStatuses = ui.cardStatuses ?? [];
  const newTranscript = (ui.transcriptCardStatuses ?? []).find(
    (card) => card.revisionId === newRevisionId
  );
  const oldArchivedCard = allCardStatuses.find(
    (card) => card.revisionId === oldRevisionId && card.status === "archived"
  );
  const oldLifecycleEvent = (state.rawEvents ?? []).some((event) => {
    const resultStatus = String(
      event.resultStatus ?? event.result?.status ?? ""
    );
    return (
      event.planRevisionId === oldRevisionId &&
      ["archived", "approved", "cancelled"].includes(resultStatus)
    );
  });
  if (!newTranscript || (!oldArchivedCard && !oldLifecycleEvent)) {
    throw new Error(
      `${label} plan revision replacement was not visible/archived; old=${oldRevisionId} new=${newRevisionId} ui=${JSON.stringify(ui)} state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

async function waitForPlanGone(label) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(label);
      const ui = await execJS(js.planUi);
      return (
        !state.pendingPlan &&
        ui.readyCurrentCardCount === 0 &&
        ui.rawEnabledBuildButtonCount === 0 &&
        ui.rawEnabledSkipButtonCount === 0 &&
        !ui.planDocBuildEnabled
      );
    },
    {
      timeout: 30_000,
      interval: 1_000,
      timeoutMsg: `${label} buildable plan state remained; ui=${JSON.stringify(await execJS(js.planUi))} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))}`,
    }
  );
}

async function clickPlanBuild(label) {
  await waitForPlanCardReady(label);
  const ui = await execJS(js.planUi);
  if (ui.planDocBuildEnabled) {
    const clicked = await execJS(js.click('[data-testid="plan-doc-build"]'));
    if (clicked === "clicked") return;
  }
  const clicked = await execJS(`
    const buttons = Array.from(document.querySelectorAll('[data-testid="create-plan-build"]'));
    const target = buttons.find((button) => !button.disabled);
    if (!target) return "missing";
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return "clicked";
  `);
  if (clicked !== "clicked") {
    throw new Error(
      `${label} build click failed: ${clicked}; ui=${JSON.stringify(ui)}`
    );
  }
}

async function clickPlanSkip(label) {
  await waitForPlanCardReady(label);
  const ui = await execJS(js.planUi);
  const clicked = await execJS(`
    const buttons = Array.from(document.querySelectorAll('[data-testid="create-plan-skip"]'));
    const target = buttons.find((button) => !button.disabled);
    if (!target) return "missing";
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return "clicked";
  `);
  if (clicked !== "clicked") {
    throw new Error(
      `${label} skip click failed: ${clicked}; ui=${JSON.stringify(ui)}`
    );
  }
}

async function waitForPlanSkipped(label, revisionId) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(label);
      const ui = await execJS(js.planUi);
      const cancelledEvent = (state.rawEvents ?? []).some(
        (event) =>
          event.planRevisionId === revisionId &&
          event.resultStatus === "cancelled"
      );
      const visibleSkippedStatus = ui.bodyText.includes("Plan skipped");
      return !state.pendingPlan && cancelledEvent && visibleSkippedStatus;
    },
    {
      timeout: 30_000,
      interval: 1_000,
      timeoutMsg: `${label} skipped plan status did not appear; revision=${revisionId} ui=${JSON.stringify(await execJS(js.planUi))} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))}`,
    }
  );
}

async function waitForMarkerFile(config, filePath, markerText) {
  await browser.waitUntil(
    async () =>
      fs.existsSync(filePath) &&
      fs.readFileSync(filePath, "utf8").includes(markerText),
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${config.label} marker file was not created at ${filePath}; assistantTexts=${JSON.stringify(await execJS(js.assistantTexts))} fileChanges=${JSON.stringify(await execJS(js.fileChanges))} chat=${JSON.stringify(summarizeChatState(await inspectChatState(config.label)))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function waitForSessionInactive(label) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(label);
      return !state.isSessionActive && state.runtimeStatus !== "running";
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} session did not become inactive; state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))}`,
    }
  );
}

// The file-changes panel was replaced by Agent Station Diff view in
// fbf20c78. Clicking the files pill now opens the diff view rather than
// expanding an inline panel. waitForFileChangesPanel clicks the pill and
// confirms the diff view opened (evidenced by the Undo All button appearing
// in SimulatorWorkstationTabHeader).
async function waitForFileChangesPanel(label) {
  // Wait for the files pill to appear first
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.fileChanges);
      return state.filesPill;
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} file changes pill never appeared; fileChanges=${JSON.stringify(await execJS(js.fileChanges))} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  // If Undo All is already visible we're already in the diff view
  const alreadyOpen = await execJS(js.fileChanges);
  if (alreadyOpen.undoAll) return;

  // Click the pill to open Agent Station Diff. Retry up to 3 times.
  const MAX_EXPAND_ATTEMPTS = 3;
  const EXPAND_ATTEMPT_TIMEOUT_MS = 8_000;

  for (let attempt = 1; attempt <= MAX_EXPAND_ATTEMPTS; attempt++) {
    const clicked = await execJS(
      js.click('[data-testid="composer-section-files"]')
    );
    if (clicked !== "clicked" && attempt === 1) {
      throw new Error(`${label} file changes pill click failed: ${clicked}`);
    }

    // The pill now opens a dropdown menu (GitDiffActionsMenu); choose
    // "View in Agent station" to open the diff.
    await execJS(
      js.click('[data-testid="git-diff-action-view-agent-station"]')
    );

    const opened = await browser
      .waitUntil(
        async () => {
          const state = await execJS(js.fileChanges);
          if (state.undoAll) return true;
          const hasDiffTabs = await execJS(
            `return !!document.querySelector('[data-testid="replay-tab-diff-filter"]');`
          );
          return !!hasDiffTabs;
        },
        {
          timeout: EXPAND_ATTEMPT_TIMEOUT_MS,
          interval: 1_000,
        }
      )
      .catch(() => null);

    if (opened) return;

    if (attempt === MAX_EXPAND_ATTEMPTS) {
      // Fall back to the bridge that sets the same atoms as the
      // "View in Agent station" menu item, in case Tauri WebDriver clicks
      // missed the portal-rendered menu.
      await invokeE2E("openAgentStationDiff");
      const openedViaBridge = await browser
        .waitUntil(
          async () => {
            const state = await execJS(js.fileChanges);
            if (state.undoAll) return true;
            const hasDiffTabs = await execJS(
              `return !!document.querySelector('[data-testid="replay-tab-diff-filter"]');`
            );
            return !!hasDiffTabs;
          },
          {
            timeout: 10_000,
            interval: 500,
          }
        )
        .catch(() => null);
      if (openedViaBridge) return;
      throw new Error(
        `${label} file changes panel did not expand after ${MAX_EXPAND_ATTEMPTS} attempts; fileChanges=${JSON.stringify(await execJS(js.fileChanges))}`
      );
    }
  }
}

async function clickUndoAllAndConfirm(label) {
  await execJS(`window.__orgiiE2EAutoConfirmDestructive = true; return true;`);
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.fileChanges);
      return state.undoAll && state.undoAllDisabled === false;
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${label} Undo All never became enabled; fileChanges=${JSON.stringify(await execJS(js.fileChanges))} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))}`,
    }
  );
  const clicked = await execJS(
    js.click('[data-testid="file-changes-undo-all"]')
  );
  if (clicked !== "clicked") {
    throw new Error(`${label} Undo All click failed: ${clicked}`);
  }
}

// Track every plan scenario tmpdir we create so the suite can wipe them on
// exit (macOS /var/folders/.../T does not auto-clean).
const PLAN_SCENARIO_TMP_DIRS = new Set();
let planScenarioCleanupRegistered = false;

function registerPlanScenarioCleanup() {
  if (planScenarioCleanupRegistered) return;
  planScenarioCleanupRegistered = true;
  const cleanup = () => {
    for (const dir of PLAN_SCENARIO_TMP_DIRS) {
      try {
        fs.rmSync(dir, { force: true, recursive: true });
      } catch {
        // best-effort
      }
    }
    PLAN_SCENARIO_TMP_DIRS.clear();
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

function createTempRepo(label) {
  registerPlanScenarioCleanup();
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      `orgii-e2e-plan-${label.replace(/[^a-zA-Z0-9]/g, "-")}-`
    )
  );
  PLAN_SCENARIO_TMP_DIRS.add(root);
  fs.writeFileSync(
    path.join(root, "README.md"),
    `# ORGII Plan E2E\n\n${label}\n`,
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ORGII E2E",
      GIT_AUTHOR_EMAIL: "e2e@orgii.local",
      GIT_COMMITTER_NAME: "ORGII E2E",
      GIT_COMMITTER_EMAIL: "e2e@orgii.local",
    },
  });
  return root;
}

function planPrompt(config, markerFile, markerText) {
  return [
    `Draft a short implementation plan for ${config.label}.`,
    "The Build phase must do exactly one filesystem change and no other implementation work.",
    "Do not edit Cargo.toml, source files, config files, tests, or documentation.",
    `Plan a one-step Build that creates exactly one workspace marker file named ${markerFile}.`,
    `That marker file must contain exactly this single line: ${markerText}`,
    "Do not implement anything until the user clicks Build.",
    "The plan card must be ready for user approval.",
  ].join(" ");
}

async function createInitialPlan(config, repoPath, markerFile, markerText) {
  await configurePlanScenario(config, repoPath);
  await waitForModePill(`${config.label}-plan`, "Plan");
  const prompt = planPrompt(config, markerFile, markerText);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, prompt);
  await waitForChatLaunched(prompt);
  if (config.account.agent_type === CLAUDE_CODE_AGENT_TYPE) {
    await waitForClaudeCodePlanStreamingSurface(
      `${config.label}-initial-plan-streaming`
    );
  }
  await waitForPlanShellVisible(`${config.label}-initial-plan`);
  await waitForPlanCardReady(`${config.label}-initial-plan`);
  await assertPlanReadyTurnIdle(`${config.label}-initial-plan`);
  const state = await inspectChatState(`${config.label}-initial-plan`);
  const revisionId = planRevisionIdentity(state.pendingPlan);
  if (!revisionId) {
    throw new Error(
      `${config.label} initial plan did not expose a revision id; state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
  await assertPlanLatestOnly(
    `${config.label}-initial-plan`,
    revisionId,
    "history"
  );
  return { prompt, revisionId };
}

async function createSeededInitialPlan(
  config,
  repoPath,
  markerFile,
  markerText
) {
  await configurePlanScenario(config, repoPath);
  await waitForModePill(`${config.label}-seed-plan`, "Plan");
  unwrap(
    await invokeE2E("navigateTo", WORKSTATION_CODE_PATH),
    `${config.label}-navigate-workstation-code`
  );
  const sessionId = await launchSeedOnlySession(
    config,
    repoPath,
    `${config.label}-seed-plan`
  );
  const planContent = [
    `# Plan: create ${markerFile}`,
    "",
    "1. In Build mode, create exactly one workspace marker file.",
    `2. Write exactly ${markerText} to ${markerFile}.`,
    "3. Do not perform any other implementation work.",
  ].join("\n");
  const response = await postJsonFromNode(
    `${e2eUrl("/agent/test/sde/plan-approval/")}${encodeURIComponent(sessionId)}/seed`,
    {
      title: `E2E skip plan for ${config.label}`,
      content: planContent,
      plan_path: path.join(repoPath, ".orgii-e2e-skip-plan.md"),
      tool_call_id: `${sessionId}-plan-revision`,
    }
  );
  if (!response || response.ok !== true || !response.snapshot) {
    throw new Error(
      `${config.label} seed plan failed: ${JSON.stringify(response)}`
    );
  }
  unwrap(
    await invokeE2E("seedPlanCard", {
      sessionId,
      title: `E2E skip plan for ${config.label}`,
      content: planContent,
    }),
    `${config.label}-seedPlanCard`
  );
  await waitForPlanShellVisible(`${config.label}-seed-plan`);
  await waitForPlanCardReady(`${config.label}-seed-plan`);
  await assertPlanReadyTurnIdle(`${config.label}-seed-plan`);
  const state = await inspectChatState(`${config.label}-seed-plan`);
  const revisionId = planRevisionIdentity(state.pendingPlan);
  if (!revisionId) {
    throw new Error(
      `${config.label} seeded plan did not expose a revision id; state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
  await assertPlanLatestOnly(
    `${config.label}-seed-plan`,
    revisionId,
    "history"
  );
  return { prompt: planPrompt(config, markerFile, markerText), revisionId };
}

async function sendOrdinaryChatAndAssertNoPlan(config, marker, label) {
  const prompt = [
    `Answer this ordinary chat question for ${config.label}.`,
    `Reply with exactly this marker and no other words: ${marker}`,
    "Do not create a plan and do not modify files.",
  ].join(" ");
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, prompt);
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(label);
      return state.chatEvents.some(
        (event) =>
          event.source === "assistant" &&
          event.displayVariant === "message" &&
          event.displayText.includes(marker)
      );
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} ordinary chat marker did not appear; marker=${marker} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
  await assertNoPlanningFooterAfterAssistantReply(label);
  await assertNoLongRunningStopAfterAssistantReply(label);
  await assertAgentTurnCompleted(label);
  await waitForPlanGone(label);
}

async function sendNewPlanRequest(config, markerFile, markerText, label) {
  const prompt = planPrompt(config, markerFile, markerText);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, prompt);
  await waitForPlanShellVisible(label);
  await waitForPlanCardReady(label);
  await assertPlanReadyTurnIdle(label);
  const state = await inspectChatState(label);
  const revisionId = planRevisionIdentity(state.pendingPlan);
  if (!revisionId) {
    throw new Error(
      `${label} new plan did not expose a revision id; state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
  await assertPlanLatestOnly(label, revisionId, "history");
  await assertNoDuplicateThinkingEvents(label);
  return revisionId;
}

async function sendPlanSideChatAndAssertPinned(config, marker, revisionId) {
  const prompt = [
    `Answer this ordinary side question for ${config.label}: what is the exact marker?`,
    `Reply with exactly ${marker}.`,
    "Do not create, revise, or submit an approval plan for this question.",
  ].join(" ");
  const beforeState = await inspectChatState(
    `${config.label}-side-chat-before`
  );
  const beforeChatEventCount = beforeState.chatEventCount;
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, prompt);
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${config.label}-side-chat`);
      return state.chatEvents.some(
        (event) =>
          event.source === "assistant" &&
          event.displayVariant === "message" &&
          event.displayText.includes(marker)
      );
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${config.label} side chat marker did not appear while plan pending; marker=${marker} beforeCount=${beforeChatEventCount} state=${JSON.stringify(summarizeChatState(await inspectChatState(`${config.label}-side-chat-timeout`)))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
  await assertNoPlanningFooterAfterAssistantReply(`${config.label}-side-chat`);
  await assertNoLongRunningStopAfterAssistantReply(`${config.label}-side-chat`);
  await assertAgentTurnCompleted(`${config.label}-side-chat`);
  const afterState = await inspectChatState(`${config.label}-side-chat-after`);
  const afterRevisionId = planRevisionIdentity(afterState.pendingPlan);
  if (afterRevisionId !== revisionId) {
    throw new Error(
      `${config.label} side chat changed the pending plan revision; expected=${revisionId} actual=${afterRevisionId} state=${JSON.stringify(summarizeChatState(afterState))}`
    );
  }
  await assertPlanPinnedCollapsed(
    `${config.label}-side-chat-pinned`,
    revisionId
  );
}

async function assertPlanActionsDisabledWhileSessionRunning(label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await inspectChatState(label);
    const ui = await execJS(js.planUi);
    if (state.runtimeStatus === "running" && ui.rawBuildButtonCount > 0) {
      if (
        ui.rawEnabledBuildButtonCount > 0 ||
        ui.rawEnabledSkipButtonCount > 0 ||
        ui.planDocBuildEnabled
      ) {
        throw new Error(
          `${label} plan actions remained enabled while session was running; ui=${JSON.stringify(ui)} state=${JSON.stringify(summarizeChatState(state))}`
        );
      }
      return;
    }
    if (
      state.runtimeStatus !== "running" &&
      state.runtimeStatus !== "installing"
    ) {
      return;
    }
    await browser.pause(500);
  }
}

async function sendPlanUpdate(
  config,
  previousRevisionId,
  markerFile,
  markerText
) {
  const prompt = [
    `Revise the existing pending approval plan for ${config.label}.`,
    `The new plan revision must replace the previous Build target with a workspace marker file named ${markerFile}.`,
    `The marker file must contain exactly this single line: ${markerText}.`,
    `The updated plan must be a new pending plan revision, different from ${previousRevisionId}, and ready for Build.`,
    "Do not implement the Build yet.",
  ].join(" ");
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, prompt);
  await assertPlanActionsDisabledWhileSessionRunning(
    `${config.label}-plan-update-actions-disabled`
  );
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(
        `${config.label}-plan-update-no-queue`
      );
      return state.queuedMessages.length === 0;
    },
    {
      timeout: QUEUE_TIMEOUT_MS,
      timeoutMsg: `${config.label} queued pending-plan update instead of sending directly; state=${JSON.stringify(summarizeChatState(await inspectChatState(`${config.label}-plan-update-no-queue`)))}`,
    }
  );
  await waitForPendingPlanRevisionChange(
    `${config.label}-plan-update`,
    previousRevisionId
  );
  await waitForPlanCardReady(`${config.label}-plan-update`);
  const state = await inspectChatState(`${config.label}-plan-update`);
  const revisionId = planRevisionIdentity(state.pendingPlan);
  if (!revisionId) {
    throw new Error(
      `${config.label} updated plan did not expose a revision id; state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
  await assertPlanLatestOnly(
    `${config.label}-plan-update`,
    revisionId,
    "history"
  );
  await assertNoDuplicateThinkingEvents(`${config.label}-plan-update`);
  return revisionId;
}

async function waitForPendingPlanRestored(label, expectedRevisionId) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(label);
      return planRevisionIdentity(state.pendingPlan) === expectedRevisionId;
    },
    {
      timeout: FIRST_TURN_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${label} pending plan did not restore; expected=${expectedRevisionId} state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))} ui=${JSON.stringify(await execJS(js.planUi))}`,
    }
  );
}

async function reloadAndOpenSession(sessionId, label) {
  await browser.refresh();
  await waitForApp();
  unwrap(
    await invokeE2E("openSession", sessionId),
    `openSession(${sessionId})`
  );
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${label}-after-open`);
      return state.activeSessionId === sessionId && state.chatEventCount > 0;
    },
    {
      timeout: FIRST_TURN_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${label} did not restore session ${sessionId}; state=${JSON.stringify(summarizeChatState(await inspectChatState(label)))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function runRustAgentSwitchModeToPlanScenario(config) {
  if (config.category !== RUST_AGENT_CATEGORY) {
    throw new Error(
      `rust-agent mode-switch scenario requires category=${RUST_AGENT_CATEGORY}, got ${config.category} (${config.label})`
    );
  }

  const repoPath = createTempRepo(`${config.label}-switch-mode-plan`);
  const markerFile = `orgii-switch-mode-plan-${Date.now()}.md`;
  const markerText = `ORGII_SWITCH_MODE_PLAN_${Date.now()}`;
  const reason = "This architecture change needs a plan before implementation.";
  const prompt = "Switch to plan mode before doing any implementation work.";
  const planContent = [
    `# Plan: create ${markerFile}`,
    "",
    "1. In Build mode, create exactly one workspace marker file.",
    `2. Write exactly ${markerText} to ${markerFile}.`,
    "3. Do not perform any other implementation work.",
  ].join("\n");

  try {
    await execJS(`window.__ORGII_E2E_MODE_SWITCH_MOCK__ = false; return true;`);
    await configurePlanScenario(config, repoPath, "build");
    unwrap(
      await invokeE2E("navigateTo", WORKSTATION_CODE_PATH),
      `${config.label}-navigate-workstation-code`
    );
    await browser.waitUntil(
      async () =>
        String(await execJS("return window.location.pathname;")).includes(
          "/orgii/workstation"
        ),
      {
        timeout: 5_000,
        timeoutMsg: `${config.label} did not navigate to WorkStation`,
      }
    );
    const sessionId = await launchSeedOnlySession(
      config,
      repoPath,
      `${config.label}-mode-switch`
    );
    await seedBackendModeSwitchPending(
      config,
      sessionId,
      repoPath,
      "plan",
      reason
    );
    const seeded = unwrap(
      await invokeE2E("seedModeSwitchSession", {
        sessionId,
        repoPath,
        userText: prompt,
        reason,
        targetMode: "plan",
      }),
      `${config.label}-seedModeSwitchSession`
    );
    await assertBackendModeSwitchPending(
      sessionId,
      true,
      `${config.label}-backend-pending-before-switch`
    );
    await waitForModePill(`${config.label}-initial-build`, "Build");
    await assertEffectiveToolsForMode(
      sessionId,
      "build",
      `${config.label}-effective-tools-before-switch`
    );
    await waitForModeSwitchCard(`${config.label}-switch-mode-card`, reason);

    const beforeSwitchState = await inspectChatState(
      `${config.label}-before-switch`
    );
    const suggestEvents = beforeSwitchState.rawEvents.filter(
      (event) => event.functionName === "suggest_mode_switch"
    );
    const leakedNativeSwitchEvents = beforeSwitchState.rawEvents.filter(
      (event) =>
        event.functionName === "SwitchMode" ||
        event.functionName === "switch_mode" ||
        event.functionName === "switchmode"
    );
    if (suggestEvents.length !== 1 || leakedNativeSwitchEvents.length > 0) {
      throw new Error(
        `${config.label} did not expose exactly one ORGII suggest_mode_switch without native SwitchMode leakage; suggest=${suggestEvents.length} native=${JSON.stringify(leakedNativeSwitchEvents)} eventId=${seeded.eventId} state=${JSON.stringify(summarizeChatState(beforeSwitchState))}`
      );
    }

    await clickModeSwitchConfirm(`${config.label}-switch-mode-confirm`);
    await waitForModePill(`${config.label}-after-switch-plan`, "Plan");
    await assertBackendModeSwitchPending(
      sessionId,
      false,
      `${config.label}-backend-pending-after-switch`
    );
    await assertEffectiveToolsForMode(
      sessionId,
      "plan",
      `${config.label}-effective-tools-after-switch`
    );

    const afterSwitchState = await inspectChatState(
      `${config.label}-after-switch`
    );
    const resolvedSwitchEvent = afterSwitchState.rawEvents.find(
      (event) => event.id === seeded.eventId
    );
    if (
      !resolvedSwitchEvent ||
      resolvedSwitchEvent.activityStatus !== "processed" ||
      resolvedSwitchEvent.result?.choice !== "switch"
    ) {
      throw new Error(
        `${config.label} mode-switch event was not resolved through the production response path; event=${JSON.stringify(resolvedSwitchEvent)} state=${JSON.stringify(summarizeChatState(afterSwitchState))}`
      );
    }

    unwrap(
      await invokeE2E("seedPlanCard", {
        sessionId: seeded.sessionId,
        title: "E2E mode switch plan",
        content: planContent,
      }),
      `${config.label}-seedPlanCard`
    );
    await waitForPlanShellVisible(`${config.label}-plan-after-switch`);
    await waitForPlanCardReady(`${config.label}-plan-after-switch`);

    const filePath = path.join(repoPath, markerFile);
    if (fs.existsSync(filePath)) {
      throw new Error(
        `${config.label} created ${markerFile} before Build after mode switch`
      );
    }
  } finally {
    await execJS(
      `window.__ORGII_E2E_MODE_SWITCH_MOCK__ = false; return true;`
    ).catch(() => undefined);
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

async function runPendingPlanSideChatScenario(config) {
  const repoPath = createTempRepo(`${config.label}-pending-side-chat`);
  const markerFile = `orgii-plan-side-chat-${Date.now()}.md`;
  const markerText = `ORGII_PLAN_SIDE_CHAT_${Date.now()}`;
  const sideMarker = `ORGII_PLAN_SIDE_MARKER_${Date.now()}`;
  try {
    const initialPlan = await createInitialPlan(
      config,
      repoPath,
      markerFile,
      markerText
    );
    await sendPlanSideChatAndAssertPinned(
      config,
      sideMarker,
      initialPlan.revisionId
    );
    const filePath = path.join(repoPath, markerFile);
    if (fs.existsSync(filePath)) {
      throw new Error(
        `${config.label} created ${markerFile} before Build during side chat`
      );
    }
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

async function runSkipPendingPlanThenChatScenario(config) {
  const repoPath = createTempRepo(`${config.label}-skip-plan-chat`);
  const markerFile = `orgii-plan-skip-${Date.now()}.md`;
  const markerText = `ORGII_PLAN_SKIP_FILE_${Date.now()}`;
  const followupMarker = `ORGII_PLAN_SKIP_FOLLOWUP_${Date.now()}`;
  const markerPath = path.join(repoPath, markerFile);

  try {
    const initialPlan =
      config.category === CLI_AGENT_CATEGORY
        ? await createInitialPlan(config, repoPath, markerFile, markerText)
        : await createSeededInitialPlan(
            config,
            repoPath,
            markerFile,
            markerText
          );
    await clickPlanSkip(`${config.label}-skip-plan`);
    await waitForPlanGone(`${config.label}-skip-plan`);
    await waitForPlanSkipped(
      `${config.label}-skip-plan`,
      initialPlan.revisionId
    );
    if (fs.existsSync(markerPath)) {
      throw new Error(
        `${config.label} created ${markerFile} after Skip; content=${JSON.stringify(fs.readFileSync(markerPath, "utf8"))}`
      );
    }

    const prompt = [
      `The previous plan was skipped for ${config.label}.`,
      `Reply with exactly this marker and no other words: ${followupMarker}`,
      "Do not create a plan and do not modify files.",
    ].join(" ");
    const inputSelector = await waitForChatInput();
    await typeAndClickSend(inputSelector, prompt);
    await browser.waitUntil(
      async () => {
        const state = await inspectChatState(`${config.label}-after-skip-chat`);
        return state.chatEvents.some(
          (event) =>
            event.source === "assistant" &&
            event.displayVariant === "message" &&
            event.displayText.includes(followupMarker)
        );
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 2_000,
        timeoutMsg: `${config.label} did not continue chatting after Skip; marker=${followupMarker} state=${JSON.stringify(summarizeChatState(await inspectChatState(`${config.label}-after-skip-chat-timeout`)))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
      }
    );
    await waitForIdleSendButton(`${config.label}-after-skip-chat`);
    await waitForPlanGone(`${config.label}-after-skip-chat`);
    if (fs.existsSync(markerPath)) {
      throw new Error(
        `${config.label} created skipped plan file ${markerFile} during follow-up; content=${JSON.stringify(fs.readFileSync(markerPath, "utf8"))}`
      );
    }
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

async function runFirstChatThenNewPlanScenario(config) {
  const repoPath = createTempRepo(`${config.label}-first-chat-new-plan`);
  const chatMarker = `ORGII_PLAN_FIRST_CHAT_${Date.now()}`;
  const markerFile = `orgii-plan-first-chat-${Date.now()}.md`;
  const markerText = `ORGII_PLAN_FIRST_CHAT_FILE_${Date.now()}`;
  const markerPath = path.join(repoPath, markerFile);

  try {
    await configurePlanScenario(config, repoPath);
    await waitForModePill(`${config.label}-first-chat-plan-mode`, "Plan");
    await sendOrdinaryChatAndAssertNoPlan(
      config,
      chatMarker,
      `${config.label}-first-chat-no-plan`
    );
    await sendNewPlanRequest(
      config,
      markerFile,
      markerText,
      `${config.label}-first-chat-new-plan`
    );
    await clickPlanBuild(`${config.label}-first-chat-new-plan-build`);
    await waitForPlanGone(`${config.label}-first-chat-new-plan-build`);
    await waitForMarkerFile(config, markerPath, markerText);
    await assertAgentTurnCompleted(`${config.label}-first-chat-new-plan-build`);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

async function runPendingPlanSideChatThenUpdateScenario(config) {
  const repoPath = createTempRepo(`${config.label}-side-chat-update`);
  const firstMarkerFile = `orgii-plan-side-update-first-${Date.now()}.md`;
  const firstMarkerText = `ORGII_PLAN_SIDE_UPDATE_FIRST_${Date.now()}`;
  const updatedMarkerFile = `orgii-plan-side-update-latest-${Date.now()}.md`;
  const updatedMarkerText = `ORGII_PLAN_SIDE_UPDATE_LATEST_${Date.now()}`;
  const sideMarker = `ORGII_PLAN_SIDE_UPDATE_CHAT_${Date.now()}`;
  const updatedPath = path.join(repoPath, updatedMarkerFile);

  try {
    const initialPlan = await createInitialPlan(
      config,
      repoPath,
      firstMarkerFile,
      firstMarkerText
    );
    await sendPlanSideChatAndAssertPinned(
      config,
      sideMarker,
      initialPlan.revisionId
    );
    const updatedRevisionId = await sendPlanUpdate(
      config,
      initialPlan.revisionId,
      updatedMarkerFile,
      updatedMarkerText
    );
    await assertPlanRevisionReplaced(
      `${config.label}-side-chat-update-replaced`,
      initialPlan.revisionId,
      updatedRevisionId
    );
    await clickPlanBuild(`${config.label}-side-chat-update-build`);
    await waitForPlanGone(`${config.label}-side-chat-update-build`);
    await waitForMarkerFile(config, updatedPath, updatedMarkerText);
    await assertAgentTurnCompleted(`${config.label}-side-chat-update-build`);
    const ui = await execJS(js.planUi);
    if ((ui.enabledBuildRevisionIds ?? []).includes(initialPlan.revisionId)) {
      throw new Error(
        `${config.label} old side-chat plan revision remained buildable after update; old=${initialPlan.revisionId} latest=${updatedRevisionId} ui=${JSON.stringify(ui)}`
      );
    }
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

async function runBuildThenNewPlanScenario(config) {
  const repoPath = createTempRepo(`${config.label}-build-then-new-plan`);
  const firstMarkerFile = `orgii-plan-built-first-${Date.now()}.md`;
  const firstMarkerText = `ORGII_PLAN_BUILT_FIRST_${Date.now()}`;
  const secondMarkerFile = `orgii-plan-built-second-${Date.now()}.md`;
  const secondMarkerText = `ORGII_PLAN_BUILT_SECOND_${Date.now()}`;
  const firstPath = path.join(repoPath, firstMarkerFile);
  const secondPath = path.join(repoPath, secondMarkerFile);

  try {
    const firstPlan = await createInitialPlan(
      config,
      repoPath,
      firstMarkerFile,
      firstMarkerText
    );
    await clickPlanBuild(`${config.label}-build-then-new-plan-first-build`);
    await waitForPlanGone(`${config.label}-build-then-new-plan-first-build`);
    await waitForMarkerFile(config, firstPath, firstMarkerText);
    await assertAgentTurnCompleted(
      `${config.label}-build-then-new-plan-first-build`
    );

    const secondRevisionId = await sendNewPlanRequest(
      config,
      secondMarkerFile,
      secondMarkerText,
      `${config.label}-build-then-new-plan-second-plan`
    );
    if (secondRevisionId === firstPlan.revisionId) {
      throw new Error(
        `${config.label} second plan reused first revision id ${secondRevisionId}`
      );
    }
    await clickPlanBuild(`${config.label}-build-then-new-plan-second-build`);
    await waitForPlanGone(`${config.label}-build-then-new-plan-second-build`);
    await waitForMarkerFile(config, secondPath, secondMarkerText);
    await assertAgentTurnCompleted(
      `${config.label}-build-then-new-plan-second-build`
    );
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

async function runReloadFollowupBuildChatRewindScenario(config) {
  const repoPath = createTempRepo(`${config.label}-reload-build-chat`);
  const firstMarkerFile = `orgii-plan-reload-first-${Date.now()}.md`;
  const firstMarkerText = `ORGII_PLAN_RELOAD_FIRST_${Date.now()}`;
  const updatedMarkerFile = `orgii-plan-reload-updated-${Date.now()}.md`;
  const updatedMarkerText = `ORGII_PLAN_RELOAD_UPDATED_${Date.now()}`;
  const reloadSideMarker = `ORGII_PLAN_RELOAD_SIDE_${Date.now()}`;
  const afterBuildMarker = `ORGII_AFTER_PLAN_BUILD_CHAT_${Date.now()}`;
  const updatedFilePath = path.join(repoPath, updatedMarkerFile);

  try {
    const initialPlan = await createInitialPlan(
      config,
      repoPath,
      firstMarkerFile,
      firstMarkerText
    );
    const active = unwrap(
      await invokeE2E("getActiveSessionId"),
      `${config.label}-getActiveSessionId`
    );
    if (!active.sessionId) {
      throw new Error(`${config.label} has no active session before reload`);
    }

    await reloadAndOpenSession(active.sessionId, `${config.label}-reload`);
    await waitForPendingPlanRestored(
      `${config.label}-reload-restored-plan`,
      initialPlan.revisionId
    );

    const updatedRevisionId = await sendPlanUpdate(
      config,
      initialPlan.revisionId,
      updatedMarkerFile,
      updatedMarkerText
    );
    await clickPlanBuild(`${config.label}-reload-build-latest`);
    await waitForPlanGone(`${config.label}-reload-build-latest`);
    await waitForMarkerFile(config, updatedFilePath, updatedMarkerText);
    await waitForIdleSendButton(`${config.label}-reload-build-complete`);
    await waitForSessionInactive(`${config.label}-reload-build-complete`);

    const afterBuildPrompt = [
      `The plan was built. Now discuss an unrelated follow-up for ${config.label}.`,
      `Reply with exactly this marker and no other words: ${afterBuildMarker}`,
      "Do not create another plan and do not modify files.",
    ].join(" ");
    const inputSelector = await waitForChatInput();
    await typeAndClickSend(inputSelector, afterBuildPrompt);
    await browser.waitUntil(
      async () => {
        const state = await inspectChatState(
          `${config.label}-after-build-chat`
        );
        return state.chatEvents.some(
          (event) =>
            event.source === "assistant" &&
            event.displayVariant === "message" &&
            event.displayText.includes(afterBuildMarker)
        );
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 2_000,
        timeoutMsg: `${config.label} after-build side chat marker did not appear; marker=${afterBuildMarker} state=${JSON.stringify(summarizeChatState(await inspectChatState(`${config.label}-after-build-chat-timeout`)))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
      }
    );
    await waitForIdleSendButton(`${config.label}-after-build-chat`);
    await waitForPlanGone(`${config.label}-after-build-chat`);

    const state = await inspectChatState(`${config.label}-after-build-chat`);
    const ui = await execJS(js.planUi);
    const staleRevisionStillBuildable =
      ui.currentCardRevisionIds.includes(updatedRevisionId) ||
      ui.planDocRevisionId === updatedRevisionId ||
      ui.rawEnabledBuildButtonCount > 0 ||
      ui.planDocBuildEnabled;
    if (staleRevisionStillBuildable) {
      throw new Error(
        `${config.label} stale plan revision remained buildable after Build and side chat; revision=${updatedRevisionId} ui=${JSON.stringify(ui)} state=${JSON.stringify(summarizeChatState(state))}`
      );
    }

    await waitForFileChangesPanel(`${config.label}-plan-build-rewind`);
    await clickUndoAllAndConfirm(`${config.label}-plan-build-rewind`);
    await browser.waitUntil(
      async () => {
        const panel = await execJS(js.fileChanges);
        const fileExists = fs.existsSync(updatedFilePath);
        const fileHasMarker = fileExists
          ? fs.readFileSync(updatedFilePath, "utf8").includes(updatedMarkerText)
          : false;
        return !panel.undoAll && !fileHasMarker;
      },
      {
        timeout: 30_000,
        timeoutMsg: `${config.label} Plan Build Undo All did not rewind file after side chat; exists=${fs.existsSync(updatedFilePath)} content=${fs.existsSync(updatedFilePath) ? JSON.stringify(fs.readFileSync(updatedFilePath, "utf8")) : "<missing>"} fileChanges=${JSON.stringify(await execJS(js.fileChanges))}`,
      }
    );
    await waitForPlanGone(`${config.label}-after-rewind`);
  } finally {
    await execJS(
      `window.__orgiiE2EAutoConfirmDestructive = false; return true;`
    ).catch(() => undefined);
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

export {
  CONTROL_LABEL_FILTER,
  assertKnownControlScenarios,
  isControlScenarioExplicitlyRequested,
  listAccounts,
  runBuildThenNewPlanScenario,
  runFirstChatThenNewPlanScenario,
  runRustAgentSwitchModeToPlanScenario,
  runPendingPlanSideChatScenario,
  runPendingPlanSideChatThenUpdateScenario,
  runReloadFollowupBuildChatRewindScenario,
  runSkipPendingPlanThenChatScenario,
  scenarioConfigs,
  shouldRunScenario,
  waitForApp,
};
