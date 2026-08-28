/* global describe, before, it */
import {
  E2E_REPO_PATH,
  assertE2ERepoFixture,
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../../support/core/agentOrgUiDriver.mjs";

const ROUTE = "/orgii/app/settings/agent-orgs/agents";
const WORKSTATION_ROUTE = "/orgii/workstation/code";
const WAIT_TIMEOUT_MS = 30_000;
const BUILTIN_OS_AGENT_ID = "builtin:os";
const BUILTIN_SDE_AGENT_ID = "builtin:sde";
const BUILTIN_WINGMAN_AGENT_ID = "builtin:wingman";
const RUNTIME_CONFIG_MARKER = `E2E_AGENT_CONFIG_${Date.now()}`;
const CANONICAL_AGENT_TABS = [
  "general",
  "models",
  "subagents",
  "tools",
  "skillsets",
  "rules",
];

let currentAgentConfigRootSelector = null;

async function waitForScript(
  predicateScript,
  label,
  timeout = WAIT_TIMEOUT_MS,
  args = []
) {
  await browser.waitUntil(
    async () => browser.executeScript(predicateScript, args),
    { timeout, interval: 250, timeoutMsg: label }
  );
}

async function pointerClick(selector, label, options = {}) {
  let point = null;
  await browser
    .waitUntil(
      async () => {
        const rawPoint = await browser.executeScript(
          `
          try {
          const selector = arguments[0];
          const rootSelector = arguments[1];
          const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
          const root = roots[roots.length - 1] ?? document;
          const candidates = [...root.querySelectorAll(selector)].filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          });
          if (candidates.length === 0) {
            return JSON.stringify({ found: false, selector, bodyText: document.body.innerText.slice(0, 2000) });
          }
          // Probe candidates from last to first and, within each, several
          // vertical sample points. A sticky table header can cover the
          // geometric center of an otherwise fully clickable row; the old
          // single-point single-candidate probe reported those as covered.
          const probeElement = (element) => {
            element.scrollIntoView({ block: "center", inline: "center" });
            const rect = element.getBoundingClientRect();
            const x = Math.floor(rect.left + rect.width / 2);
            const ys = [
              Math.floor(rect.top + rect.height / 2),
              Math.floor(rect.top + rect.height * 0.75),
              Math.floor(rect.top + rect.height * 0.25),
            ];
            for (const y of ys) {
              const hit = document.elementFromPoint(x, y);
              if (hit?.closest?.(selector)) {
                return { element, rect, x, y, hit, hitMatches: true };
              }
            }
            const y = ys[0];
            const hit = document.elementFromPoint(x, y);
            const chain = [];
            let node = hit;
            for (let d = 0; d < 6 && node; d += 1) {
              chain.push({
                tag: node.tagName,
                testId: node.getAttribute?.("data-testid") || null,
                cls: typeof node.className === "string" ? node.className.slice(0, 80) : null,
              });
              node = node.parentElement;
            }
            const theadRects = [...document.querySelectorAll(".table-thead")].map((el) => {
              const r = el.getBoundingClientRect();
              return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
            });
            return { element, rect, x, y, hit, hitMatches: false, debug: { chain, theadRects, scrollY: window.scrollY } };
          };
          let probe = null;
          for (let i = candidates.length - 1; i >= 0; i -= 1) {
            probe = probeElement(candidates[i]);
            if (probe.hitMatches) break;
          }
          const { element, rect, x, y, hit, hitMatches } = probe;
          return JSON.stringify({
            found: true,
            selector,
            x,
            y,
            rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
            hitMatches,
            hit: hit ? {
              tag: hit.tagName,
              className: typeof hit.className === "string" ? hit.className : null,
              testId: hit.getAttribute?.("data-testid") || null,
              dataTabKey: hit.getAttribute?.("data-tab-key") || null,
              text: (hit.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 180),
            } : null,
            text: (element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 180),
            debug: probe.debug ?? null,
          });
          } catch (err) {
            return JSON.stringify({ scriptError: String(err && err.stack || err) });
          }
        `,
          [
            selector,
            (options.rootSelector ?? currentAgentConfigRootSelector) || "",
          ]
        );
        point = typeof rawPoint === "string" ? JSON.parse(rawPoint) : rawPoint;
        return (
          point?.found === true &&
          (options.jsClick === true || point?.hitMatches === true)
        );
      },
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        // NOTE: timeoutMsg is rendered lazily in the catch below — inlining
        // JSON.stringify(point) here would freeze the pre-loop null value.
        timeoutMsg: `${label} not clickable`,
      }
    )
    .catch((err) => {
      throw new Error(
        `${label} not clickable; last probe: ${JSON.stringify(point, null, 2)}`,
        { cause: err }
      );
    });
  if (options.jsClick === true) {
    const rawClickState = await browser.executeScript(
      `
        const selector = arguments[0];
        const rootSelector = arguments[1];
        const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
        const root = roots[roots.length - 1] ?? document;
        const candidates = [...root.querySelectorAll(selector)].filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        const element = candidates[candidates.length - 1] ?? null;
        if (!element) return JSON.stringify({ ok: false, reason: "missing" });
        element.click();
        return JSON.stringify({ ok: true, text: element.textContent?.trim() ?? "" });
      `,
      [selector, (options.rootSelector ?? currentAgentConfigRootSelector) || ""]
    );
    const clickState =
      typeof rawClickState === "string"
        ? JSON.parse(rawClickState)
        : rawClickState;
    if (clickState?.ok !== true) {
      throw new Error(
        `${label} js click failed: ${JSON.stringify(clickState)}`
      );
    }
    return point;
  }
  await browser
    .action("pointer")
    .move({ x: point.x, y: point.y })
    .down()
    .up()
    .perform();
  return point;
}

function agentConfigVariantFor(agentId) {
  if (agentId === BUILTIN_OS_AGENT_ID) return "builtin-os";
  if (agentId === BUILTIN_SDE_AGENT_ID) return "builtin-sde";
  if (agentId === BUILTIN_WINGMAN_AGENT_ID) return "wingman";
  return "custom";
}

async function restoreWorkstationIfFocused(rootSelector, label) {
  const restoreTarget = `e2e-restore-workstation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const state = await browser.executeScript(
    `
      const rootSelector = arguments[0];
      const restoreTarget = arguments[1];
      const root = document.querySelector(rootSelector);
      const rect = root?.getBoundingClientRect?.() ?? null;
      if (rect && rect.width > 0 && rect.height > 0) return { needed: false };
      document.querySelectorAll('[data-e2e-restore-workstation-target]').forEach((element) => {
        element.removeAttribute('data-e2e-restore-workstation-target');
      });
      const candidates = Array.from(document.querySelectorAll('button[aria-label]')).filter((button) => {
        const label = button.getAttribute('aria-label') || '';
        const buttonRect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        return /Workstation|工作站/.test(label) && buttonRect.width > 0 && buttonRect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      const button = candidates[0] ?? null;
      if (!button) return { needed: true, foundButton: false, rootRect: rect ? { width: rect.width, height: rect.height } : null };
      button.setAttribute('data-e2e-restore-workstation-target', restoreTarget);
      return { needed: true, foundButton: true, label: button.getAttribute('aria-label') };
    `,
    [rootSelector, restoreTarget]
  );
  if (state?.needed !== true) return;
  if (state?.foundButton !== true) {
    throw new Error(
      `${label} needed Workstation restore but no visible restore button was found: ${JSON.stringify(state)}`
    );
  }
  const previousRoot = currentAgentConfigRootSelector;
  currentAgentConfigRootSelector = null;
  await pointerClick(
    `[data-e2e-restore-workstation-target="${restoreTarget}"]`,
    `${label} restore Workstation button`
  );
  currentAgentConfigRootSelector = previousRoot;
  await waitForScript(
    `
      const root = document.querySelector(arguments[0]);
      const rect = root?.getBoundingClientRect?.();
      return !!rect && rect.width > 0 && rect.height > 0;
    `,
    `${label} Workstation did not become visible after restore`,
    WAIT_TIMEOUT_MS,
    [rootSelector]
  );
}

async function openAgentDetail(agentId, label) {
  currentAgentConfigRootSelector = null;
  unwrap(await invokeE2E("navigateTo", ROUTE), `navigate to ${label}`);
  await waitForScript(
    `return !!document.querySelector('[data-testid="agent-orgs-agent-row-${agentId}"]');`,
    `${label} row did not render after navigating to Agent settings`
  );
  await pointerClick(
    `[data-testid="agent-orgs-agent-row-${agentId}"]`,
    `${label} row`
  );
  const openResult = unwrap(
    await invokeE2E("openAgentTab", agentId, "general"),
    `open ${label} agent tab`
  );
  const previousRoot = currentAgentConfigRootSelector;
  currentAgentConfigRootSelector = null;
  await pointerClick(
    '[data-testid="station-mode-my-station"]',
    `${label} My Station switch`,
    {
      jsClick: true,
    }
  );
  currentAgentConfigRootSelector = previousRoot;
  const focusedResult = unwrap(
    await invokeE2E("openAgentTab", agentId, "general"),
    `refocus ${label} agent tab after station switch`
  );
  const variant = agentConfigVariantFor(agentId);
  currentAgentConfigRootSelector = `[data-testid="agent-config-tab-${variant}-${agentId}"]`;
  try {
    await waitForScript(
      `return !!document.querySelector(arguments[0]);`,
      `${label} agent-config tab root did not mount`,
      WAIT_TIMEOUT_MS,
      [currentAgentConfigRootSelector]
    );
  } catch (error) {
    const workstationSurface = await invokeE2E("inspectWorkstationSurface");
    const diagnostic = await browser.executeScript(
      `
        const selector = arguments[0];
        const testIds = Array.from(document.querySelectorAll('[data-testid]'))
          .map((element) => element.getAttribute('data-testid'))
          .filter(Boolean)
          .slice(0, 140);
        return {
          selector,
          matchingCount: document.querySelectorAll(selector).length,
          testIds,
          bodyText: document.body?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 1200) ?? null,
        };
      `,
      [currentAgentConfigRootSelector]
    );
    throw new Error(
      `${label} agent-config tab root did not mount: ${JSON.stringify({ openResult, focusedResult, workstationSurface, diagnostic })}`,
      { cause: error }
    );
  }
  await restoreWorkstationIfFocused(currentAgentConfigRootSelector, label);
  await waitForScript(
    `
      const element = document.querySelector(arguments[0]);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    `,
    `${label} agent-config tab did not become visible`,
    WAIT_TIMEOUT_MS,
    [currentAgentConfigRootSelector]
  );
}

async function assertTabActive(tabKey) {
  await waitForScript(
    `
      const tabKey = arguments[0];
      const rootSelector = arguments[1];
      const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
      const root = roots[roots.length - 1] ?? document;
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const detailRoots = [...root.querySelectorAll('[data-active-tab]')].filter(isVisible);
      const detailRoot = detailRoots[detailRoots.length - 1] ?? null;
      if (detailRoot?.getAttribute("data-active-tab") === tabKey) return true;
      const elements = [...root.querySelectorAll('[data-testid^="agent-orgs-detail-tab-"]')].filter((element) => {
        return isVisible(element) && (element.getAttribute("data-tab-key") === tabKey || element.getAttribute("data-testid") === "agent-orgs-detail-tab-" + tabKey);
      });
      const element = elements[elements.length - 1] ?? null;
      return element?.getAttribute("data-active") === "true";
    `,
    `${tabKey} tab did not become active`,
    WAIT_TIMEOUT_MS,
    [tabKey, currentAgentConfigRootSelector]
  );
}

async function clickAgentTab(tabKey) {
  let clickState = null;
  await browser.waitUntil(
    async () => {
      clickState = await browser.executeScript(
        `
          const tabKey = arguments[0];
          const rootSelector = arguments[1];
          const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
          const root = roots[roots.length - 1] ?? document;
          const isVisible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          const candidates = [...root.querySelectorAll('[data-testid^="agent-orgs-detail-tab-"]')].filter((element) => {
            return isVisible(element) && (element.getAttribute("data-tab-key") === tabKey || element.getAttribute("data-testid") === "agent-orgs-detail-tab-" + tabKey);
          });
          const element = candidates[candidates.length - 1] ?? null;
          if (!element) {
            return {
              ok: false,
              reason: "missing",
              rootSelector,
              activeTabs: [...root.querySelectorAll('[data-testid^="agent-orgs-detail-tab-"]')].map((tab) => ({
                testId: tab.getAttribute('data-testid'),
                active: tab.getAttribute('data-active'),
                text: tab.textContent?.trim() ?? '',
              })),
            };
          }
          element.scrollIntoView({ block: "center", inline: "center" });
          element.click();
          return { ok: true, activeBefore: element.getAttribute('data-active'), text: element.textContent?.trim() ?? '' };
        `,
        [tabKey, currentAgentConfigRootSelector]
      );
      return clickState?.ok === true;
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${tabKey} tab did not render in current detail surface: ${JSON.stringify(clickState)}`,
    }
  );
  await assertTabActive(tabKey);
}

async function openAgentTabForControls(agentId, tabKey, label) {
  unwrap(
    await invokeE2E("openAgentTab", agentId, tabKey),
    `open ${label} ${tabKey} tab`
  );
  const variant = agentConfigVariantFor(agentId);
  currentAgentConfigRootSelector = `[data-testid="agent-config-tab-${variant}-${agentId}"]`;
  await restoreWorkstationIfFocused(
    currentAgentConfigRootSelector,
    `${label} ${tabKey}`
  );
  await assertTabActive(tabKey);
}

async function clickSwitchAndWait(selector, label) {
  const readVisibleSwitchStateScript = `
    const selector = arguments[0];
    const rootSelector = arguments[1];
    const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
    const root = roots[roots.length - 1] ?? document;
    const candidates = [...root.querySelectorAll(selector)].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const state = element.getAttribute("aria-checked");
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        (state === "true" || state === "false") &&
        !element.disabled
      );
    });
    const element = candidates[candidates.length - 1] ?? null;
    return element?.getAttribute("aria-checked") ?? null;
  `;
  await browser.waitUntil(
    async () => {
      const state = await browser.executeScript(readVisibleSwitchStateScript, [
        selector,
        currentAgentConfigRootSelector,
      ]);
      return state === "true" || state === "false";
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} did not become an enabled switch`,
    }
  );
  const before = await browser.executeScript(readVisibleSwitchStateScript, [
    selector,
    currentAgentConfigRootSelector,
  ]);
  if (before !== "true" && before !== "false") {
    throw new Error(`${label} did not expose switch state: ${before}`);
  }
  const clickState = await browser.executeScript(
    `
      const selector = arguments[0];
      const rootSelector = arguments[1];
      const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
      const root = roots[roots.length - 1] ?? document;
      const candidates = [...root.querySelectorAll(selector)].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const state = element.getAttribute("aria-checked");
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (state === "true" || state === "false") &&
          !element.disabled
        );
      });
      const element = candidates[candidates.length - 1] ?? null;
      if (!element) return { ok: false, reason: "missing", selector, rootSelector };
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return { ok: true, before: arguments[2], afterImmediate: element.getAttribute("aria-checked") };
    `,
    [selector, currentAgentConfigRootSelector, before]
  );
  if (clickState?.ok !== true) {
    throw new Error(
      `${label} switch click failed: ${JSON.stringify(clickState)}`
    );
  }
  return before === "true" ? false : true;
}

function assertIncludes(arrayValue, expected, label) {
  if (!Array.isArray(arrayValue) || !arrayValue.includes(expected)) {
    throw new Error(
      `${label} missing ${expected}: ${JSON.stringify(arrayValue)}`
    );
  }
}

function assertNotIncludes(arrayValue, unexpected, label) {
  if (Array.isArray(arrayValue) && arrayValue.includes(unexpected)) {
    throw new Error(
      `${label} unexpectedly included ${unexpected}: ${JSON.stringify(arrayValue)}`
    );
  }
}

async function listAccounts() {
  return unwrap(await invokeE2E("listAccounts"), "listAccounts").accounts;
}

async function invokeSnapshot(helperName, sessionId, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await invokeE2E(helperName, sessionId);
    if (result?.ok) {
      return result;
    }
    lastError = result?.error ?? JSON.stringify(result);
    await browser.pause(500);
  }
  throw new Error(`${label} snapshot did not become available: ${lastError}`);
}

async function cleanupStaleE2EAgentDefs() {
  const result = unwrap(
    await invokeE2E("listAgentDefs"),
    "list agent definitions for stale E2E cleanup"
  );
  const defs = Array.isArray(result.defs) ? result.defs : [];
  for (const definition of defs) {
    const id = String(definition?.id ?? "");
    if (
      id.startsWith("e2e-ui-settings-") ||
      id.startsWith("e2e-parent-") ||
      id.startsWith("e2e-child-") ||
      id.includes("E2E_AGENT_CONFIG_")
    ) {
      await invokeE2E("removeAgentDef", id);
    }
  }
  await refreshAgentRows();
}

function selectRuntimeAccount(accounts) {
  const candidates = accounts.filter(
    (account) =>
      account.enabled &&
      account.supports_rust_agents &&
      (account.has_api_key || account.has_session_token) &&
      (account.enabled_models ?? []).length > 0
  );
  return (
    candidates.find((account) => account.agent_type === "codex") ??
    candidates.find((account) => account.agent_type === "openai_api") ??
    candidates[0]
  );
}

function selectModel(account) {
  const models = account?.enabled_models ?? [];
  if (models.length === 0) {
    throw new Error(
      `Account has no enabled models: ${JSON.stringify(account)}`
    );
  }
  return models[0];
}

async function refreshAgentRows() {
  unwrap(await invokeE2E("refreshAgentDefs"), "refresh agent definitions");
}

async function setTextInput(selector, value, label) {
  const targetId = `e2e-input-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await waitForScript(
    `
      const selector = arguments[0];
      const targetId = arguments[1];
      const rootSelector = arguments[2];
      const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
      const root = roots[roots.length - 1] ?? document;
      document.querySelectorAll("[data-e2e-input-target]").forEach((element) => {
        element.removeAttribute("data-e2e-input-target");
      });
      const candidates = [...root.querySelectorAll(selector)].filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) &&
          !candidate.disabled &&
          !candidate.readOnly
        );
      });
      const element = candidates[candidates.length - 1] ?? null;
      if (!element) return false;
      element.setAttribute("data-e2e-input-target", targetId);
      return true;
    `,
    `${label} missing or disabled`,
    WAIT_TIMEOUT_MS,
    [selector, targetId, currentAgentConfigRootSelector]
  );

  await browser.executeScript(
    `
      const targetId = arguments[0];
      const value = arguments[1];
      const element = document.querySelector(
        '[data-e2e-input-target="' + CSS.escape(targetId) + '"]'
      );
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        throw new Error("target input disappeared");
      }
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
      descriptor?.set?.call(element, value);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
      return element.value;
    `,
    [targetId, String(value)]
  );
  await browser.waitUntil(
    async () =>
      browser.executeScript(
        `
          const targetId = arguments[0];
          const expected = arguments[1];
          const element = document.querySelector(
            '[data-e2e-input-target="' + CSS.escape(targetId) + '"]'
          );
          if (!element) return false;
          if (element.value === expected) return true;
          const numericActual = Number(String(element.value).replace(/,/g, ""));
          const numericExpected = Number(expected);
          return expected.trim() !== "" && !Number.isNaN(numericActual) && !Number.isNaN(numericExpected) && numericActual === numericExpected;
        `,
        [targetId, String(value)]
      ),
    {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: `${label} did not reflect typed value`,
    }
  );
}

async function setNumberInput(selector, value, label) {
  await setTextInput(selector, String(value), label);
}

async function setMarkdownEditor(selector, value, label) {
  await waitForScript(
    `
      const rootSelector = arguments[1];
      const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
      const surface = roots[roots.length - 1] ?? document;
      const root = surface.querySelector(arguments[0]);
      const editor = root?.querySelector(".cm-content[contenteditable='true']");
      if (!root || !editor) return false;
      const rect = editor.getBoundingClientRect();
      const style = window.getComputedStyle(editor);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    `,
    `${label} markdown editor did not become editable`,
    WAIT_TIMEOUT_MS,
    [selector, currentAgentConfigRootSelector]
  );

  const result = await browser.executeScript(
    `
      const rootSelector = arguments[2];
      const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
      const surface = roots[roots.length - 1] ?? document;
      const root = surface.querySelector(arguments[0]);
      const value = arguments[1];
      const editor = root?.querySelector(".cm-content[contenteditable='true']");
      if (!editor) return { ok: false, reason: "editor-missing" };
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete", false);
      const inserted = document.execCommand("insertText", false, value);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return { ok: inserted, text: editor.textContent || "" };
    `,
    [selector, String(value), currentAgentConfigRootSelector]
  );
  if (!result?.ok || !String(result.text ?? "").includes(String(value))) {
    throw new Error(
      `${label} markdown editor did not accept text: ${JSON.stringify(result)}`
    );
  }
}

async function waitForAgentDefField(agentId, predicate, label) {
  let lastDefinition = null;
  let lastNonNullDefinition = null;
  await browser.waitUntil(
    async () => {
      const definition = unwrap(
        await invokeE2E("getAgentDef", agentId),
        `poll ${label}`
      ).def;
      lastDefinition = definition;
      if (definition) lastNonNullDefinition = definition;
      return predicate(definition);
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} did not persist. Last=${JSON.stringify(lastDefinition)} LastNonNull=${JSON.stringify(lastNonNullDefinition)}`,
    }
  );
  return lastDefinition ?? lastNonNullDefinition;
}

function expectDefinitionField(definition, predicate, label) {
  if (!predicate(definition)) {
    throw new Error(
      `${label} mismatch in definition: ${JSON.stringify(definition)}`
    );
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`
    );
  }
}

describe("Settings Agent configuration UI", () => {
  before(async () => {
    assertE2ERepoFixture();
    await waitForApp();
    await browser.executeScript(
      `
        localStorage.setItem("orgii:auth_skipped", "1");
        return true;
      `,
      []
    );
    unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "pin custom config E2E repo"
    );
    await cleanupStaleE2EAgentDefs();
  });

  it("opens built-in Agent configuration tabs without covered click targets", async () => {
    await openAgentDetail(BUILTIN_OS_AGENT_ID, "OS Agent");

    await waitForScript(
      `return !!document.querySelector('[data-testid="agent-orgs-builtin-detail-os"]');`,
      "OS Agent detail panel did not open"
    );

    for (const tabKey of CANONICAL_AGENT_TABS) {
      await clickAgentTab(tabKey);
    }

    await openAgentDetail(BUILTIN_SDE_AGENT_ID, "SDE Agent");
    await waitForScript(
      `return !!document.querySelector('[data-testid="agent-orgs-builtin-detail-sde"]');`,
      "SDE Agent detail panel did not open"
    );

    for (const tabKey of CANONICAL_AGENT_TABS) {
      await clickAgentTab(tabKey);
    }
  });

  it("persists workspace Skills and Rules switches from UI to agent definition", async () => {
    await openAgentDetail(BUILTIN_SDE_AGENT_ID, "SDE Agent");

    const beforeDefinition = unwrap(
      await invokeE2E("getAgentDef", BUILTIN_SDE_AGENT_ID),
      "get SDE Agent definition before switch test"
    ).def;

    await openAgentTabForControls(
      BUILTIN_SDE_AGENT_ID,
      "skillsets",
      "SDE Agent"
    );
    const loadWorkspaceResources = await clickSwitchAndWait(
      '[data-testid="agent-orgs-load-workspace-resources-switch"]',
      "load workspace resources switch"
    );
    await browser.waitUntil(
      async () => {
        const definition = unwrap(
          await invokeE2E("getAgentDef", BUILTIN_SDE_AGENT_ID),
          "poll SDE Agent loadWorkspaceResources"
        ).def;
        return definition.loadWorkspaceResources === loadWorkspaceResources;
      },
      {
        timeout: 15_000,
        interval: 500,
        timeoutMsg:
          "loadWorkspaceResources did not persist to agent definition",
      }
    );

    await openAgentTabForControls(BUILTIN_SDE_AGENT_ID, "rules", "SDE Agent");
    const loadWorkspaceRules = await clickSwitchAndWait(
      '[data-testid="agent-orgs-load-workspace-rules-switch"]',
      "load workspace rules switch"
    );
    await browser.waitUntil(
      async () => {
        const definition = unwrap(
          await invokeE2E("getAgentDef", BUILTIN_SDE_AGENT_ID),
          "poll SDE Agent loadWorkspaceRules"
        ).def;
        return definition.loadWorkspaceRules === loadWorkspaceRules;
      },
      {
        timeout: 15_000,
        interval: 500,
        timeoutMsg: "loadWorkspaceRules did not persist to agent definition",
      }
    );

    unwrap(
      await invokeE2E("updateAgentDefPatch", BUILTIN_SDE_AGENT_ID, {
        loadWorkspaceResources: beforeDefinition.loadWorkspaceResources ?? true,
        loadWorkspaceRules: beforeDefinition.loadWorkspaceRules ?? true,
      }),
      "restore SDE Agent workspace toggles"
    );
  });

  it("persists Wingman Desktop Safety switches from Settings UI to desktop config", async () => {
    const beforeConfig = unwrap(
      await invokeE2E("getDesktopConfig"),
      "get desktop config before Settings UI test"
    ).config;

    try {
      await openAgentDetail(BUILTIN_WINGMAN_AGENT_ID, "Wingman Agent");
      await waitForScript(
        `return !!document.querySelector('[data-testid="agent-orgs-custom-detail"]');`,
        "Wingman detail panel did not open"
      );
      await openAgentTabForControls(
        BUILTIN_WINGMAN_AGENT_ID,
        "safety",
        "Wingman Agent"
      );

      const hideBeforeAction = await clickSwitchAndWait(
        '[data-testid="agent-orgs-desktop-safety-hideBeforeAction-switch"]',
        "desktop safety hide-before-action switch"
      );
      const antiDetection = await clickSwitchAndWait(
        '[data-testid="agent-orgs-desktop-safety-antiDetection-switch"]',
        "desktop safety anti-detection switch"
      );

      await browser.waitUntil(
        async () => {
          const current = unwrap(
            await invokeE2E("getDesktopConfig"),
            "poll desktop config after Settings UI switches"
          ).config;
          return (
            current.hideBeforeAction === hideBeforeAction &&
            current.antiDetection === antiDetection
          );
        },
        {
          timeout: 15_000,
          interval: 500,
          timeoutMsg:
            "Desktop Safety switches did not persist to desktop config",
        }
      );
    } finally {
      unwrap(
        await invokeE2E("setDesktopConfig", beforeConfig),
        "restore desktop config after Settings UI test"
      );
    }
  });

  it("writes custom Agent Settings controls from rendered UI into AgentDefinition", async () => {
    const agentId = `e2e-ui-settings-${RUNTIME_CONFIG_MARKER}`;
    const mcpServerName = `e2e-mcp-${RUNTIME_CONFIG_MARKER}`;
    const mcpToolName = `e2e_tool_${RUNTIME_CONFIG_MARKER.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const mcpToolKey = `mcp__${mcpServerName}__${mcpToolName}`;
    const ruleName = `e2e-rule-${RUNTIME_CONFIG_MARKER}`;
    let originalMcpConfig = null;
    const initialDefinition = {
      id: agentId,
      name: `E2E UI Settings ${RUNTIME_CONFIG_MARKER}`,
      description: "Temporary E2E custom agent for rendered Settings controls.",
      builtIn: false,
      tier: "primary",
      inheritsFrom: BUILTIN_SDE_AGENT_ID,
      capabilities: { coding: { modeSwitch: true } },
      delegationConfig: { delegatable: true, contextBuilders: [] },
      sessionModel: {
        mode: "singleton",
        processingLock: true,
        maxIterations: 5,
        compaction: {
          enabled: true,
          triggerRatio: 0.8,
        },
      },
      contextWindow: 128_000,
      maxTokens: 8_192,
      temperature: 0.7,
      execTimeout: 120,
      maxToolUseConcurrency: 10,
      agentPolicy: {
        autonomy: "full",
        workspaceOnly: true,
        blockedCommands: [],
        riskRules: { medium: [], high: [] },
      },
      tools: { userAllowedTools: [], excludedTools: [] },
      skillsConfig: { enabled: true, include: [], exclude: [], sourceDirs: [] },
      soulContent: `Initial soul ${RUNTIME_CONFIG_MARKER}`,
    };

    try {
      originalMcpConfig = unwrap(
        await invokeE2E("mcpGetConfig", "global"),
        "get original MCP config for Agent Settings UI test"
      ).config;
      unwrap(
        await invokeE2E(
          "mcpUpdateServers",
          {
            mcpServers: {
              ...(originalMcpConfig.mcpServers ?? {}),
              [mcpServerName]: {
                type: "stdio",
                command: "node",
                args: [
                  "-e",
                  `const toolName = ${JSON.stringify(mcpToolName)};
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "orgii-e2e-mcp", version: "1.0.0" } } });
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: toolName, description: "E2E MCP tool", inputSchema: { type: "object", properties: {} } }] } });
    } else if (request.method === "tools/call") {
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok" }] } });
    } else if (request.id !== undefined) {
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    }
  }
});`,
                ],
                disabled: false,
                timeout: 5,
              },
            },
          },
          "global"
        ),
        "seed MCP server for Agent Settings UI test"
      );
      unwrap(
        await invokeE2E("createPolicy", {
          name: ruleName,
          content: `# ${ruleName}\n\nE2E rule content ${RUNTIME_CONFIG_MARKER}`,
          source: "personal",
          agents: [],
          scopeRepoPaths: null,
          scopeExcludeRepoPaths: null,
        }),
        "seed policy for Agent Settings UI test"
      );
      unwrap(
        await invokeE2E("addAgentDef", initialDefinition),
        "add rendered UI settings agent definition"
      );
      await waitForAgentDefField(
        agentId,
        (definition) => definition?.id === agentId,
        "rendered UI settings agent immediately after add"
      );
      await refreshAgentRows();
      await openAgentDetail(agentId, "E2E rendered UI settings custom Agent");
      await waitForScript(
        `
          const elements = [...document.querySelectorAll('[data-testid="agent-orgs-custom-detail"]')];
          return elements.some((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          });
        `,
        "custom Agent detail panel did not open"
      );
      await openAgentTabForControls(
        agentId,
        "general",
        "E2E rendered UI settings custom Agent"
      );

      await setTextInput(
        '[data-testid="agent-orgs-custom-name-input"]',
        `E2E UI Settings Edited ${RUNTIME_CONFIG_MARKER}`,
        "custom Agent name"
      );
      await setTextInput(
        '[data-testid="agent-orgs-custom-description-input"]',
        `Edited rendered description ${RUNTIME_CONFIG_MARKER}`,
        "custom Agent description"
      );
      const editedSoulContent = `Edited rendered soul ${RUNTIME_CONFIG_MARKER}`;
      await pointerClick(
        '[data-testid="agent-orgs-personality-edit-button"]',
        "personality edit button"
      );
      await setMarkdownEditor(
        '[data-testid="agent-orgs-personality-editor"]',
        editedSoulContent,
        "personality soul editor"
      );
      await waitForScript(
        `
          const root = document.querySelector(arguments[0]);
          const button = root?.querySelector('[data-testid="agent-orgs-personality-save-button"]');
          return !!button && button.disabled === false;
        `,
        "personality save button did not become enabled after editor change",
        WAIT_TIMEOUT_MS,
        [currentAgentConfigRootSelector]
      );
      await pointerClick(
        '[data-testid="agent-orgs-personality-save-button"]',
        "personality save button"
      );
      await waitForAgentDefField(
        agentId,
        (definition) => definition?.soulContent === editedSoulContent,
        "rendered UI settings agent soulContent after personality save"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-runtime-max-iterations-input"]',
        7,
        "max iterations"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-runtime-exec-timeout-input"]',
        135,
        "exec timeout"
      );
      const workspaceOnly = await clickSwitchAndWait(
        '[data-testid="agent-orgs-security-workspace-only-switch"]',
        "security workspace-only switch"
      );
      const blockListCommand = `e2e-deny-${RUNTIME_CONFIG_MARKER}`;
      const alwaysAskCommand = `e2e-ask-${RUNTIME_CONFIG_MARKER}`;
      await setTextInput(
        '[data-testid="agent-orgs-security-block-list-textarea"]',
        blockListCommand,
        "security block-list textarea"
      );
      await pointerClick(
        '[data-testid="agent-orgs-security-block-list-save-button"]',
        "security block-list save button"
      );
      await setTextInput(
        '[data-testid="agent-orgs-security-always-ask-textarea"]',
        alwaysAskCommand,
        "security always-ask textarea"
      );
      await pointerClick(
        '[data-testid="agent-orgs-security-always-ask-save-button"]',
        "security always-ask save button"
      );

      await openAgentTabForControls(
        agentId,
        "models",
        "E2E rendered UI settings custom Agent"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-context-window-input"]',
        64_000,
        "context window"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-max-tokens-input"]',
        4_096,
        "max tokens"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-temperature-input"]',
        0.3,
        "temperature"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-model-compaction-enabled-switch"]',
        "compaction enabled switch off"
      );
      await waitForAgentDefField(
        agentId,
        (definition) => definition?.sessionModel?.compaction?.enabled === false,
        "rendered UI settings agent compaction disabled"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-model-compaction-enabled-switch"]',
        "compaction enabled switch on"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-model-compaction-advanced-switch"]',
        "compaction advanced switch"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-compaction-trigger-ratio-input"]',
        0.65,
        "compaction trigger ratio"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-compaction-keep-ratio-input"]',
        0.35,
        "compaction keep ratio"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-compaction-summary-max-tokens-input"]',
        2048,
        "compaction summary max tokens"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-compaction-min-messages-input"]',
        11,
        "compaction min messages"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-compaction-floor-tokens-input"]',
        12_000,
        "compaction floor tokens"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-compaction-reserved-summary-tokens-input"]',
        18_000,
        "compaction reserved summary tokens"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-compaction-buffer-tokens-input"]',
        9_000,
        "compaction buffer tokens"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-model-reliability-enabled-switch"]',
        "reliability enabled switch off"
      );
      await waitForAgentDefField(
        agentId,
        (definition) => definition?.reliability?.maxRetries === 0,
        "rendered UI settings agent reliability disabled"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-model-reliability-enabled-switch"]',
        "reliability enabled switch on"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-reliability-max-retries-input"]',
        4,
        "reliability max retries"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-model-reliability-base-backoff-input"]',
        750,
        "reliability base backoff"
      );

      await openAgentTabForControls(
        agentId,
        "subagents",
        "E2E rendered UI settings custom Agent"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-subagents-max-tool-use-concurrency-input"]',
        6,
        "max tool-use concurrency"
      );

      await openAgentTabForControls(
        agentId,
        "tools",
        "E2E rendered UI settings custom Agent"
      );
      const toggledToolName = await browser.waitUntil(
        async () =>
          browser.executeScript(
            `
              const switchElement = document.querySelector('[data-testid^="agent-orgs-tool-switch-"]');
              if (!switchElement) return null;
              const testId = switchElement.getAttribute("data-testid") ?? "";
              return testId.replace("agent-orgs-tool-switch-", "");
            `,
            []
          ),
        {
          timeout: WAIT_TIMEOUT_MS,
          interval: 250,
          timeoutMsg: "tool switch did not render for custom Agent",
        }
      );
      await clickSwitchAndWait(
        `[data-testid="agent-orgs-tool-switch-${toggledToolName}"]`,
        `tool switch ${toggledToolName}`
      );

      await openAgentTabForControls(
        agentId,
        "skillsets",
        "E2E rendered UI settings custom Agent"
      );
      const toggledSkillName = await browser.waitUntil(
        async () =>
          browser.executeScript(
            `
              const switchElement = document.querySelector('[data-testid^="agent-orgs-skill-switch-"]');
              if (!switchElement) return null;
              const testId = switchElement.getAttribute("data-testid") ?? "";
              return testId.replace("agent-orgs-skill-switch-", "");
            `,
            []
          ),
        {
          timeout: WAIT_TIMEOUT_MS,
          interval: 250,
          timeoutMsg: "skill switch did not render for custom Agent",
        }
      );
      await clickSwitchAndWait(
        `[data-testid="agent-orgs-skill-switch-${toggledSkillName}"]`,
        `skill switch ${toggledSkillName}`
      );
      await waitForAgentDefField(
        agentId,
        (definition) => definition?.id === agentId,
        "rendered UI settings agent after Skill switch"
      );
      await browser.waitUntil(
        async () => {
          const tools = unwrap(
            await invokeE2E("mcpListServerTools", mcpServerName),
            `poll MCP tools for ${mcpServerName}`
          ).tools;
          return tools.some((tool) => tool.name === mcpToolName);
        },
        {
          timeout: WAIT_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "seeded MCP server did not expose its E2E tool",
        }
      );
      await pointerClick(
        `[data-testid="agent-orgs-mcp-server-row-${mcpServerName}"]`,
        `MCP server row ${mcpServerName}`
      );
      await clickSwitchAndWait(
        `[data-testid="agent-orgs-mcp-tool-switch-${mcpServerName}-${mcpToolName}"]`,
        `MCP tool switch ${mcpToolName}`
      );
      await waitForAgentDefField(
        agentId,
        (definition) =>
          (definition?.tools?.disabledMcpTools ?? []).includes(mcpToolKey),
        "rendered UI settings agent disabled MCP tool after MCP tool switch"
      );
      await clickSwitchAndWait(
        `[data-testid="agent-orgs-mcp-server-switch-${mcpServerName}"]`,
        `MCP server switch ${mcpServerName}`
      );
      await waitForAgentDefField(
        agentId,
        (definition) =>
          (definition?.tools?.disabledMcpServers ?? []).includes(mcpServerName),
        "rendered UI settings agent disabled MCP server after MCP server switch"
      );

      await openAgentTabForControls(
        agentId,
        "rules",
        "E2E rendered UI settings custom Agent"
      );
      await clickSwitchAndWait(
        `[data-testid="agent-orgs-rule-switch-personal-${ruleName}"]`,
        `rule switch ${ruleName}`
      );
      await browser.waitUntil(
        async () => {
          const policies = unwrap(
            await invokeE2E("listPolicies"),
            "poll policy after rendered Rules switch"
          ).policies;
          const policy = policies.find(
            (item) => item.name === ruleName && item.source === "personal"
          );
          return policy?.enabled === false;
        },
        {
          timeout: 15_000,
          interval: 500,
          timeoutMsg: "rendered Rules switch did not persist to policies store",
        }
      );
      await waitForAgentDefField(
        agentId,
        (definition) => definition?.id === agentId,
        "rendered UI settings agent after Rules switch"
      );

      const stored = await waitForAgentDefField(
        agentId,
        (definition) => definition?.id === agentId,
        "rendered UI custom Agent Settings controls"
      );

      expectDefinitionField(
        stored,
        (definition) =>
          definition.name === `E2E UI Settings Edited ${RUNTIME_CONFIG_MARKER}`,
        "custom Agent name"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.description ===
          `Edited rendered description ${RUNTIME_CONFIG_MARKER}`,
        "custom Agent description"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.soulContent === editedSoulContent,
        "custom Agent personality soul content"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.sessionModel?.maxIterations === 7,
        "max iterations"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.execTimeout === 135,
        "exec timeout"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.agentPolicy?.workspaceOnly === workspaceOnly,
        "workspace-only"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          (definition.agentPolicy?.riskRules?.high ?? []).includes(
            blockListCommand
          ),
        "security block-list command"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          (definition.agentPolicy?.riskRules?.medium ?? []).includes(
            alwaysAskCommand
          ),
        "security always-ask command"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.contextWindow === 64_000,
        "context window"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.maxTokens === 4_096,
        "max tokens"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.temperature === 0.3,
        "temperature"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.triggerRatio === 0.65,
        "compaction trigger ratio"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.sessionModel?.compaction?.keepRatio === 0.35,
        "compaction keep ratio"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.summaryMaxTokens === 2048,
        "compaction summary max tokens"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.sessionModel?.compaction?.minMessages === 11,
        "compaction min messages"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.floorTokens === 12_000,
        "compaction floor tokens"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.reservedSummaryTokens === 18_000,
        "compaction reserved summary tokens"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.bufferTokens === 9_000,
        "compaction buffer tokens"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.reliability?.maxRetries === 4,
        "reliability max retries"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.reliability?.baseBackoffMs === 750,
        "reliability base backoff"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.maxToolUseConcurrency === 6,
        "max tool-use concurrency"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          (definition.tools?.excludedTools ?? []).includes(toggledToolName),
        "excluded tool"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          (definition.skillsConfig?.exclude ?? []).includes(toggledSkillName),
        "excluded skill"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          (definition.tools?.disabledMcpServers ?? []).includes(mcpServerName),
        "disabled MCP server"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          (definition.tools?.disabledMcpTools ?? []).includes(mcpToolKey),
        "disabled MCP tool"
      );

      expectEqual(
        stored.sessionModel?.mode,
        "singleton",
        "sessionModel mode preserved after partial UI edits"
      );
      expectEqual(
        stored.sessionModel?.processingLock,
        true,
        "sessionModel processingLock preserved after partial UI edits"
      );
      expectEqual(
        stored.sessionModel?.compaction?.enabled,
        true,
        "compaction enabled preserved after nested UI edit"
      );
      expectEqual(
        stored.agentPolicy?.autonomy,
        "full",
        "security autonomy preserved after workspace toggle"
      );
    } finally {
      await invokeE2E("removeAgentDef", agentId);
      await invokeE2E("deletePolicy", ruleName, "personal");
      if (originalMcpConfig) {
        await invokeE2E("mcpUpdateServers", originalMcpConfig, "global");
      }
      await refreshAgentRows();
    }
  });

  it("launches a custom Agent and proves General/Models/Subagents/Tools/Skills settings reach runtime", async () => {
    const accounts = await listAccounts();
    const account = selectRuntimeAccount(accounts);
    if (!account) {
      throw new Error(
        `No enabled account with usable key/token and enabled models for runtime config E2E. Accounts=${JSON.stringify(accounts)}`
      );
    }
    const model = selectModel(account);
    const allTools = unwrap(
      await invokeE2E("listAllTools"),
      "listAllTools"
    ).tools;
    const toolNames = allTools
      .map((tool) => tool.name ?? tool.id)
      .filter((name) => typeof name === "string" && name.length > 0);
    const pickTool = (preferred, used = new Set()) =>
      preferred.find((name) => toolNames.includes(name) && !used.has(name)) ??
      toolNames.find((name) => !used.has(name));
    const usedTools = new Set();
    const restrictedTool = pickTool(["read_file", "Read"], usedTools);
    if (restrictedTool) usedTools.add(restrictedTool);
    const userAllowedTool = pickTool(["list_dir", "List"], usedTools);
    if (userAllowedTool) usedTools.add(userAllowedTool);
    const excludedTool = pickTool(
      ["edit_file", "Exec", "run_terminal_cmd"],
      usedTools
    );
    if (excludedTool) usedTools.add(excludedTool);
    if (!restrictedTool || !userAllowedTool || !excludedTool) {
      throw new Error(
        `Need at least three registered tools for tools runtime E2E: ${JSON.stringify(allTools)}`
      );
    }

    const parentAgentId = `e2e-parent-${RUNTIME_CONFIG_MARKER}`;
    const childAgentId = `e2e-child-${RUNTIME_CONFIG_MARKER}`;
    const soulContent = `E2E runtime soul marker ${RUNTIME_CONFIG_MARKER}`;
    const skillInclude = [`e2e-include-${RUNTIME_CONFIG_MARKER}`];
    const skillExclude = [`e2e-exclude-${RUNTIME_CONFIG_MARKER}`];
    const fallbackModel = `${model}-fallback-e2e`;

    const baseChildDefinition = {
      id: childAgentId,
      name: `E2E Child ${RUNTIME_CONFIG_MARKER}`,
      description: "Temporary E2E child agent for sub-agent runtime wiring.",
      builtIn: false,
      tier: "secondary",
      inheritsFrom: BUILTIN_SDE_AGENT_ID,
      capabilities: { coding: { modeSwitch: true } },
      delegationConfig: { delegatable: true, contextBuilders: [] },
      sessionModel: {
        mode: "singleton",
        processingLock: true,
        maxIterations: 2,
      },
      tools: { userAllowedTools: [], excludedTools: [] },
      skillsConfig: { enabled: true, include: [], exclude: [], sourceDirs: [] },
      soulContent: `E2E child soul ${RUNTIME_CONFIG_MARKER}`,
    };
    const parentDefinition = {
      id: parentAgentId,
      name: `E2E Parent ${RUNTIME_CONFIG_MARKER}`,
      description: "Temporary E2E parent agent for config runtime wiring.",
      builtIn: false,
      tier: "primary",
      inheritsFrom: BUILTIN_SDE_AGENT_ID,
      capabilities: { coding: { modeSwitch: true } },
      agentPolicy: {
        autonomy: "full",
        workspaceOnly: true,
        blockedCommands: [`e2e-blocked-${RUNTIME_CONFIG_MARKER}`],
        riskRules: {
          medium: [`e2e-ask-${RUNTIME_CONFIG_MARKER}`],
          high: [`e2e-block-${RUNTIME_CONFIG_MARKER}`],
        },
      },
      delegationConfig: { delegatable: true, contextBuilders: [] },
      sessionModel: {
        mode: "singleton",
        processingLock: true,
        maxIterations: 3,
        compaction: {
          enabled: true,
          triggerRatio: 0.55,
          keepRatio: 0.33,
          summaryMaxTokens: 1536,
          minMessages: 9,
          floorTokens: 10_000,
          reservedSummaryTokens: 17_000,
          bufferTokens: 8_000,
        },
      },
      contextWindow: 12_345,
      maxTokens: 2_345,
      temperature: 0.42,
      execTimeout: 91,
      maxToolUseConcurrency: 4,
      subAgents: [{ agentId: childAgentId, isolation: "worktree" }],
      tools: {
        systemRestrictToTools: [restrictedTool],
        userAllowedTools: [userAllowedTool],
        excludedTools: [excludedTool],
        disabledMcpServers: ["e2e-disabled-server"],
        disabledMcpTools: ["e2e-disabled-tool"],
      },
      loadWorkspaceResources: false,
      loadWorkspaceRules: false,
      skillsConfig: {
        enabled: true,
        include: skillInclude,
        exclude: skillExclude,
        sourceDirs: [],
      },
      selectedAccountId: account.id,
      selectedModelId: model,
      reliability: {
        maxRetries: 1,
        baseBackoffMs: 10,
        fallbackModels: [fallbackModel],
      },
      soulContent,
    };

    try {
      unwrap(
        await invokeE2E("addAgentDef", baseChildDefinition),
        "add E2E child agent definition"
      );
      unwrap(
        await invokeE2E("addAgentDef", parentDefinition),
        "add E2E parent agent definition"
      );

      const storedParent = unwrap(
        await invokeE2E("getAgentDef", parentAgentId),
        "get E2E parent agent definition"
      ).def;
      if (storedParent.soulContent !== soulContent) {
        throw new Error(
          `Parent definition did not persist before launch: ${JSON.stringify(storedParent)}`
        );
      }

      unwrap(
        await invokeE2E("navigateTo", WORKSTATION_ROUTE),
        "navigate to workstation"
      );
      const launch = unwrap(
        await invokeE2E("launchSession", {
          category: "rust_agent",
          content: `E2E runtime config ${RUNTIME_CONFIG_MARKER}. Reply with one short sentence.`,
          workspacePath: E2E_REPO_PATH,
          keySource: "own_key",
          accountId: account.id,
          model,
          agentDefinitionId: parentAgentId,
          background: false,
        }),
        "launch runtime config session"
      ).result;
      const sessionId = launch?.sessionId ?? launch?.session_id;
      if (!sessionId) {
        throw new Error(
          `Runtime config launch did not create a session id: ${JSON.stringify(launch)}`
        );
      }

      const general = unwrap(
        await invokeSnapshot(
          "debugSessionGeneralSnapshot",
          sessionId,
          "General"
        ),
        "debugSessionGeneralSnapshot"
      ).snapshot;
      if (general.agentId !== parentAgentId) {
        throw new Error(
          `General snapshot agent mismatch: ${JSON.stringify(general)}`
        );
      }
      if (
        general.definitionSoulContent !== soulContent ||
        general.runtimeAgentSoul !== soulContent
      ) {
        throw new Error(
          `Soul content did not reach runtime: ${JSON.stringify(general)}`
        );
      }
      if (
        general.definitionMaxIterations !== 3 ||
        general.resolvedMaxIterations !== 3
      ) {
        throw new Error(
          `Max iterations did not reach runtime: ${JSON.stringify(general)}`
        );
      }
      if (
        general.definitionExecTimeout !== 91 ||
        general.resolvedExecTimeoutSecs !== 91
      ) {
        throw new Error(
          `Exec timeout did not reach runtime: ${JSON.stringify(general)}`
        );
      }

      const modelSnapshot = unwrap(
        await invokeSnapshot("debugSessionModelSnapshot", sessionId, "Models"),
        "debugSessionModelSnapshot"
      ).snapshot;
      if (
        modelSnapshot.activeModel !== model ||
        modelSnapshot.activeAccountId !== account.id
      ) {
        throw new Error(
          `Model/account did not reach runtime: ${JSON.stringify(modelSnapshot)}`
        );
      }
      if (modelSnapshot.resolvedSelectedModelId !== model) {
        throw new Error(
          `Selected model did not resolve: ${JSON.stringify(modelSnapshot)}`
        );
      }
      assertIncludes(
        modelSnapshot.fallbackModels,
        fallbackModel,
        "fallbackModels"
      );
      const runtimeCompaction = modelSnapshot.compaction ?? {};
      if (
        runtimeCompaction.enabled !== true ||
        runtimeCompaction.triggerRatio !== 0.55 ||
        runtimeCompaction.keepRatio !== 0.33 ||
        runtimeCompaction.summaryMaxTokens !== 1536 ||
        runtimeCompaction.minMessages !== 9 ||
        runtimeCompaction.floorTokens !== 10_000 ||
        runtimeCompaction.reservedSummaryTokens !== 17_000 ||
        runtimeCompaction.bufferTokens !== 8_000
      ) {
        throw new Error(
          `Compaction config did not reach runtime: ${JSON.stringify(modelSnapshot)}`
        );
      }

      const subagents = unwrap(
        await invokeSnapshot(
          "debugSessionSubagentSnapshot",
          sessionId,
          "Subagents"
        ),
        "debugSessionSubagentSnapshot"
      ).snapshot;
      assertIncludes(
        subagents.resolvedSubAgents.map((entry) => entry.agentId),
        childAgentId,
        "resolved sub-agents"
      );
      assertIncludes(
        subagents.allowedSubagents,
        childAgentId,
        "allowed sub-agents"
      );
      assertIncludes(
        subagents.llmVisibleAgentIds,
        childAgentId,
        "LLM-visible sub-agents"
      );

      const tools = unwrap(
        await invokeSnapshot("debugSessionToolsSnapshot", sessionId, "Tools"),
        "debugSessionToolsSnapshot"
      ).snapshot;
      assertIncludes(
        tools.definitionSystemRestrictToTools,
        restrictedTool,
        "definition restrict tools"
      );
      assertIncludes(
        tools.definitionUserAllowedTools,
        userAllowedTool,
        "definition user allowed tools"
      );
      assertIncludes(
        tools.definitionExcludedTools,
        excludedTool,
        "definition excluded tools"
      );
      assertIncludes(
        tools.resolvedRestrictTo,
        restrictedTool,
        "resolved restrict tools"
      );
      assertIncludes(
        tools.resolvedRestrictTo,
        userAllowedTool,
        "resolved user-allowed tools"
      );
      assertIncludes(
        tools.resolvedDisabledMcpServers,
        "e2e-disabled-server",
        "disabled MCP servers"
      );
      assertIncludes(
        tools.resolvedDisabledMcpTools,
        "e2e-disabled-tool",
        "disabled MCP tools"
      );
      assertIncludes(
        tools.promptToolNames,
        restrictedTool,
        "policy-filtered prompt tools"
      );
      assertIncludes(
        tools.promptToolNames,
        userAllowedTool,
        "policy-filtered user-allowed prompt tools"
      );
      assertNotIncludes(
        tools.promptToolNames,
        excludedTool,
        "policy-filtered prompt tools"
      );

      const security = unwrap(
        await invokeSnapshot(
          "debugSessionSecuritySnapshot",
          sessionId,
          "Security"
        ),
        "debugSessionSecuritySnapshot"
      ).snapshot;
      if (!security.workspaceOnly) {
        throw new Error(
          `Security workspace-only policy did not reach runtime: ${JSON.stringify(security)}`
        );
      }
      assertIncludes(
        security.blockedCommands,
        `e2e-blocked-${RUNTIME_CONFIG_MARKER}`,
        "runtime blocked commands"
      );
      assertIncludes(
        security.mediumRiskRules,
        `e2e-ask-${RUNTIME_CONFIG_MARKER}`,
        "runtime medium risk rules"
      );
      assertIncludes(
        security.highRiskRules,
        `e2e-block-${RUNTIME_CONFIG_MARKER}`,
        "runtime high risk rules"
      );
      const blockedValidation = unwrap(
        await invokeE2E(
          "debugSessionValidateCommand",
          sessionId,
          `e2e-blocked-${RUNTIME_CONFIG_MARKER}`,
          false
        ),
        "debugSessionValidateCommand blocked command"
      ).validation;
      if (blockedValidation.outcome !== "denied") {
        throw new Error(
          `Blocked command was not denied by runtime policy: ${JSON.stringify(blockedValidation)}`
        );
      }

      const literalBacktickValidation = unwrap(
        await invokeE2E(
          "debugSessionValidateCommand",
          sessionId,
          "python -c 'print(`not shell`)'; python <<'PY'\nprint(`not shell`)\nPY",
          false
        ),
        "debugSessionValidateCommand literal backticks"
      ).validation;
      if (literalBacktickValidation.outcome !== "allowed") {
        throw new Error(
          `Literal backticks inside shell-quoted script text should be allowed: ${JSON.stringify(literalBacktickValidation)}`
        );
      }

      const executableBacktickValidation = unwrap(
        await invokeE2E(
          "debugSessionValidateCommand",
          sessionId,
          "echo `whoami`",
          false
        ),
        "debugSessionValidateCommand executable backtick"
      ).validation;
      const executableBacktickReason = String(
        executableBacktickValidation.reason ?? ""
      );
      if (executableBacktickValidation.outcome !== "denied") {
        throw new Error(
          `Executable backtick subshell should still be denied: ${JSON.stringify(executableBacktickValidation)}`
        );
      }
      for (const expectedReasonPart of [
        "shell-injection guard",
        "not an agent autonomy/tool permission",
        "single-quoted heredoc",
        "edit_file/write_file",
      ]) {
        if (!executableBacktickReason.includes(expectedReasonPart)) {
          throw new Error(
            `Executable backtick denial reason was not actionable; missing ${expectedReasonPart}: ${JSON.stringify(executableBacktickValidation)}`
          );
        }
      }

      const promptDump = unwrap(
        await invokeSnapshot("promptDump", sessionId, "Prompt"),
        "promptDump"
      ).dump;
      if (
        promptDump.loadWorkspaceResources !== false ||
        promptDump.loadWorkspaceRules !== false
      ) {
        throw new Error(
          `Workspace resource/rule flags did not reach prompt config: ${JSON.stringify(promptDump)}`
        );
      }
      const rulesTrace = promptDump.sections?.find(
        (section) => section.sectionId === "rules"
      );
      if (rulesTrace?.content?.includes(".orgii/rules")) {
        throw new Error(
          `Workspace rules content leaked despite loadWorkspaceRules=false: ${JSON.stringify(rulesTrace)}`
        );
      }

      const skills = unwrap(
        await invokeSnapshot("debugSessionSkillsSnapshot", sessionId, "Skills"),
        "debugSessionSkillsSnapshot"
      ).snapshot;
      if (
        !skills.definitionPresent ||
        skills.definitionEnabled !== true ||
        skills.resolvedSkillsEnabled !== true
      ) {
        throw new Error(
          `Skills config did not resolve enabled: ${JSON.stringify(skills)}`
        );
      }
      assertIncludes(
        skills.definitionInclude,
        skillInclude[0],
        "definition skill include"
      );
      assertIncludes(
        skills.definitionExclude,
        skillExclude[0],
        "definition skill exclude"
      );
      assertIncludes(
        skills.resolvedSkillsInclude,
        skillInclude[0],
        "resolved skill include"
      );
      assertIncludes(
        skills.resolvedSkillsDisabled,
        skillExclude[0],
        "resolved skill disabled"
      );
      assertIncludes(
        skills.effectivePerTurnDisabled,
        skillExclude[0],
        "effective per-turn skill disabled list"
      );
    } finally {
      await invokeE2E("removeAgentDef", parentAgentId);
      await invokeE2E("removeAgentDef", childAgentId);
    }
  });
});
