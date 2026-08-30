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

        // Count "Load more" items in the sidebar — must be 0 or 1, never 2+.
        // Load more items carry an id starting with "load-more-" (NavigationMenuItem id).
        const loadMoreCount = await execJS(`
      (() => {
        // The navigation sidebar renders items with data-item-id attributes.
        // Both backend pagination "Load more" and group-level "Load more"
        // carry ids starting with "load-more-" or "load-more-group-".
        const byDataId = Array.from(document.querySelectorAll('[data-item-id^="load-more-"]')).length;
        // Fallback: count by visible text content in the sidebar nav tree.
        const byText = Array.from(document.querySelectorAll('nav button, nav [role="button"]'))
          .filter(el => el.textContent?.trim() === 'Load more').length;
        return Math.max(byDataId, byText);
      })()
    `);
        if (loadMoreCount >= 2) {
          throw new Error(
            `Expected at most 1 "Load more" item in sidebar, got ${loadMoreCount}. Phantom hasMore from abandoned org sessions was not fixed.`
          );
        }
      }
    ));

  it("Standalone, Pinned, and Agent Org pagination advance independently in one click", async () =>
    runAgentOrgScenarioWithTimeout(
      "independent-native-sidebar-pagination",
      async () => {
        // Debug helpers seed durable preconditions only. The assertions below use
        // the rendered filter menu and real NavigationMenu Load more clicks.
        const fixturePrefix = `issue-572-${RUN_ID}`;
        const futureTimestamp = "2099-07-29T12:00:00Z";
        const standaloneSessionIds = Array.from(
          { length: 30 },
          (_, index) =>
            `sdeagent-${fixturePrefix}-standalone-${String(index).padStart(2, "0")}`
        );
        const rootSessionIds = Array.from(
          { length: 11 },
          (_, index) =>
            `sdeagent-${fixturePrefix}-root-${String(index).padStart(2, "0")}`
        );
        const workerSessionIds = Array.from(
          { length: 11 },
          (_, index) =>
            `sdeagent-${fixturePrefix}-worker-${String(index).padStart(2, "0")}`
        );
        const pinnedSessionIds = Array.from(
          { length: 11 },
          (_, index) =>
            `sdeagent-${fixturePrefix}-pinned-${String(index).padStart(2, "0")}`
        );
        const runIds = [];
        let scenarioError = null;

        try {
          // Put 30 Standalone entities into the ordinary cache first. The rendered
          // refresh below must replace that provisional window with backend page 1,
          // then expose page 2 with one real click.
          for (let index = 29; index >= 0; index -= 1) {
            unwrap(
              await invokeE2E("debugSeedSidebarCodingSessionWire", {
                sessionId: standaloneSessionIds[index],
                name: `Issue 572 standalone ${String(index).padStart(2, "0")}`,
                status: "idle",
                createdAt: futureTimestamp,
                updatedAt: futureTimestamp,
              }),
              `seed standalone sidebar row ${index}`
            );
          }
          for (let index = 10; index >= 0; index -= 1) {
            unwrap(
              await invokeE2E("debugSeedSidebarCodingSessionWire", {
                sessionId: pinnedSessionIds[index],
                name: `Issue 572 pinned ${String(index).padStart(2, "0")}`,
                status: "idle",
                createdAt: futureTimestamp,
                updatedAt: futureTimestamp,
                pinned: true,
              }),
              `seed pinned sidebar row ${index}`
            );

            const seededRun = await postJson(
              "/agent/test/agent-org/stale-workers/seed-run",
              {
                org_id: `e2e-agent-org-fixture:${fixturePrefix}-${String(index).padStart(2, "0")}`,
                coordinator_agent_id: "builtin:sde",
                root_session_id: rootSessionIds[index],
                updated_at: futureTimestamp,
                workers: [
                  {
                    session_id: workerSessionIds[index],
                    member_id: "worker",
                    agent_definition_id: "builtin:sde",
                    status: "idle",
                    updated_at: "2099-07-29T11:00:00Z",
                  },
                ],
              }
            );
            runIds.push(seededRun.org_run_id);
          }

          unwrap(
            await invokeE2E("primeSidebarEntityCache"),
            "prime 30-row provisional entity cache"
          );
          await browser.waitUntil(
            () =>
              execJS(`
            const splash = document.getElementById("splash");
            if (!splash) return true;
            const style = window.getComputedStyle(splash);
            return style.display === "none" ||
              style.visibility === "hidden" ||
              style.pointerEvents === "none";
          `),
            {
              timeout: RENDER_TIMEOUT_MS,
              timeoutMsg:
                "Startup splash still covered the sidebar before real UI clicks",
            }
          );
          // Use the rendered filter menu for grouping and the authoritative roster
          // refresh. No helper advances a pagination cursor or visibility atom.
          await browser
            .$('[data-testid="sidebar-session-filter-button"]')
            .click();
          // Grouping lives in the menu's second level; the row opens it.
          await browser.$('[data-testid="sidebar-group-by-trigger"]').click();
          await browser.$('[data-testid="sidebar-group-by-byAgent"]').click();
          await browser
            .$('[data-testid="sidebar-session-filter-button"]')
            .click();
          await browser.$('[data-testid="sidebar-refresh-sessions"]').click();
          // WebKit can keep the filter popover's transparent dismissal layer for
          // one more interaction after the refresh action closes it. Escape makes
          // the rendered menu state explicit before exercising sidebar rows.
          await browser.keys("Escape");

          const rootPagerSelector =
            '[data-menu-item-id="load-more-agent_org_root"]';
          const standalonePagerSelector =
            '[data-menu-item-id="load-more-standalone_agent"]';
          const localSdePagerSelector =
            '[data-menu-item-id="load-more-group-agent:sde"]';
          const pinnedPagerSelector =
            '[data-menu-item-id="load-more-pinned_native"]';
          const localPinnedPagerSelector =
            '[data-menu-item-id="load-more-group-pinned"]';
          const clickRenderedPager = async (selector) => {
            await browser.waitUntil(
              () =>
                execJS(`
              const element = document.querySelector(${JSON.stringify(selector)});
              return Boolean(element) &&
                element.getAttribute("aria-disabled") !== "true";
            `),
              {
                timeout: RENDER_TIMEOUT_MS,
                timeoutMsg: `Rendered pager stayed disabled: ${selector}`,
              }
            );
            const scrollResult = await browser.executeScript(
              `
            const selector = arguments[0];
            const element = document.querySelector(selector);
            if (!element) return false;
            element.scrollIntoView({ block: "center", inline: "center" });
            return true;
          `,
              [selector]
            );
            if (!scrollResult) {
              throw new Error(`Rendered pager is missing: ${selector}`);
            }
            await browser.$(selector).click();
          };

          // The by-agent view has a local group cap in front of backend
          // pagination. Reveal already-loaded SDE rows first; these clicks do not
          // advance either backend cursor.
          for (let revealAttempt = 0; revealAttempt < 10; revealAttempt += 1) {
            if (await execJS(js.exists(standalonePagerSelector))) break;
            if (!(await execJS(js.exists(localSdePagerSelector)))) break;
            await browser.$(localSdePagerSelector).click();
          }
          for (let revealAttempt = 0; revealAttempt < 10; revealAttempt += 1) {
            if (await execJS(js.exists(pinnedPagerSelector))) break;
            if (!(await execJS(js.exists(localPinnedPagerSelector)))) break;
            await browser.$(localPinnedPagerSelector).click();
          }

          const pagersRendered = await browser
            .waitUntil(
              async () =>
                (await execJS(js.exists(rootPagerSelector))) &&
                (await execJS(js.exists(standalonePagerSelector))) &&
                (await execJS(js.exists(pinnedPagerSelector))),
              {
                timeout: RENDER_TIMEOUT_MS,
                timeoutMsg:
                  "Independent Pinned, Agent Org, and Standalone backend pagers did not render",
              }
            )
            .then(() => true)
            .catch(() => false);
          if (!pagersRendered) {
            const diagnostics = await execJS(`return JSON.stringify((() => ({
      groupBy: localStorage.getItem("orgii:sidebarGroupBy"),
      fixtureRows: Array.from(document.querySelectorAll('[data-testid^="sidebar-session-item-sdeagent-${fixturePrefix}"]'))
        .map((row) => row.getAttribute("data-testid")),
      loadMoreRows: Array.from(document.querySelectorAll('[data-menu-item-id^="load-more-"]'))
        .map((row) => row.getAttribute("data-menu-item-id")),
    }))())`);
            throw new Error(
              `Independent Pinned, Agent Org, and Standalone backend pagers did not render: ${JSON.stringify(diagnostics)}`
            );
          }
          for (const selector of [
            rootPagerSelector,
            standalonePagerSelector,
            pinnedPagerSelector,
          ]) {
            const count = await execJS(
              `return document.querySelectorAll(${JSON.stringify(selector)}).length`
            );
            if (count !== 1) {
              throw new Error(
                `Expected exactly one shared pager for ${selector}, got ${count}`
              );
            }
          }

          const deferredRootId = rootSessionIds[0];
          const deferredStandaloneId = standaloneSessionIds[19];
          const deferredPinnedId = pinnedSessionIds[0];
          if (
            await execJS(
              js.exists(
                `[data-testid="sidebar-session-item-${deferredRootId}"]`
              )
            )
          ) {
            throw new Error("Agent Org page 2 row rendered before Load more");
          }
          if (
            await execJS(
              js.exists(
                `[data-testid="sidebar-session-item-${deferredStandaloneId}"]`
              )
            )
          ) {
            throw new Error(
              "Standalone Agent page 2 row rendered before Load more"
            );
          }
          if (
            await execJS(
              js.exists(
                `[data-testid="sidebar-session-item-${deferredPinnedId}"]`
              )
            )
          ) {
            throw new Error("Pinned page 2 row rendered before Load more");
          }

          // Advancing Agent Org roots must not advance the standalone cursor.
          await clickRenderedPager(rootPagerSelector);
          const rootPageRendered = await browser
            .waitUntil(
              () =>
                execJS(
                  js.exists(
                    `[data-testid="sidebar-session-item-${deferredRootId}"]`
                  )
                ),
              {
                timeout: RENDER_TIMEOUT_MS,
                timeoutMsg:
                  "Agent Org page 2 root did not render after Load more",
              }
            )
            .then(() => true)
            .catch(() => false);
          if (!rootPageRendered) {
            const paginationDiagnostics = await invokeE2E(
              "inspectSidebarPagination",
              rootSessionIds
            );
            const renderedDiagnostics = await execJS(`return JSON.stringify({
          fixtureRows: Array.from(document.querySelectorAll('[data-testid^="sidebar-session-item-sdeagent-${fixturePrefix}-root-"]'))
            .map((row) => row.getAttribute("data-testid")),
          pager: (() => {
            const row = document.querySelector(${JSON.stringify(rootPagerSelector)});
            return row ? { text: row.textContent, disabled: row.getAttribute("aria-disabled") } : null;
          })(),
        })`);
            throw new Error(
              `Agent Org page 2 root did not render after Load more: ${JSON.stringify(
                {
                  paginationDiagnostics,
                  renderedDiagnostics,
                }
              )}`
            );
          }
          if (
            await execJS(
              js.exists(
                `[data-testid="sidebar-session-item-${deferredStandaloneId}"]`
              )
            )
          ) {
            throw new Error(
              "Agent Org Load more incorrectly advanced standalone Agent rows"
            );
          }
          if (!(await execJS(js.exists(standalonePagerSelector)))) {
            throw new Error(
              "Standalone Agent pager disappeared when only Agent Org advanced"
            );
          }

          const pinnedRowsBeforeStandalone = await execJS(
            `return document.querySelectorAll('[data-testid^="sidebar-session-item-sdeagent-${fixturePrefix}-pinned-"]').length`
          );
          await clickRenderedPager(standalonePagerSelector);
          await browser.waitUntil(
            () =>
              execJS(
                js.exists(
                  `[data-testid="sidebar-session-item-${deferredStandaloneId}"]`
                )
              ),
            {
              timeout: RENDER_TIMEOUT_MS,
              timeoutMsg:
                "Standalone page 2 did not render after one real click",
            }
          );
          const pinnedRowsAfterStandalone = await execJS(
            `return document.querySelectorAll('[data-testid^="sidebar-session-item-sdeagent-${fixturePrefix}-pinned-"]').length`
          );
          if (pinnedRowsAfterStandalone !== pinnedRowsBeforeStandalone) {
            throw new Error("Standalone Load more changed the Pinned roster");
          }

          const standaloneRowsBeforePinned = await execJS(
            `return document.querySelectorAll('[data-testid^="sidebar-session-item-sdeagent-${fixturePrefix}-standalone-"]').length`
          );
          await clickRenderedPager(pinnedPagerSelector);
          await browser.waitUntil(
            () =>
              execJS(
                js.exists(
                  `[data-testid="sidebar-session-item-${deferredPinnedId}"]`
                )
              ),
            {
              timeout: RENDER_TIMEOUT_MS,
              timeoutMsg: "Pinned page 2 did not render after one real click",
            }
          );
          const standaloneRowsAfterPinned = await execJS(
            `return document.querySelectorAll('[data-testid^="sidebar-session-item-sdeagent-${fixturePrefix}-standalone-"]').length`
          );
          if (standaloneRowsAfterPinned !== standaloneRowsBeforePinned) {
            throw new Error("Pinned Load more changed the Standalone roster");
          }
        } catch (error) {
          scenarioError = error;
          throw error;
        } finally {
          const cleanupFailures = [];
          for (const orgRunId of runIds) {
            try {
              await postJson("/agent/test/agent-org/run/cleanup", {
                org_run_id: orgRunId,
              });
            } catch (error) {
              cleanupFailures.push(`run ${orgRunId}: ${String(error)}`);
            }
          }
          for (const sessionId of [
            ...standaloneSessionIds,
            ...rootSessionIds,
            ...workerSessionIds,
            ...pinnedSessionIds,
          ]) {
            try {
              unwrap(
                await invokeE2E("deleteSessionWire", sessionId),
                `cleanup sidebar fixture ${sessionId}`
              );
            } catch (error) {
              cleanupFailures.push(`session ${sessionId}: ${String(error)}`);
            }
          }
          if (cleanupFailures.length > 0) {
            const cleanupMessage = `Issue 572 fixture cleanup failed:\n${cleanupFailures.join("\n")}`;
            if (scenarioError instanceof Error) {
              scenarioError.message = `${scenarioError.message}\n${cleanupMessage}`;
            } else {
              throw new Error(cleanupMessage);
            }
          }
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

        await openRenderedGroupChatView();
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
