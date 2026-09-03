/* global describe, before, beforeEach, afterEach, it */
import {
  AGENT_ORG_COORDINATOR_MEMBER_ID,
  AGENT_ORG_TASK_STATUS,
  DEFAULT_AGENT_ORG_MEMBER_IDS,
  RUN_ID,
  assertE2ERepoFixture,
  configureCreatorForDefaultAgentOrg,
  getApiAccount,
  invokeE2E,
  openAgentOrgOverviewPanel,
  selectPreferredModel,
  selectRenderedDefaultAgentOrg,
  selectRenderedExecMode,
  sendFromRenderedCreator,
  unwrap,
  waitForAgentOrgRunView,
  waitForApp,
} from "../../support/core/agentOrgUiDriver.mjs";

describe("Agent Org safe Task handoff rendered UI", () => {
  before(async () => {
    assertE2ERepoFixture();
    await waitForApp();
  });

  beforeEach(async () => {
    await invokeE2E("resetToNewSession");
  });

  afterEach(async () => {
    await invokeE2E("resetToNewSession");
  });

  it("reassigns only after old execution release and cancels the replacement through real controls", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const scenarioId = `rendered_${RUN_ID}`;
    const sessionId = await sendFromRenderedCreator(
      `Run E2E_AGENT_ORG_HANDOFF:${scenarioId}`
    );
    if (!sessionId) {
      throw new Error("safe handoff launch did not create a root Session");
    }

    let oldTaskId = null;
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const task = (view?.tasks ?? []).find(
          (candidate) => candidate.subject === `E2E_HANDOFF_TASK:${scenarioId}`
        );
        oldTaskId = task?.id ?? null;
        return Boolean(
          view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          task?.status === AGENT_ORG_TASK_STATUS.IN_PROGRESS &&
          task?.owner === DEFAULT_AGENT_ORG_MEMBER_IDS.IMPLEMENTER
        );
      },
      "old Task owns a live execution before rendered reassignment"
    );
    if (!oldTaskId) throw new Error("safe handoff Task id was not projected");

    await openAgentOrgOverviewPanel("safe handoff reassignment");
    const oldRow = await browser.$(
      `[data-testid="agent-org-overview-task-row"][data-task-id="${oldTaskId}"]`
    );
    await oldRow.$('[data-testid="agent-org-task-reassign-button"]').click();
    await browser
      .$('[data-testid="agent-org-task-reassign-owner-select"]')
      .click();
    await browser
      .$(
        `[data-testid="agent-org-task-reassign-owner-option-${DEFAULT_AGENT_ORG_MEMBER_IDS.REVIEWER}"]`
      )
      .click();
    await browser
      .$('[data-testid="agent-org-task-handoff-confirm-button"]')
      .click();

    let replacementTaskId = null;
    let sawBlockedReplacement = false;
    let latest = null;
    try {
      await browser.waitUntil(
        async () => {
          latest = unwrap(
            await invokeE2E("agentOrgSessionRunView", sessionId),
            "agentOrgSessionRunView(reassignment fence)"
          ).view;
          const handoff = (latest?.executionHandoffs ?? []).find(
            (receipt) => receipt.oldTaskId === oldTaskId
          );
          replacementTaskId = handoff?.replacementTaskId ?? replacementTaskId;
          const replacement = (latest?.tasks ?? []).find(
            (task) => task.id === replacementTaskId
          );
          if (
            handoff &&
            (handoff.state === "requested" || handoff.state === "yielding")
          ) {
            if (replacement?.status !== AGENT_ORG_TASK_STATUS.PENDING) {
              throw new Error(
                `replacement escaped Pending before release: ${JSON.stringify({ handoff, replacement })}`
              );
            }
            sawBlockedReplacement = true;
          }
          if (
            replacement?.status === AGENT_ORG_TASK_STATUS.IN_PROGRESS &&
            handoff?.state !== "released"
          ) {
            throw new Error(
              `replacement started before the release receipt: ${JSON.stringify({ handoff, replacement })}`
            );
          }
          return Boolean(
            handoff?.state === "released" &&
            replacement?.status === AGENT_ORG_TASK_STATUS.IN_PROGRESS &&
            replacement.owner === DEFAULT_AGENT_ORG_MEMBER_IDS.REVIEWER
          );
        },
        {
          timeout: 90_000,
          interval: 50,
          timeoutMsg: "replacement did not start after release",
        }
      );
    } catch (error) {
      throw new Error(
        `replacement did not start after release: ${JSON.stringify(latest)}`,
        { cause: error }
      );
    }
    if (!sawBlockedReplacement) {
      throw new Error(
        "rendered reassignment never exposed the blocked Pending replacement"
      );
    }
    if (!replacementTaskId) {
      throw new Error(
        "rendered reassignment did not create a replacement Task"
      );
    }

    const replacementRow = await browser.$(
      `[data-testid="agent-org-overview-task-row"][data-task-id="${replacementTaskId}"]`
    );
    await replacementRow
      .$('[data-testid="agent-org-task-cancel-button"]')
      .click();
    await browser
      .$('[data-testid="agent-org-task-handoff-confirm-button"]')
      .click();

    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const cancellation = (view?.executionHandoffs ?? []).find(
          (receipt) =>
            receipt.oldTaskId === replacementTaskId &&
            receipt.replacementTaskId == null
        );
        return Boolean(
          cancellation?.state === "released" &&
          view?.taskOverview?.cancelled === 2 &&
          view?.taskOverview?.inProgress === 0 &&
          view?.taskOverview?.pending === 0 &&
          view?.completion?.outcome !== "delivered"
        );
      },
      "replacement cancellation releases the exact old execution without false Delivered"
    );
  });
});
