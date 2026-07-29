/* global describe, before, it, browser, process */
import { execFileSync } from "node:child_process";

import {
  RENDER_TIMEOUT_MS,
  execJS,
  invokeE2E,
  openRenderedSidebarSession,
  unwrap,
  waitForApp,
} from "../../support/core/agentOrgUiDriver.mjs";

const E2E_BASE_URL = `http://127.0.0.1:${process.env.E2E_IDE_SERVER_PORT ?? "13847"}`;
const RUN_ID = Date.now();

async function postJson(pathname, body = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${E2E_BASE_URL}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json();
    if (!response.ok || json?.ok !== true) {
      throw new Error(`${pathname} failed: ${JSON.stringify(json)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function seedHierarchy({
  label,
  rootStatus = "completed",
  runStatus = "completed",
  workerStatus = "completed",
  nested = false,
}) {
  const rootSessionId = `sdeagent-e2e-delete-${label}-root-${RUN_ID}`;
  const firstWorkerId = `sdeagent-e2e-delete-${label}-worker-a-${RUN_ID}`;
  const secondWorkerId = `sdeagent-e2e-delete-${label}-worker-b-${RUN_ID}`;
  const workers = [
    {
      session_id: firstWorkerId,
      member_id: `${label}-worker-a`,
      agent_definition_id: "builtin:sde",
      status: workerStatus,
    },
  ];
  if (nested) {
    workers.push({
      session_id: secondWorkerId,
      parent_session_id: firstWorkerId,
      member_id: `${label}-worker-b`,
      agent_definition_id: "builtin:sde",
      status: workerStatus,
    });
  }
  const seeded = await postJson(
    "/agent/test/agent-org/stale-workers/seed-run",
    {
      org_id: `e2e-delete-${label}-${RUN_ID}`,
      coordinator_agent_id: "builtin:sde",
      root_session_id: rootSessionId,
      root_status: rootStatus,
      run_status: runStatus,
      workers,
    }
  );
  return {
    runId: seeded.org_run_id,
    rootSessionId,
    workerSessionIds: workers.map((worker) => worker.session_id),
  };
}

async function refreshAndWaitForSidebarRow(sessionId) {
  unwrap(
    await invokeE2E("seedSidebarSession", {
      sessionId,
      name: `Agent Org delete ${sessionId}`,
      status: "completed",
    }),
    `seedSidebarSession(${sessionId})`
  );
  const selector = `[data-testid="sidebar-session-item-${sessionId}"]`;
  await browser.waitUntil(
    async () =>
      execJS(`return !!document.querySelector(${JSON.stringify(selector)});`),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: `sidebar row ${sessionId} did not render`,
    }
  );
}

async function chooseDeleteFromRenderedSidebarMenu(sessionId) {
  const rowSelector = `[data-testid="sidebar-session-item-${sessionId}"]`;
  const moreSelector = `[data-testid="sidebar-session-more-${sessionId}"]`;
  const row = await browser.$(rowSelector);
  await row.moveTo();

  let opened = false;
  for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
    await (await browser.$(moreSelector)).click();
    opened = await browser
      .waitUntil(
        async () =>
          execJS(
            `return document.querySelector(${JSON.stringify(moreSelector)})?.getAttribute('aria-pressed') === 'true';`
          ),
        { timeout: 2_000, interval: 100 }
      )
      .catch(() => false);
  }
  if (!opened) {
    throw new Error(`native sidebar menu did not open for ${sessionId}`);
  }

  // WebDriver key actions target the WebView rather than the macOS menu
  // process. Native menus support type-to-select, so select the uniquely
  // named Delete item and confirm it with real OS key events.
  execFileSync("osascript", [
    "-e",
    'tell application "System Events" to keystroke "d"',
    "-e",
    'tell application "System Events" to key code 36',
  ]);
}

async function persistenceSnapshot(sessionIds, runIds) {
  return postJson("/agent/test/agent-org/session-delete/snapshot", {
    session_ids: sessionIds,
    run_ids: runIds,
  });
}

async function deleteHierarchyAndAssertGone(hierarchy) {
  await refreshAndWaitForSidebarRow(hierarchy.rootSessionId);
  await openRenderedSidebarSession(hierarchy.rootSessionId);

  await chooseDeleteFromRenderedSidebarMenu(hierarchy.rootSessionId);

  const rootSelector = `[data-testid="sidebar-session-item-${hierarchy.rootSessionId}"]`;
  await browser.waitUntil(
    async () =>
      execJS(
        `return !document.querySelector(${JSON.stringify(rootSelector)});`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: "deleted Agent Org root remained in the sidebar",
    }
  );
  const snapshot = await persistenceSnapshot(
    [hierarchy.rootSessionId, ...hierarchy.workerSessionIds],
    [hierarchy.runId]
  );
  for (const sessionId of [
    hierarchy.rootSessionId,
    ...hierarchy.workerSessionIds,
  ]) {
    if (snapshot.sessions[sessionId] !== false) {
      throw new Error(
        `deleted Rust session remained durable: ${sessionId} ${JSON.stringify(snapshot)}`
      );
    }
  }
  if (snapshot.runs[hierarchy.runId] !== false) {
    throw new Error(
      `deleted run remained durable: ${JSON.stringify(snapshot)}`
    );
  }
}

describe("Agent Org Rust session hierarchy deletion rendered UI", () => {
  before(async () => {
    await waitForApp();
  });

  it("deletes the completed root and all Rust workers through the real sidebar menu", async () => {
    const hierarchy = await seedHierarchy({
      label: "completed",
      nested: true,
    });
    const unrelated = await seedHierarchy({
      label: "unrelated",
    });
    await deleteHierarchyAndAssertGone(hierarchy);
    const activeSessionId = unwrap(
      await invokeE2E("getActiveSessionId"),
      "getActiveSessionId after hierarchy delete"
    ).sessionId;
    if (activeSessionId === hierarchy.rootSessionId) {
      throw new Error(
        "deleting the active Agent Org root did not navigate once"
      );
    }

    const snapshot = await persistenceSnapshot(
      [unrelated.rootSessionId],
      [unrelated.runId]
    );
    if (
      snapshot.sessions[unrelated.rootSessionId] !== true ||
      snapshot.runs[unrelated.runId] !== true
    ) {
      throw new Error(
        `unrelated Agent Org was modified: ${JSON.stringify(snapshot)}`
      );
    }
  });

  it("stops a running run and deletes its Rust hierarchy through the real sidebar menu", async () => {
    const hierarchy = await seedHierarchy({
      label: "running",
      rootStatus: "idle",
      runStatus: "running",
      workerStatus: "pending",
      nested: true,
    });
    await deleteHierarchyAndAssertGone(hierarchy);
  });

  it("deletes a paused run and its Rust hierarchy through the real sidebar menu", async () => {
    const hierarchy = await seedHierarchy({
      label: "paused",
      rootStatus: "paused",
      runStatus: "paused",
      workerStatus: "paused",
      nested: true,
    });
    await deleteHierarchyAndAssertGone(hierarchy);
  });
});
