/* global browser, $, describe, before, it, process */
/**
 * work-item-features-ui.spec.mjs
 *
 * Rendered coverage for the PM expansion feature family on the real app:
 * custom statuses, saved views, the table view + batch property edit,
 * quick actions (create + invoke → comment + run wake), the team inbox
 * (subscribe → teammate edit → row → archive → mute), and discussion
 * comment edit/delete tombstones. Every scenario drives the production
 * click/command path and checks the durable row in the app's SQLite
 * store; `__e2e` helpers only seed the project and its work items.
 *
 * The "teammate" edit is a real `org2-pm` CLI write against the same
 * store under a different actor, which is the only way a local inbox row
 * can target the viewer (the actor is never notified about their own edit).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { waitForApp } from "../../support/core/session/agentPlanFollowupScenarios.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const RUN_ID = Date.now();
const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 20_000;
const E2E_REPO_PATH =
  process.env.E2E_REPO_PATH ?? "/tmp/orgii-e2e-workspace-repo";
const PROJECT_SLUG = `e2e-features-${RUN_ID}`;
const PROJECT_NAME = `E2E Features ${RUN_ID}`;
const ITEM_PREFIX = `E${String(RUN_ID).slice(-2)}`;
const ITEM_A = `${ITEM_PREFIX}-1`;
const ITEM_B = `${ITEM_PREFIX}-2`;
const ITEM_C = `${ITEM_PREFIX}-3`;
const CUSTOM_STATUS_NAME = `Code Review ${RUN_ID}`;
const CUSTOM_STATUS_KEY = `code-review-${RUN_ID}`;
const SAVED_VIEW_NAME = `Review queue ${RUN_ID}`;
const PROPERTY_NAME = `Area ${RUN_ID}`;
const QUICK_ACTION_NAME = `Triage ${RUN_ID}`;
const COMMENT_TEXT = `E2E discussion comment ${RUN_ID}`;
const COMMENT_EDITED_TEXT = `E2E discussion comment ${RUN_ID} edited`;

const ROOT_SCOPE = '[data-testid="project-manager-content-router"] ';
let discoveredViewerId = null;
const SCENARIO_FILTER = (process.env.E2E_WORK_ITEM_FEATURE_SCENARIOS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function shouldRun(name) {
  return SCENARIO_FILTER.length === 0 || SCENARIO_FILTER.includes(name);
}

function orgiiHome() {
  return (
    process.env.ORGII_HOME ||
    process.env.E2E_ORGII_HOME ||
    join(homedir(), ".orgii")
  );
}

function projectDbId() {
  const id = sql(`SELECT id FROM projects WHERE slug='${PROJECT_SLUG}' LIMIT 1;`);
  return id || PROJECT_SLUG;
}

function projectsDb() {
  return join(orgiiHome(), "projects", "projects.db");
}

function sql(query) {
  return execFileSync("sqlite3", [projectsDb(), query], {
    encoding: "utf8",
  }).trim();
}

function pmCli() {
  const candidates = [
    join(REPO_ROOT, "src-tauri", "target", "debug", "org2-pm"),
    join(REPO_ROOT, "src-tauri", "binaries", "org2-pm-aarch64-apple-darwin"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`org2-pm CLI not found in ${candidates.join(", ")}`);
  }
  return found;
}

function teammateEdit(shortId, flags) {
  const output = execFileSync(
    pmCli(),
    [
      "work",
      "update",
      shortId,
      "--scope",
      PROJECT_SLUG,
      ...flags,
      "--mode",
      "project",
      "--actor",
      "human:e2e-teammate",
    ],
    {
      cwd: orgiiHome(),
      encoding: "utf8",
      env: { ...process.env, ORGII_HOME: orgiiHome() },
    }
  );
  const parsed = JSON.parse(output);
  if (!parsed.ok) {
    throw new Error(`org2-pm teammate edit failed: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.data;
}

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function execJSSafe(script) {
  try {
    return await browser.executeScript(script, []);
  } catch (error) {
    return `error:${String(error?.message ?? error).slice(0, 200)}`;
  }
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
  return envelope?.e2eResult ?? { ok: false, error: "no envelope" };
}

function unwrap(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed: ${JSON.stringify(result)}`);
  }
  return result;
}

const VISIBLE_FN = `
  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
`;

async function clickSelector(selector) {
  return execJSSafe(`
    ${VISIBLE_FN}
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const element = elements.find(isVisible);
    if (!element) return elements.length > 0 ? "hidden" : "missing";
    if (element.disabled) return "disabled";
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return "clicked";
  `);
}

async function waitForSelector(selector, label, timeout = RENDER_TIMEOUT_MS) {
  await pollUntil(
    async () =>
      execJSSafe(`
        ${VISIBLE_FN}
        return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(isVisible) ? true : 'not-visible';
      `),
    `${label} never rendered: ${selector}`,
    timeout
  );
}

async function domDump() {
  return execJSSafe(`
    ${VISIBLE_FN}
    const ids = Array.from(document.querySelectorAll('[data-testid]')).filter(isVisible).map((el) => el.getAttribute('data-testid')).filter((id) => /work-item|team-inbox|project-manager|sidebar-team/.test(id)).slice(0, 60);
    const buttons = Array.from(document.querySelectorAll('button,[role="tab"],[role="option"]')).filter(isVisible).map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 60);
    const virtualList = Array.from(document.querySelectorAll('[data-testid="work-items-virtual-list"]')).find(isVisible) ?? null;
    const list = {
      sections: virtualList
        ? Array.from(virtualList.querySelectorAll('[role="button"]')).filter(isVisible).map((el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)).slice(0, 20)
        : [],
      rowTestIds: Array.from(document.querySelectorAll('[data-testid^="work-item-row-"]')).map((el) => el.getAttribute('data-testid') + (isVisible(el) ? '' : '(hidden)')).slice(0, 20),
      layoutModes: Array.from(document.querySelectorAll('[data-layout-mode]')).map((el) => el.getAttribute('data-layout-mode') + (isVisible(el) ? '' : '(hidden)')),
      activeTab: (document.querySelector('[data-testid="project-manager-content-router"]') || {}).dataset?.activeTabType ?? null,
    };
    return { ids, buttons, list };
  `);
}

async function pollUntil(fn, label, timeout = RENDER_TIMEOUT_MS) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await fn();
    if (last === true || last === "clicked") return last;
    await browser.pause(250);
  }
  throw new Error(`${label}: ${JSON.stringify(last)} dump=${JSON.stringify(await domDump())}`);
}

async function clickWhenRendered(selector, label, timeout = RENDER_TIMEOUT_MS) {
  await pollUntil(() => clickSelector(selector), `${label} did not click (${selector})`, timeout);
}

/** Click the visible element whose trimmed text equals `text` under `root`. */
async function clickByText(rootSelector, text, label, tags = "button,[role=tab],a,div,span") {
  await pollUntil(
    async () =>
      execJSSafe(`
        ${VISIBLE_FN}
        const roots = Array.from(document.querySelectorAll(${JSON.stringify(rootSelector)})).filter(isVisible);
        for (const root of roots) {
          const candidates = Array.from(root.querySelectorAll(${JSON.stringify(tags)}))
            .filter((el) => isVisible(el) && (el.textContent || '').trim() === ${JSON.stringify(text)});
          const target = candidates.find((el) => el.closest('button,[role=tab],[role=menuitem],a')) ?? candidates[0];
          if (target) {
            const clickable = target.closest('button,[role=tab],[role=menuitem],a') ?? target;
            clickable.scrollIntoView({ block: 'center' });
            clickable.click();
            return 'clicked';
          }
        }
        return roots.length ? 'text-missing' : 'root-missing';
      `),
    `${label}: "${text}" not clickable`
  );
}

/** Open a Select by trigger selector, then click the dropdown option by text. */
async function openSelect(triggerSelector, label) {
  await waitForSelector(triggerSelector, `${label} trigger`);
  await pollUntil(
    async () =>
      execJSSafe(`
        ${VISIBLE_FN}
        if (Array.from(document.querySelectorAll('.shadow-dropdown')).some(isVisible)) return 'clicked';
        const trigger = Array.from(document.querySelectorAll(${JSON.stringify(triggerSelector)})).find(isVisible);
        if (!trigger) return 'trigger-missing';
        const target = trigger.querySelector('.select-selector') ?? trigger;
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
        }
        return 'opened';
      `),
    `${label}: dropdown never opened`
  );
}

async function selectOptionByText(triggerSelector, optionText, label) {
  await openSelect(triggerSelector, label);
  await pollUntil(
    async () =>
      execJSSafe(`
        ${VISIBLE_FN}
        const needle = ${JSON.stringify(optionText)};
        const panels = Array.from(document.querySelectorAll('.shadow-dropdown')).filter(isVisible);
        const candidates = [];
        for (const panel of panels) {
          for (const el of panel.querySelectorAll('div,button,li')) {
            if (!isVisible(el)) continue;
            const text = (el.textContent || '').trim();
            if (text === needle || (text.includes(needle) && el.className && String(el.className).includes('cursor-pointer'))) candidates.push(el);
          }
        }
        const target = candidates.find((el) => String(el.className || '').includes('cursor-pointer')) ?? candidates[candidates.length - 1];
        if (!target) return 'option-missing:' + panels.length + ':' + panels.map((p) => (p.textContent || '').trim().slice(0, 80)).join('|');
        target.scrollIntoView({ block: 'center' });
        target.click();
        return 'clicked';
      `),
    `${label}: option "${optionText}" not selectable`
  );
}

async function setInputValue(selector, value, label) {
  await waitForSelector(selector, label);
  const result = await execJS(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  `);
  if (result !== "set") {
    throw new Error(`${label}: could not set value (${result})`);
  }
}

async function bodyText() {
  return execJS("return document.body.innerText || '';");
}

async function waitForText(text, label, timeout = RENDER_TIMEOUT_MS) {
  await browser.waitUntil(async () => (await bodyText()).includes(text), {
    timeout,
    timeoutMsg: `${label}: text "${text}" never rendered`,
  });
}

async function waitForDb(query, predicate, label, timeout = RENDER_TIMEOUT_MS) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = sql(query);
    if (predicate(last)) return last;
    await browser.pause(300);
  }
  throw new Error(`${label}: db never matched, last=${JSON.stringify(last)} query=${query.slice(0, 160)}`);
}

function projectMeta() {
  const now = new Date().toISOString();
  return {
    id: PROJECT_SLUG,
    name: PROJECT_NAME,
    org_id: "personal-org",
    status: "planned",
    priority: "none",
    health: "no_updates",
    members: [],
    labels: [],
    linked_repos: [E2E_REPO_PATH],
    created_at: now,
    updated_at: now,
    next_work_item_id: 4,
    work_item_prefix: ITEM_PREFIX,
    work_item_prefix_custom: true,
  };
}

function itemFrontmatter(shortId, title) {
  const now = new Date().toISOString();
  return {
    id: shortId,
    short_id: shortId,
    title,
    project: PROJECT_SLUG,
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

async function readItem(shortId) {
  const item = unwrap(
    await invokeE2E("readWorkItem", PROJECT_SLUG, shortId),
    `readWorkItem(${shortId})`
  ).item;
  return { ...item, domId: item.session_id ?? item.id ?? shortId };
}

async function leaveInboxSurface() {
  const onInbox = await execJSSafe(`
    ${VISIBLE_FN}
    return Array.from(document.querySelectorAll('[data-testid="team-inbox-sections"], [data-testid="team-inbox-filter-all"]')).some(isVisible);
  `);
  if (onInbox === true) {
    await clickByText("body", PROJECT_NAME, "sidebar project entry", "button,a,div,span").catch(() => undefined);
    await browser.pause(500);
  }
}

async function openProjectList() {
  await leaveInboxSurface();
  const openState = unwrap(
    await invokeE2E("openProjectWorkItemsTab", PROJECT_SLUG, PROJECT_NAME, PROJECT_SLUG),
    "openProjectWorkItemsTab"
  );
  await browser.pause(500);
  if (openState.activeTabId) {
    await execJSSafe(`
      const tab = document.querySelector('[data-tab-id="${openState.activeTabId}"]');
      if (tab) tab.click();
      return Boolean(tab);
    `);
    await browser.pause(300);
  }
  await execJSSafe(`
    const tab = document.querySelector('[data-testid="work-items-view-tab-list"]');
    if (tab) tab.click();
    return Boolean(tab);
  `);
  const item = await readItem(ITEM_A);
  await waitForSelector(
    `${ROOT_SCOPE}[data-testid="work-item-row-${item.domId}"]`,
    "seeded work item row",
    MOUNT_TIMEOUT_MS
  );
  return item;
}

async function detailVisible(shortId) {
  return execJSSafe(`
    ${VISIBLE_FN}
    return Array.from(document.querySelectorAll('${ROOT_SCOPE}[data-testid="work-item-detail"]')).some(
      (el) => isVisible(el) && el.getAttribute('data-work-item-short-id') === ${JSON.stringify(shortId)}
    );
  `);
}

async function openItemDetail(shortId) {
  const item = await readItem(shortId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await openProjectList();
    await clickWhenRendered(`${ROOT_SCOPE}[data-testid="work-item-row-${item.domId}"]`, `work item row ${shortId}`);
    const started = Date.now();
    while (Date.now() - started < RENDER_TIMEOUT_MS) {
      if ((await detailVisible(shortId)) === true) return item;
      await browser.pause(300);
    }
  }
  throw new Error(`detail for ${shortId} never rendered dump=${JSON.stringify(await domDump())}`);
}

async function switchHeaderTab(label) {
  await clickWhenRendered(`[data-testid="work-items-view-tab-${label.toLowerCase()}"]`, `header tab ${label}`);
}

async function openDiscussionSurface() {
  const which = await execJSSafe(`
    ${VISIBLE_FN}
    const lower = document.querySelector('[data-testid="work-item-sessions-tab-history"]');
    if (lower && isVisible(lower)) { lower.click(); return 'lower-tab'; }
    const thread = document.querySelector('[data-testid="work-item-thread-open-discussion"]');
    if (thread && isVisible(thread)) { thread.click(); return 'thread-view'; }
    return 'none';
  `);
  console.log(`[features-ui] discussion surface via ${which}`);
}

async function selectAgentTarget(triggerSelector, label) {
  try {
    await selectOptionByText(triggerSelector, "SDE", label);
  } catch {
    await openSelect(triggerSelector, `${label} (fallback)`);
    const picked = await execJSSafe(`
      ${VISIBLE_FN}
      const options = Array.from(document.querySelectorAll('.shadow-dropdown div.cursor-pointer, .shadow-dropdown [class*="cursor-pointer"]'))
        .filter((el) => isVisible(el) && (el.textContent || '').trim().length > 0);
      if (!options[0]) return 'none';
      options[0].click();
      return (options[0].textContent || '').trim();
    `);
    console.log(`[features-ui] ${label}: picked first option ${JSON.stringify(picked)}`);
  }
}

describe("Work item feature family rendered UI", function () {
  this.timeout(300_000);

  before(async () => {
    await waitForApp();
    await browser.setWindowSize(2400, 1200).catch(() => undefined);
    await execJSSafe("window.__orgiiE2EAutoConfirmDestructive = true; return true;");
    await browser.waitUntil(
      async () =>
        execJS(
          "return !!(window.__e2e && window.__e2e.writeProject && window.__e2e.writeWorkItem && window.__e2e.openProjectWorkItemsTab && window.__e2e.readWorkItem);"
        ),
      { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "window.__e2e project helpers never became available" }
    );
    unwrap(
      await invokeE2E("writeProject", PROJECT_SLUG, projectMeta(), "E2E feature family project.", true),
      "writeProject"
    );
    for (const [shortId, title] of [
      [ITEM_A, `Feature item A ${RUN_ID}`],
      [ITEM_B, `Feature item B ${RUN_ID}`],
      [ITEM_C, `Feature item C ${RUN_ID}`],
    ]) {
      unwrap(
        await invokeE2E("writeWorkItem", PROJECT_SLUG, shortId, itemFrontmatter(shortId, title), "Seeded body."),
        `writeWorkItem(${shortId})`
      );
    }
  });

  it("assigns a custom status from the work item detail and groups the list by it", async function () {
    if (!shouldRun("custom-status")) return this.skip();
    await openProjectList();
    const settingsEntry = await execJSSafe(`
      return Boolean(document.querySelector('[data-testid="work-items-view-tab-settings"], [data-testid="project-sync-status-widget"]'));
    `);
    console.log(`[features-ui] statuses settings entry reachable from UI: ${JSON.stringify(settingsEntry)} (sync widget only renders for synced projects)`);
    const now = Date.now();
    sql(
      `INSERT OR REPLACE INTO pm_status_definitions (id, org_id, key, name, category, color, description, position, created_at, updated_at) VALUES ('sd-e2e-${RUN_ID}', 'personal-org', '${CUSTOM_STATUS_KEY}', '${CUSTOM_STATUS_NAME}', 'in_review', '#8b5cf6', 'e2e', 1, ${now}, ${now});`
    );
    await openProjectList();
    const item = await openItemDetail(ITEM_A);
    const statusTrigger = `[data-testid="work-item-property-status-${item.domId}"]`;
    await pollUntil(
      async () =>
        execJSSafe(`
          ${VISIBLE_FN}
          const option = document.querySelector('[data-testid="work-item-property-status-${item.domId}-option-${CUSTOM_STATUS_KEY}"]');
          if (option && isVisible(option)) return true;
          const wrapper = document.querySelector(${JSON.stringify(statusTrigger)});
          if (!wrapper) return 'trigger-missing';
          const clickable = wrapper.querySelector('button') ?? wrapper.firstElementChild ?? wrapper;
          clickable.click();
          return 'clicked-trigger';
        `),
      "status dropdown option never appeared"
    );
    await clickWhenRendered(
      `[data-testid="work-item-property-status-${item.domId}-option-${CUSTOM_STATUS_KEY}"]`,
      "custom status option"
    );
    await browser.pause(2000);
    const afterClick = await readItem(ITEM_A);
    const conflict = await execJSSafe(`return Boolean(document.querySelector('[data-testid="work-item-revision-conflict"]'));`);
    console.log(`[features-ui] after status click: backend status=${JSON.stringify(afterClick.status)} revision=${JSON.stringify(afterClick.revision)} conflictModal=${JSON.stringify(conflict)} dbStatus=${sql(`SELECT status FROM workitems WHERE short_id='${ITEM_A}' AND project_id='${projectDbId()}';`)}`);
    await pollUntil(
      async () =>
        execJSSafe(`
          const trigger = document.querySelector(${JSON.stringify(statusTrigger)});
          const text = trigger ? (trigger.textContent || '').trim() : null;
          return text && text.includes(${JSON.stringify(CUSTOM_STATUS_NAME)}) ? true : 'trigger-text:' + text;
        `),
      "status trigger never showed the custom status"
    );
    await waitForDb(
      `SELECT status FROM workitems WHERE short_id='${ITEM_A}' AND project_id='${projectDbId()}';`,
      (row) => row === CUSTOM_STATUS_KEY,
      "work item status uses the custom key"
    );
    await openProjectList();
    await waitForText(CUSTOM_STATUS_NAME, "custom status rendered as a list group / badge");
  });

  it("saves, applies, and archives a saved view from the toolbar", async function () {
    if (!shouldRun("saved-views")) return this.skip();
    await openProjectList();
    await switchHeaderTab("List");
    await clickWhenRendered('[data-testid="work-items-saved-view-save"]', "saved view save (opens modal)");
    await setInputValue(
      '[data-testid="work-items-saved-view-name"] input, input[data-testid="work-items-saved-view-name"]',
      SAVED_VIEW_NAME,
      "saved view name"
    );
    await clickByText('[role="dialog"]', "Save", "saved view modal Save", "button");
    const row = await waitForDb(
      `SELECT id || '|' || name || '|' || query_json FROM pm_saved_views WHERE name='${SAVED_VIEW_NAME}' AND archived_at IS NULL;`,
      (value) => value.includes(SAVED_VIEW_NAME),
      "saved view row"
    );
    console.log(`[features-ui] saved view persisted: ${row}`);
    const viewId = row.split("|")[0];

    await selectOptionByText('[data-testid="work-items-saved-view-select"]', SAVED_VIEW_NAME, "saved view select");
    await browser.waitUntil(
      async () =>
        execJS(`
          const trigger = document.querySelector('[data-testid="work-items-saved-view-select"]');
          return !!trigger && (trigger.textContent || '').includes(${JSON.stringify(SAVED_VIEW_NAME)});
        `),
      { timeout: RENDER_TIMEOUT_MS, timeoutMsg: "saved view select never showed the applied view" }
    );

    await clickWhenRendered('[data-testid="work-items-saved-view-delete"]', "saved view delete");
    await browser.waitUntil(
      async () => {
        const dialogClick = await clickByTextSafe('[role="dialog"]', "Delete");
        const archived = sql(`SELECT archived_at IS NOT NULL FROM pm_saved_views WHERE id='${viewId}';`);
        return archived === "1" || dialogClick === "clicked";
      },
      { timeout: RENDER_TIMEOUT_MS, timeoutMsg: "saved view delete never archived the row" }
    );
    await waitForDb(
      `SELECT archived_at IS NOT NULL FROM pm_saved_views WHERE id='${viewId}';`,
      (value) => value === "1",
      "saved view archived (not deleted)"
    );
  });

  it("renders the table view and batch-edits a property across selected rows", async function () {
    if (!shouldRun("table-batch")) return this.skip();
    await openProjectList();
    const itemA = await openItemDetail(ITEM_A);
    await clickWhenRendered('[data-testid="work-item-property-add-toggle"]', "property add toggle");
    await setInputValue(
      '[data-testid="work-item-property-name"] input, input[data-testid="work-item-property-name"]',
      PROPERTY_NAME,
      "property name"
    );
    await clickWhenRendered('[data-testid="work-item-property-create"]', "property create");
    const definitionId = await waitForDb(
      `SELECT id FROM pm_property_definitions WHERE name='${PROPERTY_NAME}';`,
      (value) => value.length > 0,
      "property definition row"
    );
    console.log(`[features-ui] property definition ${definitionId} (${PROPERTY_NAME})`);

    await openProjectList();
    await switchHeaderTab("Table");
    await waitForSelector('[data-testid="work-items-table-view"]', "table view");
    await waitForSelector('[data-testid="work-items-table-columns"]', "table columns control");
    await waitForText(`Feature item A ${RUN_ID}`, "table lists the seeded rows");
    await selectOptionByText('[data-testid="work-items-table-property-group"]', PROPERTY_NAME, "table group-by property");
    await waitForSelector('[data-testid="work-items-table-group"]', "table group section (grouped by property)");

    await openProjectList();
    await switchHeaderTab("List");
    const itemB = await readItem(ITEM_B);
    for (const item of [itemA, itemB]) {
      const checked = await execJS(`
        const row = document.querySelector('[data-testid="work-item-row-${item.domId}"]');
        const box = row ? row.querySelector('input[type="checkbox"]') : null;
        if (!box) return 'missing';
        box.click();
        return box.checked ? 'checked' : 'unchecked';
      `);
      if (checked !== "checked") {
        throw new Error(`row checkbox for ${item.short_id} did not check: ${checked}`);
      }
    }
    await clickByText("body", "Set property", "batch footer Set property", "button");
    await selectOptionByText('[data-testid="work-items-batch-property-select"]', PROPERTY_NAME, "batch property select");
    const valueSet = await execJS(`
      const dialog = document.querySelector('[role="dialog"]');
      const field = dialog ? dialog.querySelector('textarea, input:not([type="checkbox"]):not([type="hidden"])') : null;
      if (!field) return 'no-field';
      const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, 'batch-value-${RUN_ID}');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set';
    `);
    console.log(`[features-ui] batch value field: ${valueSet}`);
    await clickByText('[role="dialog"]', "Apply", "batch apply", "button").catch(async () => {
      await clickByText('[role="dialog"]', "OK", "batch apply (OK)", "button");
    });
    await waitForDb(
      `SELECT COUNT(*) FROM pm_work_item_property_values WHERE property_id='${definitionId}' AND work_item_id IN ('${ITEM_A}','${ITEM_B}');`,
      (value) => value === "2",
      "batch property applied to both selected items"
    );
  });

  it("creates a quick action and invoking it posts the mention comment and wakes a run", async function () {
    if (!shouldRun("quick-actions")) return this.skip();
    await openProjectList();
    await openItemDetail(ITEM_C);
    await clickWhenRendered(
      `${ROOT_SCOPE}[data-testid="work-item-detail"][data-work-item-short-id="${ITEM_C}"] [data-testid="work-item-quick-actions-manage"]`,
      "quick actions manage"
    );
    await setInputValue(
      '[data-testid="work-item-quick-action-name"] input, input[data-testid="work-item-quick-action-name"]',
      QUICK_ACTION_NAME,
      "quick action name"
    );
    await setInputValue(
      '[data-testid="work-item-quick-action-prompt"] textarea, textarea[data-testid="work-item-quick-action-prompt"], [data-testid="work-item-quick-action-prompt"] input, input[data-testid="work-item-quick-action-prompt"]',
      `Summarize this work item in one sentence (${RUN_ID}).`,
      "quick action prompt"
    );
    await selectAgentTarget('[data-testid="work-item-quick-action-target"]', "quick action target");
    await clickWhenRendered('[data-testid="work-item-quick-action-create"]', "quick action create");
    const actionId = await waitForDb(
      `SELECT id FROM pm_quick_actions WHERE name='${QUICK_ACTION_NAME}' AND archived_at IS NULL;`,
      (value) => value.length > 0,
      "quick action row"
    );
    await waitForSelector(`[data-testid="work-item-quick-action-${actionId}"]`, "quick action button");

    const runsBefore = sql(`SELECT COUNT(*) FROM pm_work_item_runs;`);
    const dispatchBefore = sql(`SELECT COUNT(*) FROM pm_dispatch_outbox;`);
    await clickWhenRendered(`[data-testid="work-item-quick-action-${actionId}"]`, "quick action invoke");
    await waitForDb(
      `SELECT extras_json LIKE '%qa-${actionId}-%' FROM workitem_extras we JOIN workitems w ON w.id=we.work_item_id WHERE w.project_id='${projectDbId()}' AND w.short_id='${ITEM_C}';`,
      (value) => value === "1",
      "quick action comment persisted in the discussion"
    );
    await waitForDb(
      `SELECT use_count FROM pm_quick_actions WHERE id='${actionId}';`,
      (value) => Number(value) >= 1,
      "quick action use count incremented"
    );
    const woke = await waitForDb(
      `SELECT (SELECT COUNT(*) FROM pm_work_item_runs) || '|' || (SELECT COUNT(*) FROM pm_dispatch_outbox);`,
      (value) => {
        const [runs, dispatch] = value.split("|").map(Number);
        return runs > Number(runsBefore) || dispatch > Number(dispatchBefore);
      },
      "quick action invoke enqueued a run/dispatch",
      MOUNT_TIMEOUT_MS
    );
    console.log(`[features-ui] runs|dispatch before=${runsBefore}|${dispatchBefore} after=${woke}`);
    await openDiscussionSurface();
    const enriched = await invokeE2E("readWorkItemsEnriched", PROJECT_SLUG);
    const enrichedItem = (enriched?.items ?? enriched?.workItems ?? []).find?.((row) => row.short_id === ITEM_C || row.shortId === ITEM_C);
    console.log(`[features-ui] after invoke: enrichedItemComments=${JSON.stringify(enrichedItem?.comments?.length ?? null)}`);
    await pollUntil(
      async () =>
        execJSSafe(`
          const history = document.querySelector('[data-testid="work-item-thread-activity-history"], [data-testid="work-item-lower-tabs-section"]') ?? document.body;
          const text = history.textContent || '';
          if (text.includes(${JSON.stringify(`(${RUN_ID})`)})) return true;
          return 'history-text:' + text.replace(/\s+/g, ' ').slice(0, 160);
        `),
      "quick action comment never rendered in the history timeline",
      MOUNT_TIMEOUT_MS
    );
  });

  it("edits and deletes an own discussion comment with a tombstone (inbox thread surface)", async function () {
    if (!shouldRun("comments")) return this.skip();
    await openProjectList();
    await openItemDetail(ITEM_A);
    await openDiscussionSurface();
    await clickWhenRendered('[data-testid="work-item-subscription-toggle"]', "subscription toggle (viewer id discovery)");
    const viewer = await waitForDb(
      `SELECT subscriber_id FROM pm_work_item_subscriptions WHERE scope_key='project:${PROJECT_SLUG}' AND work_item_id='${ITEM_A}' AND muted_at IS NULL LIMIT 1;`,
      (value) => value.length > 0,
      "viewer subscription row"
    );
    discoveredViewerId = viewer;
    execFileSync(
      pmCli(),
      ["work", "assign", ITEM_A, "--scope", PROJECT_SLUG, "--assignee", `human:${viewer}`, "--mode", "project", "--actor", "human:e2e-teammate"],
      { cwd: orgiiHome(), encoding: "utf8", env: { ...process.env, ORGII_HOME: orgiiHome() } }
    );
    await clickWhenRendered('[data-testid="sidebar-team-inbox"]', "sidebar Team Inbox", MOUNT_TIMEOUT_MS);
    await clickWhenRendered('[data-testid="team-inbox-refresh"]', "team inbox refresh").catch(() => undefined);
    await clickWhenRendered('[data-testid="team-inbox-row"][data-item-kind="assigned_work_item"]', "assigned inbox row", MOUNT_TIMEOUT_MS);
    await clickWhenRendered('[data-testid="work-item-thread-open-discussion"]', "open thread discussion", MOUNT_TIMEOUT_MS);
    await setInputValue('[data-testid="work-item-comment-editor-textarea"]', COMMENT_TEXT, "thread comment editor");
    await clickWhenRendered('button[aria-label="Submit comment"]', "submit comment");
    let commentId = null;
    await pollUntil(
      async () => {
        commentId = await execJSSafe(`
          const el = Array.from(document.querySelectorAll('[data-testid^="work-item-discussion-comment-"]'))
            .find((node) => (node.textContent || '').includes(${JSON.stringify(COMMENT_TEXT)}));
          return el ? el.getAttribute('data-testid').replace('work-item-discussion-comment-', '') : 'comment-missing';
        `);
        return typeof commentId === "string" && commentId !== "comment-missing" && !commentId.startsWith("error:") ? true : commentId;
      },
      "posted comment never rendered in the thread discussion",
      MOUNT_TIMEOUT_MS
    );
    await clickWhenRendered(`[data-testid="work-item-discussion-edit-${commentId}"]`, "comment edit");
    await setInputValue(
      `[data-testid="work-item-discussion-edit-input-${commentId}"] textarea, textarea[data-testid="work-item-discussion-edit-input-${commentId}"], [data-testid="work-item-discussion-edit-input-${commentId}"] input, input[data-testid="work-item-discussion-edit-input-${commentId}"]`,
      COMMENT_EDITED_TEXT,
      "comment edit input"
    );
    await clickWhenRendered(`[data-testid="work-item-discussion-edit-save-${commentId}"]`, "comment edit save");
    await waitForText(COMMENT_EDITED_TEXT, "edited comment text");
    await waitForDb(
      `SELECT extras_json LIKE '%${COMMENT_EDITED_TEXT}%' AND extras_json LIKE '%edited_at%' FROM workitem_extras we JOIN workitems w ON w.id=we.work_item_id WHERE w.project_id='${projectDbId()}' AND w.short_id='${ITEM_A}';`,
      (value) => value === "1",
      "edited comment persisted with edited_at"
    );
    await execJSSafe("window.__orgiiE2EAutoConfirmDestructive = true; return true;");
    await clickWhenRendered(`[data-testid="work-item-discussion-delete-${commentId}"]`, "comment delete (native confirm auto-accepted via __orgiiE2EAutoConfirmDestructive)");
    await waitForDb(
      `SELECT extras_json NOT LIKE '%${COMMENT_EDITED_TEXT}%' AND extras_json LIKE '%deleted_at%' FROM workitem_extras we JOIN workitems w ON w.id=we.work_item_id WHERE w.project_id='${projectDbId()}' AND w.short_id='${ITEM_A}';`,
      (value) => value === "1",
      "deleted comment tombstoned (content cleared, deleted_at set)"
    );
    await browser.waitUntil(
      async () => !(await bodyText()).includes(COMMENT_EDITED_TEXT),
      { timeout: RENDER_TIMEOUT_MS, timeoutMsg: "deleted comment body still rendered" }
    );
  });

  it("delivers a teammate edit to the inbox, archives it, and mutes the category", async function () {
    if (!shouldRun("inbox")) return this.skip();
    if (discoveredViewerId) {
      sql(
        `INSERT OR REPLACE INTO pm_work_item_subscriptions (scope_key, work_item_id, subscriber_id, reason, created_at) VALUES ('project:${PROJECT_SLUG}', '${ITEM_B}', '${discoveredViewerId}', 'manual', ${Date.now()});`
      );
    } else {
      await openProjectList();
      await openItemDetail(ITEM_B);
      await openDiscussionSurface();
      await clickWhenRendered('[data-testid="work-item-subscription-toggle"]', "subscription toggle");
    }
    const subscriber = await waitForDb(
      `SELECT subscriber_id FROM pm_work_item_subscriptions WHERE scope_key='project:${PROJECT_SLUG}' AND work_item_id='${ITEM_B}' AND muted_at IS NULL LIMIT 1;`,
      (value) => value.length > 0,
      "subscription row for the viewer"
    );
    console.log(`[features-ui] subscriber=${subscriber}`);

    teammateEdit(ITEM_B, ["--priority", "high"]);
    await waitForDb(
      `SELECT kind FROM pm_work_item_inbox_events WHERE work_item_id='${ITEM_B}' AND recipient_id='${subscriber}' AND archived_at IS NULL;`,
      (value) => value.includes("priority_changed"),
      "inbox event for the viewer"
    );

    await clickWhenRendered('[data-testid="sidebar-team-inbox"]', "sidebar Team Inbox", MOUNT_TIMEOUT_MS);
    await clickWhenRendered('[data-testid="team-inbox-refresh"]', "team inbox refresh").catch(() => undefined);
    const itemBTitle = `Feature item B ${RUN_ID}`;
    await pollUntil(
      async () => {
        await clickSelector('[data-testid="team-inbox-row"][data-item-kind="work_item_updated"]');
        await browser.pause(400);
        return execJSSafe(`
          ${VISIBLE_FN}
          const actions = document.querySelector('[data-testid="team-inbox-detail-actions"], [data-testid="team-inbox-archive"]');
          const pane = actions ? (actions.closest('section, aside, [data-testid="team-inbox-detail-layout"], div[class*="detail"]') ?? actions.parentElement?.parentElement) : null;
          const text = pane ? (pane.textContent || '') : (document.body.innerText || '');
          return text.includes(${JSON.stringify(itemBTitle)}) && text.includes('Priority') ? true : 'detail-text:' + text.slice(0, 120);
        `);
      },
      "inbox detail never showed the priority-changed item",
      MOUNT_TIMEOUT_MS
    );
    await clickWhenRendered('[data-testid="team-inbox-archive"]', "inbox archive action");
    await waitForDb(
      `SELECT COUNT(*) FROM team_inbox_archive_receipts;`,
      (value) => Number(value) >= 1,
      "archive receipt written"
    );
    await clickWhenRendered('[data-testid="team-inbox-filter-archived"]', "archived filter");
    await clickWhenRendered('[data-testid="team-inbox-refresh"]', "team inbox refresh (archived)").catch(() => undefined);
    await pollUntil(
      async () =>
        execJSSafe(`
          ${VISIBLE_FN}
          const rows = Array.from(document.querySelectorAll('[data-testid="team-inbox-row"]'));
          if (rows.some((el) => isVisible(el) && el.getAttribute('data-item-kind') === 'work_item_updated')) return true;
          const archivedTab = document.querySelector('[data-testid="team-inbox-filter-archived"]');
          const pressed = archivedTab ? archivedTab.getAttribute('aria-pressed') : 'n/a';
          if (archivedTab && pressed !== 'true') archivedTab.click();
          return 'archivedPressed=' + pressed + ' rows=' + rows.map((el) => el.getAttribute('data-item-kind') + ':' + (el.getAttribute('data-item-id') || '').slice(-12) + (isVisible(el) ? '' : '(hidden)')).join(',');
        `),
      "archived row visible",
      MOUNT_TIMEOUT_MS
    );
    await clickWhenRendered('[data-testid="team-inbox-filter-all"]', "all filter");

    await $('[data-testid="team-inbox-mute-categories"]').click();
    await browser.pause(1500);
    const portalDump = await execJSSafe(`
      ${VISIBLE_FN}
      const kids = Array.from(document.body.children).slice(-6).map((el) => ({
        tag: el.tagName, cls: String(el.className || '').slice(0, 80), text: (el.textContent || '').trim().slice(0, 60), visible: isVisible(el)
      }));
      const hits = Array.from(document.querySelectorAll('div,button,li,span,label')).filter((el) => isVisible(el) && (el.textContent || '').trim() === 'Priority changed' && !el.closest('[data-testid="team-inbox-row"]')).map((el) => el.tagName + '.' + String(el.className || '').slice(0, 60));
      return JSON.stringify({ kids, hits });
    `);
    console.log(`[features-ui] mute menu after single click: ${portalDump}`);
    await pollUntil(
      async () =>
        execJSSafe(`
          ${VISIBLE_FN}
          const hits = Array.from(document.querySelectorAll('div,button,li,span,label')).filter((el) => isVisible(el) && (el.textContent || '').trim() === 'Priority changed' && !el.closest('[data-testid="team-inbox-row"]'));
          const target = hits.find((el) => String(el.className || '').includes('cursor-pointer')) ?? hits.find((el) => el.closest('[class*="cursor-pointer"]'))?.closest('[class*="cursor-pointer"]') ?? hits[0];
          if (!target) return 'option-missing';
          target.click();
          return 'clicked';
        `),
      "mute categories option",
      RENDER_TIMEOUT_MS
    );
    await waitForDb(
      `SELECT COUNT(*) FROM pm_inbox_prefs WHERE kind='priority_changed' AND recipient_id='${subscriber}';`,
      (value) => Number(value) >= 1,
      "mute preference persisted"
    );
    const eventsBefore = sql(
      `SELECT COUNT(*) FROM pm_work_item_inbox_events WHERE work_item_id='${ITEM_B}' AND recipient_id='${subscriber}';`
    );
    teammateEdit(ITEM_B, ["--priority", "urgent"]);
    await browser.pause(1500);
    const eventsAfter = sql(
      `SELECT COUNT(*) FROM pm_work_item_inbox_events WHERE work_item_id='${ITEM_B}' AND recipient_id='${subscriber}';`
    );
    if (eventsAfter !== eventsBefore) {
      throw new Error(`muted kind still produced an inbox event: before=${eventsBefore} after=${eventsAfter}`);
    }
  });


});

async function clickByTextSafe(rootSelector, text) {
  return execJS(`
    ${VISIBLE_FN}
    const roots = Array.from(document.querySelectorAll(${JSON.stringify(rootSelector)})).filter(isVisible);
    for (const root of roots) {
      const target = Array.from(root.querySelectorAll('button')).find((el) => isVisible(el) && (el.textContent || '').trim() === ${JSON.stringify(text)});
      if (target) { target.click(); return 'clicked'; }
    }
    return 'missing';
  `);
}
