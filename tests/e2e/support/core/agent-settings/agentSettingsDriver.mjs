import {
  E2E_REPO_PATH,
  assertE2ERepoFixture,
  invokeE2E,
  unwrap,
  waitForApp,
} from "../agentOrgUiDriver.mjs";

export const AGENT_SETTINGS_ROUTE = "/orgii/app/settings/agent-orgs/agents";
export const WORKSTATION_ROUTE = "/orgii/workstation/code";
export const WAIT_TIMEOUT_MS = 30_000;
export const BUILTIN_SDE_AGENT_ID = "builtin:sde";

let currentAgentConfigRootSelector = null;

function agentConfigVariantFor(agentId) {
  if (agentId === "builtin:os") return "builtin-os";
  if (agentId === BUILTIN_SDE_AGENT_ID) return "builtin-sde";
  if (agentId === "builtin:wingman") return "wingman";
  return "custom";
}

export function getCurrentAgentConfigRootSelector() {
  return currentAgentConfigRootSelector;
}

export async function bootAgentSettingsE2E() {
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
    "pin agent settings E2E repo"
  );
}

export async function waitForScript(
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

export async function pointerClick(selector, label, options = {}) {
  let point = null;
  try {
    await browser.waitUntil(
      async () => {
        point = await browser.executeScript(
          `
          const selector = arguments[0];
          const rootSelector = arguments[1];
          const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document];
          const root = roots[roots.length - 1] ?? document;
          const matches = [...root.querySelectorAll(selector)];
          const describe = (element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const ancestors = [];
            let parent = element.parentElement;
            while (parent && ancestors.length < 8) {
              const parentRect = parent.getBoundingClientRect();
              const parentStyle = window.getComputedStyle(parent);
              ancestors.push({
                tag: parent.tagName,
                testId: parent.getAttribute?.("data-testid") || null,
                className: typeof parent.className === "string" ? parent.className.slice(0, 160) : null,
                rect: { left: Math.round(parentRect.left), top: Math.round(parentRect.top), width: Math.round(parentRect.width), height: Math.round(parentRect.height) },
                display: parentStyle.display,
                visibility: parentStyle.visibility,
                overflow: parentStyle.overflow,
              });
              parent = parent.parentElement;
            }
            return {
              tag: element.tagName,
              testId: element.getAttribute?.("data-testid") || null,
              text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 180),
              rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
              display: style.display,
              visibility: style.visibility,
              opacity: style.opacity,
              ancestors,
            };
          };
          const candidates = matches.filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          });
          const element = candidates[0] ?? null;
          if (!element) {
            return { found: false, selector, totalMatches: matches.length, matches: matches.map(describe), bodyText: document.body.innerText.slice(0, 2000) };
          }
          element.scrollIntoView({ block: "center", inline: "center" });
          const rect = element.getBoundingClientRect();
          const x = Math.floor(rect.left + rect.width / 2);
          const y = Math.floor(rect.top + rect.height / 2);
          const hit = document.elementFromPoint(x, y);
          const hitMatches = !!hit?.closest?.(selector);
          return {
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
          };
        `,
          [selector, options.rootSelector ?? null]
        );
        return point?.found === true && point?.hitMatches === true;
      },
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `${label} not clickable`,
      }
    );
  } catch (error) {
    throw new Error(
      `${label} not clickable: ${JSON.stringify(point, null, 2)}`,
      {
        cause: error,
      }
    );
  }
  if (options.jsClick === true) {
    const clickState = await browser.executeScript(
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
        const element = candidates[0] ?? null;
        if (!element) return { ok: false, reason: "missing" };
        element.click();
        return { ok: true, text: element.textContent?.trim() ?? "" };
      `,
      [selector, options.rootSelector ?? null]
    );
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

export async function clickSwitchAndWait(selector, label) {
  await browser.waitUntil(
    async () =>
      browser.executeScript(
        `
          const element = document.querySelector(arguments[0]);
          if (!element) return false;
          const state = element.getAttribute("aria-checked");
          return (state === "true" || state === "false") && !element.disabled;
        `,
        [selector]
      ),
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} did not become an enabled switch`,
    }
  );
  const before = await browser.executeScript(
    `return document.querySelector(arguments[0])?.getAttribute("aria-checked") ?? null;`,
    [selector]
  );
  if (before !== "true" && before !== "false") {
    throw new Error(`${label} did not expose switch state: ${before}`);
  }
  await pointerClick(selector, label);
  await browser.waitUntil(
    async () => {
      const current = await browser.executeScript(
        `return document.querySelector(arguments[0])?.getAttribute("aria-checked") ?? null;`,
        [selector]
      );
      return current !== before && (current === "true" || current === "false");
    },
    { timeout: 10_000, interval: 200, timeoutMsg: `${label} did not toggle` }
  );
  return before === "true" ? false : true;
}

export async function setTextInput(selector, value, label) {
  const targetId = `e2e-input-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await waitForScript(
    `
      const selector = arguments[0];
      const targetId = arguments[1];
      document.querySelectorAll("[data-e2e-input-target]").forEach((element) => {
        element.removeAttribute("data-e2e-input-target");
      });
      const element = [...document.querySelectorAll(selector)].find((candidate) => {
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
      if (!element) return false;
      element.setAttribute("data-e2e-input-target", targetId);
      return true;
    `,
    `${label} missing or disabled`,
    WAIT_TIMEOUT_MS,
    [selector, targetId]
  );

  const expectedValue = String(value);
  const inputElement = await browser.$(`[data-e2e-input-target="${targetId}"]`);
  await inputElement.click();
  const setState = await browser.executeScript(
    `
      const targetId = arguments[0];
      const expected = arguments[1];
      const element = document.querySelector(
        '[data-e2e-input-target="' + CSS.escape(targetId) + '"]'
      );
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        return { ok: false, reason: "target-missing" };
      }
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      const previousValue = element.value;
      element.focus();
      descriptor?.set?.call(element, expected);
      element._valueTracker?.setValue?.(previousValue);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: expected, inputType: "insertReplacementText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
      element.blur();
      return { ok: element.value === expected, value: element.value, expected };
    `,
    [targetId, expectedValue]
  );
  if (setState?.ok !== true) {
    throw new Error(
      `${label} did not set input value: ${JSON.stringify(setState)}`
    );
  }

  const inputState = await browser.executeScript(
    `
      const targetId = arguments[0];
      const expected = arguments[1];
      const element = document.querySelector(
        '[data-e2e-input-target="' + CSS.escape(targetId) + '"]'
      );
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        return { ok: false, reason: "target-missing" };
      }
      const numericActual = Number(String(element.value).replace(/,/g, ""));
      const numericExpected = Number(expected);
      const numericOk =
        expected.trim() !== "" &&
        !Number.isNaN(numericActual) &&
        !Number.isNaN(numericExpected) &&
        numericActual === numericExpected;
      return {
        ok: element.value === expected || numericOk,
        value: element.value,
        expected,
        tag: element.tagName,
        type: element.getAttribute("type"),
        activeTag: document.activeElement?.tagName ?? null,
        activeTestId: document.activeElement?.getAttribute?.("data-testid") ?? null,
      };
    `,
    [targetId, expectedValue]
  );
  if (inputState?.ok !== true) {
    throw new Error(
      `${label} did not reflect typed value: ${JSON.stringify(inputState)}`
    );
  }
}

export async function setNumberInput(selector, value, label) {
  await setTextInput(selector, String(value), label);
}

export async function setMarkdownEditor(selector, value, label) {
  await waitForScript(
    `
      const root = document.querySelector(arguments[0]);
      const editor = root?.querySelector(".cm-content[contenteditable='true']");
      if (!root || !editor) return false;
      const rect = editor.getBoundingClientRect();
      const style = window.getComputedStyle(editor);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    `,
    `${label} markdown editor did not become editable`,
    WAIT_TIMEOUT_MS,
    [selector]
  );

  const result = await browser.executeScript(
    `
      const root = document.querySelector(arguments[0]);
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
    [selector, String(value)]
  );
  if (!result?.ok || !String(result.text ?? "").includes(String(value))) {
    throw new Error(
      `${label} markdown editor did not accept text: ${JSON.stringify(result)}`
    );
  }
}

export async function waitForAgentDefField(agentId, predicate, label) {
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

export async function refreshAgentRows() {
  unwrap(await invokeE2E("refreshAgentDefs"), "refresh agent definitions");
}

export async function removeAgentDefIfExists(agentId) {
  await invokeE2E("removeAgentDef", agentId);
  await refreshAgentRows();
}

export async function openAgentSettingsAgents() {
  unwrap(
    await invokeE2E("navigateTo", AGENT_SETTINGS_ROUTE),
    "navigate to Agent settings"
  );
  await waitForScript(
    `return !!document.querySelector('[data-testid="agent-orgs-add-agent-button"]');`,
    "Agent settings table did not render"
  );
}

export async function openAgentWizard() {
  await openAgentSettingsAgents();
  await pointerClick(
    '[data-testid="agent-orgs-add-agent-button"]',
    "Add Agent button"
  );
  await waitForScript(
    `return !!document.querySelector('[data-testid="agent-orgs-agent-wizard-root"]');`,
    "Agent wizard did not open"
  );
}

export async function restoreWorkstationIfFocused(rootSelector, label) {
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
  await pointerClick(
    `[data-e2e-restore-workstation-target="${restoreTarget}"]`,
    `${label} restore Workstation button`,
    { rootSelector: null }
  );
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

export async function openAgentRow(agentId, label, tab = "general") {
  currentAgentConfigRootSelector = null;
  await openAgentSettingsAgents();
  await refreshAgentRows();
  await waitForScript(
    `return !!document.querySelector('[data-testid="agent-orgs-agent-row-${agentId}"]');`,
    `${label} row did not render`
  );
  await pointerClick(
    `[data-testid="agent-orgs-agent-row-${agentId}"]`,
    `${label} row`
  );
  const openResult = unwrap(
    await invokeE2E("openAgentTab", agentId, tab),
    `open ${label} agent tab`
  );
  await pointerClick(
    '[data-testid="station-mode-my-station"]',
    `${label} My Station switch`,
    {
      rootSelector: null,
      jsClick: true,
    }
  );
  const focusedResult = unwrap(
    await invokeE2E("openAgentTab", agentId, tab),
    `refocus ${label} agent tab after station switch`
  );
  const variant = agentConfigVariantFor(agentId);
  currentAgentConfigRootSelector = `[data-testid="agent-config-tab-${variant}-${agentId}"]`;
  try {
    await waitForScript(
      `return !!document.querySelector(arguments[0]);`,
      `${label} agent config tab root did not mount`,
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
          .slice(0, 120);
        return {
          selector,
          location: window.location.pathname,
          chatMaximized: localStorage.getItem('orgii:chatPanelMaximized'),
          stationVisibility: localStorage.getItem('stationChatVisibility'),
          layoutStorageV1: localStorage.getItem('orgii:workstation:tabs:v1'),
          layoutStorageV2: localStorage.getItem('workstation:layout-v2'),
          matchingCount: document.querySelectorAll(selector).length,
          testIds,
          bodyText: document.body?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 1000) ?? null,
        };
      `,
      [currentAgentConfigRootSelector]
    );
    throw new Error(
      `${label} agent config tab root did not mount: ${JSON.stringify({ openResult, focusedResult, workstationSurface, diagnostic })}`,
      { cause: error }
    );
  }
  await restoreWorkstationIfFocused(currentAgentConfigRootSelector, label);
  await waitForScript(
    `
      const root = document.querySelector(arguments[0]);
      const rect = root?.getBoundingClientRect?.();
      return !!rect && rect.width > 0 && rect.height > 0;
    `,
    `${label} agent config tab did not render visibly`,
    WAIT_TIMEOUT_MS,
    [currentAgentConfigRootSelector]
  );
}

export async function clickAgentDetailTab(tabKey) {
  const rootSelector = currentAgentConfigRootSelector;
  await restoreWorkstationIfFocused(rootSelector, `${tabKey} detail tab`);
  await pointerClick(
    `[data-testid="agent-orgs-detail-tab-${tabKey}"]`,
    `${tabKey} detail tab`,
    { rootSelector, jsClick: true }
  );
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
      const detailRoot = [...root.querySelectorAll('[data-active-tab]')].filter(isVisible).at(-1) ?? null;
      if (detailRoot?.getAttribute("data-active-tab") === tabKey) return true;
      const tab = [...root.querySelectorAll('[data-testid="agent-orgs-detail-tab-' + CSS.escape(tabKey) + '"]')].filter(isVisible).at(-1) ?? null;
      return tab?.getAttribute("data-active") === "true";
    `,
    `${tabKey} detail tab did not become active`,
    WAIT_TIMEOUT_MS,
    [tabKey, rootSelector]
  );
}

export async function openWizardTab(tabKey) {
  await pointerClick(
    `[data-tab-key="${tabKey}"]`,
    `Agent wizard ${tabKey} tab`
  );
  await waitForScript(
    `
      const tabKey = arguments[0];
      return [...document.querySelectorAll('[data-tab-key="' + CSS.escape(tabKey) + '"]')]
        .some((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && element.className.includes("font-semibold");
        });
    `,
    `Agent wizard ${tabKey} tab did not become active`,
    WAIT_TIMEOUT_MS,
    [tabKey]
  );
}

export function expectDefinitionField(definition, predicate, label) {
  if (!predicate(definition)) {
    throw new Error(
      `${label} mismatch in definition: ${JSON.stringify(definition)}`
    );
  }
}
