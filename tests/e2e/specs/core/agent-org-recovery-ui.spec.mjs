/* global describe, before, it, process */
import {
  AGENT_ORG_COORDINATOR_MEMBER_ID,
  AGENT_ORG_TASK_STATUS,
  API_AGENT_TYPE,
  BUILTIN_SDE_AGENT_ID,
  DEFAULT_AGENT_ORG_ID,
  DEFAULT_AGENT_ORG_MEMBER_IDS,
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
  clickRenderedMemberSwitcher,
  configureCreatorForAgentOrg,
  configureCreatorForDefaultAgentOrg,
  createLongTaskPrecondition,
  createRenderedStrictTwoMemberAgentOrg,
  ensureMemberHasSwitchableInbox,
  execJS,
  executeCreatePlanAsMember,
  getApiAccount,
  invokeE2E,
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

describe("Agent Org recovery and intervention rendered UI", () => {
  before(async () => {
    assertE2ERepoFixture();
    await waitForApp();
  });

  it("renders failed member recovery state in the Agent Org UI", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const launchPrompt = `E2E default Agent Org failed member recovery ${RUN_ID}. Reply briefly.`;
    const sessionId = await sendFromRenderedCreator(launchPrompt);
    if (!sessionId) {
      throw new Error(
        "Default Agent Org recovery launch did not create a session id"
      );
    }
    await waitForRenderedAssistantReply("default Agent Org recovery launch");

    let runId = null;
    let planner = null;
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        runId = view?.context?.runId ?? null;
        planner = (view?.members ?? []).find(
          (member) => member.memberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER
        );
        return Boolean(
          view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          runId &&
          planner?.memberId &&
          planner?.agentId
        );
      },
      "default Agent Org recovery members materialized"
    );

    const failureReason = `HTTP 429: rate limit exceeded during rendered recovery ${RUN_ID}`;
    const idleResponse = unwrap(
      await invokeE2E(
        "debugAgentOrgEmitMemberIdle",
        runId,
        planner.memberId,
        "failed",
        failureReason,
        "build"
      ),
      "debugAgentOrgEmitMemberIdle(failed planner)"
    ).result;
    if (idleResponse?.ok !== true || idleResponse?.emitted !== true) {
      throw new Error(
        `failed member_idle seed did not emit: ${JSON.stringify(idleResponse)}`
      );
    }

    const releasedTaskId = `rendered-failed-member-released-task-${RUN_ID}`;
    const releasedTaskSubject = `Released recovery work ${RUN_ID}`;
    const seedTaskResponse = unwrap(
      await invokeE2E(
        "debugAgentOrgExecuteToolAsAgent",
        runId,
        AGENT_ORG_COORDINATOR_MEMBER_ID,
        "task_create",
        {
          id: releasedTaskId,
          subject: releasedTaskSubject,
          description: `Task released after failed member model error ${RUN_ID}`,
          status: AGENT_ORG_TASK_STATUS.PENDING,
          eligible_member_ids: [planner.memberId],
          dispatch_policy: "immediate",
          execution_mode: "build",
        }
      ),
      "debugAgentOrgExecuteToolAsAgent(task_create released recovery task)"
    ).result;
    if (seedTaskResponse?.ok !== true) {
      throw new Error(
        `released task seed failed: ${JSON.stringify(seedTaskResponse)}`
      );
    }

    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        const failedIdleRow = (view?.inbox ?? []).some((row) => {
          const payload = JSON.parse(String(row.payloadJson ?? "{}"));
          return (
            row.payloadKind === "member_idle" &&
            row.recipientMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
            payload.member_id === planner.memberId &&
            payload.reason === "failed" &&
            payload.failure_reason === failureReason
          );
        });
        const releasedTask = (view?.tasks ?? []).find(
          (task) => task.id === releasedTaskId
        );
        const noOwnerlessInProgress = (view?.tasks ?? []).every(
          (task) =>
            task.status !== AGENT_ORG_TASK_STATUS.IN_PROGRESS || !!task.owner
        );
        return Boolean(
          failedIdleRow &&
          releasedTask?.status === AGENT_ORG_TASK_STATUS.PENDING &&
          !releasedTask.owner &&
          noOwnerlessInProgress
        );
      },
      "failed member recovery run-view invariants"
    );

    await assertRenderedInboxPinBarAbsent("failed member recovery");
    await waitForRenderedReleasedTask(
      releasedTaskId,
      releasedTaskSubject,
      "failed member recovery"
    );
  });

  it("launches default Agent Org through rendered UI and preserves coordinator/member intervention semantics", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const launchPrompt = `E2E true positive default Agent Org launch ${RUN_ID}. Reply briefly, then stay available.`;
    const sessionId = await sendFromRenderedCreator(launchPrompt);
    if (!sessionId) {
      throw new Error("Default Agent Org launch did not create a session id");
    }
    await waitForRenderedAssistantReply("default Agent Org launch");

    const dump = await waitForPromptDump(sessionId);
    if (dump.agentDefinitionId !== BUILTIN_SDE_AGENT_ID) {
      throw new Error(
        `default Agent Org coordinator agent mismatch: ${JSON.stringify(dump)}`
      );
    }
    if (!String(dump.prompt ?? "").includes("Agent Org")) {
      throw new Error(
        "default Agent Org prompt did not include Agent Org context"
      );
    }

    let runId = null;
    let plannerSessionId = null;
    let plannerName = null;
    let coordinatorName = null;
    let runPhase = null;
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        runId = view?.context?.runId ?? null;
        runPhase = view?.runPhase ?? null;
        coordinatorName = view?.context?.coordinatorName ?? null;
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
        const planner = members.find(
          (member) => member.memberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER
        );
        plannerSessionId = planner?.sessionRuntime?.sessionId ?? null;
        plannerName = planner?.name ?? null;
        return Boolean(
          view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
          runId &&
          runPhase &&
          plannerSessionId &&
          plannerName &&
          allMembersMaterialized
        );
      },
      "default shared-SDE members materialized by member_id"
    );

    if (!plannerName || !coordinatorName || !runId) {
      throw new Error(
        `Agent Org names/run id were not materialized: ${JSON.stringify({ runId, plannerName, coordinatorName })}`
      );
    }
    await openAgentOrgOverviewPanel("default Agent Org run phase");
    const renderedRunPhase = await execJS(`
      const phase = document.querySelector('[data-testid="agent-org-overview-run-phase"]');
      return phase ? {
        value: phase.getAttribute('data-run-phase'),
        text: (phase.textContent || '').trim(),
      } : null;
    `);
    const knownRunPhases = new Set([
      "coordinating",
      "dispatching",
      "members_working",
      "waiting",
      "awaiting_plan_approval",
      "finalizing",
      "paused",
      "completed",
      "failed",
      "cancelled",
      "abandoned",
    ]);
    if (
      !knownRunPhases.has(runPhase) ||
      !knownRunPhases.has(renderedRunPhase?.value) ||
      !renderedRunPhase?.text
    ) {
      throw new Error(
        `Agent Org durable/rendered phase projection is invalid: ${JSON.stringify({ runPhase, renderedRunPhase })}`
      );
    }
    const routeSummary = `E2E planner to coordinator inbox route ${RUN_ID}`;
    unwrap(
      await invokeE2E(
        "debugAgentOrgExecuteToolAsAgent",
        runId,
        DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
        "org_send_message",
        {
          recipient_member_id: AGENT_ORG_COORDINATOR_MEMBER_ID,
          kind: "plain",
          summary: routeSummary,
          text: `Planner-originated message for sender-route assertion ${RUN_ID}`,
        }
      ),
      "debugAgentOrgExecuteToolAsAgent(planner -> coordinator)"
    );
    const plannerToCoordinatorRow = await waitForInboxRow(
      sessionId,
      (row) =>
        row.senderMemberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER &&
        row.senderName === plannerName &&
        row.recipientMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID &&
        row.recipientName === coordinatorName &&
        String(row.payloadJson ?? "").includes(routeSummary),
      "planner to coordinator inbox row names"
    );
    await assertRenderedInboxPinBarAbsent(
      "planner to coordinator Agent message"
    );

    await clickRenderedMemberSwitcher(
      AGENT_ORG_COORDINATOR_MEMBER_ID,
      sessionId
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) => view?.currentMemberId === AGENT_ORG_COORDINATOR_MEMBER_ID,
      "coordinator direct view before UI chat intervention"
    );

    const coordinatorPrompt = `E2E ordinary coordinator instruction ${RUN_ID}`;
    await sendRenderedChatPrompt(coordinatorPrompt);
    await assertNoMemberIntervention(
      sessionId,
      "ordinary coordinator instruction"
    );
    await waitForInboxRowRead(
      sessionId,
      plannerToCoordinatorRow.id,
      "ordinary coordinator turn drains worker inbox"
    );
    await assertNoMemberIntervention(
      sessionId,
      "coordinator after worker inbox drain"
    );
    await waitForRenderedGroupChatUserTurn({
      text: coordinatorPrompt,
      label: "ordinary coordinator instruction user turn",
    });

    if (!plannerName) {
      throw new Error("planner member name was not materialized");
    }
    await ensureMemberHasSwitchableInbox(
      sessionId,
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      "default planner intervention"
    );
    await clickRenderedMemberSwitcher(
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      plannerSessionId
    );
    await waitForAgentOrgRunView(
      plannerSessionId,
      (view) => view?.currentMemberId === DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      "planner session after rendered member switch"
    );
    const plannerPrompt = `E2E direct planner user intervention ${RUN_ID}`;
    await sendRenderedChatPrompt(plannerPrompt);
    const plannerIntervention = await waitForIntervention(
      plannerSessionId,
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      "planner direct UI chat"
    );
    if (plannerIntervention.sessionId !== plannerSessionId) {
      throw new Error(
        `planner intervention session mismatch: ${JSON.stringify(plannerIntervention)}`
      );
    }
    await waitForRenderedInterventionPin(
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER,
      "planner direct UI chat"
    );

    const longTaskId = `true-positive-long-task-${RUN_ID}`;
    const longSubject = `Long Agent Org task ${RUN_ID}: ${"rendered task text must stay collapsed until the user explicitly expands it ".repeat(8)}`;
    await createLongTaskPrecondition(
      plannerSessionId,
      longTaskId,
      longSubject,
      DEFAULT_AGENT_ORG_MEMBER_IDS.PLANNER
    );
    await assertLongTaskRenderedCollapsed(longTaskId, longSubject);
    await assertNoFalseFinality(
      plannerSessionId,
      runId,
      "default Agent Org true-positive path"
    );
  });
});
