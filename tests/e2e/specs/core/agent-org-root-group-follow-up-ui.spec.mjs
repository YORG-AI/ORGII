/* global describe, before, it, browser */
import {
  AGENT_ORG_COORDINATOR_MEMBER_ID,
  REPLY_TIMEOUT_MS,
  RUN_ID,
  assertE2ERepoFixture,
  assertNoMemberIntervention,
  configureCreatorForDefaultAgentOrg,
  getApiAccount,
  invokeE2E,
  openRenderedGroupChatView,
  selectPreferredModel,
  selectRenderedDefaultAgentOrg,
  selectRenderedExecMode,
  sendFromRenderedCreator,
  sendRenderedChatPrompt,
  unwrap,
  waitForAgentOrgRunView,
  waitForApp,
  waitForCoordinatorRuntimeStatus,
  waitForRenderedAssistantReply,
  waitForRenderedGroupChatActive,
  waitForRenderedGroupChatMessage,
  waitForRenderedGroupChatUserTurn,
} from "../../support/core/agentOrgUiDriver.mjs";

async function coordinatorUserInboxIds(runId, label) {
  const result = unwrap(
    await invokeE2E("debugAgentOrgInboxList", runId),
    `debugAgentOrgInboxList(${label})`
  );
  return new Set(
    (result.rows ?? [])
      .filter(
        (row) =>
          row.senderAgentId === "_user" &&
          row.recipientMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID
      )
      .map((row) => row.id)
  );
}

describe("Agent Org Root Group follow-up rendered UI", () => {
  before(async () => {
    assertE2ERepoFixture();
    await waitForApp();
  });

  it("accepts Idle follow-ups and keeps busy follow-ups as distinct FIFO turns", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const launchPrompt = `E2E Root Group follow-up launch ${RUN_ID}. Reply briefly and do not create tasks.`;
    const sessionId = await sendFromRenderedCreator(launchPrompt);
    if (!sessionId) {
      throw new Error("Root Group follow-up launch did not create a session");
    }
    await waitForRenderedAssistantReply("Root Group follow-up launch");

    let runId = null;
    let coordinatorName = "Coordinator";
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const coordinator = (view?.members ?? []).find(
          (member) => member.memberId === AGENT_ORG_COORDINATOR_MEMBER_ID
        );
        runId = view?.context?.runId ?? null;
        coordinatorName = coordinator?.name ?? coordinatorName;
        return Boolean(runId && view?.runStatus === "idle");
      },
      "pure launch answer leaves Team Idle",
      REPLY_TIMEOUT_MS
    );
    if (!runId) throw new Error("Root Group follow-up run id was unavailable");

    await openRenderedGroupChatView();
    await waitForRenderedGroupChatActive("Idle Root follow-up");
    const inboxIdsBefore = await coordinatorUserInboxIds(
      runId,
      "before Idle Root follow-up"
    );

    const idleMessage = `E2E Idle Root follow-up ${RUN_ID}`;
    await sendRenderedChatPrompt(idleMessage);
    await waitForRenderedGroupChatUserTurn({
      text: idleMessage,
      label: "Idle Root follow-up user Turn",
    });
    await waitForRenderedGroupChatMessage({
      sender: coordinatorName,
      text: idleMessage,
      label: "Idle Root follow-up Coordinator reply",
      timeout: REPLY_TIMEOUT_MS,
    });
    await waitForAgentOrgRunView(
      sessionId,
      (view) => view?.runStatus === "idle",
      "pure Root follow-up keeps Team Idle",
      REPLY_TIMEOUT_MS
    );

    const inboxIdsAfterIdle = await coordinatorUserInboxIds(
      runId,
      "after Idle Root follow-up"
    );
    if (
      [...inboxIdsAfterIdle].some((inboxId) => !inboxIdsBefore.has(inboxId))
    ) {
      throw new Error(
        "Idle Root follow-up incorrectly entered the legacy Coordinator Inbox"
      );
    }

    const activeMessage = `E2E Root FIFO active ${RUN_ID}. Create a stoppable window by waiting for about 4 seconds.`;
    const queuedMessage = `E2E Root FIFO queued next Turn ${RUN_ID}`;
    await sendRenderedChatPrompt(activeMessage);
    await waitForCoordinatorRuntimeStatus(
      sessionId,
      (status) => status === "running",
      "Coordinator active before FIFO follow-up"
    );
    await sendRenderedChatPrompt(queuedMessage);

    let queuedState = null;
    await browser.waitUntil(
      async () => {
        queuedState = unwrap(
          await invokeE2E("inspectChatState"),
          "inspectChatState(Root FIFO queued)"
        );
        return (queuedState.queuedMessages ?? []).some(
          (message) =>
            message.sessionId === sessionId &&
            message.content === queuedMessage &&
            message.priority === "next"
        );
      },
      {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: `busy Root follow-up was not visible in FIFO: ${JSON.stringify(queuedState)}`,
      }
    );

    await waitForRenderedGroupChatUserTurn({
      text: queuedMessage,
      label: "queued Root follow-up materialized as its own user Turn",
    });
    await waitForRenderedGroupChatMessage({
      sender: coordinatorName,
      text: queuedMessage,
      label: "queued Root follow-up received its own Coordinator reply",
      timeout: REPLY_TIMEOUT_MS,
    });
    await waitForRenderedGroupChatUserTurn({
      text: activeMessage,
      label: "active Root message retained in the shared Group projection",
    });
    await waitForRenderedGroupChatMessage({
      sender: coordinatorName,
      text: activeMessage,
      label: "active Root reply retained in the shared Group projection",
      timeout: REPLY_TIMEOUT_MS,
    });
    await waitForRenderedGroupChatUserTurn({
      text: queuedMessage,
      label: "queued Root message remains a separate projection item",
    });
    await waitForAgentOrgRunView(
      sessionId,
      (view) => view?.runStatus === "idle",
      "FIFO follow-ups finish without opening work",
      REPLY_TIMEOUT_MS
    );
    await assertNoMemberIntervention(
      sessionId,
      "Root Group FIFO must not create Member intervention"
    );

    const inboxIdsAfterFifo = await coordinatorUserInboxIds(
      runId,
      "after Root FIFO follow-ups"
    );
    if (
      [...inboxIdsAfterFifo].some((inboxId) => !inboxIdsBefore.has(inboxId))
    ) {
      throw new Error(
        "Root FIFO follow-up incorrectly entered the legacy Coordinator Inbox"
      );
    }
  });
});
