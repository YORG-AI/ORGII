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
  seedFlatAgentOrg,
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
      run?.status === "running"
  );
  for (const run of activeRuns) {
    unwrap(
      await invokeE2E("agentOrgPauseRun", run.rootSessionId),
      `agentOrgPauseRun(${label}:${run.rootSessionId})`
    );
  }
}

async function waitForTaskFsmProductionScenario(sessionId, scenarioId) {
  let latestTasks = [];
  let latestRunId = null;
  let latestReadError = null;
  try {
    await browser.waitUntil(
      async () => {
        try {
          const view = unwrap(
            await invokeE2E("agentOrgSessionRunView", sessionId),
            `agentOrgSessionRunView(Task FSM ${scenarioId})`
          ).view;
          latestRunId = view?.context?.runId ?? latestRunId;
          if (!latestRunId) return false;
          latestTasks = unwrap(
            await invokeE2E("debugAgentOrgTasksList", latestRunId),
            `debugAgentOrgTasksList(Task FSM ${scenarioId})`
          ).tasks;
          latestReadError = null;
          const subject = (prefix) =>
            latestTasks.find(
              (task) => task?.subject === `${prefix}:${scenarioId}`
            );
          const pagedHistory = latestTasks.filter((task) =>
            String(task?.subject ?? "").startsWith(
              `E2E_TASK_FSM_HISTORY:${scenarioId}:`
            )
          );
          return Boolean(
            subject("E2E_TASK_FSM_PENDING")?.status ===
              AGENT_ORG_TASK_STATUS.PENDING &&
            subject("E2E_TASK_FSM_REPLACEMENT")?.status ===
              AGENT_ORG_TASK_STATUS.PENDING &&
            subject("E2E_TASK_FSM_COMPLETE")?.status ===
              AGENT_ORG_TASK_STATUS.COMPLETED &&
            subject("E2E_TASK_FSM_FAIL")?.status ===
              AGENT_ORG_TASK_STATUS.FAILED &&
            subject("E2E_TASK_FSM_LATE")?.status ===
              AGENT_ORG_TASK_STATUS.CANCELLED &&
            pagedHistory.length === 20 &&
            pagedHistory.every(
              (task) => task.status === AGENT_ORG_TASK_STATUS.COMPLETED
            )
          );
        } catch (error) {
          latestReadError = String(error);
          return false;
        }
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `Task FSM production scenario ${scenarioId} did not settle`,
      }
    );
  } catch (error) {
    throw new Error(
      `Task FSM production scenario ${scenarioId} did not settle: ${JSON.stringify({ latestRunId, latestReadError, latestTasks })}`,
      { cause: error }
    );
  }
  return latestTasks;
}

async function waitForRenderedTaskHistory(status, expectedCount, label) {
  let state = null;
  try {
    await browser.waitUntil(
      async () => {
        state = await execJS(`
          const rows = Array.from(document.querySelectorAll('[data-testid="agent-org-task-history-row"]'));
          return {
            rows: rows.map((row) => ({
              id: row.getAttribute('data-task-id') || '',
              status: row.getAttribute('data-task-status') || '',
              text: row.textContent || '',
            })),
            nextDisabled: document.querySelector('[data-testid="agent-org-task-history-next-page"]')?.disabled ?? null,
            previousDisabled: document.querySelector('[data-testid="agent-org-task-history-previous-page"]')?.disabled ?? null,
            error: document.querySelector('[role="alert"]')?.textContent || '',
          };
        `);
        return (
          state.rows.length === expectedCount &&
          state.rows.every((row) => row.status === status)
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `Task History did not render ${label}`,
      }
    );
  } catch (error) {
    throw new Error(
      `Task History did not render ${label}: ${JSON.stringify(state)}`,
      { cause: error }
    );
  }
  return state;
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

  it("certifies completed work from the atomic snapshot without a task_list refresh", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const scenarioId = `certificate_${RUN_ID}`;
    const sessionId = await sendFromRenderedCreator(
      `Run E2E_AGENT_ORG_COMPLETION:${scenarioId}`
    );
    if (!sessionId) {
      throw new Error(
        "completion-candidate regression did not create a session"
      );
    }

    let finalView = null;
    await browser.waitUntil(
      async () => {
        finalView = unwrap(
          await invokeE2E("agentOrgSessionRunView", sessionId),
          "agentOrgSessionRunView(completion candidate regression)"
        ).view;
        return Boolean(
          finalView?.taskOverview?.total === 1 &&
            finalView?.taskOverview?.completed === 1 &&
            finalView?.completion?.state === "certified" &&
            finalView?.completion?.outcome === "delivered" &&
            finalView?.completion?.certificateId
        );
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "completed Task did not produce one published delivery certificate",
      }
    );

    const history = await postJson("/agent/test/session/llm-history", {
      session_id: sessionId,
    });
    const names = (history.messages ?? []).flatMap((message) =>
      (message?.tool_calls ?? []).map(
        (call) => call?.function?.name ?? call?.name ?? null
      )
    );
    const trajectory = {
      completionCalls: names.filter((name) => name === "org_run_complete")
        .length,
      taskListCalls: names.filter((name) => name === "task_list").length,
      names,
    };
    if (
      trajectory?.completionCalls !== 1 ||
      trajectory?.taskListCalls !== 0
    ) {
      throw new Error(
        `completion trajectory refreshed task_list or issued multiple certificates: ${JSON.stringify(trajectory)}`
      );
    }

    await openAgentOrgOverviewPanel("completion candidate Delivered");
    const completionBadge = await execJS(`
      const badge = document.querySelector('[data-completion-state]');
      return badge ? {
        state: badge.getAttribute('data-completion-state'),
        outcome: badge.getAttribute('data-completion-outcome'),
        text: badge.textContent || '',
      } : null;
    `);
    if (
      completionBadge?.state !== "certified" ||
      completionBadge?.outcome !== "delivered" ||
      !String(completionBadge?.text ?? "").match(/Delivered|已验证交付/)
    ) {
      throw new Error(
        `Overview did not render certificate-backed Delivered: ${JSON.stringify({ completionBadge, finalView })}`
      );
    }
  });

  it("enforces the Agent Org Task FSM through the packaged production Tool path", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    await configureCreatorForDefaultAgentOrg({ account, model });
    await selectRenderedExecMode("build");
    await selectRenderedDefaultAgentOrg();

    const scenarioIds = [1, 2, 3].map((index) => `page${index}_${RUN_ID}`);
    const sessionId = await sendFromRenderedCreator(
      `Run ${`E2E_AGENT_ORG_TASK_FSM:${scenarioIds[0]}`}`
    );
    if (!sessionId) {
      throw new Error(
        "Task FSM production-path launch did not create a session"
      );
    }

    await waitForAgentOrgRunView(
      sessionId,
      (view) =>
        (view?.tasks ?? []).some(
          (task) => task.status === AGENT_ORG_TASK_STATUS.IN_PROGRESS
        ) &&
        (view?.tasks ?? []).some(
          (task) => task.status === AGENT_ORG_TASK_STATUS.PENDING
        ),
      "Task FSM Current Work exposes pending and in-progress"
    );

    const scenarioTasks = [];
    scenarioTasks.push(
      await waitForTaskFsmProductionScenario(sessionId, scenarioIds[0])
    );
    for (const scenarioId of scenarioIds.slice(1)) {
      await sendRenderedChatPrompt(`Run E2E_AGENT_ORG_TASK_FSM:${scenarioId}`);
      scenarioTasks.push(
        await waitForTaskFsmProductionScenario(sessionId, scenarioId)
      );
    }

    const settledTasks = scenarioTasks.at(-1) ?? [];
    const statusCounts = settledTasks.reduce((counts, task) => {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
      return counts;
    }, {});
    const duplicateSubjects = Object.entries(
      settledTasks.reduce((counts, task) => {
        counts[task.subject] = (counts[task.subject] ?? 0) + 1;
        return counts;
      }, {})
    ).filter(([, count]) => count > 1);
    if (
      settledTasks.length !== 75 ||
      statusCounts[AGENT_ORG_TASK_STATUS.PENDING] !== 6 ||
      statusCounts[AGENT_ORG_TASK_STATUS.COMPLETED] !== 63 ||
      statusCounts[AGENT_ORG_TASK_STATUS.FAILED] !== 3 ||
      statusCounts[AGENT_ORG_TASK_STATUS.CANCELLED] !== 3
    ) {
      throw new Error(
        `Task FSM production scenarios created an unexpected Task set: ${JSON.stringify({ taskCount: settledTasks.length, statusCounts, duplicateSubjects })}`
      );
    }

    for (let index = 0; index < scenarioIds.length; index += 1) {
      const scenarioId = scenarioIds[index];
      const tasks = scenarioTasks[index];
      const find = (prefix) =>
        tasks.find((task) => task.subject === `${prefix}:${scenarioId}`);
      const completed = find("E2E_TASK_FSM_COMPLETE");
      const failed = find("E2E_TASK_FSM_FAIL");
      const cancelled = find("E2E_TASK_FSM_LATE");
      const replacement = find("E2E_TASK_FSM_REPLACEMENT");
      if (
        completed?.output?.producedByMemberId !==
          DEFAULT_AGENT_ORG_MEMBER_IDS.REVIEWER ||
        !completed?.output?.producedAt ||
        failed?.failureReason?.code !== "e2e.expected_failure" ||
        cancelled?.cancelReason?.code !== "e2e.replaced" ||
        cancelled?.output != null ||
        replacement?.replacesTaskId !== cancelled?.id ||
        replacement?.owner != null ||
        !replacement?.sourceTurnIntentId ||
        replacement?.createdByParticipantId !== AGENT_ORG_COORDINATOR_MEMBER_ID
      ) {
        throw new Error(
          `Task FSM provenance/result invariant failed for ${scenarioId}: ${JSON.stringify({ completed, failed, cancelled, replacement })}`
        );
      }
    }

    await openAgentOrgOverviewPanel("Task FSM Current/History");
    const collapsed = await execJS(`
      return {
        expanded: document.querySelector('[data-testid="agent-org-task-history-toggle"]')?.getAttribute('aria-expanded'),
        hasHistoryList: Boolean(document.querySelector('[data-testid="agent-org-task-history-list"]')),
        currentStatuses: Array.from(document.querySelectorAll('[data-testid="agent-org-overview-task-row"]')).map((row) => row.getAttribute('data-task-status')),
      };
    `);
    if (
      collapsed?.expanded !== "false" ||
      collapsed?.hasHistoryList !== false ||
      !collapsed?.currentStatuses.every(
        (status) => status === AGENT_ORG_TASK_STATUS.PENDING
      )
    ) {
      throw new Error(
        `Task FSM collapsed History/Current Work invariant failed: ${JSON.stringify(collapsed)}`
      );
    }

    const historyToggle = await execJS(
      js.click('[data-testid="agent-org-task-history-toggle"]')
    );
    if (historyToggle !== "clicked") {
      throw new Error(`Task FSM History toggle failed: ${historyToggle}`);
    }
    const completedFirstPage = await waitForRenderedTaskHistory(
      AGENT_ORG_TASK_STATUS.COMPLETED,
      50,
      "completed first page"
    );
    if (completedFirstPage.nextDisabled !== false) {
      throw new Error(
        `Task FSM completed first page did not expose a next cursor: ${JSON.stringify(completedFirstPage)}`
      );
    }
    const firstPageFirstId = completedFirstPage.rows[0]?.id;
    const nextPage = await execJS(
      js.click('[data-testid="agent-org-task-history-next-page"]')
    );
    if (nextPage !== "clicked") {
      throw new Error(`Task FSM History next page failed: ${nextPage}`);
    }
    const completedSecondPage = await waitForRenderedTaskHistory(
      AGENT_ORG_TASK_STATUS.COMPLETED,
      13,
      "completed second page"
    );
    if (
      completedSecondPage.previousDisabled !== false ||
      completedSecondPage.rows[0]?.id === firstPageFirstId
    ) {
      throw new Error(
        `Task FSM completed second page cursor invariant failed: ${JSON.stringify(completedSecondPage)}`
      );
    }
    await execJS(
      js.click('[data-testid="agent-org-task-history-previous-page"]')
    );
    await waitForRenderedTaskHistory(
      AGENT_ORG_TASK_STATUS.COMPLETED,
      50,
      "completed previous page"
    );

    const completedTaskId = scenarioTasks[0].find(
      (task) => task.subject === `E2E_TASK_FSM_COMPLETE:${scenarioIds[0]}`
    )?.id;
    if (!completedTaskId) {
      throw new Error(
        "Task FSM completed Task id was missing from the durable snapshot"
      );
    }
    let completedDetail = await execJS(`
      const row = Array.from(document.querySelectorAll('[data-testid="agent-org-task-history-row"]'))
        .find((candidate) => candidate.getAttribute('data-task-id') === ${JSON.stringify(completedTaskId)});
      const toggle = row?.querySelector('[data-testid="agent-org-task-detail-toggle"]');
      if (!toggle) return 'missing';
      toggle.click();
      return 'clicked';
    `);
    if (completedDetail === "missing") {
      await execJS(
        js.click('[data-testid="agent-org-task-history-next-page"]')
      );
      await waitForRenderedTaskHistory(
        AGENT_ORG_TASK_STATUS.COMPLETED,
        13,
        "completed detail page"
      );
      completedDetail = await execJS(`
        const row = Array.from(document.querySelectorAll('[data-testid="agent-org-task-history-row"]'))
          .find((candidate) => candidate.getAttribute('data-task-id') === ${JSON.stringify(completedTaskId)});
        const toggle = row?.querySelector('[data-testid="agent-org-task-detail-toggle"]');
        if (!toggle) return 'missing';
        toggle.click();
        return 'clicked';
      `);
    }
    if (completedDetail !== "clicked") {
      throw new Error(
        `Task FSM completed detail toggle failed: ${completedDetail}`
      );
    }
    await browser.waitUntil(
      async () => {
        const detail = await execJS(`
          const row = Array.from(document.querySelectorAll('[data-testid="agent-org-task-history-row"]'))
            .find((candidate) => candidate.getAttribute('data-task-id') === ${JSON.stringify(completedTaskId)});
          return row?.querySelector('[data-testid="agent-org-task-detail"]')?.textContent || '';
        `);
        return (
          detail.includes(`E2E completed ${scenarioIds[0]}`) &&
          detail.includes(`E2E production-path evidence for ${scenarioIds[0]}`)
        );
      },
      { timeout: RENDER_TIMEOUT_MS, interval: 250 }
    );

    await execJS(
      js.click('[data-testid="agent-org-task-history-filter-failed"]')
    );
    await waitForRenderedTaskHistory(
      AGENT_ORG_TASK_STATUS.FAILED,
      3,
      "failed filter"
    );
    const failedDetail = await execJS(`
      const row = document.querySelector('[data-testid="agent-org-task-history-row"]');
      row?.querySelector('[data-testid="agent-org-task-detail-toggle"]')?.click();
      return Boolean(row);
    `);
    if (!failedDetail)
      throw new Error("Task FSM failed detail row was missing");
    await browser.waitUntil(
      async () =>
        String(
          await execJS(
            `return document.querySelector('[data-testid="agent-org-task-detail"]')?.textContent || '';`
          )
        ).includes("Deterministic E2E failure"),
      { timeout: RENDER_TIMEOUT_MS, interval: 250 }
    );

    await execJS(
      js.click('[data-testid="agent-org-task-history-filter-cancelled"]')
    );
    await waitForRenderedTaskHistory(
      AGENT_ORG_TASK_STATUS.CANCELLED,
      3,
      "cancelled filter"
    );
    const cancelledState = await execJS(`
      const rows = Array.from(document.querySelectorAll('[data-testid="agent-org-task-history-row"]'));
      return rows.map((row) => ({
        status: row.getAttribute('data-task-status'),
        text: row.textContent || '',
      }));
    `);
    if (
      !cancelledState.every(
        (row) =>
          row.status === AGENT_ORG_TASK_STATUS.CANCELLED &&
          !row.text.includes("Late output")
      )
    ) {
      throw new Error(
        `Task FSM cancelled filter exposed a late result: ${JSON.stringify(cancelledState)}`
      );
    }
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
    if (pauseResult.outcome?.transitioned !== false) {
      await waitForAgentOrgRunView(
        sessionId,
        (view) => view?.runStatus === "paused",
        "group chat run paused for inline Resume"
      );
      await refreshRenderedAgentOrgOverview("group chat paused banner refresh");
      await waitForGroupChatPausedBanner("group chat paused requires Resume");
      const pausedSendState = await execJS(`
        const visible = Array.from(document.querySelectorAll('[data-testid="chat-send-button"]'))
          .find((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
        return visible ? { disabled: Boolean(visible.disabled) } : null;
      `);
      if (pausedSendState?.disabled !== true) {
        throw new Error(
          `Paused Group Chat send must be disabled: ${JSON.stringify(pausedSendState)}`
        );
      }
      await clickGroupChatResumeButton("group chat explicit Resume");
      await waitForAgentOrgRunView(
        sessionId,
        (view) => view?.runStatus !== "paused",
        "explicit Group Chat Resume leaves paused state"
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
            "group chat paused banner did not disappear after explicit Resume",
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
      if (pauseResult.outcome?.transitioned !== false) {
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
        { operation: "start", id: planTaskId }
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

  it("lets the user request changes and approve an immutable member plan revision in Group chat", async () => {
    const account = await getApiAccount();
    const model = selectPreferredModel(account);
    const orgName = `E2E User Plan Approval Org ${RUN_ID}`;
    const plannerName = `E2E User Plan Planner ${RUN_ID}`;
    const implementerName = `E2E User Plan Implementer ${RUN_ID}`;
    await removeAgentOrgsByName(orgName);

    const org = await seedFlatAgentOrg({
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

    const plannerMember = (org.members ?? []).find(
      (member) => member.name === plannerName
    );
    const implementerMember = (org.members ?? []).find(
      (member) => member.name === implementerName
    );
    if (!plannerMember?.memberId || !implementerMember?.memberId) {
      throw new Error(
        `Rendered Team did not persist the scenario members: ${JSON.stringify(org)}`
      );
    }
    const plannerMemberId = plannerMember.memberId;
    const implementerMemberId = implementerMember.memberId;
    const scenarioId = `plan_revision_${RUN_ID}`;
    const sessionId = await sendFromRenderedCreator(
      `Run E2E_AGENT_ORG_PLAN_REVISION:${scenarioId} planner=${plannerMemberId} implementer=${implementerMemberId}`
    );
    if (!sessionId) {
      throw new Error("User plan approval launch did not create a session id");
    }
    await waitForRenderedAssistantReply("user plan approval launch");

    let runId = null;
    let plannerSessionId = null;
    let planTaskId = null;
    let downstreamTaskId = null;
    await waitForAgentOrgRunView(
      sessionId,
      (view) => {
        runId = view?.context?.runId ?? null;
        const planner = (view?.members ?? []).find(
          (member) => member.memberId === plannerMemberId
        );
        const planTask = (view?.tasks ?? []).find(
          (task) => task.subject === `E2E_PLAN_REVISION:${scenarioId}`
        );
        const downstreamTask = (view?.tasks ?? []).find(
          (task) => task.subject === `E2E_PLAN_REVISION_BUILD:${scenarioId}`
        );
        plannerSessionId = planner?.sessionRuntime?.sessionId ?? null;
        planTaskId = planTask?.id ?? null;
        downstreamTaskId = downstreamTask?.id ?? null;
        return Boolean(
          runId &&
            plannerSessionId &&
            planTaskId &&
            downstreamTaskId &&
            planTask?.status === AGENT_ORG_TASK_STATUS.IN_PROGRESS &&
            downstreamTask?.status === AGENT_ORG_TASK_STATUS.PENDING
        );
      },
      "provider-created immutable Plan graph"
    );
    if (
      !runId ||
      !plannerSessionId ||
      !planTaskId ||
      !downstreamTaskId
    ) {
      throw new Error(
        `User approval scenario did not materialize its formal graph: ${JSON.stringify({ runId, plannerSessionId, planTaskId, downstreamTaskId })}`
      );
    }

    const initialTitle = `E2E User Plan ${scenarioId}`;
    const initialContent = `Initial user-reviewed plan ${scenarioId}: inspect, implement, and verify.`;

    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession(coordinator for user plan approval)"
    );
    await refreshRenderedAgentOrgOverview("user plan approval card");
    await browser.waitUntil(
      async () => {
        const card = await execJS(`
          const element = document.querySelector('[data-testid="agent-org-plan-approval-card"]');
          const task = document.querySelector(
            '[data-testid="agent-org-overview-task-row"][data-task-id="${planTaskId}"][data-task-status="in_progress"]'
          );
          return element ? {
            text: element.textContent || "",
            taskAwaiting: Boolean(
              task?.querySelector('[data-testid="agent-org-task-awaiting-approval-chip"]')
            ),
          } : null;
        `);
        return Boolean(
          card?.text.includes(initialTitle) &&
            card?.text.includes(plannerName) &&
            card?.taskAwaiting === true
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
    const feedback = `Please add explicit checkpoints for ${scenarioId}. E2E_AGENT_ORG_PLAN_REVISION:${scenarioId} task=${planTaskId}`;
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

    const revisedTitle = `E2E Revised User Plan ${scenarioId}`;
    const revisedContent = `Revised user-reviewed plan ${scenarioId}: inspect, implement, review each checkpoint, then verify.`;
    await refreshRenderedAgentOrgOverview("revised user plan approval card");
    await browser.waitUntil(
      async () => {
        return execJS(`
          const card = Array.from(document.querySelectorAll('[data-testid="agent-org-plan-approval-card"]'))
            .find((candidate) => candidate.textContent?.includes(${JSON.stringify(revisedTitle)}));
          const approve = card?.querySelector('[data-testid="agent-org-plan-approve-button"]');
          return Boolean(
            card?.textContent?.includes(${JSON.stringify(revisedContent)}) &&
            approve instanceof HTMLButtonElement &&
            !approve.disabled
          );
        `);
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "revised user plan detail never loaded into an enabled approval card",
      }
    );

    const legacyEditSurface = await execJS(`
      return {
        editButton: Boolean(document.querySelector('[data-testid="agent-org-plan-edit-button"]')),
        editInput: Boolean(document.querySelector('[data-testid="agent-org-plan-approval-edit"]')),
      };
    `);
    if (legacyEditSurface?.editButton || legacyEditSurface?.editInput) {
      throw new Error(
        `Immutable Agent Org plan unexpectedly rendered an edit surface: ${JSON.stringify(legacyEditSurface)}`
      );
    }
    const approveClick = await execJS(`
      const card = Array.from(document.querySelectorAll('[data-testid="agent-org-plan-approval-card"]'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(revisedTitle)}));
      const button = card?.querySelector('[data-testid="agent-org-plan-approve-button"]');
      if (!(button instanceof HTMLButtonElement)) return "missing";
      if (button.disabled) return "disabled";
      button.click();
      return "clicked";
    `);
    if (approveClick !== "clicked") {
      throw new Error(`Approve immutable plan did not click: ${approveClick}`);
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
      (view) => {
        const planner = (view?.members ?? []).find(
          (member) => member.memberId === plannerMemberId
        );
        const approvedRevision = (view?.planRevisions ?? []).find(
          (revision) =>
            revision.sourceTaskId === planTaskId &&
            revision.status === "approved"
        );
        return Boolean(
          approvedRevision?.taskOutput?.taskId === planTaskId &&
            planner?.completedTaskCount === 1 &&
            (view?.taskOverview?.completed ?? 0) >= 1
        );
      },
      "user approval completes Plan task"
    );
    const approvedPlanRevision = unwrap(
      await invokeE2E("agentOrgSessionRunView", sessionId),
      "agentOrgSessionRunView(approved Planner history identity)"
    ).view?.planRevisions?.find(
      (revision) =>
        revision.sourceTaskId === planTaskId && revision.status === "approved"
    );
    if (!approvedPlanRevision?.planRevisionId) {
      throw new Error(
        `approved Planner revision identity was unavailable: ${JSON.stringify(approvedPlanRevision)}`
      );
    }
    await browser.waitUntil(
      async () => {
        const history = await execJS(`
          return Array.from(document.querySelectorAll('[data-testid="agent-org-plan-approval-card"]')).map((card) => ({
            text: card.textContent || "",
            status: card.querySelector('[data-testid="agent-org-plan-revision-status"]')?.getAttribute('data-plan-status') || null,
            hasTaskOutput: Boolean(card.querySelector('[data-testid="agent-org-plan-revision-task-output"]')),
          }));
        `);
        return (
          history.some(
            (revision) =>
              revision.status === "changes_requested" &&
              revision.text.includes(initialTitle) &&
              revision.text.includes(feedback)
          ) &&
          history.some(
            (revision) =>
              revision.status === "approved" &&
              revision.text.includes(revisedTitle) &&
              revision.hasTaskOutput
          )
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "terminal immutable Plan revisions did not remain visible in rendered history",
      }
    );

    // Remount the UI from durable state so the approved terminal card starts
    // collapsed. The click below then covers the real historical "Open plan"
    // control instead of reading content left expanded from the approval turn.
    await browser.refresh();
    await waitForApp();
    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession(immutable Plan history after reload)"
    );
    await waitForAgentOrgRunView(
      sessionId,
      (view) =>
        (view?.planRevisions ?? []).some(
          (revision) =>
            revision.sourceTaskId === planTaskId &&
            revision.status === "approved" &&
            revision.taskOutput?.taskId === planTaskId
        ),
      "approved immutable Plan history after reload"
    );
    await refreshRenderedAgentOrgOverview(
      "approved immutable Plan history after reload"
    );

    const openApprovedRevision = await execJS(`
      const card = Array.from(document.querySelectorAll('[data-testid="agent-org-plan-approval-card"]'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(revisedTitle)}));
      const button = card?.querySelector('[data-testid="agent-org-plan-revision-open"]');
      if (!(button instanceof HTMLElement)) return "missing";
      button.click();
      return "clicked";
    `);
    if (openApprovedRevision !== "clicked") {
      throw new Error(
        `Approved immutable revision could not be reopened: ${openApprovedRevision}`
      );
    }
    await browser.waitUntil(
      async () => {
        const approvedText = await execJS(`
          const card = Array.from(document.querySelectorAll('[data-testid="agent-org-plan-approval-card"]'))
            .find((candidate) => candidate.textContent?.includes(${JSON.stringify(revisedTitle)}));
          return card?.textContent || "";
        `);
        return String(approvedText).includes(revisedContent);
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "approved immutable Plan body could not be reopened",
      }
    );

    // Regression: Team Overview always had the formal PlanRevision, but a
    // cold Planner transcript previously reloaded only the raw create_plan
    // provider event. With no plan ids on that raw row PlanDocAdapter returned
    // null, so the same plan disappeared when the user opened Planner history.
    // Use the rendered Team Member switcher after the durable reload and
    // require the transcript card to carry the exact immutable revision
    // identity. Member sessions intentionally do not appear as ordinary
    // top-level sidebar sessions.
    await clickRenderedMemberSwitcher(plannerMemberId, plannerSessionId);
    await browser.waitUntil(
      async () => {
        const plannerHistory = await execJS(`
          const cards = Array.from(document.querySelectorAll(
            '[data-testid="create-plan-card"][data-plan-surface="transcript"]'
          ));
          const target = cards.find(
            (card) => card.getAttribute('data-plan-revision-id') === ${JSON.stringify(approvedPlanRevision.planRevisionId)}
          );
          return target ? {
            text: target.textContent || "",
            status: target.getAttribute('data-plan-approval-status'),
            revisionId: target.getAttribute('data-plan-revision-id'),
          } : null;
        `);
        return Boolean(
          plannerHistory?.text.includes(revisedTitle) &&
          plannerHistory?.status === "approved" &&
          plannerHistory?.revisionId === approvedPlanRevision.planRevisionId
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "approved formal plan did not reappear in the rendered Planner transcript after reload",
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
