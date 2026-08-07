/* global browser, describe, before, after, it, process, console */
/* eslint-disable no-console */
import { execFileSync } from "node:child_process";

/**
 * cloud-org-ui.spec.mjs — rendered UI E2E for the MANAGED ORG2 Cloud org
 * surfaces (cloud-parity Phase D, run BEFORE the self-hosted track is
 * deleted in Phase E).
 *
 * Coverage model (one app instance, two backend modes):
 * - OFFLINE (default, no env): the cloud endpoint override points at an
 *   .invalid host (nothing can reach the official backend); every surface
 *   reachable WITHOUT a live backend is exercised through the production
 *   click path — CLOUD create/join form cards + signed-out gates, the
 *   join-invite dialog, cloud org scope + panel shell, the sidebar "Team
 *   sessions" section, the per-session sync-level dialog, and the cloud
 *   share dialog. Backend-dependent assertions SKIP with a visible reason.
 * - LIVE (E2E_CLOUD_* set in tests/e2e/.env): the SAME flows run against a
 *   real throwaway org2_cloud Supabase project — a real JWT is minted via
 *   the cloud harness's password-user trick and pre-seeded into the auth
 *   store, `list_my_orgs` / entitlement / member fetches are real, and the
 *   CLOUD create form performs a real `create_org` round-trip.
 *
 * HONESTY GATES (anti-false-prosperity, same regime as collab-org-ui):
 * - Missing E2E_CLOUD_* env, a schema_version mismatch, or a failed user
 *   provision SKIPS the live scenarios with an explicit reason — the
 *   offline scenarios still run and must PASS.
 * - `__e2e.cloud*` helpers only seed store state that has no
 *   WebDriver-reachable entry (persisted auth atom, in-memory orgs atom,
 *   deep-link pending invite, the native-context-menu-only sync-level
 *   dialog); every assertion is on the rendered production DOM.
 *
 * Requires for LIVE (tests/e2e/.env):
 *   E2E_CLOUD_SUPABASE_URL, E2E_CLOUD_ANON_KEY — throwaway Supabase project
 *   provisioned with the ORGII-cloud-infra migrations (schema_version must
 *   match the app's ORG2_CLOUD_EXPECTED_SCHEMA_VERSION — consolidated
 *   baseline v1, comment + task RPCs included, so the comment scenarios
 *   H–L have their RPCs when live).
 *   Plus ONE of:
 *   E2E_CLOUD_SERVICE_KEY                       — mint + clean up a user
 *   E2E_CLOUD_EMAIL + E2E_CLOUD_PASSWORD        — pre-provisioned user
 *
 * COMMENT AGENT SCENARIOS (H–L, in-place rework 2026-07-11): the comment
 * plane runs LIVE-only (comments/tasks are real RPCs against a session
 * row seeded server-side — see publishCloudSessionMetadata in the
 * driver). Follow-ups run IN PLACE on the owning session — there is no
 * fork runner, no task card, no Run-here dialog:
 *   - H posts an `@agent ` comment through the production composer and
 *     asserts the open pickup task server-side plus the turn-chrome robot
 *     badge; the task STAYS open/unclaimed because the per-org owner
 *     auto-run opt-in (`autoRunEnabled`) defaults OFF.
 *   - I asserts the sidebar open-tasks chip.
 *   - J drives the tri-state thread status (Active / Resolved / Won't fix)
 *     through the head-row control.
 *   - K posts a session-level note, opens the slash "Address comments"
 *     flyout, verifies explicit session/round groups, and asserts the
 *     confirmed mixed-scope selection lands as a composer pill.
 *   - L runs the actual in-place agent round and asserts the
 *     "Agent @<name>"-attributed reply. Set E2E_CLOUD_LIVE=1 with a
 *     dedicated OAuth-live E2E home; H then creates a real provider-backed
 *     session and H–L share that durable session end to end.
 *
 * Invocation (NOT part of the vitest run; needs the webdriver app build,
 * i.e. src-tauri/target/debug binary consumed by wdio.conf.mjs):
 *   cd tests/e2e && npm test -- --spec specs/core/cloud-org-ui.spec.mjs
 */
import {
  CLOUD_CREATE_ORG_TIMEOUT_MS,
  CLOUD_FETCH_TIMEOUT_MS,
  E2E_REPO_PATH,
  OFFLINE_CLOUD_ENDPOINT,
  RENDER_TIMEOUT_MS,
  RUN_ID,
  applyCloudEndpointOverride,
  chatComposerText,
  cleanupCloudUser,
  clearChatComposer,
  clearCloudEndpointOverride,
  clickRendered,
  cloudEnv,
  confirmAddressCommentsFlyout,
  ensureCloudSchemaReady,
  execJS,
  hasAddressCommentsPill,
  invokeE2E,
  listCloudCommentTasks,
  offlineCloudUser,
  openAddressCommentsFlyout,
  openCloudOrgPanelFromSidebar,
  openCreateOrgFormFromSidebar,
  openTurnCommentPanel,
  postSessionNote,
  postTurnComment,
  pressEscape,
  provisionCloudUser,
  publishCloudSessionMetadata,
  seedAndOpenCloudEligibleSession,
  seedCloudOrgUntilListed,
  selectCloudOrgScopeFromSidebar,
  selectPersonalScopeFromSidebar,
  setCloudSessionModeViaDialog,
  setThreadStatus,
  typeRendered,
  unwrap,
  waitForAgentTurnBadge,
  waitForApp,
  waitForGone,
  waitForRealCloudOrgs,
  waitForRendered,
  waitForSessionTasksBadge,
} from "../../support/core/cloudOrgUiDriver.mjs";
import {
  configureScenario,
  filteredConfigs,
  inspectChatState,
  listAccounts,
  rustAgentConfigs,
  scenarioConfigs,
  typeAndClickSend,
  waitForChatLaunched,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const OFFLINE_ORG_ID = `e2e-cloud-org-${RUN_ID}`;
const OFFLINE_ORG_NAME = `E2E Cloud Org ${RUN_ID}`;
const SIGNED_OUT_ALIAS_LOCAL_ID = `e2e-cloud-alias-local-${RUN_ID}`;
const SIGNED_OUT_ALIAS_EXTERNAL_ID = `e2e-cloud-alias-remote-${RUN_ID}`;
const SIGNED_OUT_ALIAS_NAME = `Signed-out cloud workspace ${RUN_ID}`;
const LIVE_CREATED_ORG_NAME = `E2E Cloud Created ${RUN_ID}`;
const SYNC_LEVEL_SESSION_ID = `e2e-cloud-sync-${RUN_ID}`;
const SHARE_SESSION_ID = `e2e-cloud-share-${RUN_ID}`;
const TASK_SESSION_ID = `e2e-cloud-task-${RUN_ID}`;
const TASK_TEAM_SESSION_ID = `e2e-cloud-team-task-${RUN_ID}`;
const TASK_SESSION_TITLE = `E2E cloud task ${RUN_ID}`;
const TASK_COMMENT_BODY = `@agent E2E agent task ${RUN_ID}: tighten the error handling in this turn`;
const SESSION_NOTE_BODY = `E2E session-level note ${RUN_ID}: verify the overall outcome`;
const TASK_TURN_ANCHOR_ID = `user-${TASK_SESSION_ID}`;
const TASK_AGENT_BOOTSTRAP_PROMPT = `Reply exactly CLOUD_AGENT_READY_${RUN_ID} and do not call tools.`;
const LIVE_AGENT_ROUND = process.env.E2E_CLOUD_LIVE === "1";
const E2E_REPO_SCOPE_KEY =
  process.env.E2E_REPO_SCOPE_KEY ?? "github.com/orgii/e2e-workspace";

async function selectCloudOrgManagementTab(tab, label) {
  await clickRendered(
    `[data-testid="cloud-org-tab-${tab}"]`,
    `${label} management tab`
  );
}

// Removed with the fork runner: the Run-here dialog scenario and the
// E2E_CLOUD_RUN claim→release leg (tasks now run in place on the owner's
// machine; there is no teammate-machine fork pickup to drive).
describe("Cloud org rendered UI (managed ORG2 Cloud)", function () {
  /** Non-null only when the LIVE gates all passed. */
  let env = null;
  let liveUser = null;
  let live = false;
  /** Org the scope/panel/dialog scenarios run under (live: personal org). */
  let orgId = null;
  /** Set by scenario H once the agent task exists (gates I–L). */
  let taskAssigned = false;
  /** H–L use seeded ids normally and the real durable ids in OAuth-live mode. */
  let taskSessionId = TASK_SESSION_ID;
  let taskTurnAnchorId = TASK_TURN_ANCHOR_ID;
  let taskSessionTitle = TASK_SESSION_TITLE;
  /** Preserve the user's clipboard around the explicit system-copy proof. */
  let originalSystemClipboard = null;

  before(async function () {
    this.timeout(120_000);
    await waitForApp();
    try {
      originalSystemClipboard = execFileSync("pbpaste", { encoding: "utf8" });
    } catch {
      originalSystemClipboard = null;
    }
    // Baseline reset: webview localStorage persists across runs, so a
    // previous run's (or the user's own) cloud sign-in and endpoint override
    // must never leak into this suite's signed-out assertions.
    unwrap(await invokeE2E("cloudClearAuthState"), "cloudClearAuthState");

    env = cloudEnv();
    if (!env) {
      console.warn(
        "[cloud-e2e] OFFLINE mode: E2E_CLOUD_SUPABASE_URL / E2E_CLOUD_ANON_KEY not set in tests/e2e/.env — backend-dependent scenarios will SKIP (provisioning gap, not a product failure)."
      );
    } else {
      const readiness = await ensureCloudSchemaReady(env);
      if (!readiness.ready) {
        console.warn(
          `[cloud-e2e] OFFLINE mode (live gates failed): ${readiness.reason}. Skipping live scenarios instead of green-washing — NOT a pass for the live path.`
        );
        env = null;
      } else {
        const provisioned = await provisionCloudUser(env);
        if (!provisioned.ok) {
          console.warn(
            `[cloud-e2e] OFFLINE mode (live gates failed): ${provisioned.reason}.`
          );
          env = null;
        } else {
          liveUser = provisioned.user;
          console.log(
            `[cloud-e2e] LIVE mode: schemaVersion=${readiness.schemaVersion}, user=${liveUser.email}.`
          );
        }
      }
    }
    live = Boolean(env && liveUser);

    // Point EVERY cloud client at the suite's backend through the Phase C
    // endpoint override (resolved per call — no reload needed). Offline uses
    // an .invalid host so no request can reach the official managed project.
    await applyCloudEndpointOverride(
      live
        ? {
            webOrigin: env.webOrigin,
            supabaseUrl: env.supabaseUrl,
            anonKey: env.anonKey,
          }
        : OFFLINE_CLOUD_ENDPOINT
    );
  });

  after(async function () {
    this.timeout(60_000);
    // Hygiene only — never a test failure.
    try {
      await invokeE2E("cloudCloseSyncLevelDialog");
      await pressEscape();
      await invokeE2E("cloudClearAuthState");
      await clearCloudEndpointOverride();
    } catch {
      // App window may already be gone at teardown.
    }
    if (live) await cleanupCloudUser(env, liveUser);
    if (originalSystemClipboard !== null) {
      try {
        execFileSync("pbcopy", { input: originalSystemClipboard });
      } catch {
        // Clipboard restoration is hygiene, never a product failure.
      }
    }
  });

  it("A0. hides a stale cloud workspace alias from the signed-out org selector", async function () {
    this.timeout(60_000);
    const auth = unwrap(
      await invokeE2E("cloudReadAuthState"),
      "cloudReadAuthState(signed-out alias)"
    );
    if (auth.signedIn) {
      throw new Error(
        `signed-out alias precondition failed: ${JSON.stringify(auth)}`
      );
    }

    // Setup only: reproduce the durable Project-org backing row left by a
    // previous cloud sign-in. The behavior under test below is the real user
    // click on the production selector and its rendered option list.
    const alias = unwrap(
      await invokeE2E("cloudSeedProjectOrgAlias", {
        localOrgId: SIGNED_OUT_ALIAS_LOCAL_ID,
        externalOrgId: SIGNED_OUT_ALIAS_EXTERNAL_ID,
        name: SIGNED_OUT_ALIAS_NAME,
      }),
      "cloudSeedProjectOrgAlias"
    );
    if (alias.externalOrgId !== SIGNED_OUT_ALIAS_EXTERNAL_ID) {
      throw new Error(
        `cloud alias setup did not persist: ${JSON.stringify(alias)}`
      );
    }

    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation before signed-out selector"
    );
    await clickRendered(
      '[data-testid="sidebar-org-selector"]',
      "signed-out sidebar org selector"
    );
    await waitForRendered(
      '[data-testid="sidebar-personal-org-option"]',
      "signed-out Personal org option"
    );
    await waitForRendered(
      '[data-testid="sidebar-add-org"]',
      "signed-out Add ORG action"
    );

    const rendered = await execJS(`
      const overlay = document.querySelector('.select-options-overlay');
      return {
        optionText: overlay?.textContent ?? '',
        aliasVisible: (overlay?.textContent ?? '').includes(${JSON.stringify(SIGNED_OUT_ALIAS_NAME)}),
      };
    `);
    if (rendered.aliasVisible) {
      throw new Error(
        `signed-out selector leaked cloud alias: ${JSON.stringify(rendered)}`
      );
    }
    await pressEscape();
  });

  it("A. renders the CLOUD source card with its signed-out gates", async function () {
    this.timeout(120_000);
    await openCreateOrgFormFromSidebar();
    await clickRendered(
      '[data-testid="create-collab-org-source-cloud"]',
      "cloud source card"
    );
    // Signed out (baseline reset in before): the sign-in hint must render —
    // the classic silent-disabled-button trap this hint exists to prevent.
    await waitForRendered(
      '[data-testid="create-cloud-org-sign-in-hint"]',
      "cloud sign-in hint"
    );
    await clickRendered(
      '[data-testid="create-collab-org-mode-create"]',
      "create mode card"
    );
    await typeRendered(
      '[data-testid="create-collab-org-name"]',
      OFFLINE_ORG_NAME,
      "org name"
    );
    // With the name filled, the ONLY remaining create gate is the missing
    // cloud account — submit must stay disabled (canSubmit's auth gate).
    const submitState = await execJS(`
      const button = document.querySelector('[data-testid="create-collab-org-submit"]');
      return button ? { disabled: button.disabled } : null;
    `);
    if (!submitState || submitState.disabled !== true) {
      throw new Error(
        `signed-out cloud create submit should be disabled: ${JSON.stringify(submitState)}`
      );
    }
    // Cloud identity comes from the account — the Supabase coordinate and
    // join-as fields of the self-hosted flavor must NOT render.
    const strayFields = await execJS(`
      return {
        supabaseUrl: !!document.querySelector('[data-testid="create-collab-org-supabase-url"]'),
        anonKey: !!document.querySelector('[data-testid="create-collab-org-anon-key"]'),
        displayName: !!document.querySelector('[data-testid="create-collab-org-display-name"]'),
      };
    `);
    if (
      strayFields.supabaseUrl ||
      strayFields.anonKey ||
      strayFields.displayName
    ) {
      throw new Error(
        `cloud source rendered self-hosted-only fields: ${JSON.stringify(strayFields)}`
      );
    }
    // Join flavor: the invite input replaces the org name.
    await clickRendered(
      '[data-testid="create-collab-org-mode-join"]',
      "join mode card"
    );
    await waitForRendered(
      '[data-testid="create-collab-org-invite"]',
      "cloud join invite input"
    );
  });

  it("B. opens the join dialog from a parsed cloud invite deep link (signed-out CTA)", async function () {
    this.timeout(60_000);
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation before join dialog"
    );
    // The helper runs the PRODUCTION orgii://cloud/join parser — a malformed
    // link fails here exactly like the deep-link handler would reject it.
    unwrap(
      await invokeE2E("cloudSeedPendingInvite", {
        link: `orgii://cloud/join?invite=e2e-cloud-invite-${RUN_ID}`,
      }),
      "cloudSeedPendingInvite"
    );
    await waitForRendered(
      '[data-testid="cloud-join-org-dialog"]',
      "cloud join dialog"
    );
    // Signed out: sign-in CTA instead of the confirm button.
    const buttons = await execJS(`
      return {
        signIn: !!document.querySelector('[data-testid="cloud-join-org-sign-in"]'),
        confirm: !!document.querySelector('[data-testid="cloud-join-org-confirm"]'),
      };
    `);
    if (!buttons.signIn || buttons.confirm) {
      throw new Error(
        `signed-out join dialog should offer sign-in only: ${JSON.stringify(buttons)}`
      );
    }
    await pressEscape();
    await waitForGone(
      '[data-testid="cloud-join-org-dialog"]',
      "cloud join dialog (one-shot consume)"
    );
  });

  it("C. signs in via pre-seeded JWT and renders the cloud org scope + management panel", async function () {
    this.timeout(180_000);
    if (live) {
      await invokeE2E("cloudSeedAuthState", {
        supabaseUrl: env.supabaseUrl,
        anonKey: env.anonKey,
        userId: liveUser.userId,
        accessToken: liveUser.accessToken,
        refreshToken: liveUser.refreshToken,
        expiresAt: liveUser.expiresAt,
      });
      // Real `list_my_orgs`: the 0008 signup trigger auto-provisions a
      // personal org, so the fresh throwaway user always lands one.
      const orgs = await waitForRealCloudOrgs();
      orgId = orgs[0].orgId;
    } else {
      const user = offlineCloudUser();
      await invokeE2E("cloudSeedAuthState", {
        supabaseUrl: OFFLINE_CLOUD_ENDPOINT.supabaseUrl,
        anonKey: OFFLINE_CLOUD_ENDPOINT.anonKey,
        userId: user.userId,
        accessToken: user.accessToken,
        refreshToken: user.refreshToken,
        expiresAt: user.expiresAt,
        displayName: user.displayName,
      });
      orgId = OFFLINE_ORG_ID;
      await seedCloudOrgUntilListed({
        orgId,
        name: OFFLINE_ORG_NAME,
        role: "owner",
      });
    }

    await openCloudOrgPanelFromSidebar(
      orgId,
      live ? null : { orgId, name: OFFLINE_ORG_NAME, role: "owner" }
    );

    if (!live) {
      console.warn(
        "[cloud-e2e] SKIP panel ready-state sections (plan, invites, members, repo scopes): no live backend — the panel shell + error state is the offline-reachable surface."
      );
      return;
    }
    // Ready state against the REAL backend: entitlement + members landed.
    await waitForRendered(
      '[data-testid="cloud-org-plan-section"]',
      "plan section",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForRendered(
      '[data-testid="cloud-org-default-access"]',
      "default sync level section"
    );
    await selectCloudOrgManagementTab("members", "members");
    await waitForRendered(
      '[data-testid="cloud-org-member-row"]',
      "members section (self row)"
    );
    // Owner of the personal org ⇒ admin invite surface renders.
    await waitForRendered(
      '[data-testid="cloud-org-invites"]',
      "invites card (admin)"
    );
    await selectCloudOrgManagementTab("repo-scope", "repo scopes");
    await waitForRendered(
      '[data-testid="cloud-org-repo-scope"]',
      "repo scopes section"
    );
    await selectCloudOrgManagementTab("general", "general");
    await waitForRendered(
      '[data-testid="cloud-org-settings"]',
      "org settings section (admin)"
    );
  });

  it("D. renders the sidebar Team sessions section under the cloud scope", async function () {
    this.timeout(60_000);
    if (!orgId) throw new Error("scenario C did not establish a cloud org");
    await selectCloudOrgScopeFromSidebar(
      orgId,
      live ? null : { orgId, name: OFFLINE_ORG_NAME, role: "owner" }
    );
    // Empty/loading/error states all funnel into this stable row — offline
    // renders the load-error label, live renders the empty label; both prove
    // the section mounted for the cloud scope.
    await waitForRendered(
      '[data-testid="cloud-team-sessions-empty"]',
      "cloud team-sessions section state row"
    );

    // Deterministic viewer-specific projection: one ordinary org row and one
    // row the server says is directly granted to this viewer. This exercises
    // the rendered production dropdown + pre-thread filter without claiming
    // a live two-user backend round-trip in OFFLINE mode.
    unwrap(
      await invokeE2E("cloudSeedRemoteSessions", {
        orgId,
        sessions: [
          {
            id: `${orgId}:e2e-owner-a:e2e-team-all-${RUN_ID}`,
            orgId,
            ownerMemberId: "e2e-owner-a",
            ownerUserId: "e2e-owner-a",
            ownerDisplayName: "Teammate A",
            ownerIdentityKind: "human",
            sourceSessionId: `e2e-team-all-${RUN_ID}`,
            title: `Visible to org ${RUN_ID}`,
            repoScopeKey: E2E_REPO_SCOPE_KEY,
            directlySharedWithMe: false,
            eventsEpoch: 1,
            eventsFrozenSeq: 0,
            eventsCount: 1,
            eventsTailHash: "all",
          },
          {
            id: `${orgId}:e2e-owner-b:e2e-team-direct-${RUN_ID}`,
            orgId,
            ownerMemberId: "e2e-owner-b",
            ownerUserId: "e2e-owner-b",
            ownerDisplayName: "Teammate B",
            ownerIdentityKind: "human",
            sourceSessionId: `e2e-team-direct-${RUN_ID}`,
            title: `Shared directly ${RUN_ID}`,
            repoScopeKey: E2E_REPO_SCOPE_KEY,
            directlySharedWithMe: true,
            eventsEpoch: 1,
            eventsFrozenSeq: 0,
            eventsCount: 1,
            eventsTailHash: "direct",
          },
        ],
      }),
      "cloudSeedRemoteSessions"
    );
    const ordinaryRowSelector = `[data-testid="sidebar-cloud-session-item-e2e-team-all-${RUN_ID}"]`;
    const directRowSelector = `[data-testid="sidebar-cloud-session-item-e2e-team-direct-${RUN_ID}"]`;
    if (!live) {
      // The deliberately unreachable backend may finish a late list_my_orgs
      // retry after the scope was selected and replace the roster with [].
      // Keep the E2E-only roster fixture alive until BOTH production rows
      // render; selectedOrgId remains cloud:<id>, so restoring the roster
      // reactivates the same scope without bypassing the rendered filter UI.
      await browser.waitUntil(
        async () => {
          unwrap(
            await invokeE2E("cloudSeedOrgs", {
              orgs: [{ orgId, name: OFFLINE_ORG_NAME, role: "owner" }],
            }),
            "cloudSeedOrgs(remote-session rows)"
          );
          return Boolean(
            await execJS(`
              return !!document.querySelector(${JSON.stringify(ordinaryRowSelector)}) &&
                !!document.querySelector(${JSON.stringify(directRowSelector)});
            `)
          );
        },
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 250,
          timeoutMsg:
            "seeded ordinary/direct cloud session rows never rendered together",
        }
      );
    } else {
      await waitForRendered(
        ordinaryRowSelector,
        "ordinary org-visible cloud session row"
      );
      await waitForRendered(
        directRowSelector,
        "directly shared cloud session row"
      );
    }
    await clickRendered(
      '[data-testid="cloud-team-sessions-filter"]',
      "Team sessions filter button"
    );
    await clickRendered(
      '[data-testid="sidebar-cloud-filter-directly-shared-with-me"]',
      "Shared directly with me filter"
    );
    await waitForGone(
      `[data-testid="sidebar-cloud-session-item-e2e-team-all-${RUN_ID}"]`,
      "ordinary row after directed filter"
    );
    await waitForRendered(
      `[data-testid="sidebar-cloud-session-item-e2e-team-direct-${RUN_ID}"]`,
      "direct row after directed filter"
    );
    await clickRendered(
      '[data-testid="cloud-team-sessions-filter"]',
      "Team sessions filter button reset"
    );
    await clickRendered(
      '[data-testid="sidebar-cloud-filter-everyone"]',
      "Everyone filter reset"
    );
    await waitForRendered(
      `[data-testid="sidebar-cloud-session-item-e2e-team-all-${RUN_ID}"]`,
      "ordinary row after Everyone filter reset"
    );

    // `cloudSeedRemoteSessions` is an in-memory projection fixture. Restore
    // the real server snapshot through the rendered refresh action before
    // later LIVE scenarios publish rows into this org; otherwise the 60s
    // production cache would make those scenarios inherit synthetic rows.
    await clickRendered(
      '[data-testid="cloud-team-sessions-refresh"]',
      "Team sessions refresh after projection fixture"
    );
    if (live) {
      await waitForGone(
        `[data-testid="sidebar-cloud-session-item-e2e-team-all-${RUN_ID}"]`,
        "synthetic ordinary row after server refresh",
        CLOUD_FETCH_TIMEOUT_MS
      );
      await waitForGone(
        `[data-testid="sidebar-cloud-session-item-e2e-team-direct-${RUN_ID}"]`,
        "synthetic direct row after server refresh",
        CLOUD_FETCH_TIMEOUT_MS
      );
    }
  });

  it("E. opens the per-session cloud sync-level dialog", async function () {
    this.timeout(60_000);
    if (!orgId) throw new Error("scenario C did not establish a cloud org");
    if (!live) {
      unwrap(
        await invokeE2E("cloudSeedOrgs", {
          orgs: [{ orgId, name: OFFLINE_ORG_NAME, role: "owner" }],
        }),
        "cloudSeedOrgs(sync-level dialog)"
      );
    }
    unwrap(
      await invokeE2E("seedSidebarSession", {
        sessionId: SYNC_LEVEL_SESSION_ID,
        name: `E2E cloud sync level ${RUN_ID}`,
        repoPath: E2E_REPO_PATH,
      }),
      "seedSidebarSession(sync level)"
    );
    // The dialog's only production entry is a NATIVE Tauri context-menu item
    // (not WebDriver-reachable) — the bridge sets the same open-state atom
    // that menu action sets; everything asserted below is the real rendered
    // dialog.
    unwrap(
      await invokeE2E("cloudOpenSyncLevelDialog", {
        sessionId: SYNC_LEVEL_SESSION_ID,
      }),
      "cloudOpenSyncLevelDialog"
    );
    await waitForRendered(
      `[data-testid="session-sync-level-org-${orgId}"]`,
      "sync level org row"
    );
    const selects = await execJS(`
      return {
        mode: !!document.querySelector('[data-testid="session-sync-level-mode-${orgId}"]'),
        visibility: !!document.querySelector('[data-testid="session-sync-level-visibility-${orgId}"]'),
      };
    `);
    if (!selects.mode || !selects.visibility) {
      throw new Error(
        `sync level dialog missing ladder selects: ${JSON.stringify(selects)}`
      );
    }
    // Escape exercises the production close path (Modal onCancel → atom null).
    await pressEscape();
    await waitForGone(
      `[data-testid="session-sync-level-org-${orgId}"]`,
      "sync level dialog"
    );
  });

  it("E2. saves the session remote as the org repository scope through the rendered panel", async function () {
    this.timeout(180_000);
    if (!live) {
      console.warn(
        "[cloud-e2e] SKIP scenario E2: saving repository governance needs a real cloud backend."
      );
      this.skip();
    }
    if (!orgId) throw new Error("scenario C did not establish a cloud org");

    unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "ensureRepoSelected(repository governance)"
    );
    await openCloudOrgPanelFromSidebar(orgId);
    await selectCloudOrgManagementTab("repo-scope", "repository scope");
    await waitForRendered(
      '[data-testid="cloud-org-repo-scope"]',
      "repository-scope management section",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await browser.waitUntil(
      async () =>
        execJS(`
          const expected = ${JSON.stringify(E2E_REPO_SCOPE_KEY)};
          const labels = [...document.querySelectorAll('[data-testid="cloud-org-repo-scope"] button span[title]')];
          const label = labels.find((candidate) => candidate.getAttribute('title') === expected);
          return !!label?.closest('button') && !label.closest('button').disabled;
        `),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `rendered repo picker did not expose enabled scope ${E2E_REPO_SCOPE_KEY}`,
      }
    );
    await execJS(`
      const expected = ${JSON.stringify(E2E_REPO_SCOPE_KEY)};
      const labels = [...document.querySelectorAll('[data-testid="cloud-org-repo-scope"] button span[title]')];
      labels.find((candidate) => candidate.getAttribute('title') === expected)?.closest('button')?.click();
      return true;
    `);
    await browser.waitUntil(
      async () =>
        execJS(`
          const button = document.querySelector('[data-testid="cloud-org-save-repo-scopes"]');
          return !!button && !button.disabled;
        `),
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: "repository-scope Save button never became enabled",
      }
    );
    await clickRendered(
      '[data-testid="cloud-org-save-repo-scopes"]',
      "save repository scopes"
    );
    await browser.waitUntil(
      async () => {
        const state = await execJS(`
          const section = document.querySelector('[data-testid="cloud-org-repo-scope"]');
          return {
            text: section?.textContent ?? '',
            saveDisabled: document.querySelector('[data-testid="cloud-org-save-repo-scopes"]')?.disabled ?? false,
          };
        `);
        return state.saveDisabled && state.text.includes(E2E_REPO_SCOPE_KEY);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `repository scope ${E2E_REPO_SCOPE_KEY} never reached the saved state`,
      }
    );
  });

  it("F. opens the cloud share dialog from the chat panel header menu", async function () {
    this.timeout(120_000);
    if (!orgId) throw new Error("scenario C did not establish a cloud org");
    if (!live) {
      unwrap(
        await invokeE2E("cloudSeedOrgs", {
          orgs: [{ orgId, name: OFFLINE_ORG_NAME, role: "owner" }],
        }),
        "cloudSeedOrgs(share dialog)"
      );
    }
    await seedAndOpenCloudEligibleSession(
      SHARE_SESSION_ID,
      `E2E cloud share ${RUN_ID}`
    );
    unwrap(
      await invokeE2E("cloudSeedRepoScopes", {
        orgId,
        repoScopes: [E2E_REPO_SCOPE_KEY],
      }),
      "cloudSeedRepoScopes"
    );
    const resolvedScope = unwrap(
      await invokeE2E("cloudResolveRepoScopeKeys", {
        repoPath: E2E_REPO_PATH,
      }),
      "cloudResolveRepoScopeKeys"
    );
    if (!resolvedScope.keys?.includes(E2E_REPO_SCOPE_KEY)) {
      throw new Error(
        `production git-remote resolver did not return ${E2E_REPO_SCOPE_KEY}: ${JSON.stringify(resolvedScope.keys)}`
      );
    }
    // Explicit tag = production MoveToOrgDialog write; makes the session
    // share-eligible for the org regardless of repo-scope resolution.
    unwrap(
      await invokeE2E("cloudTagSessionToOrg", {
        sessionId: SHARE_SESSION_ID,
        orgId,
      }),
      "cloudTagSessionToOrg"
    );
    await setCloudSessionModeViaDialog(
      SHARE_SESSION_ID,
      orgId,
      "full_replay",
      live ? null : { orgId, name: OFFLINE_ORG_NAME, role: "owner" }
    );
    if (live) {
      await publishCloudSessionMetadata(env, liveUser, {
        orgId,
        sessionId: SHARE_SESSION_ID,
        title: `E2E cloud share ${RUN_ID}`,
        repoScopeKey: E2E_REPO_SCOPE_KEY,
      });
    }
    await clickRendered(
      '[data-testid="chat-panel-header-more-button"]',
      "chat panel header more menu"
    );
    // Eligibility-gated menu entry (signed in + own pushable session +
    // tagged cloud org) — its presence IS the eligibility assertion.
    if (!live) {
      await browser.waitUntil(
        async () => {
          const shareEntryVisible = await execJS(`
            return !!document.querySelector('[data-testid="cloud-session-share-settings-button"]');
          `);
          if (shareEntryVisible) return true;
          const listed = unwrap(
            await invokeE2E("cloudListOrgs"),
            "cloudListOrgs(share menu)"
          );
          if (!listed.orgs?.some((org) => org.orgId === orgId)) {
            unwrap(
              await invokeE2E("cloudSeedOrgs", {
                orgs: [{ orgId, name: OFFLINE_ORG_NAME, role: "owner" }],
              }),
              "cloudSeedOrgs(share menu)"
            );
          }
          const menuOpen = await execJS(`
            return document
              .querySelector('[data-testid="chat-panel-header-more-button"]')
              ?.getAttribute('aria-expanded') === 'true';
          `);
          if (!menuOpen) {
            await execJS(`
              document.querySelector('[data-testid="chat-panel-header-more-button"]')?.click();
              return true;
            `);
          }
          return false;
        },
        {
          timeout: RENDER_TIMEOUT_MS,
          interval: 250,
          timeoutMsg:
            "offline cloud share menu never stabilized after roster retries",
        }
      );
    }
    await clickRendered(
      '[data-testid="cloud-session-share-settings-button"]',
      "cloud share menu entry"
    );
    await waitForRendered(
      `[data-testid="cloud-session-share-org-section-${orgId}"]`,
      "cloud share org section"
    );
    await waitForRendered(
      '[data-testid="cloud-session-share-create-link"]',
      "cloud share create-link button"
    );
    if (live) {
      await clickRendered(
        '[data-testid="cloud-session-share-create-link"]',
        "create cloud share link"
      );
      await waitForRendered(
        '[data-testid="cloud-session-share-created-link"]',
        "one-time generated share link",
        CLOUD_FETCH_TIMEOUT_MS
      );
      const createdLink = String(
        (await execJS(`
          return document.querySelector('[data-testid="cloud-session-share-created-link"]')?.textContent?.trim() ?? '';
        `)) ?? ""
      );
      if (!createdLink.startsWith("orgii://cloud/session?share=")) {
        throw new Error("created share did not render its one-time link");
      }
      await clickRendered(
        '[data-testid="cloud-session-share-copy-link"]',
        "copy cloud share link"
      );
      await browser.waitUntil(
        async () =>
          execJS(`
            const button = document.querySelector('[data-testid="cloud-session-share-copy-link"]');
            return button?.getAttribute('data-copy-state') === 'copied';
          `),
        {
          timeout: RENDER_TIMEOUT_MS,
          timeoutMsg: "share link copy action never reached copied state",
        }
      );
      const systemClipboard = execFileSync("pbpaste", { encoding: "utf8" });
      if (systemClipboard !== createdLink) {
        throw new Error(
          `system clipboard did not receive the generated link (expectedLength=${createdLink.length}, actualLength=${systemClipboard.length})`
        );
      }
      await clickRendered(
        '[data-testid="cloud-session-share-created-link-revoke"]',
        "revoke the link created by this dialog"
      );
      await waitForGone(
        '[data-testid="cloud-session-share-copy-link"]',
        "one-shot plaintext after its share is revoked"
      );
    } else {
      console.warn(
        "[cloud-e2e] SKIP live share round-trip (create/list/revoke a real share): no live backend — those RPCs are covered by the cloud integration harness."
      );
    }
    await pressEscape();
    await waitForGone(
      `[data-testid="cloud-session-share-org-section-${orgId}"]`,
      "cloud share dialog"
    );
  });

  it("F2. never offers a same-remote cloud workspace on a Personal session", async function () {
    this.timeout(120_000);
    if (!orgId) throw new Error("scenario C did not establish a cloud org");
    const personalSessionId = `e2e-cloud-personal-${RUN_ID}`;
    await seedAndOpenCloudEligibleSession(
      personalSessionId,
      `E2E Personal same-remote ${RUN_ID}`
    );
    await clickRendered(
      '[data-testid="chat-panel-header-more-button"]',
      "Personal session header more menu"
    );
    const hasCloudShare = await execJS(`
      return !!document.querySelector('[data-testid="cloud-session-share-settings-button"]');
    `);
    if (hasCloudShare) {
      throw new Error(
        "Personal session exposed a cloud-workspace share action solely because its Git remote matched"
      );
    }
    await pressEscape();

    // Even an explicitly cloud-tagged session must not surface that org's
    // roster while the sidebar is in Personal. The active scope — not stale
    // ownership history — determines where the user is sharing.
    unwrap(
      await invokeE2E("cloudTagSessionToOrg", {
        sessionId: personalSessionId,
        orgId,
      }),
      "cloudTagSessionToOrg(Personal scope gate)"
    );
    await selectPersonalScopeFromSidebar();
    await clickRendered(
      '[data-testid="chat-panel-header-more-button"]',
      "Personal tagged-session header more menu"
    );
    const taggedPersonalHasCloudShare = await execJS(`
      return !!document.querySelector('[data-testid="cloud-session-share-settings-button"]');
    `);
    if (taggedPersonalHasCloudShare) {
      throw new Error(
        "Personal scope exposed a cloud roster for an explicitly tagged session"
      );
    }
    await pressEscape();
  });

  it("G. creates a cloud org through the rendered CLOUD form (gated: real backend)", async function () {
    this.timeout(180_000);
    if (!live) {
      console.warn(
        "[cloud-e2e] SKIP scenario G: set E2E_CLOUD_* in tests/e2e/.env for the real create_org round-trip."
      );
      this.skip();
    }
    await openCreateOrgFormFromSidebar();
    await clickRendered(
      '[data-testid="create-collab-org-source-cloud"]',
      "cloud source card"
    );
    await clickRendered(
      '[data-testid="create-collab-org-mode-create"]',
      "create mode card"
    );
    await typeRendered(
      '[data-testid="create-collab-org-name"]',
      LIVE_CREATED_ORG_NAME,
      "org name"
    );
    // Signed in (scenario C) + name committed → canSubmit flips.
    await browser.waitUntil(
      async () =>
        execJS(`
          const button = document.querySelector('[data-testid="create-collab-org-submit"]');
          return !!button && !button.disabled;
        `),
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg:
          "cloud create submit never became enabled while signed in (canSubmit gate)",
      }
    );
    // A successful create navigates STRAIGHT to the org management panel
    // (no interstitial success screen) — the panel only renders after a
    // REAL create_org round-trip; there is no mocked success path.
    await clickRendered(
      '[data-testid="create-collab-org-submit"]',
      "cloud create submit"
    );
    try {
      await waitForRendered(
        '[data-testid="cloud-org-plan-section"]',
        "org panel after create",
        CLOUD_CREATE_ORG_TIMEOUT_MS
      );
    } catch (error) {
      const diagnostic = await execJS(`
        const panel = document.querySelector('[data-testid="cloud-org-panel"]');
        const form = document.querySelector('[data-testid="create-collab-org-body"]');
        return {
          pathname: location.pathname,
          panel: panel?.textContent?.trim().slice(0, 800) ?? null,
          form: form?.textContent?.trim().slice(0, 800) ?? null,
          body: document.body?.innerText?.trim().slice(0, 1200) ?? null,
        };
      `);
      const listed = unwrap(
        await invokeE2E("cloudListOrgs"),
        "cloudListOrgs(create diagnostic)"
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify(diagnostic)}; orgs=${JSON.stringify(listed.orgs)}`
      );
    }

    // Store ground truth: refetchCloudOrgs ran inside the submit handler,
    // so the created org is in org2CloudOrgsAtom — recover its id by name.
    let createdOrgId = null;
    await browser.waitUntil(
      async () => {
        const listed = unwrap(
          await invokeE2E("cloudListOrgs"),
          "cloudListOrgs(created)"
        );
        createdOrgId =
          (listed.orgs ?? []).find((row) => row?.name === LIVE_CREATED_ORG_NAME)
            ?.orgId ?? null;
        return Boolean(createdOrgId);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: `created cloud org ${LIVE_CREATED_ORG_NAME} never appeared in org2CloudOrgsAtom`,
      }
    );

    // Rendered corroboration: the new org is selectable in the sidebar and
    // its panel reaches the ready state (creator = owner ⇒ admin sections).
    await openCloudOrgPanelFromSidebar(createdOrgId);
    await waitForRendered(
      '[data-testid="cloud-org-plan-section"]',
      "created org plan section",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await selectCloudOrgManagementTab("members", "created org members");
    await waitForRendered(
      '[data-testid="cloud-org-invites"]',
      "created org invites card (owner)"
    );
  });

  it("H. posts an @agent comment that creates an open pickup task (gated: real backend)", async function () {
    this.timeout(720_000);
    if (!live) {
      console.warn(
        "[cloud-e2e] SKIP scenario H: set E2E_CLOUD_* in tests/e2e/.env — the comment/task RPCs need a real org2_cloud backend."
      );
      this.skip();
    }
    if (!orgId) throw new Error("scenario C did not establish a cloud org");

    // OAuth-live mode starts a genuine provider-backed Rust-agent session.
    // The remaining comment scenarios keep using this exact durable session;
    // seeding chat events here would make scenario L a false-positive because
    // there would be no backend runtime to receive the follow-up.
    if (LIVE_AGENT_ROUND) {
      const accounts = await listAccounts();
      const configs = rustAgentConfigs(
        filteredConfigs(scenarioConfigs(accounts))
      );
      const config =
        configs.find((row) => row.label === "codex-rust-agent") ??
        configs.find((row) => row.label === "claude-code-rust-agent") ??
        configs[0];
      if (!config) {
        throw new Error(
          "E2E_CLOUD_LIVE=1 requires an enabled Rust-agent Codex or Claude account"
        );
      }

      await configureScenario(config, {
        agentExecMode: "build",
        repoPath: E2E_REPO_PATH,
      });
      await typeAndClickSend(
        '[data-testid="chat-input"] [contenteditable="true"]',
        TASK_AGENT_BOOTSTRAP_PROMPT
      );
      await waitForChatLaunched(TASK_AGENT_BOOTSTRAP_PROMPT);

      let completedState = null;
      await browser.waitUntil(
        async () => {
          const state = await inspectChatState("cloud task bootstrap");
          if (state.runtimeError) {
            throw new Error(
              `cloud task bootstrap provider round failed: ${state.runtimeError}`
            );
          }
          const hasReply = (state.chatEvents ?? []).some(
            (event) =>
              event.source === "assistant" &&
              String(event.displayText ?? "").includes(
                `CLOUD_AGENT_READY_${RUN_ID}`
              )
          );
          const terminal =
            state.runtimeStatus !== "running" &&
            state.runtimeStatus !== "installing" &&
            state.turnPhase === "idle" &&
            !state.isSessionActive;
          if (hasReply && terminal) {
            completedState = state;
            return true;
          }
          return false;
        },
        {
          timeout: 600_000,
          interval: 1_000,
          timeoutMsg:
            "real cloud task bootstrap round never produced its terminal assistant reply",
        }
      );

      const active = unwrap(
        await invokeE2E("getActiveSessionId"),
        "getActiveSessionId(real cloud task)"
      );
      const promptEvent = (completedState?.chatEvents ?? [])
        .filter(
          (event) =>
            event.source === "user" &&
            String(event.displayText ?? "").includes(
              TASK_AGENT_BOOTSTRAP_PROMPT
            )
        )
        .at(-1);
      if (!active.sessionId || !promptEvent?.id) {
        throw new Error(
          `real cloud task session is missing its session/event identity: ${JSON.stringify({ sessionId: active.sessionId, promptEvent })}`
        );
      }
      taskSessionId = active.sessionId;
      taskTurnAnchorId = promptEvent.id;
      taskSessionTitle = `E2E cloud live task ${RUN_ID}`;
    } else {
      await seedAndOpenCloudEligibleSession(taskSessionId, taskSessionTitle);
    }

    unwrap(
      await invokeE2E("cloudTagSessionToOrg", {
        sessionId: taskSessionId,
        orgId,
      }),
      "cloudTagSessionToOrg(task session)"
    );
    await setCloudSessionModeViaDialog(taskSessionId, orgId, "full_replay");
    await publishCloudSessionMetadata(env, liveUser, {
      orgId,
      sessionId: taskSessionId,
      title: taskSessionTitle,
      repoScopeKey: E2E_REPO_SCOPE_KEY,
    });

    await openTurnCommentPanel(taskTurnAnchorId);
    await postTurnComment(TASK_COMMENT_BODY);

    await waitForAgentTurnBadge(taskTurnAnchorId, CLOUD_FETCH_TIMEOUT_MS);

    let taskRow = null;
    await browser.waitUntil(
      async () => {
        const tasks = await listCloudCommentTasks(env, liveUser, orgId);
        taskRow =
          tasks.find((task) => task?.sessionId === taskSessionId) ?? null;
        return Boolean(taskRow && taskRow.state === "open");
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg:
          "@agent comment never produced an open pickup task server-side",
      }
    );
    if (taskRow.attempt !== 0) {
      throw new Error(
        `fresh pickup task should stay unclaimed (autoRunEnabled defaults OFF): ${JSON.stringify(taskRow)}`
      );
    }
    taskAssigned = true;
  });

  it("I. shows the open-tasks chip on the sidebar Team-sessions row (gated: real backend)", async function () {
    this.timeout(120_000);
    if (!live) {
      console.warn(
        "[cloud-e2e] SKIP scenario I: set E2E_CLOUD_* in tests/e2e/.env (needs the scenario H task on a real backend)."
      );
      this.skip();
    }
    if (!taskAssigned) throw new Error("scenario H did not assign a task");

    // H proves the real task RPC. This row is the viewer-side projection the
    // Team section is designed for: a teammate-owned session (own-only
    // threads intentionally remain in the flat local list).
    await selectCloudOrgScopeFromSidebar(orgId);
    const taskProjection = {
      orgId,
      sessions: [
        {
          id: `${orgId}:e2e-task-teammate:${TASK_TEAM_SESSION_ID}`,
          orgId,
          ownerMemberId: "e2e-task-teammate",
          ownerUserId: "e2e-task-teammate",
          ownerDisplayName: "Task Teammate",
          ownerIdentityKind: "human",
          sourceSessionId: TASK_TEAM_SESSION_ID,
          title: `Teammate task ${RUN_ID}`,
          repoScopeKey: E2E_REPO_SCOPE_KEY,
          accessMode: "full_replay",
          directlySharedWithMe: true,
          eventsEpoch: 1,
          eventsFrozenSeq: 0,
          eventsCount: 1,
          eventsTailHash: "task",
          unresolvedCommentCount: 1,
          openAgentTaskCount: 1,
          activeAgentTaskCount: 0,
        },
      ],
    };
    const seedTaskProjection = async () =>
      unwrap(
        await invokeE2E("cloudSeedRemoteSessions", taskProjection),
        "cloudSeedRemoteSessions(task badge projection)"
      );
    const taskRowSelector = `[data-testid="sidebar-cloud-session-item-${TASK_TEAM_SESSION_ID}"]`;
    await seedTaskProjection();
    // Selecting the live org starts a real listing request. If it was already
    // in flight when this deterministic viewer projection was seeded, its
    // response can legitimately win the first race. Re-seed only while the
    // row is absent; once React consumes it, the assertion remains pure UI.
    await browser.waitUntil(
      async () => {
        if (
          await execJS(
            `return !!document.querySelector(${JSON.stringify(taskRowSelector)});`
          )
        ) {
          return true;
        }
        await seedTaskProjection();
        return execJS(
          `return !!document.querySelector(${JSON.stringify(taskRowSelector)});`
        );
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `teammate task row never rendered after projection convergence: ${TASK_TEAM_SESSION_ID}`,
      }
    );
    const badgeText = await waitForSessionTasksBadge(
      TASK_TEAM_SESSION_ID,
      "attention"
    );
    if ((badgeText ?? "").trim() !== "1") {
      throw new Error(
        `open-tasks chip should count exactly the one open task: "${badgeText}"`
      );
    }
  });

  it("J. cycles the thread tri-state status through the head-row control (gated: real backend)", async function () {
    this.timeout(180_000);
    if (!live) {
      console.warn(
        "[cloud-e2e] SKIP scenario J: set E2E_CLOUD_* in tests/e2e/.env (needs the scenario H thread on a real backend)."
      );
      this.skip();
    }
    if (!taskAssigned) throw new Error("scenario H did not create the thread");

    if (LIVE_AGENT_ROUND) {
      unwrap(
        await invokeE2E("openSession", taskSessionId),
        "openSession(real cloud task for status)"
      );
    } else {
      await seedAndOpenCloudEligibleSession(taskSessionId, taskSessionTitle);
    }
    await openTurnCommentPanel(taskTurnAnchorId);
    await waitForRendered(
      '[data-testid="session-comment-row"]',
      "scenario H thread row",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await setThreadStatus("resolved");
    await waitForRendered(
      '[data-testid="session-comment-resolved-toggle"]',
      "resolved bucket toggle",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRendered(
      '[data-testid="session-comment-resolved-toggle"]',
      "resolved bucket toggle"
    );
    await waitForRendered(
      '[data-testid="session-comment-resolved-marker"]',
      "resolved marker",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await setThreadStatus("wont_fix");
    await waitForRendered(
      '[data-testid="session-comment-wontfix-marker"]',
      "wont-fix marker",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await setThreadStatus("active");
    await waitForGone(
      '[data-testid="session-comment-resolved-toggle"]',
      "resolved bucket toggle (thread back to active)",
      CLOUD_FETCH_TIMEOUT_MS
    );
  });

  it("K. groups session/round comments and inserts the Address-comments pill (gated: real backend)", async function () {
    this.timeout(180_000);
    if (!live) {
      console.warn(
        "[cloud-e2e] SKIP scenario K: set E2E_CLOUD_* in tests/e2e/.env (the flyout lists real unresolved threads)."
      );
      this.skip();
    }
    if (!taskAssigned) throw new Error("scenario H did not create the thread");

    if (LIVE_AGENT_ROUND) {
      unwrap(
        await invokeE2E("openSession", taskSessionId),
        "openSession(real cloud task for Address comments)"
      );
    } else {
      await seedAndOpenCloudEligibleSession(taskSessionId, taskSessionTitle);
    }

    await postSessionNote(SESSION_NOTE_BODY);
    await pressEscape();
    await waitForGone(
      '[data-testid="session-comment-composer"] textarea',
      "session note modal before opening the round thread"
    );
    await openTurnCommentPanel(taskTurnAnchorId);
    await waitForRendered(
      '[data-testid="session-comment-row"]',
      "scenario H thread row",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRendered(
      `[data-testid="session-comment-toggle-${taskTurnAnchorId}"]`,
      "close turn comment panel before using the main composer"
    );
    await waitForGone(
      '[data-testid="session-comment-composer"] textarea',
      "turn comment composer before Address Comments"
    );

    const optionCount = await openAddressCommentsFlyout();
    if (!(optionCount >= 2)) {
      throw new Error(
        `address flyout should list the session note and scenario H round thread: ${optionCount}`
      );
    }
    await waitForRendered(
      '[data-testid="address-comments-select-all"]',
      "address flyout select-all row"
    );
    await waitForRendered(
      '[data-testid="address-comments-scope-session"]',
      "session-note scope group"
    );
    await waitForRendered(
      '[data-testid="address-comments-thread-option"][data-comment-scope="session"]',
      "session-note option"
    );
    await waitForRendered(
      '[data-testid="address-comments-scope-round"]',
      "round-comment scope group"
    );
    await waitForRendered(
      '[data-testid="address-comments-thread-option"][data-comment-scope="round"]',
      "round-comment option"
    );
    await confirmAddressCommentsFlyout();

    const composerText = String((await chatComposerText()) ?? "");
    if (!(await hasAddressCommentsPill())) {
      throw new Error(
        `composer should carry the /address-comments semantic pill: ${JSON.stringify(composerText)}`
      );
    }
    await clearChatComposer();
  });

  it("L. runs the address round in place and posts an Agent-attributed reply (gated: OAuth-live agent)", async function () {
    this.timeout(600_000);
    if (!live) {
      console.warn(
        "[cloud-e2e] SKIP scenario L: the comment round requires the real cloud backend."
      );
      this.skip();
    }
    if (!LIVE_AGENT_ROUND) {
      console.warn(
        "[cloud-e2e] SKIP scenario L: set E2E_CLOUD_LIVE=1 and use the isolated OAuth-live runner."
      );
      this.skip();
    }
    if (!taskAssigned) throw new Error("scenario H did not create the task");

    unwrap(
      await invokeE2E("openSession", taskSessionId),
      "openSession(real cloud task for agent round)"
    );
    await openTurnCommentPanel(taskTurnAnchorId);
    await openAddressCommentsFlyout();
    await confirmAddressCommentsFlyout();
    await clickRendered('[data-testid="chat-send-button"]', "chat send button");
    await waitForRendered(
      '[data-testid="comment-thread-agent-busy"]',
      "agent addressing line",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForRendered(
      '[data-testid="comment-agent-affix"]',
      "agent-attributed reply (cloud.comments.agentAuthor)",
      600_000
    );
  });
});
