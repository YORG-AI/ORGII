/* global describe, before, it, browser, process */
import {
  RENDER_TIMEOUT_MS,
  execJS,
  invokeE2E,
  openAgentOrgOverviewPanel,
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
  rootStatus = "idle",
  runStatus = "running",
  workerStatus = "idle",
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
    await invokeE2E("primeSidebarEntityCache"),
    `primeSidebarEntityCache(${sessionId})`
  );
  unwrap(
    await invokeE2E("seedSidebarSession", {
      sessionId,
      name: `Agent Org delete ${sessionId}`,
      status: "idle",
    }),
    `seedSidebarSession(${sessionId})`
  );
  await (
    await browser.$('[data-testid="sidebar-session-filter-button"]')
  ).click();
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!document.querySelector('[data-testid="sidebar-refresh-sessions"]');`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 100,
      timeoutMsg: "sidebar refresh action did not render",
    }
  );
  await (await browser.$('[data-testid="sidebar-refresh-sessions"]')).click();
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

async function persistenceSnapshot(sessionIds, runIds) {
  return postJson("/agent/test/agent-org/session-delete/snapshot", {
    session_ids: sessionIds,
    run_ids: runIds,
  });
}

async function deleteHierarchyAndAssertGone(hierarchy) {
  await refreshAndWaitForSidebarRow(hierarchy.rootSessionId);
  await openRenderedSidebarSession(hierarchy.rootSessionId);
  await openAgentOrgOverviewPanel(
    `Agent Org delete ${hierarchy.rootSessionId}`
  );

  await browser.waitUntil(
    async () =>
      execJS(
        `return !!document.querySelector('[data-testid="agent-org-overview-archive-button"]');`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: "Archive action did not render",
    }
  );
  await execJS("window.__orgiiE2EAutoConfirmDestructive = true; return true;");
  await (
    await browser.$('[data-testid="agent-org-overview-archive-button"]')
  ).click();

  await browser.waitUntil(
    async () =>
      execJS(
        `return document.querySelector('[data-testid="agent-org-overview-panel"]')?.getAttribute("data-run-phase") === "archived";`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: "Archive did not project Archived immediately",
    }
  );
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!document.querySelector('[data-testid="agent-org-archived-composer"]') && document.querySelector('[data-testid="agent-org-task-history-toggle"]')?.getAttribute("aria-expanded") === "true";`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: "Archived read-only composer/history did not render",
    }
  );

  const archivedSnapshot = await persistenceSnapshot(
    [hierarchy.rootSessionId, ...hierarchy.workerSessionIds],
    [hierarchy.runId]
  );
  const detail = archivedSnapshot.run_details[hierarchy.runId];
  if (
    detail?.status !== "archived" ||
    detail?.activation_generation < 2 ||
    !detail?.archived_at ||
    !detail?.archive_receipt_id
  ) {
    throw new Error(
      `Archive fence/receipt missing: ${JSON.stringify(archivedSnapshot)}`
    );
  }

  await browser.waitUntil(
    async () =>
      execJS(
        `const button=document.querySelector('[data-testid="agent-org-overview-delete-button"]'); return !!button && !button.disabled;`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: "Team Delete stayed blocked after runtime quiescence",
    }
  );
  await (
    await browser.$('[data-testid="agent-org-overview-delete-button"]')
  ).click();
  await (await browser.$('div[role="dialog"] input[type="checkbox"]')).click();
  await (
    await browser.$('[data-testid="agent-org-delete-confirm-button"]')
  ).click();

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
        `deleted Team session remained durable: ${sessionId} ${JSON.stringify(snapshot)}`
      );
    }
  }
  if (snapshot.runs[hierarchy.runId] !== false) {
    throw new Error(
      `deleted Team remained durable: ${JSON.stringify(snapshot)}`
    );
  }
}
describe("Agent Org irreversible Archive and Team Delete rendered UI", () => {
  before(async () => {
    await waitForApp();
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo(Agent Org Archive/Delete)"
    );
    await (await browser.$('[data-testid="sidebar-view-sessions"]')).click();
    await browser.waitUntil(
      async () =>
        execJS(
          `return document.querySelector('[data-testid="sidebar-view-sessions"]')?.getAttribute('aria-current') === 'page';`
        ),
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 100,
        timeoutMsg:
          "Agent Org Archive/Delete Sessions sidebar did not activate",
      }
    );
  });

  it("archives through Overview, becomes read-only, then deletes through Danger Zone", async () => {
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

  it("archives a Working Team before deleting its full Rust hierarchy", async () => {
    const hierarchy = await seedHierarchy({
      label: "running",
      rootStatus: "idle",
      runStatus: "running",
      workerStatus: "pending",
      nested: true,
    });
    await deleteHierarchyAndAssertGone(hierarchy);
  });

  it("archives a Paused Team before deleting its full Rust hierarchy", async () => {
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
