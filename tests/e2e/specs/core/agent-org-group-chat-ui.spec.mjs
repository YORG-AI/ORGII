/* global describe, before, beforeEach, afterEach, it, process, fetch */
import {
  AGENT_ORG_COORDINATOR_MEMBER_ID,
  AGENT_ORG_TASK_STATUS,
  API_AGENT_TYPE,
  BUILTIN_SDE_AGENT_ID,
  DEFAULT_AGENT_ORG_ID,
  DEFAULT_AGENT_ORG_MEMBER_IDS,
  RENDER_TIMEOUT_MS,
  REPLY_TIMEOUT_MS,
  RUN_ID,
  SHARED_CLI_AGENT_ID,
  assertCrashRecoveryBannerAbsent,
  assertE2ERepoFixture,
  assertLongTaskRenderedCollapsed,
  assertNoCurrentPlanBuildSurface,
  assertNoFalseFinality,
  assertNoMemberIntervention,
  assertRenderedGroupChatNoQuoteOrUnreadPreview,
  assertRenderedGroupChatToggleIsIdempotent,
  assertRenderedInboxPinBarAbsent,
  clickGroupChatResumeButton,
  clickRenderedGroupChatLoadOlder,
  clickRenderedMemberSwitcher,
  clickReturnToWorkAndWaitCleared,
  configureCreatorForAgentOrg,
  configureCreatorForDefaultAgentOrg,
  createLongTaskPrecondition,
  createRenderedStrictTwoMemberAgentOrg,
  ensureMemberHasSwitchableInbox,
  execJS,
  executeCreatePlanAsMember,
  getApiAccount,
  invokeE2E,
  js,
  openAgentOrgOverviewPanel,
  openRenderedGroupChatView,
  openRenderedSidebarSession,
  parseInboxPayload,
  refreshRenderedAgentOrgOverview,
  removeAgentOrgsByName,
  selectMemberOverrideModel,
  selectPreferredModel,
  selectRenderedAgentOrg,
  selectRenderedDefaultAgentOrg,
  selectRenderedExecMode,
  selectRenderedTurnPageByPreview,
  sendCoordinatorOrgMessage,
  sendFromRenderedCreator,
  sendRenderedChatPrompt,
  sendRenderedGroupChatMentionPrompt,
  unwrap,
  waitForActiveSessionExecMode,
  waitForAgentOrgByName,
  waitForAgentOrgRunView,
  waitForAgentOrgRunViewByOrg,
  waitForApp,
  waitForCoordinatorRuntimeStatus,
  waitForGroupChatPausedBanner,
  waitForGroupChatPendingTarget,
  waitForInboxRow,
  waitForInboxRowRead,
  waitForIntervention,
  waitForMemberPostMessageActivity,
  waitForPlanApprovalRequest,
  waitForPromptDump,
  waitForRenderedAssistantReply,
  waitForRenderedGroupChatActive,
  waitForRenderedGroupChatMessage,
  waitForRenderedGroupChatUserTurn,
  waitForRenderedInterventionPin,
  waitForRenderedReleasedTask,
  waitForSessionAggregateRow,
  waitForSessionOrgRuntimeSnapshot,
} from "../../support/core/agentOrgUiDriver.mjs";

const E2E_BASE_URL = `http://127.0.0.1:${process.env.E2E_IDE_SERVER_PORT ?? "13847"}`;

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

async function pauseDefaultAgentOrgRuns(label) {
  const listResult = unwrap(
    await invokeE2E("agentOrgRunList", 50),
    `agentOrgRunList(${label})`
  );
  const activeRuns = (listResult.runs ?? []).filter(
    (run) =>
      run?.orgId === DEFAULT_AGENT_ORG_ID &&
      run?.rootSessionId &&
      run?.status !== "completed" &&
      run?.status !== "failed" &&
      run?.status !== "cancelled" &&
      run?.status !== "paused"
  );
  for (const run of activeRuns) {
    unwrap(
      await invokeE2E("agentOrgPauseRun", run.rootSessionId),
      `agentOrgPauseRun(${label}:${run.rootSessionId})`
    );
  }
}

describe("Agent Org group chat and plan rendered UI", () => {
  before(async () => {
    assertE2ERepoFixture();
    await waitForApp();
  });

  beforeEach(async () => {
    await pauseDefaultAgentOrgRuns("beforeEach");
    await invokeE2E("resetToNewSession");
  });

  afterEach(async () => {
    await pauseDefaultAgentOrgRuns("afterEach");
    await invokeE2E("resetToNewSession");
  });

  it("launches default Agent Org in Plan mode through rendered UI", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("plan");
    await selectRenderedDefaultAgentOrg();

    const launchPrompt = `E2E true positive default Agent Org plan mode ${RUN_ID}. Produce a concise plan only.`;
    const sessionId = await sendFromRenderedCreator(launchPrompt);
    if (!sessionId) {
      throw new Error(
        "Default Agent Org plan launch did not create a session id"
      );
    }
    await waitForRenderedAssistantReply("default Agent Org plan launch");
    await waitForActiveSessionExecMode(
      sessionId,
      "plan",
      "default Agent Org plan launch"
    );

    const dump = await waitForPromptDump(sessionId);
    if (dump.agentDefinitionId !== BUILTIN_SDE_AGENT_ID) {
      throw new Error(
        `default Agent Org plan coordinator agent mismatch: ${JSON.stringify(dump)}`
      );
    }
    const promptText = String(dump.prompt ?? "");
    if (!promptText.includes("Agent Org")) {
      throw new Error(
        "default Agent Org plan prompt did not include Agent Org context"
      );
    }
    if (
      !promptText.includes("### Planning workflow") ||
      !promptText.includes("execution_mode=plan") ||
      !promptText.includes("enters Plan mode automatically") ||
      !promptText.includes('kind="plan_approval_response"') ||
      promptText.includes("exec_mode_set_request")
    ) {
      throw new Error(
        `default Agent Org prompt did not include coordinator Planner protocol: ${JSON.stringify({ prompt: promptText.slice(0, 4000) })}`
      );
    }

    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const members = view?.members ?? [];
        const expectedMembers = Object.values(DEFAULT_AGENT_ORG_MEMBER_IDS);
        const allMembersMaterialized = expectedMembers.every((memberId) =>
          members.some(
            (member) =>
              member.memberId === memberId &&
              member.agentId === BUILTIN_SDE_AGENT_ID &&
              member.sessionRuntime?.sessionId
          )
        );
        return Boolean(
          view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          view?.context?.runId &&
          allMembersMaterialized
        );
      },
      "default Agent Org plan members materialized"
    );
  });

  it("allows switching to a member with inbox activity but no tasks", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("plan");
    await selectRenderedDefaultAgentOrg();

    const launchPrompt = `E2E inbox-only member switch ${RUN_ID}. Produce a concise plan only.`;
    const sessionId = await sendFromRenderedCreator(launchPrompt);
    if (!sessionId) {
      throw new Error(
        "Inbox-only member switch launch did not create a session id"
      );
    }
    await waitForRenderedAssistantReply("inbox-only member switch launch");

    let plannerSessionId = null;
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const planner = (view?.members ?? []).find(
          (member) => member.memberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER
        );
        plannerSessionId = planner?.sessionRuntime?.sessionId ?? null;
        return Boolean(
          view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          view?.context?.runId &&
          plannerSessionId &&
          planner.activeTaskCount === 0 &&
          planner.pendingTaskCount === 0 &&
          planner.inProgressTaskCount === 0 &&
          planner.completedTaskCount === 0
        );
      },
      "inbox-only planner materialized with no tasks"
    );
    if (!plannerSessionId) {
      throw new Error(
        "Inbox-only member switch did not materialize planner session"
      );
    }

    await ensureMemberHasSwitchableInbox(
      sessionId,
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      "inbox-only planner message"
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const planner = (view?.members ?? []).find(
          (member) => member.memberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER
        );
        return Boolean(
          planner?.inboxActivityCount > 0 &&
          planner.activeTaskCount === 0 &&
          planner.pendingTaskCount === 0 &&
          planner.inProgressTaskCount === 0 &&
          planner.completedTaskCount === 0
        );
      },
      "planner has inbox activity but no tasks"
    );
    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession(coordinator before inbox-only switch)"
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) => view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID,
      "coordinator active before inbox-only member switch"
    );
    await refreshRenderedAgentOrgOverview("inbox-only member switch refresh");

    await clickRenderedMemberSwitcher(
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      plannerSessionId
    );
    await waitForAgentOrgRunView(
      plannerSessionId,
      (view) => view?.currentMemberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      "planner switchable with inbox activity but no tasks"
    );
  });

  it("routes rendered group chat mentions as non-interrupting user inbox messages", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const launchPrompt = `E2E rendered Agent Org group chat routing ${RUN_ID}. Reply briefly.`;
    const sessionId = await sendFromRenderedCreator(launchPrompt);
    if (!sessionId) {
      throw new Error(
        "Agent Org group chat routing launch did not create a session id"
      );
    }
    let runId = null;
    let plannerSessionId = null;
    let plannerName = null;
    let coordinatorName = null;
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const planner = (view?.members ?? []).find(
          (member) => member.memberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER
        );
        const coordinator = (view?.members ?? []).find(
          (member) => member.memberId === AGENT_ORG_COORDINATOR_MEMBER_ID
        );
        runId = view?.context?.runId ?? null;
        plannerSessionId = planner?.sessionRuntime?.sessionId ?? null;
        plannerName = planner?.name ?? null;
        coordinatorName = coordinator?.name ?? "Coordinator";
        return Boolean(runId && plannerSessionId && plannerName);
      },
      "group chat routing members materialized"
    );
    if (!plannerSessionId || !plannerName || !runId) {
      throw new Error("Group chat routing did not materialize planner runtime");
    }

    await createLongTaskPrecondition(
      sessionId,
      `group-chat-routing-${RUN_ID}`,
      `E2E group chat routing precondition ${RUN_ID}`,
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const planner = (view?.members ?? []).find(
          (member) => member.memberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER
        );
        return Boolean(planner?.pendingTaskCount > 0);
      },
      "group chat routing has planner task for group view"
    );

    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession(coordinator before group chat routing)"
    );
    await refreshRenderedAgentOrgOverview(
      "group chat routing availability refresh"
    );
    await waitForRenderedGroupChatActive("default Agent Org entry");
    await openRenderedGroupChatView();
    await assertRenderedGroupChatToggleIsIdempotent(
      sessionId,
      "default Agent Org group chat re-select"
    );
    await assertRenderedGroupChatNoQuoteOrUnreadPreview(
      "initial group chat entry"
    );

    const plannerMessage = `E2E group chat mention to planner ${RUN_ID}. Reply in group chat and include token ${RUN_ID}.`;
    const plannerBaseline = unwrap(
      await invokeE2E("getSessionAggregateRow", plannerSessionId),
      "getSessionAggregateRow(planner before group chat mention drain)"
    ).session;
    const plannerBaselineUpdatedAt = plannerBaseline?.updatedAt ?? "";
    await sendRenderedGroupChatMentionPrompt(
      plannerName,
      plannerMessage,
      "planner mention"
    );
    const plannerInboxRow = await waitForInboxRow(
      sessionId,
      (row) => {
        const payload = parseInboxPayload(row, "planner group chat mention");
        return (
          row.senderAgentId === "_user" &&
          row.senderName === "User" &&
          row.recipientMemberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER &&
          row.payloadKind === "plain" &&
          payload.text === plannerMessage
        );
      },
      "planner group chat inbox row persisted"
    );
    await waitForRenderedGroupChatUserTurn({
      text: `@${plannerName} ${plannerMessage}`,
      label: "planner mention rendered after inbox persist",
    });
    await assertRenderedGroupChatNoQuoteOrUnreadPreview(
      "planner mention rendered after inbox persist"
    );
    await waitForInboxRowRead(
      sessionId,
      plannerInboxRow.id,
      "planner group chat inbox row drained",
      REPLY_TIMEOUT_MS
    );
    await waitForMemberPostMessageActivity(
      sessionId,
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      plannerBaselineUpdatedAt,
      "planner session advanced after group chat mention",
      REPLY_TIMEOUT_MS
    );
    await waitForRenderedGroupChatMessage({
      sender: plannerName,
      text: String(RUN_ID),
      label: "planner replies after group chat mention drain",
      timeout: REPLY_TIMEOUT_MS,
    });
    await assertNoMemberIntervention(
      plannerSessionId,
      "planner group chat mention must not interrupt"
    );
    const coordinatorMessage = `E2E group chat default coordinator ${RUN_ID}`;
    await sendRenderedChatPrompt(coordinatorMessage);
    const coordinatorInboxRow = await waitForInboxRow(
      sessionId,
      (row) => {
        const payload = parseInboxPayload(
          row,
          "default coordinator group chat"
        );
        return (
          row.senderAgentId === "_user" &&
          row.senderName === "User" &&
          row.recipientMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          row.payloadKind === "plain" &&
          payload.text === coordinatorMessage
        );
      },
      "default coordinator group chat inbox row persisted"
    );
    if (!coordinatorInboxRow) {
      throw new Error(
        "default coordinator group chat inbox row was not returned"
      );
    }
    await waitForRenderedGroupChatUserTurn({
      text: coordinatorMessage,
      label: "default coordinator route",
    });
    await waitForAgentOrgRunView(
      sessionId,
      (view) =>
        (view?.inbox ?? []).some(
          (row) =>
            row.id === coordinatorInboxRow.id &&
            row.senderAgentId === "_user" &&
            row.senderName === "User" &&
            row.recipientMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
            row.payloadKind === "plain"
        ),
      "default coordinator group chat inbox row persisted"
    );
    await assertNoMemberIntervention(
      sessionId,
      "default coordinator group chat must not interrupt"
    );
    await assertNoMemberIntervention(
      plannerSessionId,
      "planner remains non-interrupted after coordinator group chat"
    );

    const pauseResult = unwrap(
      await invokeE2E("agentOrgPauseRun", sessionId),
      "agentOrgPauseRun (group chat paused banner)"
    );
    if (pauseResult.transitioned !== false) {
      await waitForAgentOrgRunView(
        sessionId,
        (view) => view?.runStatus === "paused",
        "group chat run paused for inline Resume"
      );
      await refreshRenderedAgentOrgOverview("group chat paused banner refresh");
      await waitForGroupChatPausedBanner("group chat paused send resume");

      const pausedMessage = `E2E group chat paused send resumes ${RUN_ID}`;
      await sendRenderedChatPrompt(pausedMessage);
      const pausedInboxRow = await waitForInboxRow(
        sessionId,
        (row) => {
          const payload = parseInboxPayload(row, "paused group chat send");
          return (
            row.senderAgentId === "_user" &&
            row.recipientMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
            payload.text === pausedMessage
          );
        },
        "paused group chat inbox row persisted"
      );
      await waitForRenderedGroupChatUserTurn({
        text: pausedMessage,
        label: "paused group chat send resumes",
      });
      await waitForAgentOrgRunView(
        sessionId,
        (view) => view?.runStatus !== "paused",
        "group chat send while paused resumes run"
      );
      await waitForInboxRowRead(
        sessionId,
        pausedInboxRow.id,
        "paused group chat inbox row drained after resume",
        REPLY_TIMEOUT_MS
      );
      await browser.waitUntil(
        async () =>
          !(await execJS(
            js.exists('[data-testid="agent-org-group-chat-paused-banner"]')
          )),
        {
          timeout: RENDER_TIMEOUT_MS,
          interval: 250,
          timeoutMsg:
            "group chat paused banner did not disappear after sending a message",
        }
      );
    }
  });

  it("reloads more than 200 durable Group Chat messages without truncating long text", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);

    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const sessionId = await sendFromRenderedCreator(
      `E2E durable Group Chat history ${RUN_ID}. Reply briefly.`
    );
    if (!sessionId) {
      throw new Error(
        "Durable Group Chat history launch did not create a session id"
      );
    }
    await waitForRenderedAssistantReply("durable Group Chat history launch");

    let runId = null;
    let coordinator = null;
    let runStatus = null;
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        runId = view?.context?.runId ?? null;
        runStatus = view?.runStatus ?? null;
        coordinator = (view?.members ?? []).find(
          (member) => member.memberId === AGENT_ORG_COORDINATOR_MEMBER_ID
        );
        return Boolean(runId && coordinator?.agentId && coordinator?.memberId);
      },
      "durable Group Chat history coordinator materialized"
    );
    if (!runId || !coordinator?.agentId || !coordinator?.memberId) {
      throw new Error(
        `Durable Group Chat history runtime was incomplete: ${JSON.stringify({ runId, coordinator })}`
      );
    }

    if (runStatus === "running") {
      const pauseResult = unwrap(
        await invokeE2E("agentOrgPauseRun", sessionId),
        "agentOrgPauseRun(durable Group Chat history seed)"
      );
      if (pauseResult.transitioned !== false) {
        await waitForAgentOrgRunView(
          sessionId,
          (view) => view?.runStatus === "paused",
          "durable Group Chat history paused before deterministic seed"
        );
      }
    }

    const messageCount = 230;
    const marker = (index) =>
      `E2E-GROUP-HISTORY-${String(index).padStart(3, "0")}-${RUN_ID}`;
    const longEndMarker = `E2E-GROUP-HISTORY-LONG-END-${RUN_ID}`;

    // Fixture setup only: leave the live run view before inserting the large
    // durable history batch so 230 seed notifications cannot keep rebuilding
    // the rendered projection. The user regression below still reloads the
    // app, reopens the coordinator, and pages through the production UI.
    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(durable Group Chat history seed)"
    );
    for (let index = 1; index <= messageCount; index += 1) {
      const messageText =
        index === 1
          ? `${marker(index)} ${"durable-long-message ".repeat(40)}${longEndMarker}`
          : marker(index);
      await postJson("/agent/test/agent-org/inbox/seed", {
        recipient_agent_id: coordinator.agentId,
        recipient_member_id: coordinator.memberId,
        sender_agent_id: "_user",
        org_run_id: runId,
        message: {
          kind: "plain",
          summary: `E2E durable Group Chat message ${index}`,
          text: messageText,
        },
      });
    }

    const newestPage = unwrap(
      await invokeE2E("agentOrgGroupChatHistoryPage", sessionId, null, 100),
      "agentOrgGroupChatHistoryPage(durable history seed)"
    ).page;
    if (
      newestPage?.rows?.length !== 100 ||
      newestPage?.hasMore !== true ||
      !newestPage.rows.some((row) =>
        String(row.displayText ?? "").includes(marker(messageCount))
      )
    ) {
      throw new Error(
        `Durable Group Chat production history page was incomplete: ${JSON.stringify(newestPage)}`
      );
    }

    // This is the user regression path: rebuild the rendered app state from
    // durable storage, reopen the coordinator, then page through the actual
    // Group Chat controls. Debug APIs above only created deterministic rows.
    await browser.refresh();
    await waitForApp();
    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession(durable Group Chat history after reload)"
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) => view?.context?.runId === runId,
      "durable Group Chat run restored after reload"
    );
    await refreshRenderedAgentOrgOverview(
      "durable Group Chat history after reload"
    );
    await openRenderedGroupChatView();
    await selectRenderedTurnPageByPreview(
      marker(messageCount),
      "newest durable Group Chat message after reload"
    );
    await waitForRenderedGroupChatUserTurn({
      text: marker(messageCount),
      label: "newest durable Group Chat message after reload",
    });

    await clickRenderedGroupChatLoadOlder("durable history page 2");
    await selectRenderedTurnPageByPreview(
      marker(31),
      "oldest message after first Load older"
    );
    await waitForRenderedGroupChatUserTurn({
      text: marker(31),
      label: "first older durable Group Chat page",
    });

    await clickRenderedGroupChatLoadOlder("durable history page 3");
    await selectRenderedTurnPageByPreview(
      marker(1),
      "oldest durable Group Chat message"
    );
    await waitForRenderedGroupChatUserTurn({
      text: longEndMarker,
      label: "full long durable Group Chat message after reload",
    });
  });

  it("a Plan task starts Planner in Plan mode and approval unlocks dependent work", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const launchPrompt = `E2E coordinator-controlled member plan approval ${RUN_ID}. Reply briefly.`;
    const sessionId = await sendFromRenderedCreator(launchPrompt);
    if (!sessionId) {
      throw new Error(
        "Agent Org plan approval launch did not create a session id"
      );
    }
    await waitForRenderedAssistantReply("Agent Org plan approval launch");

    let runId = null;
    let plannerSessionId = null;
    let plannerName = null;
    let coordinatorName = null;
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        runId = view?.context?.runId ?? null;
        coordinatorName = view?.context?.coordinatorName ?? null;
        const planner = (view?.members ?? []).find(
          (member) => member.memberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER
        );
        plannerSessionId = planner?.sessionRuntime?.sessionId ?? null;
        plannerName = planner?.name ?? null;
        return Boolean(
          view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          runId &&
          coordinatorName &&
          plannerName &&
          plannerSessionId
        );
      },
      "plan approval members materialized"
    );
    if (!runId || !plannerSessionId || !plannerName || !coordinatorName) {
      throw new Error(
        `Plan approval scenario did not materialize ids: ${JSON.stringify({ runId, plannerSessionId, plannerName, coordinatorName })}`
      );
    }

    const planTaskId = `e2e-plan-task-${RUN_ID}`;
    const downstreamTaskId = `e2e-build-after-plan-${RUN_ID}`;
    const planTaskCreate = unwrap(
      await invokeE2E("debugSessionExecuteOrgTool", sessionId, "task_create", {
        id: planTaskId,
        subject: `Draft an execution plan ${RUN_ID}`,
        description: "Submit the complete plan with create_plan.",
        owner_member_id: DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
        status: AGENT_ORG_TASK_STATUS.PENDING,
        dispatch_policy: "immediate",
        execution_mode: "plan",
      }),
      "debugSessionExecuteOrgTool(create Plan task)"
    ).result;
    if (planTaskCreate?.ok !== true) {
      throw new Error(
        `Plan task creation failed: ${JSON.stringify(planTaskCreate)}`
      );
    }
    const downstreamTaskCreate = unwrap(
      await invokeE2E("debugSessionExecuteOrgTool", sessionId, "task_create", {
        id: downstreamTaskId,
        subject: `Build from the approved plan ${RUN_ID}`,
        description: "Consume the approved Planner output.",
        owner_member_id: DEFAULT_AGENT_ORG_MEMBER_IDS.IMPLEMENTER,
        status: AGENT_ORG_TASK_STATUS.PENDING,
        dispatch_policy: "after_dependencies",
        dependency_task_ids: [planTaskId],
        execution_mode: "build",
      }),
      "debugSessionExecuteOrgTool(create dependent Build task)"
    ).result;
    if (downstreamTaskCreate?.ok !== true) {
      throw new Error(
        `Dependent task creation failed: ${JSON.stringify(downstreamTaskCreate)}`
      );
    }

    await waitForInboxRow(
      sessionId,
      (row) => {
        const payload = parseInboxPayload(row, "Plan task assignment");
        return (
          row.payloadKind === "task_assigned" &&
          row.recipientMemberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER &&
          payload.task_id === planTaskId &&
          payload.execution_mode === "plan"
        );
      },
      "Plan task assignment persisted"
    );

    const plannerStartsTask = unwrap(
      await invokeE2E(
        "debugAgentOrgExecuteToolAsAgent",
        runId,
        DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
        "task_update",
        { id: planTaskId, status: AGENT_ORG_TASK_STATUS.IN_PROGRESS }
      ),
      "debugAgentOrgExecuteToolAsAgent(start Plan task)"
    ).result;
    if (plannerStartsTask?.ok !== true) {
      throw new Error(
        `Planner could not start Plan task: ${JSON.stringify(plannerStartsTask)}`
      );
    }

    await waitForSessionAggregateRow(
      plannerSessionId,
      (session) => session.sessionId === plannerSessionId,
      "planner session row after Plan task assignment"
    );
    await waitForSessionOrgRuntimeSnapshot(
      plannerSessionId,
      (snapshot) =>
        snapshot.isOrgMember === true &&
        (snapshot.registeredOrgToolNames ?? []).includes("create_plan") &&
        (snapshot.requestedExecMode === "plan" ||
          snapshot.hasPrePlanMode === true),
      "planner received assignment-driven Plan mode without user chat"
    );
    await assertNoMemberIntervention(
      plannerSessionId,
      "assignment-driven Plan mode"
    );

    const planTitle = `E2E Member Plan ${RUN_ID}`;
    const planContent = `Planner proposal ${RUN_ID}: inspect the target, make a minimal change, then verify with focused E2E before wider regression checks.`;
    await executeCreatePlanAsMember(
      plannerSessionId,
      planTitle,
      planContent,
      "planner submits plan"
    );
    await waitForSessionOrgRuntimeSnapshot(
      plannerSessionId,
      (snapshot) => snapshot.hasPlanSlot === true,
      "planner plan slot exists after create_plan"
    );
    await assertNoMemberIntervention(plannerSessionId, "planner create_plan");

    const planRequestRow = await waitForPlanApprovalRequest(
      sessionId,
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      planTitle,
      planContent,
      "planner submitted plan"
    );
    const planRequestPayload = parseInboxPayload(
      planRequestRow,
      "planner plan request"
    );
    if (!planRequestPayload.request_id) {
      throw new Error(
        `plan approval request did not expose request_id: ${JSON.stringify(planRequestRow)}`
      );
    }
    await assertRenderedInboxPinBarAbsent(
      "coordinator rendered planner plan request"
    );
    await assertNoCurrentPlanBuildSurface(
      "coordinator viewing member-submitted org plan request"
    );

    const forgedRequestResult = unwrap(
      await invokeE2E(
        "debugAgentOrgExecuteToolAsAgent",
        runId,
        DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
        "org_send_message",
        {
          recipient_member_id: AGENT_ORG_COORDINATOR_MEMBER_ID,
          kind: "plan_approval_request",
          request_id: `forged-plan-request-${RUN_ID}`,
          summary: "forged request should be rejected",
          text: "forged request should be rejected",
        }
      ),
      "debugAgentOrgExecuteToolAsAgent(forged plan request)"
    ).result;
    const forgedRequestError = String(forgedRequestResult?.error ?? "");
    if (
      forgedRequestResult?.ok !== false ||
      (!forgedRequestError.includes("not LLM-callable") &&
        !forgedRequestError.includes("not allowed"))
    ) {
      throw new Error(
        `forged plan_approval_request was not rejected correctly: ${JSON.stringify(forgedRequestResult)}`
      );
    }

    const peerApprovalResult = unwrap(
      await invokeE2E(
        "debugAgentOrgExecuteToolAsAgent",
        runId,
        DEFAULT_AGENT_ORG_MEMBER_IDS.IMPLEMENTER,
        "org_send_message",
        {
          recipient_member_id: DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
          kind: "plan_approval_response",
          request_id: planRequestPayload.request_id,
          accepted: true,
          feedback: "peer approval should be rejected",
        }
      ),
      "debugAgentOrgExecuteToolAsAgent(peer plan approval)"
    ).result;
    const peerApprovalError = String(peerApprovalResult?.error ?? "");
    if (
      peerApprovalResult?.ok !== false ||
      (!peerApprovalError.includes("restricted to the coordinator") &&
        !peerApprovalError.includes("not allowed"))
    ) {
      throw new Error(
        `peer plan_approval_response was not rejected correctly: ${JSON.stringify(peerApprovalResult)}`
      );
    }

    const rejectionFeedback = `Coordinator feedback ${RUN_ID}: narrow the plan to a reviewable first phase and include verification checkpoints.`;
    await sendCoordinatorOrgMessage(
      sessionId,
      {
        recipient_member_id: DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
        kind: "plan_approval_response",
        request_id: planRequestPayload.request_id,
        accepted: false,
        feedback: rejectionFeedback,
      },
      "reject planner plan with feedback"
    );
    await waitForInboxRow(
      sessionId,
      (row) => {
        const payload = parseInboxPayload(row, "plan rejection response");
        return (
          row.payloadKind === "plan_approval_response" &&
          row.senderMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          row.recipientMemberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER &&
          payload.request_id === planRequestPayload.request_id &&
          payload.accepted === false &&
          String(payload.feedback ?? "").includes(rejectionFeedback)
        );
      },
      "coordinator rejection persisted"
    );
    await clickRenderedMemberSwitcher(
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      plannerSessionId
    );
    await waitForAgentOrgRunView(
      plannerSessionId,
      (view) => view?.currentMemberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      "planner active for rendered rejection feedback"
    );
    await assertRenderedInboxPinBarAbsent(
      "planner rendered coordinator rejection feedback"
    );
    await assertNoCurrentPlanBuildSurface(
      "planner viewing coordinator rejection feedback"
    );
    await assertNoMemberIntervention(plannerSessionId, "coordinator rejection");

    const revisedPlanTitle = `E2E Revised Member Plan ${RUN_ID}`;
    const revisedPlanContent = `Revised planner proposal ${RUN_ID}: first inspect the target and current tests, then implement the minimal safe change, then run focused verification before broader Agent Org regression coverage.`;
    await executeCreatePlanAsMember(
      plannerSessionId,
      revisedPlanTitle,
      revisedPlanContent,
      "planner submits revised plan"
    );
    const revisedPlanRequestRow = await waitForPlanApprovalRequest(
      sessionId,
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      revisedPlanTitle,
      revisedPlanContent,
      "planner submitted revised plan"
    );
    const revisedPlanRequestPayload = parseInboxPayload(
      revisedPlanRequestRow,
      "planner revised plan request"
    );
    if (!revisedPlanRequestPayload.request_id) {
      throw new Error(
        `revised plan approval request did not expose request_id: ${JSON.stringify(revisedPlanRequestRow)}`
      );
    }
    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession(coordinator before revised plan request assertion)"
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) => view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID,
      "coordinator active before revised plan request assertion"
    );
    await assertRenderedInboxPinBarAbsent(
      "coordinator rendered planner revised plan request"
    );
    await assertNoCurrentPlanBuildSurface(
      "coordinator viewing member-submitted revised org plan request"
    );

    await sendCoordinatorOrgMessage(
      sessionId,
      {
        recipient_member_id: DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
        kind: "plan_approval_response",
        request_id: revisedPlanRequestPayload.request_id,
        accepted: true,
      },
      "approve revised planner plan"
    );
    await waitForInboxRow(
      sessionId,
      (row) => {
        const payload = parseInboxPayload(row, "dependent task assignment");
        return (
          row.payloadKind === "task_assigned" &&
          row.recipientMemberId === DEFAULT_AGENT_ORG_MEMBER_IDS.IMPLEMENTER &&
          payload.task_id === downstreamTaskId &&
          payload.execution_mode === "build"
        );
      },
      "dependent task assignment persisted"
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const planTask = (view?.tasks ?? []).find(
          (task) => task.id === planTaskId
        );
        return planTask?.status === AGENT_ORG_TASK_STATUS.COMPLETED;
      },
      "approval completes Plan task and dispatches dependent Build task"
    );
    const approvalInbox = unwrap(
      await invokeE2E("debugAgentOrgInboxList", runId),
      "debugAgentOrgInboxList(approved plan)"
    ).rows;
    const obsoleteAcceptedPlannerWake = (approvalInbox ?? []).some((row) => {
      if (row.payloadKind !== "plan_approval_response") return false;
      const payload = parseInboxPayload(row, "obsolete accepted plan response");
      return (
        row.recipientMemberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER &&
        payload.request_id === revisedPlanRequestPayload.request_id &&
        payload.accepted === true
      );
    });
    if (obsoleteAcceptedPlannerWake) {
      throw new Error("Accepted plan response incorrectly woke the Planner");
    }
    await assertNoMemberIntervention(plannerSessionId, "coordinator approval");

    await assertNoFalseFinality(
      plannerSessionId,
      runId,
      "coordinator-controlled member plan approval"
    );
  });

  it("lets the user request changes, edit, and approve a member plan in Group chat", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    const orgName = `E2E User Plan Approval Org ${RUN_ID}`;
    const plannerName = `E2E User Plan Planner ${RUN_ID}`;
    const implementerName = `E2E User Plan Implementer ${RUN_ID}`;
    await removeAgentOrgsByName(orgName);

    const org = await createRenderedStrictTwoMemberAgentOrg({
      orgName,
      leadName: plannerName,
      childName: implementerName,
      planApprovalPolicy: "user",
    });
    await configureCreatorForAgentOrg({
      account,
      model,
      agentOrgId: org.id,
    });
    await selectRenderedExecMode("build");
    await selectRenderedAgentOrg(org.id);

    const sessionId = await sendFromRenderedCreator(
      `E2E rendered user plan approval ${RUN_ID}. Reply briefly.`
    );
    if (!sessionId) {
      throw new Error("User plan approval launch did not create a session id");
    }
    await waitForRenderedAssistantReply("user plan approval launch");

    let runId = null;
    let plannerMemberId = null;
    let plannerSessionId = null;
    let implementerMemberId = null;
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        runId = view?.context?.runId ?? null;
        const planner = (view?.members ?? []).find(
          (member) => member.name === plannerName
        );
        const implementer = (view?.members ?? []).find(
          (member) => member.name === implementerName
        );
        plannerMemberId = planner?.memberId ?? null;
        plannerSessionId = planner?.sessionRuntime?.sessionId ?? null;
        implementerMemberId = implementer?.memberId ?? null;
        return Boolean(
          runId && plannerMemberId && plannerSessionId && implementerMemberId
        );
      },
      "user approval members materialized"
    );
    if (
      !runId ||
      !plannerMemberId ||
      !plannerSessionId ||
      !implementerMemberId
    ) {
      throw new Error(
        `User approval scenario did not materialize runtime ids: ${JSON.stringify({ runId, plannerMemberId, plannerSessionId, implementerMemberId })}`
      );
    }

    const planTaskId = `e2e-user-plan-task-${RUN_ID}`;
    const downstreamTaskId = `e2e-user-plan-build-${RUN_ID}`;
    const createPlanTask = unwrap(
      await invokeE2E(
        "debugAgentOrgExecuteToolAsAgent",
        runId,
        AGENT_ORG_COORDINATOR_MEMBER_ID,
        "task_create",
        {
          id: planTaskId,
          subject: `Draft a user-approved plan ${RUN_ID}`,
          description: "Submit the complete plan with create_plan.",
          owner_member_id: plannerMemberId,
          status: AGENT_ORG_TASK_STATUS.PENDING,
          dispatch_policy: "immediate",
          execution_mode: "plan",
        }
      ),
      "debugAgentOrgExecuteToolAsAgent(create user-approved Plan task)"
    ).result;
    if (createPlanTask?.ok !== true) {
      throw new Error(
        `User-approved Plan task creation failed: ${JSON.stringify(createPlanTask)}`
      );
    }
    const createDownstreamTask = unwrap(
      await invokeE2E(
        "debugAgentOrgExecuteToolAsAgent",
        runId,
        AGENT_ORG_COORDINATOR_MEMBER_ID,
        "task_create",
        {
          id: downstreamTaskId,
          subject: `Build after user approval ${RUN_ID}`,
          description: "Consume the approved plan output.",
          owner_member_id: implementerMemberId,
          status: AGENT_ORG_TASK_STATUS.PENDING,
          dispatch_policy: "after_dependencies",
          dependency_task_ids: [planTaskId],
          execution_mode: "build",
          // The live coordinator may independently create setup work while the
          // rendered test seeds this isolated chain. The test is explicitly
          // asserting that this downstream task consumes only planTaskId.
          allow_parallel_with_unlisted_open_tasks: true,
        }
      ),
      "debugAgentOrgExecuteToolAsAgent(create user-approved downstream task)"
    ).result;
    if (createDownstreamTask?.ok !== true) {
      throw new Error(
        `User-approved downstream task creation failed: ${JSON.stringify(createDownstreamTask)}`
      );
    }
    const downstreamCreatePayload = JSON.parse(
      String(createDownstreamTask.result?.text ?? "{}")
    );
    if (downstreamCreatePayload?.task?.id !== downstreamTaskId) {
      throw new Error(
        `User-approved downstream task was not persisted: ${JSON.stringify(downstreamCreatePayload)}`
      );
    }

    const startPlanTask = unwrap(
      await invokeE2E(
        "debugAgentOrgExecuteToolAsAgent",
        runId,
        plannerMemberId,
        "task_update",
        { id: planTaskId, status: AGENT_ORG_TASK_STATUS.IN_PROGRESS }
      ),
      "debugAgentOrgExecuteToolAsAgent(start user-approved Plan task)"
    ).result;
    if (startPlanTask?.ok !== true) {
      throw new Error(
        `User-approved Plan task could not start: ${JSON.stringify(startPlanTask)}`
      );
    }

    let latestPlannerRuntime = null;
    await browser.waitUntil(
      async () => {
        const runViewResult = await invokeE2E(
          "agentOrgSessionRunView",
          sessionId
        );
        const planner = (runViewResult?.view?.members ?? []).find(
          (member) => member.memberId === plannerMemberId
        );
        const candidateSessionId = planner?.sessionRuntime?.sessionId ?? null;
        if (!candidateSessionId) {
          latestPlannerRuntime = { candidateSessionId: null };
          return false;
        }
        const snapshotResult = await invokeE2E(
          "debugSessionOrgRuntimeSnapshot",
          candidateSessionId
        );
        latestPlannerRuntime = {
          candidateSessionId,
          snapshotResult,
        };
        const snapshot = snapshotResult?.snapshot ?? null;
        if (
          snapshotResult?.ok === true &&
          snapshot?.isOrgMember === true &&
          (snapshot.registeredOrgToolNames ?? []).includes("create_plan") &&
          (snapshot.requestedExecMode === "plan" ||
            snapshot.hasPrePlanMode === true)
        ) {
          // A custom member may be rematerialized when its first real wake is
          // dispatched. Always use the currently registered runtime id rather
          // than the provisional id from the initial run snapshot.
          plannerSessionId = candidateSessionId;
          return true;
        }
        return false;
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `user-approval Planner never reached task-driven Plan mode: ${JSON.stringify(latestPlannerRuntime)}`,
      }
    );

    const initialTitle = `E2E User Plan ${RUN_ID}`;
    const initialContent = `Initial user-reviewed plan ${RUN_ID}: inspect, implement, and verify.`;
    await executeCreatePlanAsMember(
      plannerSessionId,
      initialTitle,
      initialContent,
      "planner submits user-reviewed plan"
    );

    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession(coordinator for user plan approval)"
    );
    await refreshRenderedAgentOrgOverview("user plan approval card");
    await browser.waitUntil(
      async () => {
        const card = await execJS(`
          const element = document.querySelector('[data-testid="agent-org-plan-approval-card"]');
          return element ? { text: element.textContent || "" } : null;
        `);
        return Boolean(
          card?.text.includes(initialTitle) && card?.text.includes(plannerName)
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "user plan approval card never rendered in Group chat",
      }
    );

    const requestChangesClick = await execJS(
      js.click('[data-testid="agent-org-plan-request-changes-button"]')
    );
    if (requestChangesClick !== "clicked") {
      throw new Error(
        `Request changes button did not click: ${requestChangesClick}`
      );
    }
    const feedback = `Please add explicit checkpoints ${RUN_ID}.`;
    const feedbackType = await execJS(
      js.inputValue(
        '[data-testid="agent-org-plan-approval-feedback"]',
        feedback
      )
    );
    if (feedbackType !== "typed") {
      throw new Error(`Plan feedback did not type: ${feedbackType}`);
    }
    const sendFeedbackClick = await execJS(
      js.click('[data-testid="agent-org-plan-send-feedback-button"]')
    );
    if (sendFeedbackClick !== "clicked") {
      throw new Error(
        `Send feedback button did not click: ${sendFeedbackClick}`
      );
    }
    await waitForInboxRow(
      sessionId,
      (row) => {
        const payload = parseInboxPayload(row, "user plan feedback");
        return (
          row.recipientMemberId === plannerMemberId &&
          row.payloadKind === "plan_approval_response" &&
          payload.accepted === false &&
          String(payload.feedback ?? "").includes(feedback)
        );
      },
      "user feedback reaches Planner"
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) =>
        (view?.tasks ?? []).some(
          (task) =>
            task.id === planTaskId &&
            task.status === AGENT_ORG_TASK_STATUS.IN_PROGRESS
        ),
      "user feedback keeps Plan task open"
    );

    const revisedTitle = `E2E Revised User Plan ${RUN_ID}`;
    const revisedContent = `Revised user-reviewed plan ${RUN_ID}: inspect, implement, review each checkpoint, then verify.`;
    await executeCreatePlanAsMember(
      plannerSessionId,
      revisedTitle,
      revisedContent,
      "planner submits revised user-reviewed plan"
    );
    await refreshRenderedAgentOrgOverview("revised user plan approval card");
    await browser.waitUntil(
      async () => {
        const cardText = await execJS(
          js.text('[data-testid="agent-org-plan-approval-card"]')
        );
        return String(cardText).includes(revisedTitle);
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "revised user plan approval card never rendered",
      }
    );

    const editClick = await execJS(
      js.click('[data-testid="agent-org-plan-edit-button"]')
    );
    if (editClick !== "clicked") {
      throw new Error(`Edit plan button did not click: ${editClick}`);
    }
    const approvedContent = `${revisedContent} User-approved final checkpoint ${RUN_ID}.`;
    const editType = await execJS(
      js.inputValue(
        '[data-testid="agent-org-plan-approval-edit"]',
        approvedContent
      )
    );
    if (editType !== "typed") {
      throw new Error(`Edited plan content did not type: ${editType}`);
    }
    const approveClick = await execJS(
      js.click('[data-testid="agent-org-plan-approve-button"]')
    );
    if (approveClick !== "clicked") {
      throw new Error(`Approve edited plan did not click: ${approveClick}`);
    }

    await waitForInboxRow(
      sessionId,
      (row) => {
        const payload = parseInboxPayload(
          row,
          "user-approved dependent task assignment"
        );
        return (
          row.payloadKind === "task_assigned" &&
          row.recipientMemberId === implementerMemberId &&
          payload.task_id === downstreamTaskId
        );
      },
      "user-approved dependent task assignment persisted"
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) =>
        (view?.tasks ?? []).some(
          (task) =>
            task.id === planTaskId &&
            task.status === AGENT_ORG_TASK_STATUS.COMPLETED
        ),
      "user approval completes Plan task"
    );
    await browser.waitUntil(
      async () =>
        !(await execJS(
          js.exists('[data-testid="agent-org-plan-approval-card"]')
        )),
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "resolved user plan approval card remained visible",
      }
    );

    const finalRunView = unwrap(
      await invokeE2E("agentOrgSessionRunView", sessionId),
      "agentOrgSessionRunView(user plan approval cleanup)"
    ).view;
    if (finalRunView?.runStatus === "running") {
      unwrap(
        await invokeE2E("agentOrgPauseRun", sessionId),
        "agentOrgPauseRun(user plan approval cleanup)"
      );
    }
  });
});
