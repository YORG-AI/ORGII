/* global describe, before, afterEach, it, process, fetch */
import {
  RENDER_TIMEOUT_MS,
  REPLY_TIMEOUT_MS,
  RUN_ID,
  assertE2ERepoFixture,
  configureCreatorForDefaultAgentOrg,
  execJS,
  getApiAccount,
  invokeE2E,
  js,
  openAgentOrgOverviewPanel,
  selectPreferredModel,
  selectRenderedDefaultAgentOrg,
  selectRenderedExecMode,
  sendFromRenderedCreator,
  unwrap,
  waitForAgentOrgRunView,
  waitForApp,
} from "../../support/core/agentOrgUiDriver.mjs";

const E2E_BASE_URL = `http://127.0.0.1:${process.env.E2E_IDE_SERVER_PORT ?? "13847"}`;
const RUN_PHASE = { FINALIZING: "finalizing", IDLE: "idle" };

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

describe("Agent Org final summary rendered UI", () => {
  let armedSessionId = null;

  before(async () => {
    assertE2ERepoFixture();
    await waitForApp();
  });

  afterEach(async () => {
    if (armedSessionId) {
      await postJson(
        "/agent/test/agent-org/formal-convergence/clear-final-summary-event-store",
        { session_id: armedSessionId }
      );
      armedSessionId = null;
    }
    await invokeE2E("resetToNewSession");
  });

  it("leaves certified evidence visible after EventStore failure and retries only from the rendered button", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const scenarioId = `final_summary_failure_${RUN_ID}`;
    const sessionId = await sendFromRenderedCreator(
      `Run E2E_AGENT_ORG_COMPLETION:${scenarioId}. Create a stoppable window by waiting for about 10 seconds before the final answer.`
    );
    if (!sessionId) {
      throw new Error("Final-summary E2E did not create a Session");
    }

    await postJson(
      "/agent/test/agent-org/formal-convergence/fail-next-final-summary-event-store",
      { session_id: sessionId }
    );
    armedSessionId = sessionId;

    let failedView = null;
    await browser.waitUntil(
      async () => {
        failedView = unwrap(
          await invokeE2E("agentOrgSessionRunView", sessionId),
          "agentOrgSessionRunView(final summary failed)"
        ).view;
        const summary = failedView?.finalSummary;
        return Boolean(
          failedView?.taskOverview?.total === 1 &&
            failedView?.taskOverview?.completed === 1 &&
            failedView?.completion?.state === "certified" &&
            failedView?.completion?.outcome === "delivered" &&
            summary?.attempt === 1 &&
            summary?.status === "failed" &&
            summary?.typedError === "event_store_error" &&
            summary?.canRetry === true &&
            failedView?.runStatus === "idle" &&
            failedView?.runPhase === RUN_PHASE.IDLE
        );
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "EventStore fault did not terminate FinalSummaryReceipt as failed and return the Team to Idle",
      }
    );
    armedSessionId = null;

    await openAgentOrgOverviewPanel("failed final report");
    const failedCard = await execJS(`
      const card = document.querySelector('[data-testid="agent-org-final-summary-failed"]');
      const retry = card?.querySelector('[data-testid="agent-org-final-summary-retry"]');
      return card ? {
        text: card.textContent || "",
        attempt: card.getAttribute('data-summary-attempt'),
        certificateId: card.getAttribute('data-certificate-id'),
        hasRetry: retry instanceof HTMLElement,
      } : null;
    `);
    if (
      failedCard?.attempt !== "1" ||
      failedCard?.certificateId !== failedView.finalSummary.certificateId ||
      failedCard?.hasRetry !== true
    ) {
      throw new Error(
        `Failed final report did not preserve evidence and render Retry: ${JSON.stringify({ failedCard, failedView })}`
      );
    }

    const retryClick = await execJS(
      js.click('[data-testid="agent-org-final-summary-retry"]')
    );
    if (retryClick !== "clicked") {
      throw new Error(`Final report Retry button did not click: ${retryClick}`);
    }

    let activeRetryView = null;
    await browser.waitUntil(
      async () => {
        activeRetryView = unwrap(
          await invokeE2E("agentOrgSessionRunView", sessionId),
          "agentOrgSessionRunView(final summary retry active)"
        ).view;
        return Boolean(
          activeRetryView?.finalSummary?.attempt === 2 &&
            ["pending", "running", "persisting"].includes(
              activeRetryView?.finalSummary?.status
            ) &&
            activeRetryView?.runPhase === RUN_PHASE.FINALIZING
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 100,
        timeoutMsg:
          "Rendered Retry did not create one active attempt and project Finalizing",
      }
    );

    let persistedView = null;
    await browser.waitUntil(
      async () => {
        persistedView = unwrap(
          await invokeE2E("agentOrgSessionRunView", sessionId),
          "agentOrgSessionRunView(final summary retry persisted)"
        ).view;
        return Boolean(
          persistedView?.finalSummary?.attempt === 2 &&
            persistedView?.finalSummary?.status === "persisted" &&
            persistedView?.finalSummary?.eventId &&
            persistedView?.runStatus === "idle" &&
            persistedView?.runPhase === RUN_PHASE.IDLE
        );
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "Explicit final report Retry did not persist one EventStore result and return to Idle",
      }
    );

    if (
      await execJS(
        js.exists('[data-testid="agent-org-final-summary-failed"]')
      )
    ) {
      throw new Error("Failed final report card remained after persisted Retry");
    }

    await browser.refresh();
    await waitForApp();
    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession(final summary EventStore reload)"
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) =>
        view?.finalSummary?.status === "persisted" &&
        view?.finalSummary?.eventId === persistedView.finalSummary.eventId,
      "persisted final summary after reload"
    );
    const chat = unwrap(
      await invokeE2E("inspectChatState"),
      "inspectChatState(final summary EventStore reload)"
    );
    const finalEvent = (chat.rawEvents ?? []).find(
      (event) => event.id === persistedView.finalSummary.eventId
    );
    if (
      finalEvent?.result?.agent_org_completion_certificate?.id !==
      persistedView.finalSummary.certificateId
    ) {
      throw new Error(
        `Reloaded EventStore row lost its exact completion certificate: ${JSON.stringify({ finalEvent, persistedView })}`
      );
    }
  });
});
