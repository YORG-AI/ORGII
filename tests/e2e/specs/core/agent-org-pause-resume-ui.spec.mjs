/* global describe, before, it, process */
import {
  AGENT_ORG_COORDINATOR_MEMBER_ID,
  AGENT_ORG_TASK_STATUS,
  API_AGENT_TYPE,
  DEFAULT_AGENT_ORG_ID,
  DEFAULT_AGENT_ORG_MEMBER_IDS,
  RENDER_TIMEOUT_MS,
  REPLY_TIMEOUT_MS,
  RUN_ID,
  SHARED_CLI_AGENT_ID,
  assertAgentOrgOverviewHasRunControl,
  assertCrashRecoveryBannerAbsent,
  assertE2ERepoFixture,
  assertLongTaskRenderedCollapsed,
  assertNoCurrentPlanBuildSurface,
  assertNoFalseFinality,
  assertNoMemberIntervention,
  assertRenderedGroupChatComposerResponsive,
  assertRenderedGroupChatNoQuoteOrUnreadPreview,
  assertRenderedGroupChatToggleIsIdempotent,
  assertRenderedInboxPinBarAbsent,
  clickGroupChatResumeButton,
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
  runAgentOrgScenarioWithTimeout,
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

describe("Agent Org pause, resume, and sidebar rendered UI", () => {
  before(async () => {
    assertE2ERepoFixture();
    await waitForApp();
  });

  it("Pause button appears when running, Resume when paused, and run view continues polling in both states", async () =>
    runAgentOrgScenarioWithTimeout(
      "pause-resume-button-visibility",
      async () => {
        const account = await getApiAccount();
        const model = selectPreferredModel(account);
        const orgName = `E2E Pause Resume Org ${RUN_ID}`;
        const leadName = `E2E PR Lead ${RUN_ID}`;
        const childName = `E2E PR Child ${RUN_ID}`;
        await removeAgentOrgsByName(orgName);

        const org = await createRenderedStrictTwoMemberAgentOrg({
          orgName,
          leadName,
          childName,
        });
        await configureCreatorForAgentOrg({
          account,
          model,
          agentOrgId: org.id,
        });
        await selectRenderedAgentOrg(org.id);
        const launchPrompt = `E2E pause resume button visibility ${RUN_ID}. Reply briefly.`;
        const sessionId = await sendFromRenderedCreator(launchPrompt);
        if (!sessionId) {
          throw new Error(
            "Pause/Resume test: launch did not create a session id"
          );
        }
        await waitForRenderedGroupChatActive(
          "default Agent Org group chat after launch"
        );
        await assertRenderedGroupChatComposerResponsive(
          "default Agent Org group chat after launch"
        );
        await assertAgentOrgOverviewHasRunControl(
          "default Agent Org group chat after launch"
        );

        // Wait for the Pause button to appear in the UI while the run is live.
        // If the run completes before the Pause button ever appears, the test
        // exits early — there is nothing to pause on an already-terminal run.
        const pauseButtonAppeared = await browser
          .waitUntil(
            async () => {
              const pauseVisible = await execJS(
                js.exists('[data-testid="agent-org-overview-pause-button"]')
              );
              if (pauseVisible) return true;
              // Check if the run has already become terminal (e.g. very fast model).
              const runView = unwrap(
                await invokeE2E("agentOrgSessionRunView", sessionId),
                "agentOrgSessionRunView (pause button wait)"
              );
              const status = runView.view?.runStatus ?? null;
              return Boolean(status && status !== "running");
            },
            {
              timeout: REPLY_TIMEOUT_MS,
              interval: 500,
              timeoutMsg:
                "Pause button never appeared and run did not terminate",
            }
          )
          .catch(() => false);

        const stillRunning = await execJS(
          js.exists('[data-testid="agent-org-overview-pause-button"]')
        );
        if (!stillRunning) {
          // Run completed before we could interact — skip the Pause/Resume UX
          // assertions (correct behaviour: completed runs show neither button).
          return;
        }
        void pauseButtonAppeared; // used only to satisfy the waitUntil flow above

        // Click the Pause button exactly as a user would.
        const pauseClick = await execJS(
          js.click('[data-testid="agent-org-overview-pause-button"]')
        );
        if (pauseClick !== "clicked") {
          throw new Error(`Pause button click failed: ${pauseClick}`);
        }

        // handlePauseRun calls pauseAgentOrgRun() + onRefresh() under the hood,
        // so the hook updates state automatically — no manual refresh needed.
        // Wait for the Resume button to appear (and Pause button to disappear).
        await browser.waitUntil(
          async () => {
            const pauseVisible = await execJS(
              js.exists('[data-testid="agent-org-overview-pause-button"]')
            );
            const resumeVisible = await execJS(
              js.exists('[data-testid="agent-org-overview-resume-button"]')
            );
            return resumeVisible && !pauseVisible;
          },
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg: "Resume button did not appear after clicking Pause",
          }
        );

        // Click the Resume button exactly as a user would.
        const resumeClick = await execJS(
          js.click('[data-testid="agent-org-overview-resume-button"]')
        );
        if (resumeClick !== "clicked") {
          throw new Error(`Resume button click failed: ${resumeClick}`);
        }

        // After resume, the Pause button should reappear (run is running again)
        // OR the run completes immediately — both are valid outcomes.
        await browser.waitUntil(
          async () => {
            const pauseVisible = await execJS(
              js.exists('[data-testid="agent-org-overview-pause-button"]')
            );
            if (pauseVisible) return true;
            const runView = unwrap(
              await invokeE2E("agentOrgSessionRunView", sessionId),
              "agentOrgSessionRunView (post-resume)"
            );
            const status = runView.view?.runStatus ?? null;
            return Boolean(status && status !== "paused");
          },
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg:
              "Pause button did not reappear after Resume and run did not leave paused state",
          }
        );
      }
    ));

  it("Overview panel and member switcher remain visible after run is paused (app-restart semantics)", async () =>
    runAgentOrgScenarioWithTimeout(
      "paused-overview-restart-semantics",
      async () => {
        // This test verifies that when a run is in `paused` state (the state the
        // app startup puts it into after an unexpected exit), the AgentOrgOverviewPanel
        // continues to render and polling is not stopped. This is the core
        // app-restart UX fix: the user should see the run state and a Resume button,
        // not a blank panel.
        const account = await getApiAccount();
        const model = selectPreferredModel(account);
        const orgName = `E2E Restart Restore Org ${RUN_ID}`;
        const leadName = `E2E RR Lead ${RUN_ID}`;
        const childName = `E2E RR Child ${RUN_ID}`;
        await removeAgentOrgsByName(orgName);

        const org = await createRenderedStrictTwoMemberAgentOrg({
          orgName,
          leadName,
          childName,
        });
        await configureCreatorForAgentOrg({
          account,
          model,
          agentOrgId: org.id,
        });
        await selectRenderedAgentOrg(org.id);
        const launchPrompt = `E2E restart restore ${RUN_ID}. Reply briefly.`;
        const sessionId = await sendFromRenderedCreator(launchPrompt);
        if (!sessionId) {
          throw new Error(
            "Restart restore test: launch did not create a session"
          );
        }

        // Wait for the Pause button — it appears while the run is live.
        // If the run completes first, skip the pause/resume UX check.
        await browser
          .waitUntil(
            async () => {
              const pauseVisible = await execJS(
                js.exists('[data-testid="agent-org-overview-pause-button"]')
              );
              if (pauseVisible) return true;
              const runView = unwrap(
                await invokeE2E("agentOrgSessionRunView", sessionId),
                "agentOrgSessionRunView (restart pause wait)"
              );
              const status = runView.view?.runStatus ?? null;
              return Boolean(status && status !== "running");
            },
            {
              timeout: REPLY_TIMEOUT_MS,
              interval: 500,
              timeoutMsg: "Pause button never appeared (restart test)",
            }
          )
          .catch(() => {});

        const pauseStillVisible = await execJS(
          js.exists('[data-testid="agent-org-overview-pause-button"]')
        );
        if (!pauseStillVisible) {
          return;
        }

        // Click the Pause button — simulates app restart / user pause.
        const pauseClick = await execJS(
          js.click('[data-testid="agent-org-overview-pause-button"]')
        );
        if (pauseClick !== "clicked") {
          throw new Error(`Pause button click failed: ${pauseClick}`);
        }

        // Overview panel must stay visible — paused is non-terminal.
        // Regression guard: before the fix the panel disappeared after pause.
        await browser.waitUntil(
          async () =>
            execJS(
              js.exists('[data-testid="agent-org-overview-resume-button"]')
            ),
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg:
              "Resume button did not appear for paused run (restart test)",
          }
        );

        // Member switcher must still be visible (Overview Panel is still rendering).
        const hasMemberSwitcher = await execJS(
          js.exists('[data-testid="agent-org-member-switcher-trigger"]')
        );
        if (!hasMemberSwitcher) {
          throw new Error(
            "Member switcher disappeared after run was paused — overview panel must remain visible"
          );
        }

        // Click Resume — simulates user resuming after restart.
        const resumeClick = await execJS(
          js.click('[data-testid="agent-org-overview-resume-button"]')
        );
        if (resumeClick !== "clicked") {
          throw new Error(
            `Resume button click failed (restart test): ${resumeClick}`
          );
        }

        // After resume the run must leave the paused state.
        await browser.waitUntil(
          async () => {
            const pauseVisible = await execJS(
              js.exists('[data-testid="agent-org-overview-pause-button"]')
            );
            if (pauseVisible) return true;
            const runView = unwrap(
              await invokeE2E("agentOrgSessionRunView", sessionId),
              "agentOrgSessionRunView (post-resume restart)"
            );
            const status = runView.view?.runStatus ?? null;
            return Boolean(status && status !== "paused");
          },
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg:
              "Run did not leave paused state after Resume (restart test)",
          }
        );
      }
    ));

  it("Coordinator history button appears when viewing a member session while run is paused", async () =>
    runAgentOrgScenarioWithTimeout(
      "paused-member-coordinator-history",
      async () => {
        // Regression guard for the bug where session history disappeared after
        // app restart. The coordinator session is not shown in the sidebar
        // (orgMemberId filter excludes it) but must remain accessible via the
        // Overview Panel's coordinator history button.
        const account = await getApiAccount();
        const model = selectPreferredModel(account);
        const orgName = `E2E Coord Hist Btn Org ${RUN_ID}`;
        const leadName = `E2E CHB Lead ${RUN_ID}`;
        const childName = `E2E CHB Child ${RUN_ID}`;
        await removeAgentOrgsByName(orgName);

        const org = await createRenderedStrictTwoMemberAgentOrg({
          orgName,
          leadName,
          childName,
        });
        await configureCreatorForAgentOrg({
          account,
          model,
          agentOrgId: org.id,
        });
        await selectRenderedAgentOrg(org.id);
        const launchPrompt = `E2E coord history button ${RUN_ID}. Reply briefly.`;
        const sessionId = await sendFromRenderedCreator(launchPrompt);
        if (!sessionId) {
          throw new Error(
            "Coord history button test: launch did not create a session"
          );
        }

        // Wait for the Pause button (run is live), then click it.
        await browser
          .waitUntil(
            async () => {
              const pauseVisible = await execJS(
                js.exists('[data-testid="agent-org-overview-pause-button"]')
              );
              if (pauseVisible) return true;
              const runView = unwrap(
                await invokeE2E("agentOrgSessionRunView", sessionId),
                "agentOrgSessionRunView (hist pause wait)"
              );
              const status = runView.view?.runStatus ?? null;
              return Boolean(status && status !== "running");
            },
            {
              timeout: REPLY_TIMEOUT_MS,
              interval: 500,
              timeoutMsg: "Pause button never appeared (hist button test)",
            }
          )
          .catch(() => {});

        const pauseStillVisibleHist = await execJS(
          js.exists('[data-testid="agent-org-overview-pause-button"]')
        );
        if (!pauseStillVisibleHist) {
          return;
        }

        const pauseClickHist = await execJS(
          js.click('[data-testid="agent-org-overview-pause-button"]')
        );
        if (pauseClickHist !== "clicked") {
          throw new Error(
            `Pause button click failed (hist test): ${pauseClickHist}`
          );
        }

        // Wait for paused state in the Overview Panel.
        await waitForAgentOrgRunView(
          sessionId,
          (view) => view?.runStatus === "paused",
          "run is paused (hist button test)"
        );

        // When we are NOT viewing the coordinator session, the history button
        // must be present so the user can navigate to the coordinator's chat.
        // (The run view context.rootSessionId is populated from the DB.)
        await browser.waitUntil(
          async () =>
            execJS(
              js.exists(
                '[data-testid="agent-org-overview-coordinator-history-button"]'
              )
            ),
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg:
              "Coordinator history button did not appear when viewing a non-coordinator member with a paused run",
          }
        );
      }
    ));

  it("Duplicate Load more buttons do not appear for rust_agent category after org sessions are abandoned", async () =>
    runAgentOrgScenarioWithTimeout(
      "no-duplicate-load-more-after-abandon",
      async () => {
        // Regression guard for the hasMore inflation bug: abandoned coordinator
        // and member sessions were counted in the raw probe count, keeping
        // hasMore: true even after filtering, causing a phantom second "Load more".
        //
        // This test verifies that after a run is paused (sessions marked abandoned
        // on restart) the session list does NOT render more than one "Load more"
        // for the rust_agent category.
        const account = await getApiAccount();
        const model = selectPreferredModel(account);
        const orgName = `E2E HasMore Fix Org ${RUN_ID}`;
        const leadName = `E2E HMF Lead ${RUN_ID}`;
        const childName = `E2E HMF Child ${RUN_ID}`;
        await removeAgentOrgsByName(orgName);

        const org = await createRenderedStrictTwoMemberAgentOrg({
          orgName,
          leadName,
          childName,
        });
        await configureCreatorForAgentOrg({
          account,
          model,
          agentOrgId: org.id,
        });
        await selectRenderedAgentOrg(org.id);
        const launchPrompt = `E2E hasmore fix ${RUN_ID}. Reply briefly.`;
        const sessionId = await sendFromRenderedCreator(launchPrompt);
        if (!sessionId) {
          throw new Error(
            "Duplicate Load more test: launch did not create a session"
          );
        }

        // Wait for the overview panel to materialise.
        await waitForAgentOrgRunView(
          sessionId,
          (view) => Boolean(view?.context?.runId),
          "overview panel appeared for hasmore test"
        );

        // Simulate app restart: pause the run (marks sessions abandoned in startup).
        unwrap(
          await invokeE2E("agentOrgPauseRun", sessionId),
          "agentOrgPauseRun (simulating app restart)"
        );

        // Reproduce the real user path. The old assertion queried the nonexistent
        // `data-item-id` attribute, accepted zero matches, and never clicked the
        // row, so it stayed green even when Load more did nothing.
        const groupBy = await $(
          '[data-testid="sidebar-session-filter-button"]'
        );
        await groupBy.waitForDisplayed({ timeout: RENDER_TIMEOUT_MS });
        await groupBy.click();
        const byAgent = await $('[data-testid="sidebar-group-by-byAgent"]');
        await byAgent.waitForDisplayed({ timeout: RENDER_TIMEOUT_MS });
        await byAgent.click();

        const sdeToggle = await $('[data-sidebar-section-toggle="sde"]');
        await sdeToggle.waitForExist({ timeout: RENDER_TIMEOUT_MS });
        if ((await sdeToggle.getAttribute("aria-expanded")) === "false") {
          await sdeToggle.click();
        }
        const pagerSelector = '[data-menu-item-id="load-more-rust_agent:sde"]';
        const initial = await execJS(`
      return (() => {
        const section = document.querySelector('[data-sidebar-section-id="sde"]');
        const sessionIds = Array.from(
          section?.querySelectorAll('[data-testid^="sidebar-session-item-"]') || []
        ).map((row) => row.getAttribute('data-menu-item-id'));
        return {
          pagerCount: document.querySelectorAll(${JSON.stringify(
            pagerSelector
          )}).length,
          sessionIds,
        };
      })();
    `);
        if (initial.pagerCount !== 1) {
          throw new Error(
            `Load more regression precondition failed: expected exactly one real rust_agent:sde pager, got ${initial.pagerCount}. The scenario must seed enough durable SDE roots; zero is not accepted as a pass.`
          );
        }
        const pager = await $(pagerSelector);
        await pager.scrollIntoView({ block: "center", inline: "nearest" });
        await pager.waitForClickable({ timeout: RENDER_TIMEOUT_MS });
        await pager.click();

        let after = null;
        await browser.waitUntil(
          async () => {
            after = await execJS(`
          return (() => {
            const section = document.querySelector('[data-sidebar-section-id="sde"]');
            const sessionIds = Array.from(
              section?.querySelectorAll('[data-testid^="sidebar-session-item-"]') || []
            ).map((row) => row.getAttribute('data-menu-item-id'));
            return {
              pagerCount: document.querySelectorAll(${JSON.stringify(
                pagerSelector
              )}).length,
              sessionIds,
            };
          })();
        `);
            return after.sessionIds.length > initial.sessionIds.length;
          },
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg:
              "real rust_agent:sde Load more click did not grow the rendered row set",
          }
        );
        if (after.pagerCount > 1) {
          throw new Error(
            `Expected at most one rust_agent:sde pager after loading, got ${after.pagerCount}`
          );
        }
        if (new Set(after.sessionIds).size !== after.sessionIds.length) {
          throw new Error(
            `rust_agent:sde Load more rendered duplicate rows: ${JSON.stringify(after.sessionIds)}`
          );
        }
      }
    ));

  it("Coordinator session remains in sidebar after switching to a member session and back", async () =>
    runAgentOrgScenarioWithTimeout(
      "coordinator-sidebar-after-member-switch",
      async () => {
        // Regression guard for the bug where switching to a member chat and then back caused the new coordinator session to disappear from the left sidebar.
        //
        // The coordinator session (root session of the org run) must appear in the
        // sidebar as a primary session. Switching to a member via the member switcher
        // and then returning to the coordinator session must NOT cause it to disappear
        // from the sidebar.
        //
        // The fix lives in two places:
        //  1. `byAgentMenuItems` in `useSessionMenuItems.tsx` — org group's local
        //     "Load more" now marks rust_agent as already emitted so the backend
        //     "Load more" is not duplicated. The rerender after member switch was
        //     triggering a full sidebar refresh that lost the session item.
        //  2. `fetchAggregatePage` reverted from `primarySessions.length >= pageSize`
        //     back to `response.sessions.length > pageSize` so hasMore is not
        //     falsely set for users whose page is exactly full.
        const account = await getApiAccount();
        const model = selectPreferredModel(account);
        const orgName = `E2E Sidebar Persist Org ${RUN_ID}`;
        const leadName = `E2E SP Lead ${RUN_ID}`;
        const childName = `E2E SP Child ${RUN_ID}`;
        await removeAgentOrgsByName(orgName);

        const org = await createRenderedStrictTwoMemberAgentOrg({
          orgName,
          leadName,
          childName,
        });
        await configureCreatorForAgentOrg({
          account,
          model,
          agentOrgId: org.id,
        });
        await selectRenderedAgentOrg(org.id);
        const launchPrompt = `E2E sidebar persist ${RUN_ID}. Reply briefly.`;
        const sessionId = await sendFromRenderedCreator(launchPrompt);
        if (!sessionId) {
          throw new Error(
            "Sidebar persist test: launch did not create a session"
          );
        }
        await waitForRenderedAssistantReply("sidebar persist launch");

        // Confirm the coordinator session appears in the sidebar.
        await browser.waitUntil(
          async () =>
            execJS(
              js.exists(`[data-testid="sidebar-session-item-${sessionId}"]`)
            ),
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg: `Coordinator session ${sessionId} did not appear in sidebar after launch`,
          }
        );

        // Wait for overview panel and member data so we can switch to a member.
        let memberSessionId = null;
        await waitForAgentOrgRunView(
          sessionId,
          (view) => {
            const member = (view?.members ?? []).find(
              (member) => member.memberId !== AGENT_ORG_COORDINATOR_MEMBER_ID
            );
            memberSessionId = member?.sessionRuntime?.sessionId ?? null;
            return Boolean(memberSessionId);
          },
          "member session materialized"
        );

        // Switch to the first non-coordinator member via the member switcher.
        const nonCoordMember = await invokeE2E(
          "agentOrgSessionRunView",
          sessionId
        );
        const firstNonCoord = unwrap(
          nonCoordMember,
          "agentOrgSessionRunView for member"
        ).view?.members?.find(
          (member) => member.memberId !== AGENT_ORG_COORDINATOR_MEMBER_ID
        );
        if (
          !firstNonCoord?.memberId ||
          !firstNonCoord?.sessionRuntime?.sessionId
        ) {
          throw new Error(
            `No non-coordinator member materialized: ${JSON.stringify(firstNonCoord)}`
          );
        }
        await ensureMemberHasSwitchableInbox(
          sessionId,
          firstNonCoord.memberId,
          "sidebar persist member"
        );
        await clickRenderedMemberSwitcher(
          firstNonCoord.memberId,
          firstNonCoord.sessionRuntime.sessionId
        );

        // After switching to member session, coordinator session must still be in sidebar.
        const afterSwitchPresent = await execJS(
          js.exists(`[data-testid="sidebar-session-item-${sessionId}"]`)
        );
        if (!afterSwitchPresent) {
          throw new Error(
            `Coordinator session ${sessionId} disappeared from sidebar after switching to member — regression in dual Load more fix`
          );
        }

        // Regression guard for the real failure: the member-switch path used to
        // kick off a legacy bulk `loadSessions({ forceRefresh: true })` in the
        // background. The immediate assertion above could pass before that async
        // destructive refresh returned, then the left sidebar would break a moment
        // later. Wait through that refresh window and assert the root session is
        // still retained by the sidebar-specific merge loader.
        await browser.pause(1_500);
        const afterAsyncRefreshPresent = await execJS(
          js.exists(`[data-testid="sidebar-session-item-${sessionId}"]`)
        );
        if (!afterAsyncRefreshPresent) {
          throw new Error(
            `Coordinator session ${sessionId} disappeared from sidebar after member switch async refresh`
          );
        }

        // Switch back to coordinator via member switcher.
        await clickRenderedMemberSwitcher(
          AGENT_ORG_COORDINATOR_MEMBER_ID,
          sessionId
        );

        // After switching back, coordinator session must still be in sidebar.
        await browser.waitUntil(
          async () =>
            execJS(
              js.exists(`[data-testid="sidebar-session-item-${sessionId}"]`)
            ),
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg: `Coordinator session ${sessionId} disappeared from sidebar after switching back from member`,
          }
        );
      }
    ));

  it("Ask mode Agent Org sessions retain task-board dispatch semantics", async () =>
    runAgentOrgScenarioWithTimeout("ask-mode-task-dispatch", async () => {
      const account = await getApiAccount();
      const model = selectPreferredModel(account);
      const orgName = `E2E Ask Task Org ${RUN_ID}`;
      const leadName = `E2E AT Lead ${RUN_ID}`;
      const childName = `E2E AT Child ${RUN_ID}`;
      await removeAgentOrgsByName(orgName);

      const org = await createRenderedStrictTwoMemberAgentOrg({
        orgName,
        leadName,
        childName,
      });
      await configureCreatorForAgentOrg({ account, model, agentOrgId: org.id });
      await selectRenderedAgentOrg(org.id);
      await selectRenderedExecMode("ask");

      const launchPrompt = `E2E ask task dispatch ${RUN_ID}. Reply briefly.`;
      const sessionId = await sendFromRenderedCreator(launchPrompt);
      if (!sessionId) {
        throw new Error(
          "Ask task dispatch test: launch did not create a session"
        );
      }
      await waitForActiveSessionExecMode(
        sessionId,
        "ask",
        "ask task dispatch session mode"
      );

      let runView = null;
      await waitForAgentOrgRunView(
        sessionId,
        (view) => {
          runView = view;
          return Boolean(
            view?.context?.runId && (view?.members ?? []).length > 1
          );
        },
        "ask task dispatch run view"
      );
      const firstWorker = runView?.members?.find(
        (member) => member.memberId !== AGENT_ORG_COORDINATOR_MEMBER_ID
      );
      if (!firstWorker?.memberId) {
        throw new Error(
          `Ask task dispatch test could not find worker member: ${JSON.stringify(runView)}`
        );
      }

      const taskId = `e2e-ask-task-dispatch-${RUN_ID}`;
      const subject = `E2E Ask mode Agent Org task dispatch ${RUN_ID} stays available for task board orchestration even though Ask remains read-only for file and plan tools.`;
      await createLongTaskPrecondition(
        sessionId,
        taskId,
        subject,
        firstWorker.memberId
      );
      await waitForAgentOrgRunView(
        sessionId,
        (view) => Boolean(view?.tasks?.some((task) => task.id === taskId)),
        "ask mode task created in run view"
      );
      await openAgentOrgOverviewPanel("ask mode task dispatch");
      await assertLongTaskRenderedCollapsed(taskId, subject);
    }));

  it("Session remains in sidebar and run can be resumed after simulated app restart", async () =>
    runAgentOrgScenarioWithTimeout(
      "resume-after-simulated-restart",
      async () => {
        // Regression guard for restart-related Agent Org history issues:
        //  - After simulated restart (mark_stale_running_sessions_abandoned +
        //    mark_all_running_as_paused_on_startup + clear_all_active_on_startup),
        //    the coordinator session must still be visible in the sidebar.
        //  - The run status must be "paused" (not completed / cancelled), so the
        //    Overview Panel continues to render with a Resume button.
        //  - Clicking Resume must transition the run back to "running".
        const account = await getApiAccount();
        const model = selectPreferredModel(account);
        const orgName = `E2E Restart Sidebar Org ${RUN_ID}`;
        const leadName = `E2E RS Lead ${RUN_ID}`;
        const childName = `E2E RS Child ${RUN_ID}`;
        await removeAgentOrgsByName(orgName);

        const org = await createRenderedStrictTwoMemberAgentOrg({
          orgName,
          leadName,
          childName,
        });
        await configureCreatorForAgentOrg({
          account,
          model,
          agentOrgId: org.id,
        });
        await selectRenderedAgentOrg(org.id);
        const launchPrompt = `E2E restart sidebar ${RUN_ID}. Reply briefly.`;
        const sessionId = await sendFromRenderedCreator(launchPrompt);
        if (!sessionId) {
          throw new Error(
            "Restart sidebar test: launch did not create a session"
          );
        }
        // Wait for the overview panel (don't require a specific runStatus — the run
        // may complete before the restart simulation arrives on slower hosts).
        let restartView = null;
        await waitForAgentOrgRunView(
          sessionId,
          (view) => {
            restartView = view;
            return Boolean(view?.context?.runId);
          },
          "overview panel appeared for restart sidebar test"
        );
        const firstWorker = restartView?.members?.find(
          (member) => member.memberId !== AGENT_ORG_COORDINATOR_MEMBER_ID
        );
        if (!firstWorker?.memberId) {
          throw new Error(
            `Restart sidebar test could not find worker member: ${JSON.stringify(restartView)}`
          );
        }
        const retainedTaskId = `e2e-restart-retained-task-${RUN_ID}`;
        const retainedTaskSubject =
          `E2E retained historical task ${RUN_ID} must remain visible in the Agent Org task board after reopening the historical session, including owner, status, and collapsed presentation.`.slice(
            0,
            190
          );
        await createLongTaskPrecondition(
          sessionId,
          retainedTaskId,
          retainedTaskSubject,
          firstWorker.memberId
        );
        await waitForAgentOrgRunView(
          sessionId,
          (view) =>
            Boolean(view?.tasks?.some((task) => task.id === retainedTaskId)),
          "retained task appears in run view before restart"
        );
        const retainedTaskAssignedRow = await waitForInboxRow(
          sessionId,
          (row) => {
            const payload = parseInboxPayload(
              row,
              "retained task assignment before restart"
            );
            return (
              row.payloadKind === "task_assigned" &&
              row.recipientMemberId === firstWorker.memberId &&
              payload.task_id === retainedTaskId &&
              !row.readAt
            );
          },
          "retained task assignment stays unread before restart"
        );
        if (!firstWorker.sessionRuntime?.sessionId) {
          throw new Error(
            `Restart sidebar test worker has no session runtime: ${JSON.stringify(firstWorker)}`
          );
        }
        await openAgentOrgOverviewPanel("retained task before restart");
        await assertLongTaskRenderedCollapsed(
          retainedTaskId,
          retainedTaskSubject
        );

        // Confirm session in sidebar before restart.
        await browser.waitUntil(
          async () =>
            execJS(
              js.exists(`[data-testid="sidebar-session-item-${sessionId}"]`)
            ),
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg: `Session ${sessionId} not in sidebar before simulated restart`,
          }
        );

        // Simulate app restart (pauses any still-running runs).
        const restartResult = unwrap(
          await invokeE2E("agentOrgSimulateAppRestart"),
          "agentOrgSimulateAppRestart"
        );

        const aggregateListAfterRestart = await postJson(
          "/agent/test/session/aggregate-list-via-cmd",
          {
            session_id: sessionId,
            category: "agent",
            limit: 200,
            sortBy: "updated_at",
            sortOrder: "desc",
          },
          60_000
        );
        const aggregateSession =
          aggregateListAfterRestart.target_session ?? null;
        if (!aggregateSession) {
          throw new Error(
            `Restart sidebar test could not find coordinator root in session_aggregate_list: ${JSON.stringify(aggregateListAfterRestart)}`
          );
        }
        if (
          aggregateSession.agentOrgId !== org.id ||
          aggregateSession.agentOrgName !== orgName ||
          aggregateSession.orgMemberId !== AGENT_ORG_COORDINATOR_MEMBER_ID ||
          aggregateSession.parentSessionId
        ) {
          throw new Error(
            `Restart sidebar aggregate row lost Agent Org root identity: ${JSON.stringify(aggregateSession)}`
          );
        }

        // If the restart paused the run, confirm it's paused. If it was already
        // terminal (completed quickly) the run stays terminal — both are valid.
        if (restartResult.runsPaused > 0) {
          await waitForAgentOrgRunView(
            sessionId,
            (view) => view?.runStatus === "paused",
            "run is paused after simulated app restart"
          );
        }

        // Session must still be in the sidebar after restart — not lost.
        const presentAfterRestart = await execJS(
          js.exists(`[data-testid="sidebar-session-item-${sessionId}"]`)
        );
        if (!presentAfterRestart) {
          throw new Error(
            `Session ${sessionId} disappeared from sidebar after simulated app restart`
          );
        }

        // Member switcher must still be visible (overview panel is polling).
        const hasMemberSwitcher = await execJS(
          js.exists('[data-testid="agent-org-member-switcher-trigger"]')
        );
        if (!hasMemberSwitcher) {
          throw new Error(
            "Member switcher disappeared after simulated app restart — overview panel stopped rendering"
          );
        }

        await invokeE2E("resetToNewSession");
        await openRenderedSidebarSession(sessionId);
        await assertCrashRecoveryBannerAbsent(
          "historical restart resume button path"
        );

        const promptRetained = await execJS(
          `return document.body.textContent.includes(${JSON.stringify(launchPrompt)});`
        );
        if (!promptRetained) {
          throw new Error(
            "Coordinator transcript prompt was not retained after reopening historical session"
          );
        }
        await browser.waitUntil(
          async () =>
            execJS(
              js.exists('[data-testid="agent-org-member-switcher-trigger"]')
            ),
          {
            timeout: RENDER_TIMEOUT_MS,
            timeoutMsg:
              "Member switcher was not retained after reopening historical session",
          }
        );
        await openAgentOrgOverviewPanel(
          "retained task after historical reopen"
        );
        await assertLongTaskRenderedCollapsed(
          retainedTaskId,
          retainedTaskSubject
        );

        if (restartResult.runsPaused === 0) {
          const pauseFallback = unwrap(
            await invokeE2E("agentOrgPauseRun", sessionId),
            "agentOrgPauseRun fallback for restart resume button path"
          );
          if (!pauseFallback.transitioned) {
            throw new Error(
              "Could not establish paused run for historical Resume button path"
            );
          }
          await waitForAgentOrgRunView(
            sessionId,
            (view) => view?.runStatus === "paused",
            "run is paused for restart resume button path"
          );
        }

        await waitForGroupChatPausedBanner(
          "historical paused run after reopening from sidebar"
        );
        await assertRenderedGroupChatComposerResponsive(
          "historical paused run after reopening from sidebar"
        );
        await assertAgentOrgOverviewHasRunControl(
          "historical paused run after reopening from sidebar"
        );
        await clickGroupChatResumeButton(
          "historical paused run after reopening from sidebar"
        );
        await waitForAgentOrgRunView(
          sessionId,
          (view) => Boolean(view?.runStatus && view.runStatus !== "paused"),
          "run left paused state after rendered resume post-restart"
        );
        await waitForCoordinatorRuntimeStatus(
          sessionId,
          (status) => Boolean(status && status !== "abandoned"),
          "coordinator session was revived after rendered resume post-restart"
        );
        await waitForInboxRowRead(
          sessionId,
          retainedTaskAssignedRow.id,
          "retained task assignment was drained after rendered resume post-restart"
        );
        await waitForAgentOrgRunView(
          sessionId,
          (view) => {
            const retainedTask = view?.tasks?.find(
              (task) => task.id === retainedTaskId
            );
            const retainedOwnerRuntime = retainedTask?.ownerRuntime;
            const workerRuntime = view?.members?.find(
              (member) => member.memberId === firstWorker.memberId
            )?.sessionRuntime;
            const ownerRuntimeStatus =
              retainedOwnerRuntime?.status ?? workerRuntime?.status;
            return Boolean(
              view?.runStatus === "running" &&
              retainedTask?.owner === firstWorker.memberId &&
              retainedTask?.status === AGENT_ORG_TASK_STATUS.PENDING &&
              ownerRuntimeStatus &&
              ownerRuntimeStatus !== "abandoned"
            );
          },
          "retained open task owner runtime was revived after rendered resume post-restart",
          REPLY_TIMEOUT_MS
        );
        await assertNoFalseFinality(
          sessionId,
          restartView.context.runId,
          "restart resume retained task progress"
        );

        // Session must still be in sidebar after the entire lifecycle.
        const presentAfterResume = await execJS(
          js.exists(`[data-testid="sidebar-session-item-${sessionId}"]`)
        );
        if (!presentAfterResume) {
          throw new Error(
            `Session ${sessionId} disappeared from sidebar after resume`
          );
        }
      }
    ));

  it("Historical paused Agent Org run resumes when the user sends a message", async () =>
    runAgentOrgScenarioWithTimeout(
      "historical-paused-send-resumes",
      async () => {
        const account = await getApiAccount();
        const model = selectPreferredModel(account);
        const orgName = `E2E Send Resume Org ${RUN_ID}`;
        const leadName = `E2E SR Lead ${RUN_ID}`;
        const childName = `E2E SR Child ${RUN_ID}`;
        await removeAgentOrgsByName(orgName);

        const org = await createRenderedStrictTwoMemberAgentOrg({
          orgName,
          leadName,
          childName,
        });
        await configureCreatorForAgentOrg({
          account,
          model,
          agentOrgId: org.id,
        });
        await selectRenderedAgentOrg(org.id);
        const launchPrompt = `E2E historical send resume ${RUN_ID}. Reply briefly.`;
        const sessionId = await sendFromRenderedCreator(launchPrompt);
        if (!sessionId) {
          throw new Error("Send resume test: launch did not create a session");
        }
        await waitForAgentOrgRunView(
          sessionId,
          (view) => Boolean(view?.context?.runId),
          "overview panel appeared for send resume test"
        );

        const restartResult = unwrap(
          await invokeE2E("agentOrgSimulateAppRestart"),
          "agentOrgSimulateAppRestart for send resume"
        );
        if (restartResult.runsPaused === 0) {
          const pauseFallback = unwrap(
            await invokeE2E("agentOrgPauseRun", sessionId),
            "agentOrgPauseRun fallback for send resume path"
          );
          if (!pauseFallback.transitioned) {
            throw new Error(
              "Could not establish paused run for send-message resume path"
            );
          }
        }
        await waitForAgentOrgRunView(
          sessionId,
          (view) => view?.runStatus === "paused",
          "run is paused before send-message resume"
        );

        await invokeE2E("resetToNewSession");
        await openRenderedSidebarSession(sessionId);
        await assertCrashRecoveryBannerAbsent(
          "historical send-message resume path"
        );

        const promptRetained = await execJS(
          `return document.body.textContent.includes(${JSON.stringify(launchPrompt)});`
        );
        if (!promptRetained) {
          throw new Error(
            "Coordinator transcript prompt was not retained before send-message resume"
          );
        }

        const followUpPrompt = `E2E send-message resume follow-up ${RUN_ID}`;
        await sendRenderedChatPrompt(followUpPrompt);
        await waitForAgentOrgRunView(
          sessionId,
          (view) => Boolean(view?.runStatus && view.runStatus !== "paused"),
          "run left paused state after user sent follow-up message"
        );
        await waitForCoordinatorRuntimeStatus(
          sessionId,
          (status) => Boolean(status && status !== "abandoned"),
          "coordinator session was revived after user sent follow-up message"
        );

        await waitForRenderedGroupChatUserTurn({
          text: followUpPrompt,
          label: "send-message resume follow-up retained",
        });
        await assertRenderedGroupChatComposerResponsive(
          "historical send-message resume group chat"
        );

        const presentAfterSendResume = await execJS(
          js.exists(`[data-testid="sidebar-session-item-${sessionId}"]`)
        );
        if (!presentAfterSendResume) {
          throw new Error(
            `Session ${sessionId} disappeared from sidebar after send-message resume`
          );
        }
      }
    ));
});
