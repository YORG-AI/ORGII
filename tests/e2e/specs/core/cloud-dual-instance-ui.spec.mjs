/* global browser, describe, before, after, it, process */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  getApiAccount,
  selectPreferredModel,
} from "../../support/core/agentOrgUiDriver.mjs";
import {
  CLOUD_CREATE_ORG_TIMEOUT_MS,
  CLOUD_FETCH_TIMEOUT_MS,
  E2E_REPO_PATH,
  RUN_ID,
  applyCloudEndpointOverride,
  cleanupCloudUser,
  clickRendered,
  cloudEnv,
  confirmAddressCommentsFlyout,
  ensureCloudSchemaReady,
  execJS,
  invokeE2E,
  openAddressCommentsFlyout,
  openCloudOrgPanelFromSidebar,
  openCreateOrgFormFromSidebar,
  openTurnCommentPanel,
  postTurnComment,
  postTurnCommentMentioning,
  pressEscape,
  provisionCloudUser,
  publishCloudSessionMetadata,
  seedAndOpenCloudEligibleSession,
  selectCloudOrgScopeFromSidebar,
  setCloudSessionModeViaDialog,
  setCloudSessionVisibilityViaDialog,
  typeRendered,
  unwrap,
  waitForApp,
  waitForGone,
  waitForRendered,
} from "../../support/core/cloudOrgUiDriver.mjs";
import {
  applyCloudEndpointOn,
  clickRenderedOn,
  executeOn,
  invokeOn,
  pressEscapeOn,
  startSecondCloudInstance,
  typeContentEditableOn,
  typeRenderedOn,
  unwrapOn,
  waitForCloudOrgsOn,
  waitForGoneOn,
  waitForRenderedOn,
} from "../../support/core/dualCloudHarness.mjs";

// Rendered shape of buildCloudInviteLink (org2CloudOrgManagement.ts).
const CLOUD_INVITE_LINK_PREFIX = "https://invite.org2.dev/#invite=";
const PRIMARY_INSTANCE_MEMBER_NAME = "Neonforge";
const SECONDARY_INSTANCE_MEMBER_NAME = "VantaNode";

const TEAM_NAME = `Dual-instance Team ${RUN_ID}`;
const RENAMED_TEAM_NAME = `Renamed dual team ${RUN_ID}`;
let sessionId = `dual-instance-session-${RUN_ID}`;
const SESSION_TITLE = `Dual instance restricted share ${RUN_ID}`;
const SESSION_BLAME_FILE = "package.json";
const COMMENT_BODY = `@agent dual-instance task ${RUN_ID}`;
const OWNER_AGENT_COMMENT_BODY = `@agent owner single task ${RUN_ID}`;
const SESSION_NOTE_BODY = `Dual-instance session note ${RUN_ID}`;
const EDITED_COMMENT_BODY = `@agent dual-instance edited task ${RUN_ID}`;
const EDITED_COMMENT_BRIEF = EDITED_COMMENT_BODY.slice("@agent ".length);
const REPLY_BODY = `Owner reply from the other instance ${RUN_ID}`;
const TEAM_INBOX_MENTION_BODY = `Team Inbox mention ${RUN_ID}`;
const SEND_BODY = `Continue this work from the matching workspace ${RUN_ID}`;
const PROJECT_NAME = `Dual cloud project ${RUN_ID}`;
const PROJECT_SLUG = PROJECT_NAME.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
const PROJECT_ID = `proj-${PROJECT_SLUG}`;
const WORK_ITEM_TITLE = `Dual synced work item ${RUN_ID}`;
const FIRST_CONTINUATION_COMMENT = `VantaNode continuation one ${RUN_ID}`;
const SECOND_CONTINUATION_COMMENT = `VantaNode continuation two ${RUN_ID}`;
const PRIMARY_PLANE_DELTA = `Neonforge plane delta ${RUN_ID}`;
const CONTINUATION_LOCAL_ORG_ID = `cloud-continuation-${RUN_ID}`;
const CONTINUATION_WORK_ITEM_SHORT_ID = "CON-1";
const CASCADE_WORK_ITEM_TITLE = `Project cascade item ${RUN_ID}`;
const UNREACHABLE_CLOUD_ENDPOINT = {
  webOrigin: "http://127.0.0.1:1",
  supabaseUrl: "http://127.0.0.1:1",
  anonKey: "offline-anon-key",
};
let remoteRowSelector = `[data-testid="sidebar-cloud-session-item-${sessionId}"]`;
const EXPECTED_REPO_NETWORK_SCOPE =
  process.env.E2E_EXPECTED_REPO_SCOPE ??
  process.env.E2E_REPO_SCOPE_KEY ??
  "github.com/orgii/e2e-workspace";
let repoScopeKey = EXPECTED_REPO_NETWORK_SCOPE;
const SECONDARY_E2E_REPO_PATH =
  process.env.E2E_SECONDARY_REPO_PATH ?? E2E_REPO_PATH;
const E2E_PROVIDER_MODE = process.env.E2E_PROVIDER_MODE ?? "mock";
const FORK_E2E_MODEL =
  E2E_PROVIDER_MODE === "mock" ? "e2e-fake-provider-cloud-fork" : "gpt-4o-mini";
let sourceTurnAnchorEventId = null;
let secondaryImportedTurnToggleSelector = null;
let secondaryImportedSessionId = null;

function bindRunnableSourceSession(nextSessionId) {
  sessionId = nextSessionId;
  remoteRowSelector = `[data-testid="sidebar-cloud-session-item-${sessionId}"]`;
  sourceTurnAnchorEventId = null;
  secondaryImportedTurnToggleSelector = null;
}

async function captureRenderedSourceTurnAnchor() {
  const togglePrefix = "session-comment-toggle-";
  await waitForRendered(
    `[data-testid^="${togglePrefix}"]`,
    "owner rendered source-turn comment toggle",
    CLOUD_FETCH_TIMEOUT_MS
  );
  const renderedTestIds = await execJS(`
    return Array.from(document.querySelectorAll('[data-testid^="${togglePrefix}"]'))
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.getAttribute('data-testid'))
      .filter(Boolean);
  `);
  const state = unwrap(
    await invokeE2E("inspectChatState"),
    "inspect rendered source-turn anchor"
  );
  const userEventIds = (state.chatEvents ?? [])
    .filter(
      (event) =>
        event.source === "user" || event.functionName === "user_message"
    )
    .map((event) => event.id)
    .filter(Boolean);
  const renderedAnchorIds = renderedTestIds.map((testId) =>
    testId.slice(togglePrefix.length)
  );
  const invalidAnchorIds = renderedAnchorIds.filter(
    (anchorId) => !userEventIds.includes(anchorId)
  );
  const latestUserEventId = userEventIds.at(-1) ?? null;
  const renderedLatestAnchorId = renderedAnchorIds.at(-1) ?? null;
  if (
    state.activeSessionId !== sessionId ||
    !renderedLatestAnchorId ||
    invalidAnchorIds.length > 0 ||
    renderedLatestAnchorId !== latestUserEventId
  ) {
    throw new Error(
      `rendered source-turn comment anchor does not match the active session's latest user event: ${JSON.stringify(
        {
          activeSessionId: state.activeSessionId,
          expectedSessionId: sessionId,
          renderedAnchorIds,
          userEventIds,
          invalidAnchorIds,
        }
      )}`
    );
  }
  sourceTurnAnchorEventId = renderedLatestAnchorId;
  secondaryImportedTurnToggleSelector =
    `[data-testid^="session-comment-toggle-"]` +
    `[data-testid$="~${sourceTurnAnchorEventId}"]`;
  return sourceTurnAnchorEventId;
}

async function openPrimaryImportSession(label) {
  await clickRendered(
    '[data-testid="chat-panel-start-page-tab-more"]',
    `${label} More tab`
  );
  await clickRendered(
    '[data-testid="chat-panel-start-page-import-session"]',
    label
  );
}

async function openImportSessionOn(client, label) {
  await clickRenderedOn(
    client,
    '[data-testid="chat-panel-start-page-tab-more"]',
    `${label} More tab`
  );
  await clickRenderedOn(
    client,
    '[data-testid="chat-panel-start-page-import-session"]',
    label
  );
}

async function getSecondaryForkAccount(client) {
  const accounts = unwrapOn(
    await invokeOn(client, "listAccounts"),
    "secondary list real fork accounts"
  ).accounts;
  const requested = (process.env.E2E_SECONDARY_ACCOUNT ?? "").trim();
  const account = accounts.find((row) => {
    const hasRequiredCredential =
      row.auth_method === "oauth"
        ? row.has_session_token
        : row.has_api_key || row.has_session_token;
    return (
      row.enabled &&
      row.health_status !== "invalid" &&
      row.supports_rust_agents !== false &&
      hasRequiredCredential &&
      (row.enabled_models ?? []).length > 0 &&
      (!requested || row.id === requested || row.name === requested)
    );
  });
  if (!account) {
    throw new Error(
      `No runnable second-instance account found. requested=${requested || "<any>"} rows=${JSON.stringify(
        accounts.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.agent_type,
          enabled: row.enabled,
          authMethod: row.auth_method,
          health: row.health_status,
          supportsRustAgents: row.supports_rust_agents,
          hasApiKey: row.has_api_key,
          hasSessionToken: row.has_session_token,
          models: row.enabled_models,
        }))
      )}`
    );
  }
  return account;
}

async function completeForkSetupOn(client, label, options = {}) {
  await waitForRenderedOn(
    client,
    '[data-testid="fork-session-setup"]',
    `${label} setup dialog`,
    CLOUD_FETCH_TIMEOUT_MS
  );
  await waitForRenderedOn(
    client,
    '[data-testid^="fork-setup-workspace-"]',
    `${label} matching workspace`,
    CLOUD_FETCH_TIMEOUT_MS
  );
  await clickRenderedOn(
    client,
    '[data-testid^="fork-setup-workspace-"]',
    `${label} matching workspace`
  );
  try {
    await client.waitUntil(
      async () =>
        executeOn(
          client,
          `
            const value = (testId) => document
              .querySelector('[data-testid="' + testId + '"] .select-value')
              ?.textContent?.trim() ?? '';
            const submit = document.querySelector('[data-testid="fork-session-setup-submit"]');
            return !!value('fork-setup-agent') &&
              !!value('fork-setup-runtime') &&
              !!value('fork-setup-account') &&
              !!value('fork-setup-model') &&
              !!submit && !submit.disabled;
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `${label} runtime/agent/account/model defaults never became runnable`,
      }
    );
  } catch (error) {
    const setupState = await executeOn(
      client,
      `
        const inspect = (testId) => {
          const node = document.querySelector('[data-testid="' + testId + '"]');
          return node ? {
            testId,
            text: node.textContent?.trim() ?? '',
            disabled: node.disabled ?? node.getAttribute('aria-disabled'),
            className: node.className,
            html: node.outerHTML,
          } : { testId, missing: true };
        };
        return {
          controls: [
            'fork-setup-agent',
            'fork-setup-runtime',
            'fork-setup-account',
            'fork-setup-model',
            'fork-session-setup-submit',
          ].map(inspect),
          dialogText: document.querySelector('[data-testid="fork-session-setup"]')
            ?.textContent?.trim() ?? '',
        };
      `
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; setup=${JSON.stringify(setupState)}`
    );
  }
  if (options.agentName) {
    await clickRenderedOn(
      client,
      '[data-testid="fork-setup-agent"]',
      `${label} agent picker`
    );
    await client.waitUntil(
      async () =>
        executeOn(
          client,
          `
            const overlay = document.querySelector('.select-options-overlay');
            if (!overlay) return false;
            const target = Array.from(
              overlay.querySelectorAll(':scope > div > div')
            ).find((node) =>
              (node.textContent ?? '').includes(${JSON.stringify(options.agentName)})
            );
            if (!target) return false;
            target.setAttribute('data-e2e-fork-agent-option', 'true');
            return true;
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `${label} non-default agent option never rendered`,
      }
    );
    await clickRenderedOn(
      client,
      '[data-e2e-fork-agent-option="true"]',
      `${label} non-default agent option`
    );
    await client.waitUntil(
      async () =>
        executeOn(
          client,
          `
            const value = document.querySelector('[data-testid="fork-setup-agent"]')
              ?.querySelector('.select-value')?.textContent ?? '';
            const submit = document.querySelector('[data-testid="fork-session-setup-submit"]');
            return value.includes(${JSON.stringify(options.agentName)}) &&
              !!submit && !submit.disabled;
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `${label} selected non-default agent never became runnable`,
      }
    );
  }
  await clickRenderedOn(
    client,
    '[data-testid="fork-session-setup-submit"]',
    `${label} submit`
  );
}

async function callProjectsRpc(envConfig, user, functionName, body) {
  const response = await fetch(
    `${envConfig.supabaseUrl}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: envConfig.anonKey,
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
        "content-profile": "org2_cloud",
      },
      body: JSON.stringify(body),
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${functionName} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function waitForE2EOn(client) {
  await client.waitUntil(
    async () =>
      executeOn(
        client,
        'return !!window.__e2e && typeof window.__e2e.navigateTo === "function";'
      ),
    {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: "secondary window.__e2e never mounted",
    }
  );
}

async function seedAuthOn(client, env, user, displayName) {
  unwrapOn(
    await invokeOn(client, "cloudSeedAuthState", {
      supabaseUrl: env.supabaseUrl,
      anonKey: env.anonKey,
      userId: user.userId,
      accessToken: user.accessToken,
      refreshToken: user.refreshToken,
      expiresAt: user.expiresAt,
      displayName,
    }),
    `seed cloud auth for ${displayName}`
  );
}

async function selectCloudOrgOn(client, orgId) {
  const targetPath = "/orgii/workstation/code";
  const currentPath = await executeOn(client, "return location.pathname;");
  if (currentPath !== targetPath) {
    unwrapOn(
      await invokeOn(client, "navigateTo", targetPath),
      "secondary navigate to workstation"
    );
  }
  const targetSelectorValue = `cloud:${orgId}`;
  const alreadySelected = await executeOn(
    client,
    `
      const visibleScopes = Array.from(document.querySelectorAll('[data-testid="sidebar-org-selector-scope"]')).filter((scope) => {
        const rect = scope.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return visibleScopes.length > 0 && visibleScopes.every(
        (scope) => scope.getAttribute('data-org-id') === arguments[0]
      );
    `,
    [targetSelectorValue]
  );
  if (alreadySelected) return;
  await waitForRenderedOn(
    client,
    '[data-testid="sidebar-org-selector"]',
    "secondary sidebar org selector"
  );
  await client.$('[data-testid="sidebar-org-selector"]').click();
  try {
    await clickRenderedOn(
      client,
      `[data-testid="sidebar-cloud-org-option-${orgId}"]`,
      "secondary team org option"
    );
  } catch (error) {
    const [roster, dom] = await Promise.all([
      invokeOn(client, "cloudInspectRosterState"),
      executeOn(
        client,
        `
          return {
            path: location.pathname,
            scopes: Array.from(document.querySelectorAll('[data-testid="sidebar-org-selector-scope"]')).map((node) => ({
              value: node.getAttribute('data-org-id'),
              rect: node.getBoundingClientRect().toJSON(),
            })),
            triggers: Array.from(document.querySelectorAll('[data-testid="sidebar-org-selector"]')).map((node) => ({
              className: node.className,
              text: node.textContent,
              rect: node.getBoundingClientRect().toJSON(),
            })),
            optionTestIds: Array.from(document.querySelectorAll('[data-testid^="sidebar-"]')).map((node) => node.getAttribute('data-testid')),
            openPanels: Array.from(document.querySelectorAll('.select-options-overlay')).map((node) => node.textContent),
          };
        `
      ),
    ]);
    console.info(
      `[cloud-dual-e2e] selector failure diagnostic ${JSON.stringify({ roster, dom })}`
    );
    throw error;
  }
  await client.waitUntil(
    async () =>
      executeOn(
        client,
        `
          const scopes = Array.from(document.querySelectorAll('[data-testid="sidebar-org-selector-scope"]'));
          return scopes.length > 0 && scopes.every(
            (scope) => scope.getAttribute('data-org-id') === arguments[0]
          );
        `,
        [targetSelectorValue]
      ),
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `secondary sidebar never committed org ${orgId}`,
    }
  );
}

async function openFileTimelineOn(client, absoluteFilePath) {
  unwrapOn(
    await invokeOn(client, "navigateTo", "/orgii/workstation/code"),
    "secondary navigate to My Station"
  );
  await waitForRenderedOn(
    client,
    '[data-testid="station-mode-my-station"]',
    "secondary My Station switch"
  );
  await clickRenderedOn(
    client,
    '[data-testid="station-mode-my-station"]',
    "secondary My Station switch"
  );
  await client.waitUntil(
    async () => {
      const surface = unwrapOn(
        await invokeOn(client, "inspectWorkstationSurface"),
        "secondary inspect My Station"
      );
      return surface.stationMode === "my-station";
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "secondary My Station never became active",
    }
  );
  unwrapOn(
    await invokeOn(client, "openWorkstationFile", absoluteFilePath),
    "secondary open blame target file"
  );
  await client.waitUntil(
    async () => {
      const surface = unwrapOn(
        await invokeOn(client, "inspectWorkstationSurface"),
        "secondary inspect opened blame file"
      );
      return (
        surface.activeHost === "code" &&
        surface.activeTabType === "file" &&
        surface.activeTabId === `file:${absoluteFilePath}` &&
        surface.codeEditorPresent
      );
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "secondary blame target file never rendered",
    }
  );
  const toggle = '[data-testid="code-editor-agent-timeline-section-toggle"]';
  await waitForRenderedOn(client, toggle, "secondary Agent Timeline section");
  const collapsed = await executeOn(
    client,
    `return document.querySelector(arguments[0])?.getAttribute('data-collapsed') === 'true';`,
    [toggle]
  );
  if (collapsed) {
    await clickRenderedOn(
      client,
      toggle,
      "secondary expand Agent Timeline section"
    );
  }
  await waitForRenderedOn(
    client,
    '[data-testid="session-blame-section"]',
    "secondary Team Session Blame section",
    CLOUD_FETCH_TIMEOUT_MS
  );
}

async function selectCloudOrgManagementTabOn(client, tab, label) {
  await clickRenderedOn(
    client,
    `[data-testid="cloud-org-tab-${tab}"]`,
    `${label} management tab`
  );
}

async function selectPrimaryCloudOrgManagementTab(tab, label) {
  await clickRendered(
    `[data-testid="cloud-org-tab-${tab}"]`,
    `${label} management tab`
  );
}

async function openCloudOrgPanelOn(client, orgId, label) {
  await selectCloudOrgOn(client, orgId);
  // A second Tauri window may be occluded, in which case WebKit legitimately
  // throttles requestAnimationFrame. Prove that the same visible Select node
  // survives two WebDriver polls instead; a React remount loses the marker and
  // restarts the check before we send a real pointer click.
  const stabilityToken = `${Date.now()}-${Math.random()}`;
  await client.waitUntil(
    async () =>
      executeOn(
        client,
        `
          const nodes = Array.from(document.querySelectorAll('[data-testid="sidebar-org-selector"]')).filter((node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          });
          if (nodes.length === 0) return false;
          const stable = nodes.every((node) => node.getAttribute('data-e2e-stability-token') === arguments[0]);
          if (!stable) {
            nodes.forEach((node) => node.setAttribute('data-e2e-stability-token', arguments[0]));
          }
          return stable;
        `,
        [stabilityToken]
      ),
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: `${label} org selector render did not settle`,
    }
  );
  await waitForRenderedOn(
    client,
    '[data-testid="sidebar-org-selector"]',
    `${label} org selector for management`
  );
  await client.$('[data-testid="sidebar-org-selector"]').click();
  let pointerOpenedMenu = false;
  try {
    await client.waitUntil(
      async () =>
        executeOn(
          client,
          `return !!document.querySelector('[data-testid="sidebar-org-manage"]');`
        ),
      { timeout: 1_500, interval: 100 }
    );
    pointerOpenedMenu = true;
  } catch {
    // On macOS the first pointer action into an inactive WKWebView can be
    // consumed to activate the native window. It focuses this tabIndex node
    // but does not dispatch the React click; now that the window is active, a
    // second real click exercises the control itself.
  }
  if (!pointerOpenedMenu) {
    await client.$('[data-testid="sidebar-org-selector"]').click();
    try {
      await client.waitUntil(
        async () =>
          executeOn(
            client,
            `return !!document.querySelector('[data-testid="sidebar-org-manage"]');`
          ),
        { timeout: 1_500, interval: 100 }
      );
      pointerOpenedMenu = true;
    } catch {
      // Keep keyboard access as a final real-input fallback. U+E007 is the
      // WebDriver protocol's Enter key, not the literal letters "Enter".
    }
  }
  if (!pointerOpenedMenu) {
    await client.$('[data-testid="sidebar-org-selector"]').keys("\uE007");
  }
  try {
    await waitForRenderedOn(
      client,
      '[data-testid="sidebar-org-manage"]',
      `${label} manage workspace action`,
      CLOUD_FETCH_TIMEOUT_MS
    );
  } catch (error) {
    const dom = await executeOn(
      client,
      `
        return {
          active: document.activeElement?.getAttribute?.('data-testid') ?? document.activeElement?.tagName,
          dialog: !!document.querySelector('[data-testid="cloud-join-org-dialog"]'),
          pendingModals: document.querySelectorAll('[role="dialog"]').length,
          scopes: Array.from(document.querySelectorAll('[data-testid="sidebar-org-selector-scope"]')).map((node) => node.getAttribute('data-org-id')),
          triggers: Array.from(document.querySelectorAll('[data-testid="sidebar-org-selector"]')).map((node) => ({ className: node.className, text: node.textContent })),
          options: Array.from(document.querySelectorAll('.select-options-overlay')).map((node) => node.textContent),
          manageCount: document.querySelectorAll('[data-testid="sidebar-org-manage"]').length,
        };
      `
    );
    console.info(
      `[cloud-dual-e2e] manage selector diagnostic ${JSON.stringify(dom)}`
    );
    throw error;
  }
  await clickRenderedOn(
    client,
    '[data-testid="sidebar-org-manage"]',
    `${label} manage workspace action`
  );
  await waitForRenderedOn(
    client,
    '[data-testid="cloud-org-panel"]',
    `${label} cloud org panel`,
    CLOUD_FETCH_TIMEOUT_MS
  );
  await waitForRenderedOn(
    client,
    '[data-testid="cloud-org-plan-section"]',
    `${label} loaded cloud plan section`,
    CLOUD_FETCH_TIMEOUT_MS
  );
  await selectCloudOrgManagementTabOn(client, "members", `${label} members`);
  await waitForRenderedOn(
    client,
    '[data-testid="cloud-org-members"]',
    `${label} loaded cloud member roster`,
    CLOUD_FETCH_TIMEOUT_MS
  );
}

async function openProjectContextMenuOn(client, projectId, label) {
  const rowSelector = `[data-testid="project-row-${projectId}"]`;
  await waitForRenderedOn(
    client,
    rowSelector,
    `${label} Project row`,
    CLOUD_FETCH_TIMEOUT_MS
  );
  await client.$(rowSelector).click({ button: "right" });
  await waitForRenderedOn(
    client,
    '[data-testid="context-menu-item-open"]',
    `${label} Project context menu`,
    CLOUD_FETCH_TIMEOUT_MS
  );
}

async function createInviteFromOwner(previousLink = "") {
  await clickRendered(
    '[data-testid="cloud-org-create-invite"]',
    "owner create team invite"
  );
  await browser.waitUntil(
    async () => {
      const link = String(
        (await execJS(
          `return document.querySelector('[data-testid="cloud-org-invite-link"]')?.textContent?.trim() ?? '';`
        )) ?? ""
      );
      return link.startsWith(CLOUD_INVITE_LINK_PREFIX) && link !== previousLink;
    },
    {
      timeout: CLOUD_FETCH_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: "owner invite plaintext did not refresh",
    }
  );
  return execJS(`
    const row = document.querySelector('[data-testid="cloud-org-invite-row"]');
    return {
      link: document.querySelector('[data-testid="cloud-org-invite-link"]')?.textContent?.trim() ?? '',
      inviteId: row?.getAttribute('data-invite-id') ?? '',
    };
  `);
}

async function assertAddressCommentsUnavailableOn(client, label) {
  const selector = '[data-testid="chat-input"] [contenteditable="true"]';
  await waitForRenderedOn(client, selector, `${label} composer`);
  await typeContentEditableOn(client, selector, "/", `${label} slash input`);
  await client.pause(750);
  const exposed = await executeOn(
    client,
    `return !!document.querySelector('[data-testid="slash-command-item"][data-slash-source="org2cloud-address-comments"]');`
  );
  await typeContentEditableOn(
    client,
    selector,
    "",
    `${label} clear slash input`
  );
  await pressEscapeOn(client);
  if (exposed) {
    throw new Error(
      `${label} exposed Address Comments even though this viewer does not own the source session`
    );
  }
}

async function postCommentOn(client, body) {
  const textareaSelector = '[data-testid="session-comment-composer"] textarea';
  await typeRenderedOn(
    client,
    textareaSelector,
    body,
    "secondary comment body"
  );
  await client.waitUntil(
    async () =>
      executeOn(
        client,
        `
          const buttons = Array.from(
            document.querySelectorAll('[data-testid="session-comment-composer-submit"]')
          );
          return buttons.some((button) => {
            const rect = button.getBoundingClientRect();
            const style = window.getComputedStyle(button);
            return !button.disabled && rect.width > 0 && rect.height > 0 &&
              style.display !== "none" && style.visibility !== "hidden";
          });
        `
      ),
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "secondary comment submit never enabled",
    }
  );
  await clickRenderedOn(
    client,
    '[data-testid="session-comment-composer-submit"]',
    "secondary comment submit"
  );
  await waitForRenderedOn(
    client,
    '[data-testid="session-comment-row"]',
    "secondary posted comment",
    CLOUD_FETCH_TIMEOUT_MS
  );
}

async function selectAddressCommentsForBatch() {
  const selectAllWasChecked = await execJS(`
    const all = document.querySelector('[data-testid="address-comments-select-all"]');
    return all?.getAttribute('aria-checked') === 'true';
  `);
  if (selectAllWasChecked) {
    await clickRendered(
      '[data-testid="address-comments-select-all"]',
      "clear Address Comments select all"
    );
  }
  const selected = await execJS(`
    const options = Array.from(document.querySelectorAll('[data-testid="address-comments-thread-option"]'));
    const session = options.find((option) =>
      option.getAttribute('data-comment-scope') === 'session' &&
      option.textContent?.includes(${JSON.stringify(SESSION_NOTE_BODY)})
    );
    const round = options.find((option) =>
      option.getAttribute('data-comment-scope') === 'round' &&
      option.textContent?.includes(${JSON.stringify(COMMENT_BODY.slice(0, 40))})
    );
    session?.setAttribute('data-e2e-address-target', 'session');
    round?.setAttribute('data-e2e-address-target', 'round');
    return {
      session: Boolean(session),
      round: Boolean(round),
      sessionText: session?.textContent ?? '',
      roundText: round?.textContent ?? '',
    };
  `);
  if (!selected.session || !selected.round) {
    throw new Error(
      `Address Comments did not expose the intended session + round pair: ${JSON.stringify(selected)}`
    );
  }
  await clickRendered(
    '[data-e2e-address-target="session"]',
    "select session-level Address Comment"
  );
  await clickRendered(
    '[data-e2e-address-target="round"]',
    "select round-level Address Comment"
  );
  await browser.waitUntil(
    async () =>
      execJS(`
        const selected = Array.from(document.querySelectorAll('[data-testid="address-comments-thread-option"]'))
          .filter((option) => option.getAttribute('aria-checked') === 'true');
        return selected.length === 2;
      `),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg:
        "Address Comments never committed the exact two-thread selection",
    }
  );
}

async function openWorkItemsLayerOn(client, label) {
  const layerVisible = await executeOn(
    client,
    `return !!document.querySelector(
      '[data-testid="work-items-create-menu"], [data-testid="sidebar-create-project"]'
    );`
  );
  if (!layerVisible) {
    await clickRenderedOn(
      client,
      '[data-testid="sidebar-view-work-items"], [data-testid="sidebar-toggle-work-items"]',
      `${label} Work Items navigation`
    );
  }
  await waitForRenderedOn(
    client,
    '[data-testid="work-items-create-menu"], [data-testid="sidebar-create-project"]',
    `${label} Work Items layer`,
    CLOUD_FETCH_TIMEOUT_MS
  );
}

async function cloudManagementRpc(envConfig, user, functionName, body) {
  const response = await fetch(
    `${envConfig.supabaseUrl}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: envConfig.anonKey,
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
        "content-profile": "org2_cloud",
      },
      body: JSON.stringify(body),
    }
  );
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(
      `${functionName} failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }
  return payload;
}

async function provisionContinuationTeam(envConfig, ownerUser, teammateUser) {
  const created = await cloudManagementRpc(envConfig, ownerUser, "create_org", {
    org_name: TEAM_NAME,
  });
  const orgId = created.orgId;
  await cloudManagementRpc(envConfig, ownerUser, "cloud_set_org_repo_scopes", {
    p_org_id: orgId,
    scopes: [EXPECTED_REPO_NETWORK_SCOPE],
  });
  const inviteCode = randomBytes(32).toString("hex");
  const inviteCodeHash = createHash("sha256").update(inviteCode).digest("hex");
  await cloudManagementRpc(envConfig, ownerUser, "create_invite", {
    p_org_id: orgId,
    invite_code_hash: inviteCodeHash,
    invite_role: "member",
    max_uses: 1,
    expires_at: null,
  });
  const accepted = await cloudManagementRpc(
    envConfig,
    teammateUser,
    "accept_invite",
    { invite_code_hash: inviteCodeHash }
  );
  if (accepted.orgId !== orgId || accepted.role !== "member") {
    throw new Error(
      `VantaNode joined the wrong team: ${JSON.stringify({ created, accepted })}`
    );
  }
  return orgId;
}

function continuationProjectMeta() {
  const now = new Date().toISOString();
  return {
    id: PROJECT_ID,
    name: PROJECT_NAME,
    org_id: CONTINUATION_LOCAL_ORG_ID,
    status: "planned",
    priority: "none",
    health: "no_updates",
    members: [],
    labels: [],
    linked_repos: [SECONDARY_E2E_REPO_PATH],
    created_at: now,
    updated_at: now,
    next_work_item_id: 2,
    work_item_prefix: "CON",
    work_item_prefix_custom: true,
  };
}

function continuationWorkItemFrontmatter(rootSessionId) {
  const now = new Date().toISOString();
  return {
    id: CONTINUATION_WORK_ITEM_SHORT_ID,
    short_id: CONTINUATION_WORK_ITEM_SHORT_ID,
    title: WORK_ITEM_TITLE,
    project: PROJECT_SLUG,
    status: "planned",
    priority: "none",
    labels: [],
    created_by: SECONDARY_INSTANCE_MEMBER_NAME,
    created_at: now,
    updated_at: now,
    starred: false,
    todos: [],
    linked_sessions: [
      {
        session_id: rootSessionId,
        session_type: "native",
        agent_role: "coding",
        started_at: now,
        completed_at: now,
        status: "completed",
        cost_usd: 0,
        total_tokens: 0,
      },
    ],
  };
}

async function selectManualCreateModeOn(client, target, label) {
  const selector = `[data-testid="chat-panel-${target}-agent-switch"]`;
  await waitForRenderedOn(
    client,
    selector,
    `${label} Agent mode switch`,
    CLOUD_FETCH_TIMEOUT_MS
  );
  const agentModeEnabled = await executeOn(
    client,
    `return document.querySelector(arguments[0])?.getAttribute('aria-checked') === 'true';`,
    [selector]
  );
  if (agentModeEnabled) {
    await clickRenderedOn(client, selector, `${label} manual mode`);
  }
  const submitSelector =
    target === "project"
      ? '[data-testid="create-project-submit"]'
      : '[data-testid="create-work-item-submit"]';
  await waitForRenderedOn(
    client,
    submitSelector,
    `${label} manual submit`,
    CLOUD_FETCH_TIMEOUT_MS
  );
}

async function findSidebarWorkItemIdByTitleOn(client, title) {
  let foundId = "";
  await client.waitUntil(
    async () => {
      foundId = String(
        (await executeOn(
          client,
          `
          const row = Array.from(document.querySelectorAll('[data-testid^="sidebar-work-item-"]'))
            .find((candidate) => candidate.textContent?.includes(arguments[0]));
          return row?.getAttribute('data-testid')?.replace('sidebar-work-item-', '') ?? '';
        `,
          [title]
        )) ?? ""
      );
      return Boolean(foundId);
    },
    {
      timeout: CLOUD_FETCH_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${title} never rendered in the Work Items sidebar`,
    }
  );
  return foundId;
}

async function openWorkItemOn(client, workItemId, label) {
  await openWorkItemsLayerOn(client, label);
  const workItemRowSelector =
    `[data-testid="work-item-row-${workItemId}"], ` +
    `[data-testid="sidebar-work-item-${workItemId}"]`;
  await waitForRenderedOn(
    client,
    workItemRowSelector,
    `${label} Work Item row`,
    CLOUD_FETCH_TIMEOUT_MS
  );
  await clickRenderedOn(client, workItemRowSelector, `${label} open Work Item`);
  await waitForRenderedOn(
    client,
    `[data-testid="work-item-property-status-${workItemId}"]`,
    `${label} Work Item status property`,
    CLOUD_FETCH_TIMEOUT_MS
  );
}

async function visibleTextIncludesOn(client, selector, expectedText) {
  return executeOn(
    client,
    `
      return Array.from(document.querySelectorAll(arguments[0])).some((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        // Match the suite's clickRendered contract: a mounted control keeps
        // its rendered UX state while scrolled just outside the viewport or
        // while an ancestor manages focus with aria-hidden. Zero-size / CSS-
        // hidden duplicate surfaces still do not qualify.
        const rendered = rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden';
        return rendered && node.textContent?.includes(arguments[1]) === true;
      });
    `,
    [selector, expectedText]
  );
}

async function renderedValueIsOn(client, selector, expectedValue) {
  return executeOn(
    client,
    `
      return Array.from(document.querySelectorAll(arguments[0])).some((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' &&
          node.getAttribute('data-value') === arguments[1];
      });
    `,
    [selector, expectedValue]
  );
}

async function inspectRenderedNodesOn(client, selector) {
  return executeOn(
    client,
    `
      return Array.from(document.querySelectorAll(arguments[0])).map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          text: node.textContent,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          ariaHiddenAncestor: node.closest('[aria-hidden="true"]')?.getAttribute('data-testid') ??
            node.closest('[aria-hidden="true"]')?.className ?? null,
          html: node.outerHTML.slice(0, 1200),
        };
      });
    `,
    [selector]
  );
}

async function setWorkItemStatusOn(
  client,
  workItemId,
  status,
  expectedLabel,
  label
) {
  await clickRenderedOn(
    client,
    `[data-testid="work-item-property-status-${workItemId}"] [data-field-row]`,
    `${label} Work Item status picker`
  );
  await clickRenderedOn(
    client,
    `[data-testid="work-item-property-status-${workItemId}-option-${status}"]`,
    `${label} Work Item status ${expectedLabel}`
  );
  await client.waitUntil(
    async () =>
      renderedValueIsOn(
        client,
        `[data-testid="work-item-property-status-${workItemId}"]`,
        status
      ),
    {
      timeout: CLOUD_FETCH_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} Work Item status did not become ${expectedLabel}`,
    }
  );
}

async function openWorkItemDiscussionOn(client, workItemId, label) {
  await openWorkItemOn(client, workItemId, label);
  const opened = await executeOn(
    client,
    `
      const history = document.querySelector('[data-testid="work-item-sessions-tab-history"]');
      if (history) {
        history.click();
        return "history";
      }
      const discussion = document.querySelector('[data-testid="work-item-thread-open-discussion"]');
      if (discussion) {
        discussion.click();
        return "thread";
      }
      return "missing";
    `
  );
  if (opened === "missing") {
    throw new Error(`${label} Work Item exposes no Discussion navigation`);
  }
  await waitForRenderedOn(
    client,
    '[data-testid="work-item-comment-editor-textarea"]',
    `${label} Work Item Discussion composer`,
    CLOUD_FETCH_TIMEOUT_MS
  );
}

async function postWorkItemDiscussionOn(
  client,
  { workItemId, body, rootSessionId, label }
) {
  await typeRenderedOn(
    client,
    '[data-testid="work-item-comment-editor-textarea"]',
    body,
    `${label} Discussion body`
  );
  await client.waitUntil(
    async () =>
      executeOn(
        client,
        `
          const editor = document.querySelector('[data-testid="work-item-comment-editor-textarea"]');
          const preview = document.querySelector('[data-testid="work-item-discussion-trigger-preview"]');
          return editor?.value === arguments[0] &&
            preview?.getAttribute('title') === arguments[1];
        `,
        [body, rootSessionId]
      ),
    {
      timeout: CLOUD_FETCH_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} Discussion preview never targeted ${rootSessionId}`,
    }
  );
  await clickRenderedOn(
    client,
    'button[aria-label="Submit comment"]',
    `${label} Discussion submit`
  );
  await client.waitUntil(
    async () =>
      executeOn(
        client,
        `
          return Array.from(document.querySelectorAll('[data-testid^="work-item-discussion-comment-"]'))
            .some((node) => node.textContent?.includes(arguments[0]));
        `,
        [body]
      ),
    {
      timeout: CLOUD_FETCH_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} Discussion comment never rendered on ${workItemId}`,
    }
  );
}

async function continuationRecordOn(client, orgId, rootSessionId) {
  return executeOn(
    client,
    `
      const tupleKey = arguments[0];
      const legacyKey = arguments[1];
      const orgId = arguments[2];
      const rootSessionId = arguments[3];
      const entryPrefix = 'orgii:conversation-execution-v1:';
      const perConversation = Object.keys(window.localStorage)
        .filter((storageKey) => storageKey.startsWith(entryPrefix))
        .flatMap((storageKey) => {
          try {
            const executionKey = JSON.parse(
              decodeURIComponent(storageKey.slice(entryPrefix.length))
            );
            if (
              !Array.isArray(executionKey) ||
              executionKey.length !== 2 ||
              executionKey[1] !== rootSessionId ||
              typeof executionKey[0] !== 'string'
            ) {
              return [];
            }
            const executorScope = JSON.parse(executionKey[0]);
            if (
              !Array.isArray(executorScope) ||
              executorScope[0] !== 'cloud-conversation-executor' ||
              executorScope[2] !== orgId
            ) {
              return [];
            }
            const envelope = JSON.parse(window.localStorage.getItem(storageKey));
            return envelope?.version === 1 && envelope.continuation
              ? [envelope.continuation]
              : [];
          } catch {
            return [];
          }
        })
        .sort((left, right) =>
          String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
        );
      if (perConversation[0]) return perConversation[0];
      const unifiedRaw = window.localStorage.getItem('orgii:conversation-executions-v2');
      if (unifiedRaw) {
        try {
          const unified = JSON.parse(unifiedRaw);
          const executions = unified?.version === 2 ? unified.executions : null;
          const exact = executions?.[tupleKey]?.continuation ?? null;
          const scoped = executions
            ? Object.entries(executions)
                .flatMap(([key, execution]) => {
                  try {
                    const tuple = JSON.parse(key);
                    if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[1] !== rootSessionId) {
                      return [];
                    }
                    let scopeMatches = tuple[0] === orgId;
                    if (!scopeMatches && typeof tuple[0] === 'string') {
                      try {
                        const scope = JSON.parse(tuple[0]);
                        scopeMatches = Array.isArray(scope) &&
                          scope.includes(orgId) &&
                          scope.includes(rootSessionId);
                      } catch {
                        scopeMatches = false;
                      }
                    }
                    return scopeMatches && execution?.continuation
                      ? [execution.continuation]
                      : [];
                  } catch {
                    return [];
                  }
                })
                .sort((left, right) =>
                  String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
                )[0] ?? null
            : null;
          const record = exact ?? scoped;
          if (record) return record;
        } catch {
          // Fall through to the v1 migration source.
        }
      }
      const legacyRaw = window.localStorage.getItem('orgii:conversation-continuations-v1');
      if (!legacyRaw) return null;
      try {
        const legacy = JSON.parse(legacyRaw);
        const record = legacy[tupleKey] ?? legacy[legacyKey] ?? null;
        if (!record) return null;
        return {
          ...record,
          readThroughPlaneSeq: Number.isSafeInteger(record.readThroughPlaneSeq)
            ? record.readThroughPlaneSeq
            : Number.isSafeInteger(record.lastPlaneSeq)
              ? record.lastPlaneSeq
              : 0,
        };
      } catch {
        return null;
      }
    `,
    [
      JSON.stringify([orgId, rootSessionId]),
      `${orgId}:${rootSessionId}`,
      orgId,
      rootSessionId,
    ]
  );
}

async function waitForContinuationOn(
  client,
  orgId,
  rootSessionId,
  predicate,
  label
) {
  let record = null;
  await client.waitUntil(
    async () => {
      record = await continuationRecordOn(client, orgId, rootSessionId);
      return Boolean(record && predicate(record));
    },
    {
      timeout: 180_000,
      interval: 500,
      timeoutMsg: `${label} continuation record never reached the expected state`,
    }
  );
  return record;
}

async function listConversationPlane(envConfig, user, orgId, rootSessionId) {
  const response = await fetch(
    `${envConfig.supabaseUrl}/rest/v1/rpc/cloud_list_conversation_events`,
    {
      method: "POST",
      headers: {
        apikey: envConfig.anonKey,
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
        "content-profile": "org2_cloud",
      },
      body: JSON.stringify({
        p_org_id: orgId,
        p_root_session_id: rootSessionId,
        p_after_seq: 0,
        p_limit: 500,
      }),
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `cloud_list_conversation_events failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }
  return payload.events ?? [];
}

async function readCloudCapabilities(envConfig, user) {
  const response = await fetch(
    `${envConfig.supabaseUrl}/rest/v1/rpc/get_cloud_capabilities`,
    {
      method: "POST",
      headers: {
        apikey: envConfig.anonKey,
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
        "content-profile": "org2_cloud",
      },
      body: "{}",
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error(
      `get_cloud_capabilities failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }
  return payload;
}

async function pushConversationPlaneSeed(
  envConfig,
  user,
  orgId,
  rootSessionId,
  body
) {
  const eventId = `dual-plane-seed-${RUN_ID}`;
  const turnId = randomUUID();
  const createdAt = new Date().toISOString();
  const response = await fetch(
    `${envConfig.supabaseUrl}/rest/v1/rpc/cloud_push_conversation_events`,
    {
      method: "POST",
      headers: {
        apikey: envConfig.anonKey,
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
        "content-profile": "org2_cloud",
      },
      body: JSON.stringify({
        p_org_id: orgId,
        p_root_session_id: rootSessionId,
        p_turn_id: turnId,
        p_events: [
          {
            id: eventId,
            chunk_id: eventId,
            sessionId: rootSessionId,
            createdAt,
            functionName: "user_message",
            uiCanonical: "user_message",
            actionType: "raw",
            args: {},
            result: {
              type: "user",
              message: { content: body, role: "user" },
            },
            source: "user",
            displayText: body,
            displayStatus: "completed",
            displayVariant: "message",
            activityStatus: "agent",
            payloadRefs: [],
          },
        ],
      }),
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `cloud_push_conversation_events failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }
  const readback = await listConversationPlane(
    envConfig,
    user,
    orgId,
    rootSessionId
  );
  const row = readback.find(
    (candidate) =>
      candidate.turnId === turnId && candidate.event?.displayText === body
  );
  if (!row || row.seq !== payload.lastSeq) {
    throw new Error(
      `Neonforge plane fixture failed read-back: push=${JSON.stringify(payload)} row=${JSON.stringify(row)}`
    );
  }
  return row;
}

function latestDiscussionRun(secondInstance, workItemId) {
  const databasePath = join(
    secondInstance.orgiiHome,
    "projects",
    "projects.db"
  );
  const escapedWorkItemId = workItemId.replaceAll("'", "''");
  const output = execFileSync(
    "sqlite3",
    [
      "-json",
      databasePath,
      `SELECT id, status, session_id AS sessionId, failure_json AS failureJson, created_at AS createdAt
         FROM pm_work_item_runs
        WHERE work_item_id = '${escapedWorkItemId}' AND trigger_kind = 'discussion_comment'
        ORDER BY created_at DESC LIMIT 1;`,
    ],
    { encoding: "utf8" }
  ).trim();
  return output ? (JSON.parse(output)[0] ?? null) : null;
}

async function waitForDiscussionRun(
  client,
  secondInstance,
  workItemId,
  predicate,
  label
) {
  let run = null;
  await client.waitUntil(
    async () => {
      run = latestDiscussionRun(secondInstance, workItemId);
      return Boolean(run && predicate(run));
    },
    {
      timeout: 180_000,
      interval: 500,
      timeoutMsg: `${label} Work Item Run never reached the expected state`,
    }
  );
  return run;
}

describe("Cloud collaboration with two independent rendered app instances", function () {
  let env = null;
  let owner = null;
  let teammate = null;
  let second = null;
  let ownerPersonalOrgId = null;
  let teammatePersonalOrgId = null;
  let teamOrgId = null;
  let inviteLink = null;
  let workItemId = null;
  let cascadeWorkItemId = null;

  before(async function () {
    this.timeout(900_000);
    env = cloudEnv();
    if (!env) {
      console.warn(
        "[cloud-dual-e2e] SKIP: live E2E_CLOUD_* credentials are required."
      );
      this.skip();
    }
    const readiness = await ensureCloudSchemaReady(env);
    if (!readiness.ready) {
      throw new Error(
        `[cloud-dual-e2e] backend is not ready: ${readiness.reason}`
      );
    }

    const ownerResult = await provisionCloudUser(
      env,
      "neonforge",
      PRIMARY_INSTANCE_MEMBER_NAME
    );
    if (!ownerResult.ok) throw new Error(ownerResult.reason);
    owner = ownerResult.user;
    const teammateResult = await provisionCloudUser(
      env,
      "vantanode",
      SECONDARY_INSTANCE_MEMBER_NAME
    );
    if (!teammateResult.ok) {
      await cleanupCloudUser(env, owner);
      throw new Error(teammateResult.reason);
    }
    teammate = teammateResult.user;

    await waitForApp();
    unwrap(await invokeE2E("cloudClearAuthState"), "clear primary cloud auth");
    await applyCloudEndpointOverride(env);
    unwrap(
      await invokeE2E("cloudSeedAuthState", {
        supabaseUrl: env.supabaseUrl,
        anonKey: env.anonKey,
        userId: owner.userId,
        accessToken: owner.accessToken,
        refreshToken: owner.refreshToken,
        expiresAt: owner.expiresAt,
        displayName: PRIMARY_INSTANCE_MEMBER_NAME,
      }),
      "seed primary owner auth"
    );

    second = await startSecondCloudInstance();
    await waitForE2EOn(second.client);
    unwrapOn(
      await invokeOn(second.client, "cloudClearAuthState"),
      "clear secondary cloud auth"
    );
    await applyCloudEndpointOn(second.client, env);
    await seedAuthOn(
      second.client,
      env,
      teammate,
      SECONDARY_INSTANCE_MEMBER_NAME
    );

    const [ownerOrgs, teammateOrgs] = await Promise.all([
      (async () => {
        let orgs = [];
        await browser.waitUntil(
          async () => {
            const result = unwrap(
              await invokeE2E("cloudListOrgs"),
              "primary cloudListOrgs"
            );
            orgs = result.orgs ?? [];
            return orgs.length > 0;
          },
          {
            timeout: CLOUD_FETCH_TIMEOUT_MS,
            interval: 1_000,
            timeoutMsg: "primary personal org never loaded",
          }
        );
        return orgs;
      })(),
      waitForCloudOrgsOn(second.client, CLOUD_FETCH_TIMEOUT_MS),
    ]);
    ownerPersonalOrgId = ownerOrgs[0].orgId;
    teammatePersonalOrgId = teammateOrgs[0].orgId;
  });

  after(async function () {
    this.timeout(180_000);
    try {
      if (env && owner && teamOrgId) {
        await cloudManagementRpc(env, owner, "cloud_delete_org", {
          p_org_id: teamOrgId,
        });
      }
    } catch {}
    try {
      await invokeE2E("cloudClearAuthState");
    } catch {}
    try {
      if (second) {
        await invokeOn(second.client, "cloudClearAuthState");
        await second.stop();
      }
    } catch {}
    if (env && teammate) await cleanupCloudUser(env, teammate);
    if (env && owner) await cleanupCloudUser(env, owner);
  });

  it("A. keeps identities, personal orgs, storage, and homes isolated", async function () {
    const primaryAuth = unwrap(
      await invokeE2E("cloudReadAuthState"),
      "primary cloud auth"
    );
    const secondaryAuth = unwrapOn(
      await invokeOn(second.client, "cloudReadAuthState"),
      "secondary cloud auth"
    );
    if (primaryAuth.userId !== owner.userId) {
      throw new Error("primary app does not hold the owner identity");
    }
    if (secondaryAuth.userId !== teammate.userId) {
      throw new Error("secondary app does not hold the teammate identity");
    }
    if (primaryAuth.userId === secondaryAuth.userId) {
      throw new Error("the two rendered app instances leaked one identity");
    }
    if (ownerPersonalOrgId === teammatePersonalOrgId) {
      throw new Error("fresh users unexpectedly share one personal org");
    }
  });

  it("B. creates a team and joins the second app through the rendered invite flow", async function () {
    this.timeout(240_000);
    await openCreateOrgFormFromSidebar();
    await clickRendered(
      '[data-testid="create-collab-org-source-cloud"]',
      "primary Cloud source"
    );
    await clickRendered(
      '[data-testid="create-collab-org-mode-create"]',
      "primary create-org mode"
    );
    await typeRendered(
      '[data-testid="create-collab-org-name"]',
      TEAM_NAME,
      "primary team name"
    );
    await browser.waitUntil(
      async () =>
        execJS(`
          const button = document.querySelector('[data-testid="create-collab-org-submit"]');
          return !!button && !button.disabled;
        `),
      {
        timeout: 30_000,
        timeoutMsg: "primary create-team submit never enabled",
      }
    );
    await clickRendered(
      '[data-testid="create-collab-org-submit"]',
      "primary create-team submit"
    );
    await waitForRendered(
      '[data-testid="cloud-org-plan-section"]',
      "primary created-team plan section",
      CLOUD_CREATE_ORG_TIMEOUT_MS
    );
    await selectPrimaryCloudOrgManagementTab(
      "members",
      "primary created-team members"
    );
    await waitForRendered(
      '[data-testid="cloud-org-invites"]',
      "primary created-team invite section",
      CLOUD_CREATE_ORG_TIMEOUT_MS
    );
    await browser.waitUntil(
      async () => {
        const listed = unwrap(
          await invokeE2E("cloudListOrgs"),
          "primary org roster after create"
        );
        teamOrgId =
          listed.orgs?.find((org) => org.name === TEAM_NAME)?.orgId ?? null;
        return Boolean(teamOrgId);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: "created team never appeared in primary org roster",
      }
    );

    await clickRendered(
      '[data-testid="cloud-org-create-invite"]',
      "primary create invite"
    );
    await waitForRendered(
      '[data-testid="cloud-org-invite-link"]',
      "primary one-time invite link",
      CLOUD_FETCH_TIMEOUT_MS
    );
    inviteLink = await execJS(`
      return document.querySelector('[data-testid="cloud-org-invite-link"]')?.textContent?.trim() ?? '';
    `);
    if (!String(inviteLink).startsWith(CLOUD_INVITE_LINK_PREFIX)) {
      throw new Error(
        "rendered team invite is not a valid invite handoff link"
      );
    }

    unwrapOn(
      await invokeOn(second.client, "navigateTo", "/orgii/workstation/code"),
      "secondary navigate before invite"
    );
    unwrapOn(
      await invokeOn(second.client, "cloudSeedPendingInvite", {
        link: inviteLink,
      }),
      "secondary production invite parser"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "secondary join confirmation"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-confirm"]',
      "secondary accept invite"
    );
    await waitForGoneOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "secondary join confirmation",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await second.client.waitUntil(
      async () => {
        const listed = unwrapOn(
          await invokeOn(second.client, "cloudListOrgs"),
          "secondary org roster after join"
        );
        return listed.orgs?.some((org) => org.orgId === teamOrgId);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: "accepted team never appeared in secondary org roster",
      }
    );

    // The owner's already-open panel must converge without being reopened. The
    // signed-in owner has a dedicated About me card; member rows contain only
    // teammates, so a two-person org renders exactly those two distinct views.
    try {
      await browser.waitUntil(
        async () =>
          execJS(`
            const aboutMe = document.querySelector('[data-testid="cloud-org-about-me"]');
            const teammate = document.querySelector(
              '[data-testid="cloud-org-member-row"][data-member-id=${JSON.stringify(teammate.userId)}]'
            );
            return Boolean(aboutMe && teammate);
          `),
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "owner panel did not receive the joined teammate live",
        }
      );
    } catch (error) {
      const roster = unwrap(
        await invokeE2E("cloudInspectMemberRoster", { orgId: teamOrgId }),
        "inspect owner member roster after live timeout"
      );
      const renderedRows = await execJS(`
        return [...document.querySelectorAll('[data-testid="cloud-org-member-row"]')].map((row) => ({
          memberId: row.getAttribute('data-member-id'),
          text: row.textContent?.trim() ?? '',
        }));
      `);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify({ roster, renderedRows })}`
      );
    }
  });

  it("C. directly shares a restricted replay without a link; teammate receives, filters, imports, forks, and comments", async function () {
    this.timeout(
      E2E_PROVIDER_MODE === "oauth-live" ||
        process.env.E2E_COMPUTER_USE_MANUAL === "1"
        ? 900_000
        : 360_000
    );
    unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "primary ensure shared repository"
    );
    // Repo selection only seeds inventory; the primary Add, option click, and
    // Save below remain the production rendered governance path.
    unwrapOn(
      await invokeOn(second.client, "ensureRepoSelected", {
        repoPath: SECONDARY_E2E_REPO_PATH,
      }),
      "secondary ensure shared repository"
    );
    if (E2E_PROVIDER_MODE === "mock") {
      unwrapOn(
        await invokeOn(second.client, "addAccount", {
          openaiApiKey: "sk-orgii-rendered-e2e-not-sent",
          model: FORK_E2E_MODEL,
          accountName: `Cloud fork rendered E2E ${RUN_ID}`,
        }),
        "secondary seed rendered mock fork account"
      );
    } else {
      const secondaryAccount = await getSecondaryForkAccount(second.client);
      if (secondaryAccount.name !== second.seededAccountName) {
        throw new Error(
          `Second app selected ${secondaryAccount.name ?? secondaryAccount.id}, expected isolated ${second.seededAccountName}`
        );
      }
    }

    await openCloudOrgPanelFromSidebar(teamOrgId);
    await selectPrimaryCloudOrgManagementTab(
      "general",
      "primary team repo scope in General"
    );
    await waitForRendered(
      '[data-testid="cloud-org-repo-scope"]',
      "primary team repo scope",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRendered(
      '[data-testid="cloud-org-add-repo-scope"]',
      "show primary repository scope picker"
    );
    const primaryScopeResolution = unwrap(
      await invokeE2E("cloudResolveRepoScopeKeys", {
        repoPath: E2E_REPO_PATH,
      }),
      "resolve primary fork remotes"
    );
    const secondaryScopeResolution = unwrapOn(
      await invokeOn(second.client, "cloudResolveRepoScopeKeys", {
        repoPath: SECONDARY_E2E_REPO_PATH,
      }),
      "resolve secondary upstream remotes"
    );
    if (
      !primaryScopeResolution.keys?.includes(EXPECTED_REPO_NETWORK_SCOPE) ||
      !secondaryScopeResolution.keys?.includes(EXPECTED_REPO_NETWORK_SCOPE)
    ) {
      throw new Error(
        `real fork checkouts do not share expected upstream ${EXPECTED_REPO_NETWORK_SCOPE}: ${JSON.stringify({ primary: primaryScopeResolution.keys, secondary: secondaryScopeResolution.keys })}`
      );
    }
    await browser.waitUntil(
      async () => {
        const selectable = await execJS(`
          return [...document.querySelectorAll('[data-testid="cloud-org-repo-scope"] button span[title]')]
            .map((label) => ({
              key: label.getAttribute('title'),
              disabled: !!label.closest('button')?.disabled,
            }));
        `);
        const available = selectable.find(
          (entry) =>
            !entry.disabled && primaryScopeResolution.keys?.includes(entry.key)
        );
        if (available?.key) repoScopeKey = available.key;
        return Boolean(available);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "primary repo scope option never became available",
      }
    );
    const scopeOptionMarked = await execJS(`
      const expected = ${JSON.stringify(repoScopeKey)};
      const labels = [...document.querySelectorAll('[data-testid="cloud-org-repo-scope"] button span[title]')];
      const button = labels.find((label) => label.getAttribute('title') === expected)?.closest('button');
      button?.setAttribute('data-e2e-repo-scope-target', 'true');
      return Boolean(button);
    `);
    if (!scopeOptionMarked) {
      throw new Error(`primary repo scope option disappeared: ${repoScopeKey}`);
    }
    await clickRendered(
      '[data-e2e-repo-scope-target="true"]',
      "primary select team repo scope"
    );
    await browser.waitUntil(
      async () =>
        execJS(
          `
            const save = document.querySelector('[data-testid="cloud-org-save-repo-scopes"]');
            const cancel = document.querySelector('[data-testid="cloud-org-cancel-repo-scopes"]');
            const add = document.querySelector('[data-testid="cloud-org-add-repo-scope"]');
            return !!save && !save.disabled && !!cancel && save.closest('.section-layout-row') === add?.closest('.section-layout-row');
          `
        ),
      {
        timeout: 30_000,
        timeoutMsg: "primary repo-scope save never enabled",
      }
    );
    await clickRendered(
      '[data-testid="cloud-org-save-repo-scopes"]',
      "primary save team repo scope"
    );
    await browser.waitUntil(
      async () =>
        execJS(
          `
            const section = document.querySelector('[data-testid="cloud-org-repo-scope"]');
            const save = document.querySelector('[data-testid="cloud-org-save-repo-scopes"]');
            const cancel = document.querySelector('[data-testid="cloud-org-cancel-repo-scopes"]');
            return !!section && !save && !cancel && section.textContent.includes(${JSON.stringify(repoScopeKey)});
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "team repo scope never reached its saved state",
      }
    );

    const ownerAgentAccount = await getApiAccount();
    const ownerAgentModel = selectPreferredModel(ownerAgentAccount);
    const ownerAgentConfig = unwrap(
      await invokeE2E("configureWithExistingKey", {
        accountName: ownerAgentAccount.name ?? ownerAgentAccount.id,
        model: ownerAgentModel,
        agentType: ownerAgentAccount.agent_type,
        category: "rust_agent",
        agentDefinitionId: "builtin:sde",
        repoPath: E2E_REPO_PATH,
      }),
      "configure runnable owner agent for comment addressing"
    );
    if (ownerAgentConfig.modelId !== ownerAgentModel) {
      throw new Error(
        `owner comment agent selected ${ownerAgentConfig.modelId}, expected ${ownerAgentModel}`
      );
    }
    // Materialize a real persisted provider-backed session through the same
    // launch bridge as production before installing deterministic shared
    // history. The rendered model pill and tool snapshot below prove that the
    // later @agent and Address Comments assertions exercise a runnable source.
    const launchedOwnerSession = unwrap(
      await invokeE2E("launchSession", {
        category: "rust_agent",
        content: `Prepare rendered cloud-comment source ${RUN_ID}. Reply briefly.`,
        workspacePath: E2E_REPO_PATH,
        keySource: "own_key",
        accountId: ownerAgentConfig.accountId,
        model: ownerAgentConfig.modelId,
        agentDefinitionId: "builtin:sde",
        mode: "build",
        background: false,
      }),
      "launch runnable owner comment source"
    ).result;
    const launchedOwnerSessionId =
      launchedOwnerSession?.sessionId ?? launchedOwnerSession?.session_id;
    if (!launchedOwnerSessionId) {
      throw new Error(
        `runnable owner launch returned no session id: ${JSON.stringify(launchedOwnerSession)}`
      );
    }
    if (
      launchedOwnerSession?.model !== ownerAgentModel ||
      launchedOwnerSession?.accountId !== ownerAgentConfig.accountId
    ) {
      throw new Error(
        `runnable owner launch lost model/account: ${JSON.stringify(launchedOwnerSession)}`
      );
    }
    // launchSession returns as soon as the real provider turn is queued. Wait
    // for that turn to finish before replacing its transcript with the
    // deterministic sharing fixture; otherwise a late native event can race
    // in after seedChatEvents and change the visible/latest comment anchor.
    await browser.waitUntil(
      async () => {
        const state = unwrap(
          await invokeE2E("inspectChatState"),
          "inspect runnable owner launch completion"
        );
        const providerReplied = (state.chatEvents ?? []).some(
          (event) =>
            event.source === "assistant" &&
            typeof event.displayText === "string" &&
            event.displayText.trim().length > 0
        );
        const terminal =
          state.runtimeStatus !== "running" &&
          state.runtimeStatus !== "installing" &&
          state.turnPhase === "idle" &&
          !state.isSessionActive;
        return (
          state.activeSessionId === launchedOwnerSessionId &&
          providerReplied &&
          terminal
        );
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "real owner provider turn did not complete before deterministic sharing seed",
      }
    );
    bindRunnableSourceSession(launchedOwnerSessionId);
    await seedAndOpenCloudEligibleSession(sessionId, SESSION_TITLE, {
      touchedFilePath: join(E2E_REPO_PATH, SESSION_BLAME_FILE),
      additionalTurns: 2,
    });
    await waitForRendered(
      '[data-testid="chat-model-pill-model"]',
      "owner runnable model pill",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const ownerModelPill = String(
      (await execJS(
        `return document.querySelector('[data-testid="chat-model-pill-model"]')?.textContent?.trim() ?? '';`
      )) ?? ""
    );
    if (!ownerModelPill || /select model/i.test(ownerModelPill)) {
      throw new Error(
        `owner source session is not runnable before @agent: ${ownerModelPill}`
      );
    }
    const ownerToolSnapshot = unwrap(
      await invokeE2E("debugSessionToolsSnapshot", sessionId),
      "inspect owner comment tool contract"
    ).snapshot;
    const registeredOwnerTools = ownerToolSnapshot?.registeredToolNames ?? [];
    const promptedOwnerTools = ownerToolSnapshot?.promptToolNames ?? [];
    if (
      !registeredOwnerTools.includes("reply_session_comment") ||
      !promptedOwnerTools.includes("reply_session_comment")
    ) {
      throw new Error(
        `owner source session cannot address cloud comments: ${JSON.stringify({
          registered: registeredOwnerTools,
          prompted: promptedOwnerTools,
        })}`
      );
    }
    unwrap(
      await invokeE2E("cloudTagSessionToOrg", {
        sessionId,
        orgId: teamOrgId,
      }),
      "tag owner session to team"
    );
    // Start at metadata-only: the rendered directed-share button must promote
    // and publish the full replay itself before creating the grant. This is
    // the one-click UX contract; no hidden pre-share sync-level step.
    await setCloudSessionModeViaDialog(sessionId, teamOrgId, "metadata_only");
    await setCloudSessionVisibilityViaDialog(
      sessionId,
      teamOrgId,
      "restricted"
    );
    await publishCloudSessionMetadata(env, owner, {
      orgId: teamOrgId,
      sessionId,
      title: SESSION_TITLE,
      repoScopeKey,
      visibility: "restricted",
      accessMode: "metadata_only",
    });

    await selectCloudOrgOn(second.client, teamOrgId);
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-team-sessions-empty"]',
      "secondary empty restricted team section",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const leakedBeforeShare = await executeOn(
      second.client,
      "return !!document.querySelector(arguments[0]);",
      [`[data-testid="sidebar-cloud-session-item-${sessionId}"]`]
    );
    if (leakedBeforeShare) {
      throw new Error("restricted session leaked to teammate before sharing");
    }

    await clickRendered(
      '[data-testid="chat-panel-header-more-button"]',
      "owner chat header more menu"
    );
    await clickRendered(
      '[data-testid="cloud-session-share-settings-button"]',
      "owner cloud share settings"
    );
    await waitForRendered(
      `[data-testid="cloud-session-share-member-${teammate.userId}"]`,
      "owner teammate share checkbox",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRendered(
      `[data-testid="cloud-session-share-member-${teammate.userId}"] label`,
      "owner select teammate"
    );
    await browser.waitUntil(
      async () =>
        execJS(
          `
            const button = document.querySelector('[data-testid="cloud-session-share-create-directed"]');
            return !!button && !button.disabled;
          `
        ),
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg:
          "directed-share button never enabled after member selection",
      }
    );
    await clickRendered(
      '[data-testid="cloud-session-share-create-directed"]',
      "owner create directed share"
    );
    await waitForRendered(
      `[data-testid="cloud-session-share-directed-revoke-${teammate.userId}"]`,
      "owner active directed grant",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const unexpectedLink = await execJS(
      `return !!document.querySelector('[data-testid="cloud-session-share-created-link"]');`
    );
    if (unexpectedLink) {
      throw new Error("direct member sharing unexpectedly generated a link");
    }
    await pressEscape();

    await waitForRenderedOn(
      second.client,
      remoteRowSelector,
      "secondary realtime directed session",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-team-sessions-filter"]',
      "secondary Team filter"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="sidebar-cloud-filter-directly-shared-with-me"]',
      "secondary directly-shared filter"
    );
    await waitForRenderedOn(
      second.client,
      remoteRowSelector,
      "directed session under Shared with me filter"
    );

    await clickRenderedOn(
      second.client,
      remoteRowSelector,
      "secondary import/replay shared session"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-fork-button"]',
      "secondary imported-session fork action",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const unexpectedSharedByChip = await executeOn(
      second.client,
      `return !!document.querySelector('[data-testid="session-imported-from-chip"]');`
    );
    if (unexpectedSharedByChip) {
      throw new Error(
        "imported Team Session header still shows a shared-by chip"
      );
    }

    const importedState = unwrapOn(
      await invokeOn(second.client, "inspectChatState"),
      "secondary imported replay state"
    );
    secondaryImportedSessionId = importedState.activeSessionId;
    if (
      !secondaryImportedSessionId ||
      secondaryImportedSessionId === sessionId
    ) {
      throw new Error(
        `secondary replay did not materialize a distinct local session: ${JSON.stringify(importedState)}`
      );
    }

    // Full-replay authorization is also the authorization boundary for Team
    // Session Blame. The imported transcript must be projected locally with
    // the owner's identity; no second cloud provenance database is involved.
    let collaborationHistory = null;
    await second.client.waitUntil(
      async () => {
        const result = unwrapOn(
          await invokeOn(second.client, "inspectOrgtrackFileSessionHistory", {
            repoPath: SECONDARY_E2E_REPO_PATH,
            filePath: SESSION_BLAME_FILE,
          }),
          "secondary Team Session Blame projection"
        );
        collaborationHistory = result.history?.sessions?.find(
          (session) =>
            session.sessionId === secondaryImportedSessionId &&
            session.source === "orgii_cloud_replay"
        );
        return Boolean(collaborationHistory);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "authorized replay never produced local Team Session Blame",
      }
    );
    if (
      collaborationHistory.collaborationOrigin?.orgId !== teamOrgId ||
      collaborationHistory.collaborationOrigin?.sessionRowId !==
        `${teamOrgId}:${owner.userId}:${sessionId}` ||
      collaborationHistory.collaborationOrigin?.ownerDisplayName !==
        PRIMARY_INSTANCE_MEMBER_NAME ||
      collaborationHistory.actionCounts?.read !== 1
    ) {
      throw new Error(
        `Team Session Blame identity/actions are wrong: ${JSON.stringify(collaborationHistory)}`
      );
    }

    // Deliberately hide the owner row with a member filter, then leave the
    // team scope. Clicking blame must restore the exact cloud org and row
    // without rewriting that saved filter. Member filter options derive from
    // LISTED rows' owners, so seed one teammate-owned row first — without it
    // the teammate has no rows and their filter option can never render.
    const teammateRowSessionId = `dual-instance-teammate-row-${RUN_ID}`;
    await publishCloudSessionMetadata(env, teammate, {
      orgId: teamOrgId,
      sessionId: teammateRowSessionId,
      title: `Teammate filter row ${RUN_ID}`,
      repoScopeKey,
    });
    // C deliberately left "Shared with me" active, so the teammate's own
    // row must remain hidden until the member filter changes. Refresh the
    // complete inventory first; waiting for that row under the old filter
    // would assert the opposite of the production UX.
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-team-sessions-refresh"]',
      "secondary refresh Team sessions before member filter"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-team-sessions-filter"]',
      "secondary Team filter before blame navigation"
    );
    await waitForRenderedOn(
      second.client,
      `[data-testid="sidebar-cloud-filter-member-${teammate.userId}"]`,
      "secondary teammate member filter option",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      `[data-testid="sidebar-cloud-filter-member-${teammate.userId}"]`,
      "secondary filter to own sessions"
    );
    await waitForRenderedOn(
      second.client,
      `[data-testid="sidebar-cloud-session-item-${teammateRowSessionId}"]`,
      "teammate row under teammate-only filter",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForGoneOn(
      second.client,
      remoteRowSelector,
      "owner row under teammate-only filter"
    );
    await selectCloudOrgOn(second.client, teammatePersonalOrgId);
    await openFileTimelineOn(
      second.client,
      join(SECONDARY_E2E_REPO_PATH, SESSION_BLAME_FILE)
    );
    const teamBlameSelector =
      `[data-testid="session-blame-session"]` +
      `[data-session-id="${secondaryImportedSessionId}"]` +
      `[data-session-source="orgii_cloud_replay"]` +
      ` [data-testid="session-blame-session-header"]`;
    await waitForRenderedOn(
      second.client,
      teamBlameSelector,
      "rendered Team Session Blame row",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const blameText = await executeOn(
      second.client,
      "return document.querySelector(arguments[0])?.textContent ?? '';",
      [teamBlameSelector]
    );
    if (!String(blameText).includes(`@${PRIMARY_INSTANCE_MEMBER_NAME}`)) {
      throw new Error(`Team Session Blame lost owner identity: ${blameText}`);
    }
    await clickRenderedOn(
      second.client,
      teamBlameSelector,
      "secondary open Team Session from blame"
    );
    await second.client.waitUntil(
      async () => {
        const [state, navigation] = await Promise.all([
          invokeOn(second.client, "inspectChatState"),
          executeOn(
            second.client,
            `
              const scope = document.querySelector('[data-testid="sidebar-org-selector-scope"]');
              const row = document.querySelector(arguments[0]);
              return {
                orgId: scope?.getAttribute('data-org-id') ?? null,
                rowPresent: Boolean(row),
                rowSelected: row?.getAttribute('data-selected') === 'true',
              };
            `,
            [remoteRowSelector]
          ),
        ]);
        return (
          state.ok === true &&
          state.activeSessionId === secondaryImportedSessionId &&
          navigation.orgId === `cloud:${teamOrgId}` &&
          navigation.rowPresent &&
          navigation.rowSelected
        );
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "Team Session Blame did not reveal its exact filtered cloud row",
      }
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-team-sessions-filter"]',
      "secondary inspect preserved Team filter"
    );
    const filterPreserved = await executeOn(
      second.client,
      `return document.querySelector(arguments[0])?.getAttribute('aria-selected') === 'true';`,
      [`[data-testid="sidebar-cloud-filter-member-${teammate.userId}"]`]
    );
    if (!filterPreserved) {
      throw new Error(
        "blame navigation mutated the saved Team Sessions filter"
      );
    }
    await pressEscapeOn(second.client);

    // Presence is a separate, ephemeral plane: the teammate must see the
    // owner viewing the same cloud session, lose the chip when the owner
    // leaves, and regain it when the owner re-opens the session.
    const ownerViewerChip = '[data-testid="session-viewers-indicator"]';
    try {
      await waitForRenderedOn(
        second.client,
        ownerViewerChip,
        "secondary live owner viewer chip",
        CLOUD_FETCH_TIMEOUT_MS
      );
    } catch (error) {
      const [ownerPresence, teammatePresence] = await Promise.all([
        invokeE2E("cloudInspectPresence"),
        invokeOn(second.client, "cloudInspectPresence"),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `owner presence: ${JSON.stringify(ownerPresence)}\n` +
          `teammate presence: ${JSON.stringify(teammatePresence)}`
      );
    }
    const viewerLabel = await executeOn(
      second.client,
      "return document.querySelector(arguments[0])?.getAttribute('aria-label') ?? '';",
      [ownerViewerChip]
    );
    if (!String(viewerLabel).includes(PRIMARY_INSTANCE_MEMBER_NAME)) {
      throw new Error(`viewer chip did not identify the owner: ${viewerLabel}`);
    }
    const viewerLivesInPublishedHeader = await executeOn(
      second.client,
      `return !!document.querySelector(
        '[data-testid="chat-panel-published-header"] [data-testid="session-viewers-indicator"]'
      );`
    );
    if (!viewerLivesInPublishedHeader) {
      throw new Error(
        "viewer chip rendered outside the published session header"
      );
    }
    unwrap(await invokeE2E("resetToNewSession"), "owner leave shared session");
    try {
      await waitForGoneOn(
        second.client,
        ownerViewerChip,
        "secondary owner viewer chip after owner leaves",
        CLOUD_FETCH_TIMEOUT_MS
      );
    } catch (error) {
      const [ownerPresence, teammatePresence] = await Promise.all([
        invokeE2E("cloudInspectPresence"),
        invokeOn(second.client, "cloudInspectPresence"),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `owner presence after leave: ${JSON.stringify(ownerPresence)}\n` +
          `teammate presence after owner leave: ${JSON.stringify(teammatePresence)}`
      );
    }
    unwrap(await invokeE2E("openSession", sessionId), "owner reopen session");
    try {
      await waitForRenderedOn(
        second.client,
        ownerViewerChip,
        "secondary owner viewer chip after owner returns",
        CLOUD_FETCH_TIMEOUT_MS
      );
    } catch (error) {
      const [ownerPresence, teammatePresence] = await Promise.all([
        invokeE2E("cloudInspectPresence"),
        invokeOn(second.client, "cloudInspectPresence"),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `owner presence after reopen: ${JSON.stringify(ownerPresence)}\n` +
          `teammate presence after reopen: ${JSON.stringify(teammatePresence)}`
      );
    }

    // Keep the owner's comment panel open before the teammate writes; the
    // new row must arrive without a refresh or re-open.
    const renderedSourceTurnAnchor = await captureRenderedSourceTurnAnchor();
    await openTurnCommentPanel(renderedSourceTurnAnchor).catch(
      async (error) => {
        const [debug, chat] = await Promise.all([
          invokeE2E("cloudInspectDebugState", { sessionId }),
          invokeE2E("inspectChatState"),
        ]);
        const groupView = await execJS(`
        return {
          groupPending: !!document.querySelector('[data-testid="agent-org-group-chat-pending"]'),
          anchors: document.querySelectorAll('[data-testid^="session-comment-toggle-"]').length,
          turnRows: document.querySelectorAll('[data-testid="chat-message-user-editable"]').length,
        };
      `);
        throw new Error(
          `${error.message}\nowner comment debug: ${JSON.stringify(debug?.debug ?? debug).slice(0, 900)}\nowner chat state: ${JSON.stringify({ active: chat?.activeSessionId, events: chat?.chatEventCount, ids: (chat?.chatEvents ?? []).slice(0, 4).map((e) => e.id) })}\ngroup view probe: ${JSON.stringify(groupView)}`
        );
      }
    );
    await clickRenderedOn(
      second.client,
      secondaryImportedTurnToggleSelector,
      "secondary turn comment toggle"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-comment-composer"] textarea',
      "secondary turn comment composer"
    );
    await typeRenderedOn(
      second.client,
      '[data-testid="session-comment-composer"] textarea',
      "@",
      "secondary non-owner @ prefix"
    );
    await second.client.pause(750);
    const nonOwnerSuggestion = await executeOn(
      second.client,
      `return !!document.querySelector('[data-testid="session-comment-agent-suggestion"]');`
    );
    if (nonOwnerSuggestion) {
      throw new Error(
        "non-owner imported replay exposed the owner-only @agent suggestion"
      );
    }
    await postCommentOn(second.client, COMMENT_BODY);
    await waitForRendered(
      '[data-testid="session-comment-row"]',
      "owner realtime teammate comment",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForRendered(
      '[data-testid="comment-agent-mention-pill"]',
      "owner rendered @agent mention pill",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForGoneOn(
      second.client,
      '[data-testid="comment-thread-agent-status"]',
      "non-owner @agent execution status"
    );

    // Owner-authored @agent is a single-thread queue action. Drive the
    // ordinary rendered composer, then prove the production agent/tool bridge
    // replied only under that new thread (the teammate's literal @agent text
    // above must remain ordinary comment content).
    await postTurnComment(OWNER_AGENT_COMMENT_BODY);
    await browser.waitUntil(
      async () =>
        execJS(`
          const rows = Array.from(document.querySelectorAll('[data-testid="session-comment-row"]'));
          const ownerRow = rows.find((row) => row.textContent?.includes(${JSON.stringify(OWNER_AGENT_COMMENT_BODY.slice("@agent ".length))}));
          const teammateRow = rows.find((row) => row.textContent?.includes(${JSON.stringify(COMMENT_BODY.slice("@agent ".length))}));
          const ownerReplies = ownerRow?.parentElement?.querySelectorAll('[data-testid="comment-agent-affix"]').length ?? 0;
          const teammateReplies = teammateRow?.parentElement?.querySelectorAll('[data-testid="comment-agent-affix"]').length ?? 0;
          return ownerReplies === 1 && teammateReplies === 0;
        `),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "owner single @agent did not produce exactly one scoped Agent reply",
      }
    );

    // Session-level notes use the same durable/realtime plane but carry no
    // round event id. Prove the second instance can post one and the owner
    // receives it live, independently from the per-round thread above.
    await clickRendered(
      '[data-testid="session-notes-button"]',
      "owner session notes"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="session-notes-button"]',
      "secondary session notes"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-comment-composer"] textarea',
      "secondary session note composer"
    );
    await postCommentOn(second.client, SESSION_NOTE_BODY);
    await browser.waitUntil(
      async () =>
        visibleTextIncludesOn(
          browser,
          '[data-testid="session-comment-row"]',
          SESSION_NOTE_BODY
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "owner did not receive the session-level note live",
      }
    );
    await pressEscape();
    await pressEscapeOn(second.client);

    // Address Comments is the multi-thread action. Select exactly one
    // session note plus the teammate's round comment through the rendered
    // flyout, submit through the normal chat input, and verify one Agent
    // reply lands in each selected scope while the earlier owner-only thread
    // remains single-addressed.
    await clickRendered(
      `[data-testid="session-comment-toggle-${sourceTurnAnchorEventId}"]`,
      "owner close turn comments before Address Comments"
    );
    await waitForGone(
      '[data-testid="session-comment-composer"] textarea',
      "owner comment composer before Address Comments"
    );
    const batchOptionCount = await openAddressCommentsFlyout();
    if (batchOptionCount < 3) {
      throw new Error(
        `Address Comments should list the session note and both round threads: ${batchOptionCount}`
      );
    }
    await selectAddressCommentsForBatch();
    await confirmAddressCommentsFlyout();
    const semanticPillPresent = await execJS(`
      return Array.from(document.querySelectorAll('[data-composer-pill="true"][data-icon-type="skill"]'))
        .some((pill) => (pill.getAttribute('data-file-path') || '').startsWith('/address-comments:'));
    `);
    if (!semanticPillPresent) {
      throw new Error(
        "Address Comments confirmation did not insert its semantic composer pill"
      );
    }
    await clickRendered(
      '[data-testid="chat-send-button"]',
      "owner send two-thread Address Comments round"
    );
    await browser.waitUntil(
      async () => {
        const state = unwrap(
          await invokeE2E("inspectChatState"),
          "inspect owner Address Comments round"
        );
        const dispatched = (state.chatEvents ?? []).some(
          (event) =>
            event.source === "user" &&
            event.displayText === "@agent Address 2 cloud comment threads"
        );
        const terminal =
          state.runtimeStatus !== "running" &&
          state.runtimeStatus !== "installing" &&
          state.turnPhase === "idle" &&
          !state.isSessionActive;
        return dispatched && terminal;
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "two-thread Address Comments round never dispatched and completed in place",
      }
    );
    await clickRendered(
      '[data-testid="session-notes-button"]',
      "owner reopen session notes after Address Comments"
    );
    await browser.waitUntil(
      async () =>
        execJS(`
          const rows = Array.from(document.querySelectorAll('[data-testid="session-comment-row"]'));
          const note = rows.find((row) => row.textContent?.includes(${JSON.stringify(SESSION_NOTE_BODY)}));
          return (note?.parentElement?.querySelectorAll('[data-testid="comment-agent-affix"]').length ?? 0) === 1;
        `),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "Address Comments did not post an Agent reply to the selected session note",
      }
    );
    await pressEscape();
    await openTurnCommentPanel(sourceTurnAnchorEventId);
    await browser.waitUntil(
      async () =>
        execJS(`
          const rows = Array.from(document.querySelectorAll('[data-testid="session-comment-row"]'));
          const teammateRow = rows.find((row) => row.textContent?.includes(${JSON.stringify(COMMENT_BODY.slice("@agent ".length))}));
          const ownerRow = rows.find((row) => row.textContent?.includes(${JSON.stringify(OWNER_AGENT_COMMENT_BODY.slice("@agent ".length))}));
          const teammateReplies = teammateRow?.parentElement?.querySelectorAll('[data-testid="comment-agent-affix"]').length ?? 0;
          const ownerReplies = ownerRow?.parentElement?.querySelectorAll('[data-testid="comment-agent-affix"]').length ?? 0;
          return teammateReplies === 1 && ownerReplies === 1;
        `),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "Address Comments did not address exactly the selected round thread",
      }
    );

    const forkAgentId = `e2e-fork-agent-${RUN_ID}`;
    const forkAgentName = `E2E Fork Agent ${RUN_ID}`;
    unwrapOn(
      await invokeOn(second.client, "addAgentDef", {
        id: forkAgentId,
        name: forkAgentName,
        description: "Non-default agent for fork persistence evidence.",
        builtIn: false,
        tier: "primary",
        inheritsFrom: "builtin:sde",
        capabilities: { coding: { modeSwitch: true } },
        delegationConfig: { delegatable: true, contextBuilders: [] },
        sessionModel: {
          mode: "singleton",
          processingLock: true,
          maxIterations: 3,
        },
        agentPolicy: {
          autonomy: "full",
          workspaceOnly: true,
          blockedCommands: [],
          riskRules: { medium: [], high: [] },
        },
        tools: { userAllowedTools: [], excludedTools: [] },
        skillsConfig: {
          enabled: true,
          include: [],
          exclude: [],
          sourceDirs: [],
        },
      }),
      "secondary add non-default fork agent"
    );
    unwrapOn(
      await invokeOn(second.client, "refreshAgentDefs"),
      "secondary refresh agent defs"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="session-fork-button"]',
      "secondary fork imported session"
    );
    await completeForkSetupOn(second.client, "secondary explicit fork", {
      agentName: forkAgentName,
    });
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-forked-from-chip"]',
      "secondary fork provenance",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const forkActive = unwrapOn(
      await invokeOn(second.client, "getActiveSessionId"),
      "secondary fork active session"
    );
    const forkRow = unwrapOn(
      await invokeOn(
        second.client,
        "getSessionAggregateRow",
        forkActive.sessionId
      ),
      "secondary fork persisted row"
    ).session;
    if (forkRow?.agentDefinitionId !== forkAgentId) {
      throw new Error(
        `fork persisted agent_definition_id=${forkRow?.agentDefinitionId ?? "<none>"}, expected the selected ${forkAgentId}`
      );
    }
    const forkState = unwrapOn(
      await invokeOn(second.client, "inspectChatState"),
      "secondary fork inherited history"
    );
    if (
      forkState.chatEventCount < 6 ||
      !(forkState.chatEvents ?? []).some(
        (event) => event.displayText === SESSION_TITLE
      ) ||
      !(forkState.chatEvents ?? []).some(
        (event) => event.displayText === "Inherited answer 2"
      )
    ) {
      throw new Error(
        `fork dropped the inherited source turn: ${JSON.stringify(forkState.chatEvents ?? [])}`
      );
    }
    await assertAddressCommentsUnavailableOn(
      second.client,
      "secondary writable fork"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="session-forked-from-chip"]',
      "secondary open fork parent"
    );
    await second.client.waitUntil(
      async () => {
        const state = unwrapOn(
          await invokeOn(second.client, "inspectChatState"),
          "secondary imported parent after fork navigation"
        );
        const header = await executeOn(
          second.client,
          `return {
            forkAction: !!document.querySelector('[data-testid="session-fork-button"]'),
            forkProvenance: !!document.querySelector('[data-testid="session-forked-from-chip"]'),
          };`
        );
        return (
          state.activeSessionId === secondaryImportedSessionId &&
          header.forkAction &&
          !header.forkProvenance
        );
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "secondary fork parent did not become the active imported replay",
      }
    );

    // Coexistence / steal-back regression (event-id collision). The parent
    // reopen above re-persists it. Before per-session id namespacing the fork
    // and its parent import shared the source event ids (the events table PK
    // is `id` alone), so re-persisting one STOLE the shared rows from the
    // other — the fork's inherited history vanished the moment the parent was
    // opened. Assert BOTH copies still hold the full inherited transcript.
    const parentAfterReopen = unwrapOn(
      await invokeOn(second.client, "inspectChatState"),
      "secondary parent import after reopen"
    );
    if (
      parentAfterReopen.chatEventCount < 6 ||
      !(parentAfterReopen.chatEvents ?? []).some(
        (event) => event.displayText === "Inherited answer 2"
      )
    ) {
      throw new Error(
        `parent import lost inherited history after fork (event-id collision): ${JSON.stringify(parentAfterReopen.chatEvents ?? [])}`
      );
    }
    await invokeOn(second.client, "openSession", forkActive.sessionId);
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-forked-from-chip"]',
      "secondary fork reopened after parent",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const forkAfterParent = unwrapOn(
      await invokeOn(second.client, "inspectChatState"),
      "secondary fork inherited history after parent reopen"
    );
    if (
      forkAfterParent.activeSessionId !== forkActive.sessionId ||
      forkAfterParent.chatEventCount < 6 ||
      !(forkAfterParent.chatEvents ?? []).some(
        (event) => event.displayText === "Inherited answer 2"
      )
    ) {
      throw new Error(
        `fork lost inherited history after the parent was reopened (event-id collision steal-back): ${JSON.stringify(forkAfterParent.chatEvents ?? [])}`
      );
    }
  });

  it("C2. delivers a structured member mention and persists the teammate read receipt", async function () {
    this.timeout(180_000);

    unwrap(
      await invokeE2E("openSession", sessionId),
      "primary reopen source session for Team Inbox mention"
    );
    await openTurnCommentPanel(sourceTurnAnchorEventId);
    await postTurnCommentMentioning(TEAM_INBOX_MENTION_BODY, teammate.userId);
    await waitForRendered(
      '[data-testid="comment-member-mention-pill"]',
      "primary rendered teammate mention chip",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await waitForRenderedOn(
      second.client,
      '[data-testid="sidebar-team-inbox"]',
      "secondary Team Inbox navigation",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="sidebar-team-inbox"]',
      "secondary Team Inbox navigation"
    );
    await second.client.waitUntil(
      async () =>
        executeOn(
          second.client,
          `
            const body = arguments[0];
            const row = Array.from(
              document.querySelectorAll(
                '[data-testid="team-inbox-row"][data-item-kind="comment_mention"]'
              )
            ).find((candidate) => (candidate.textContent ?? '').includes(body));
            if (!row) return false;
            row.setAttribute('data-e2e-team-inbox-mention', 'true');
            return row.getAttribute('data-unread') === 'true';
          `,
          [TEAM_INBOX_MENTION_BODY]
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "secondary Team Inbox never rendered the teammate mention as unread",
      }
    );

    await clickRenderedOn(
      second.client,
      '[data-e2e-team-inbox-mention="true"]',
      "secondary unread Team Inbox mention"
    );

    let teammateInbox = null;
    await second.client.waitUntil(
      async () => {
        teammateInbox = await callProjectsRpc(
          env,
          teammate,
          "cloud_list_team_inbox_mentions",
          { p_org_id: teamOrgId, p_cursor: null, p_limit: 50 }
        );
        const mention = (teammateInbox?.mentions ?? []).find(
          (entry) => entry.body === TEAM_INBOX_MENTION_BODY
        );
        return Boolean(mention?.readAt && teammateInbox.unreadCount === 0);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg:
          "secondary click did not persist the viewer-scoped cloud read receipt",
      }
    );

    const ownerInbox = await callProjectsRpc(
      env,
      owner,
      "cloud_list_team_inbox_mentions",
      { p_org_id: teamOrgId, p_cursor: null, p_limit: 50 }
    );
    if (
      (ownerInbox?.mentions ?? []).some(
        (entry) => entry.body === TEAM_INBOX_MENTION_BODY
      )
    ) {
      throw new Error(
        "mention projection leaked the teammate-targeted comment into the owner Inbox"
      );
    }
  });

  it("D. syncs comment CRUD/status, intercepts send into a same-remote fork, and revokes directed access live", async function () {
    this.timeout(360_000);

    // C ends on a writable fork. Re-open the remote row to return to its
    // imported replay before exercising edit/status and intercept-send.
    await clickRenderedOn(
      second.client,
      remoteRowSelector,
      "secondary reopen imported replay"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-fork-button"]',
      "secondary imported replay fork action",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      secondaryImportedTurnToggleSelector,
      "secondary reopen turn comment panel"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-comment-row"]',
      "secondary existing comment thread",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await clickRenderedOn(
      second.client,
      '[data-testid="session-comment-edit"]',
      "secondary edit own comment"
    );
    await typeRenderedOn(
      second.client,
      '[data-testid="session-comment-row"] textarea',
      EDITED_COMMENT_BODY,
      "secondary edited comment body"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="session-comment-edit-save"]',
      "secondary save edited comment"
    );
    try {
      await browser.waitUntil(
        async () =>
          visibleTextIncludesOn(
            browser,
            '[data-testid="session-comment-row"]',
            EDITED_COMMENT_BRIEF
          ),
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 250,
          timeoutMsg: "owner did not receive the teammate comment edit live",
        }
      );
    } catch (error) {
      const [ownerDebug, teammateDebug] = await Promise.all([
        invokeE2E("cloudInspectDebugState", { sessionId }),
        invokeOn(second.client, "cloudInspectDebugState", {
          sessionId,
        }),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `owner comment state: ${JSON.stringify(ownerDebug)}\n` +
          `teammate comment state: ${JSON.stringify(teammateDebug)}`
      );
    }

    const ownerPermissions = await execJS(`
      const row = document.querySelector('[data-testid="session-comment-row"]');
      return {
        edit: !!row?.querySelector('[data-testid="session-comment-edit"]'),
        delete: !!row?.querySelector('[data-testid="session-comment-delete"]'),
      };
    `);
    if (ownerPermissions.edit || !ownerPermissions.delete) {
      throw new Error(
        `comment permission UI is wrong for owner/admin viewing teammate content: ${JSON.stringify(ownerPermissions)}`
      );
    }

    await clickRendered(
      '[data-testid="session-comment-reply"]',
      "owner open reply composer"
    );
    await typeRendered(
      '[data-testid="session-comment-reply-composer"] textarea',
      REPLY_BODY,
      "owner reply body"
    );
    await browser.waitUntil(
      async () =>
        execJS(`
          const button = document.querySelector('[data-testid="session-comment-reply-composer-submit"]');
          return !!button && !button.disabled;
        `),
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "owner reply submit never enabled",
      }
    );
    await clickRendered(
      '[data-testid="session-comment-reply-composer-submit"]',
      "owner submit reply"
    );
    await browser.waitUntil(
      async () =>
        execJS(
          `return Array.from(document.querySelectorAll('[data-testid="session-comment-row"]')).some((row) => row.textContent?.includes(${JSON.stringify(REPLY_BODY)}));`
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "owner reply RPC did not update the owner UI",
      }
    );
    try {
      await second.client.waitUntil(
        async () =>
          executeOn(
            second.client,
            `
              return Array.from(document.querySelectorAll('[data-testid="session-comment-row"]'))
                .some((row) => row.textContent?.includes(arguments[0]));
            `,
            [REPLY_BODY]
          ),
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 250,
          timeoutMsg: "secondary did not receive the owner reply live",
        }
      );
    } catch (error) {
      const secondaryActive = unwrapOn(
        await invokeOn(second.client, "getActiveSessionId"),
        "secondary active session diagnostic"
      ).sessionId;
      const [primaryDebug, secondaryDebug, secondaryCommentText] =
        await Promise.all([
          invokeE2E("cloudInspectDebugState", { sessionId }),
          invokeOn(second.client, "cloudInspectDebugState", {
            sessionId: secondaryActive ?? sessionId,
          }),
          executeOn(
            second.client,
            `return Array.from(document.querySelectorAll('[data-testid="session-comment-row"]')).map((row) => row.textContent ?? '');`
          ),
        ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; primary=${JSON.stringify(primaryDebug)}; secondary=${JSON.stringify(secondaryDebug)}; secondaryRows=${JSON.stringify(secondaryCommentText)}`
      );
    }

    await clickRenderedOn(
      second.client,
      '[data-testid="session-comment-status-resolved"]',
      "secondary resolve comment thread"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-comment-resolved-toggle"]',
      "secondary local resolved-thread toggle",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForRendered(
      '[data-testid="session-comment-resolved-toggle"]',
      "owner realtime resolved-thread toggle",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="session-comment-resolved-toggle"]',
      "secondary expand resolved threads"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-comment-resolved-marker"]',
      "secondary local resolved marker",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRendered(
      '[data-testid="session-comment-resolved-toggle"]',
      "owner expand resolved threads"
    );
    await waitForRendered(
      '[data-testid="session-comment-resolved-marker"]',
      "owner realtime resolved marker",
      CLOUD_FETCH_TIMEOUT_MS
    );

    // Imported composer submit must go straight to the actionable setup
    // dialog. Cancelling is silent and restores the captured draft.
    await typeContentEditableOn(
      second.client,
      '[data-testid="chat-input"] [contenteditable="true"]',
      SEND_BODY,
      "secondary imported-session composer"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="chat-send-button"]',
      "secondary imported-session send"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="fork-session-setup"]',
      "send-triggered fork setup",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await pressEscapeOn(second.client);
    await waitForGoneOn(
      second.client,
      '[data-testid="fork-session-setup"]',
      "cancelled fork setup"
    );
    await second.client.waitUntil(
      async () =>
        executeOn(
          second.client,
          `
            return Array.from(document.querySelectorAll('[data-testid="chat-input"] [contenteditable="true"]'))
              .some((editor) => editor.textContent?.includes(arguments[0]));
          `,
          [SEND_BODY]
        ),
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "cancelled fork did not restore the captured draft",
      }
    );

    await clickRenderedOn(
      second.client,
      '[data-testid="chat-send-button"]',
      "secondary retry imported-session send"
    );
    await completeForkSetupOn(second.client, "secondary send-triggered fork");
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-forked-from-chip"]',
      "send-created writable fork",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await second.client.waitUntil(
      async () =>
        executeOn(
          second.client,
          `return (document.body.textContent ?? '').includes(arguments[0]);`,
          [SEND_BODY]
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "captured first message was lost after forking",
      }
    );

    const sendForkActive = unwrapOn(
      await invokeOn(second.client, "getActiveSessionId"),
      "secondary send-created fork identity"
    );
    await second.client.waitUntil(
      async () => {
        const state = unwrapOn(
          await invokeOn(second.client, "inspectChatState"),
          "secondary send-created fork history"
        );
        return (
          state.activeSessionId === sendForkActive.sessionId &&
          (state.chatEvents ?? []).some(
            (event) => event.displayText === SESSION_TITLE
          ) &&
          (state.chatEvents ?? []).some(
            (event) => event.displayText === "Inherited answer 2"
          ) &&
          (state.chatEvents ?? []).some(
            (event) => event.displayText === SEND_BODY
          )
        );
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "sending the first fork message replaced its inherited transcript",
      }
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="session-forked-from-chip"]',
      "secondary open send-created fork parent"
    );
    await second.client.waitUntil(
      async () => {
        const state = unwrapOn(
          await invokeOn(second.client, "inspectChatState"),
          "secondary send-created fork parent"
        );
        const header = await executeOn(
          second.client,
          `return {
            forkAction: !!document.querySelector('[data-testid="session-fork-button"]'),
            forkProvenance: !!document.querySelector('[data-testid="session-forked-from-chip"]'),
          };`
        );
        return (
          state.activeSessionId === secondaryImportedSessionId &&
          header.forkAction &&
          !header.forkProvenance
        );
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "secondary send-created fork parent did not become the active imported replay",
      }
    );
    const parentAfterForkSend = unwrapOn(
      await invokeOn(second.client, "inspectChatState"),
      "secondary parent after fork send"
    );
    if (
      !(parentAfterForkSend.chatEvents ?? []).some(
        (event) => event.displayText === SESSION_TITLE
      ) ||
      !(parentAfterForkSend.chatEvents ?? []).some(
        (event) => event.displayText === "Inherited answer 2"
      )
    ) {
      throw new Error(
        `opening the parent after a fork message lost its source transcript: ${JSON.stringify(parentAfterForkSend.chatEvents ?? [])}`
      );
    }
    unwrapOn(
      await invokeOn(second.client, "openSession", sendForkActive.sessionId),
      "secondary reopen send-created fork"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-forked-from-chip"]',
      "secondary send-created fork reopened",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const reopenedSendFork = unwrapOn(
      await invokeOn(second.client, "inspectChatState"),
      "secondary reopened send-created fork history"
    );
    if (
      reopenedSendFork.activeSessionId !== sendForkActive.sessionId ||
      !(reopenedSendFork.chatEvents ?? []).some(
        (event) => event.displayText === SESSION_TITLE
      ) ||
      !(reopenedSendFork.chatEvents ?? []).some(
        (event) => event.displayText === "Inherited answer 2"
      ) ||
      !(reopenedSendFork.chatEvents ?? []).some(
        (event) => event.displayText === SEND_BODY
      )
    ) {
      throw new Error(
        `reopening the fork after its first message lost inherited or new history: ${JSON.stringify(reopenedSendFork.chatEvents ?? [])}`
      );
    }

    await clickRendered(
      '[data-testid="chat-panel-header-more-button"]',
      "owner more menu before revoke"
    );
    await clickRendered(
      '[data-testid="cloud-session-share-settings-button"]',
      "owner share settings before revoke"
    );
    await clickRendered(
      `[data-testid="cloud-session-share-directed-revoke-${teammate.userId}"]`,
      "owner revoke directed grant"
    );
    await waitForGoneOn(
      second.client,
      remoteRowSelector,
      "secondary restricted row after revoke",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-forked-from-chip"]',
      "secondary local fork retained after revoke"
    );
  });

  it("E. imports a one-shot link through the rendered Import flow and rejects it after revocation", async function () {
    this.timeout(240_000);
    // Open from the real owner header path; this test does not depend on D
    // leaving a modal open (a failed scenario must not contaminate this one).
    const shareDialogOpen = await execJS(
      `return !!document.querySelector('[data-testid="cloud-session-share-create-link"]');`
    );
    if (!shareDialogOpen) {
      await clickRendered(
        '[data-testid="chat-panel-header-more-button"]',
        "owner more menu before link share"
      );
      await clickRendered(
        '[data-testid="cloud-session-share-settings-button"]',
        "owner share settings before link share"
      );
    }
    await clickRendered(
      '[data-testid="cloud-session-share-create-link"]',
      "owner create one-shot link"
    );
    await waitForRendered(
      '[data-testid="cloud-session-share-created-link"]',
      "owner generated one-shot link",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const createdLink = await execJS(`
      const node = document.querySelector('[data-testid="cloud-session-share-created-link"]');
      return {
        link: node?.textContent?.trim() ?? '',
        shareId: node?.getAttribute('data-share-id') ?? '',
      };
    `);
    const link = String(createdLink?.link ?? "");
    const linkShareId = String(createdLink?.shareId ?? "");
    if (!link.startsWith("orgii://cloud/session?share=")) {
      throw new Error("generated session ticket is not a valid orgii link");
    }
    if (!linkShareId) {
      throw new Error("generated session ticket has no durable share identity");
    }
    const parsedLink = new URL(link);
    if (parsedLink.searchParams.get("endpoint") !== "official") {
      throw new Error(
        `managed-cloud share link has no official endpoint provenance: ${link}`
      );
    }

    // The owner already has sourceSessionId locally. Re-entering their own
    // link must offer to open that source, not materialize a read-only clone.
    await pressEscape();
    await clickRendered(
      '[data-testid="sidebar-new-session"]',
      "owner open New Session before self-import"
    );
    await openPrimaryImportSession("owner Import entry for self-import");
    await typeRendered(
      '[data-testid="import-session-input"]',
      link,
      "owner self-import share link"
    );
    await clickRendered(
      '[data-testid="import-session-submit"]',
      "owner parse self-import share link"
    );
    await waitForRendered(
      '[data-testid="cloud-share-import-existing-session"]',
      "owner existing-session explanation",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const selfImportAction = String(
      (await execJS(
        `return document.querySelector('[data-testid="cloud-share-import-confirm"]')?.textContent?.trim() ?? '';`
      )) ?? ""
    );
    if (!selfImportAction || /import/i.test(selfImportAction)) {
      throw new Error(
        `owner self-import still offers a duplicate import: ${selfImportAction}`
      );
    }
    await clickRendered(
      '[data-testid="cloud-share-import-confirm"]',
      "owner open original session"
    );
    await browser.waitUntil(
      async () => {
        const state = unwrap(
          await invokeE2E("inspectChatState"),
          "owner self-import active session"
        );
        return state.activeSessionId === sessionId;
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "owner self-import did not reopen the original session",
      }
    );
    await clickRendered(
      '[data-testid="chat-panel-header-more-button"]',
      "owner more menu after self-import"
    );
    await clickRendered(
      '[data-testid="cloud-session-share-settings-button"]',
      "owner restore share settings after self-import"
    );
    await waitForRendered(
      `[data-testid="cloud-session-share-link-revoke"][data-share-id="${linkShareId}"]`,
      "owner retained active link grant after self-import",
      CLOUD_FETCH_TIMEOUT_MS
    );

    // Regression: the receiver may have an unreachable custom endpoint
    // configured. An explicit official link must pin both resolve and segment
    // reads to managed cloud without switching global endpoint/account state.
    await applyCloudEndpointOn(second.client, UNREACHABLE_CLOUD_ENDPOINT);

    await clickRenderedOn(
      second.client,
      '[data-testid="sidebar-new-session"]',
      "secondary open a real New Session"
    );
    await openImportSessionOn(second.client, "secondary Import entry");
    await typeRenderedOn(
      second.client,
      '[data-testid="import-session-input"]',
      link,
      "secondary share link"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="import-session-submit"]',
      "secondary parse share link"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-share-import-dialog"]',
      "secondary resolved share preview",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const importCopy = String(
      (await executeOn(
        second.client,
        `return document.querySelector('[data-testid="cloud-share-import-dialog"]')?.textContent ?? '';`
      )) ?? ""
    ).toLowerCase();
    if (importCopy.includes("read only") || importCopy.includes("read-only")) {
      throw new Error("Import flow still labels the action as read-only");
    }
    await second.client.waitUntil(
      async () =>
        executeOn(
          second.client,
          `
            const button = document.querySelector('[data-testid="cloud-share-import-confirm"]');
            return !!button && !button.disabled;
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "secondary link preview never became importable",
      }
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-share-import-confirm"]',
      "secondary confirm link import"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-fork-button"]',
      "secondary link-import fork action",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await applyCloudEndpointOn(second.client, env);

    // Guest capability durability: a forced authoritative list reload used
    // to erase the imported guest row (and with it the shareToken +
    // issuing-endpoint capability). The durable registry must
    // re-materialize the row and keep the replay/fork affordances working.
    const guestListAfterReload = unwrapOn(
      await invokeOn(second.client, "reloadSessionList"),
      "secondary forced authoritative session reload"
    );
    const guestImportedId = (guestListAfterReload.sessionIds ?? []).find((id) =>
      id.startsWith("imported-session-")
    );
    if (!guestImportedId) {
      throw new Error(
        `guest import vanished after authoritative reload: ${JSON.stringify(
          guestListAfterReload.sessionIds ?? []
        )}`
      );
    }
    unwrapOn(
      await invokeOn(second.client, "openSession", guestImportedId),
      "secondary reopen guest import after reload"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-fork-button"]',
      "secondary guest fork action after reload",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await clickRendered(
      `[data-testid="cloud-session-share-link-revoke"][data-share-id="${linkShareId}"]`,
      "owner revoke one-shot link"
    );
    await waitForGone(
      `[data-testid="cloud-session-share-active-row"][data-share-id="${linkShareId}"]`,
      "owner active link grant after revoke"
    );

    await clickRenderedOn(
      second.client,
      '[data-testid="sidebar-new-session"]',
      "secondary New Session before revoked-link retry"
    );
    await openImportSessionOn(
      second.client,
      "secondary Import entry for revoked link"
    );
    await typeRenderedOn(
      second.client,
      '[data-testid="import-session-input"]',
      link,
      "secondary revoked share link"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="import-session-submit"]',
      "secondary parse revoked share link"
    );
    const immediateRevokedState = await executeOn(
      second.client,
      `
        const dialog = document.querySelector('[data-testid="cloud-share-import-dialog"]');
        const button = dialog?.querySelector('[data-testid="cloud-share-import-confirm"]');
        return {
          dialogPresent: !!dialog,
          importEnabled: !!button && !button.disabled,
          hasSpinner: !!dialog?.querySelector('.animate-spin'),
        };
      `
    );
    if (immediateRevokedState.importEnabled) {
      throw new Error(
        `reopened token reused stale success before resolve: ${JSON.stringify(immediateRevokedState)}`
      );
    }
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-share-import-resolve-error"]',
      "secondary revoked-link error",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await second.client.waitUntil(
      async () =>
        executeOn(
          second.client,
          `
            const dialog = document.querySelector('[data-testid="cloud-share-import-dialog"]');
            return !!dialog &&
              !dialog.querySelector('[data-testid="cloud-share-import-confirm"]') &&
              !dialog.querySelector('.animate-spin');
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg:
          "terminal revoked-link state still rendered an Import action or spinner",
      }
    );
    const revokedErrorKind = await executeOn(
      second.client,
      `return document.querySelector('[data-testid="cloud-share-import-resolve-error"]')?.getAttribute('data-error-kind');`
    );
    if (revokedErrorKind !== "invalid") {
      throw new Error(`revoked link misclassified as ${revokedErrorKind}`);
    }

    // A custom-cloud link never sends its capability to an arbitrary URL.
    // The receiver must explicitly configure the matching deployment first.
    await pressEscapeOn(second.client);
    const mismatchedCustomLink = new URL(link);
    mismatchedCustomLink.searchParams.set("endpoint", "custom");
    mismatchedCustomLink.searchParams.set(
      "endpointUrl",
      "https://different-cloud.example.com"
    );
    await openImportSessionOn(
      second.client,
      "secondary Import entry for mismatched custom link"
    );
    await typeRenderedOn(
      second.client,
      '[data-testid="import-session-input"]',
      mismatchedCustomLink.toString(),
      "secondary mismatched custom share link"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="import-session-submit"]',
      "secondary parse mismatched custom share link"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-share-import-resolve-error"][data-error-kind="endpoint_mismatch"]',
      "secondary endpoint-mismatch explanation",
      CLOUD_FETCH_TIMEOUT_MS
    );
  });

  it("F. creates a team Project and Work Item through UI and syncs member edits both ways", async function () {
    this.timeout(360_000);

    // Keep this scenario independently runnable: Project creation uses the
    // current workspace, so it must not inherit C's repo-selection setup.
    unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "primary ensure Project workspace"
    );
    unwrapOn(
      await invokeOn(second.client, "ensureRepoSelected", {
        repoPath: SECONDARY_E2E_REPO_PATH,
      }),
      "secondary ensure Project workspace"
    );
    await pressEscapeOn(browser);
    await pressEscapeOn(second.client);
    await selectCloudOrgOn(browser, teamOrgId);
    await selectCloudOrgOn(second.client, teamOrgId);
    await openWorkItemsLayerOn(browser, "primary");
    await clickRendered(
      '[data-testid="sidebar-create-project"]',
      "primary create Project"
    );
    await waitForRendered(
      '[data-testid="create-project-title-input"]',
      "primary new Project form",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await selectManualCreateModeOn(browser, "project", "primary Project");
    await clickRendered(
      '[data-testid="create-project-org-select"]',
      "primary Project org picker"
    );
    await clickRendered(
      `[data-testid="create-project-org-option-${teamOrgId}"]`,
      "primary team org option for Project"
    );
    await typeRendered(
      '[data-testid="create-project-title-input"]',
      PROJECT_NAME,
      "primary Project title"
    );
    await clickRendered(
      '[data-testid="create-project-submit"]',
      "primary create Project submit"
    );
    await waitForRendered(
      `[data-testid="sidebar-project-overview-${PROJECT_SLUG}"]`,
      "primary created Project sidebar row",
      CLOUD_FETCH_TIMEOUT_MS
    );

    // The UI mutation emits orgii-data-changed; drain its production outbox
    // immediately, then require the already-open teammate list to update from
    // Realtime + the production apply path.
    unwrap(await invokeE2E("cloudRunSyncPass"), "primary Project sync pass");
    await openWorkItemsLayerOn(second.client, "secondary");
    await waitForRenderedOn(
      second.client,
      `[data-testid="sidebar-project-overview-${PROJECT_SLUG}"]`,
      "secondary realtime Project sidebar row",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await clickRendered(
      '[data-testid="sidebar-create-work-item"]',
      "primary create Work Item"
    );
    await waitForRendered(
      '[data-testid="create-work-item-title-input"]',
      "primary new Work Item form",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await selectManualCreateModeOn(browser, "work-item", "primary Work Item");
    await clickRendered(
      '[data-testid="create-work-item-project-select"] [data-field-row]',
      "primary Work Item Project picker"
    );
    await clickRendered(
      `[data-testid="create-work-item-project-select-option-${PROJECT_ID}"]`,
      "primary Work Item team Project option"
    );
    await typeRendered(
      '[data-testid="create-work-item-title-input"]',
      WORK_ITEM_TITLE,
      "primary Work Item title"
    );
    await clickRendered(
      '[data-testid="create-work-item-submit"]',
      "primary create Work Item submit"
    );

    workItemId = await findSidebarWorkItemIdByTitleOn(browser, WORK_ITEM_TITLE);
    if (!workItemId) throw new Error("primary Work Item row has no stable id");
    unwrap(await invokeE2E("cloudRunSyncPass"), "primary Work Item sync pass");

    await waitForRenderedOn(
      second.client,
      `[data-testid="sidebar-work-item-${workItemId}"]`,
      "secondary realtime Work Item sidebar row",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      `[data-testid="sidebar-work-item-${workItemId}"]`,
      "secondary open synced Work Item"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="chat-panel-work-item-detail"]',
      "secondary synced Work Item detail",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await clickRenderedOn(
      second.client,
      `[data-testid="work-item-property-status-${workItemId}"] [data-field-row]`,
      "secondary Work Item status picker"
    );
    await clickRenderedOn(
      second.client,
      `[data-testid="work-item-property-status-${workItemId}-option-in_progress"]`,
      "secondary set Work Item In Progress"
    );
    await second.client.waitUntil(
      async () =>
        renderedValueIsOn(
          second.client,
          `[data-testid="work-item-property-status-${workItemId}"]`,
          "in_progress"
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "secondary Work Item status did not update locally",
      }
    );
    unwrapOn(
      await invokeOn(second.client, "cloudRunSyncPass"),
      "secondary Work Item status sync pass"
    );
    try {
      await browser.waitUntil(
        async () =>
          renderedValueIsOn(
            browser,
            `[data-testid="work-item-property-status-${workItemId}"]`,
            "in_progress"
          ),
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "primary did not receive teammate Work Item status live",
        }
      );
    } catch (error) {
      const [primaryState, secondaryState, primaryDom, secondaryDom] =
        await Promise.all([
          invokeE2E("cloudInspectProjectState", {
            projectSlug: PROJECT_SLUG,
            workItemId,
          }),
          invokeOn(second.client, "cloudInspectProjectState", {
            projectSlug: PROJECT_SLUG,
            workItemId,
          }),
          inspectRenderedNodesOn(
            browser,
            `[data-testid="work-item-property-status-${workItemId}"]`
          ),
          inspectRenderedNodesOn(
            second.client,
            `[data-testid="work-item-property-status-${workItemId}"]`
          ),
        ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `primary project state: ${JSON.stringify(primaryState)}\n` +
          `secondary project state: ${JSON.stringify(secondaryState)}\n` +
          `primary status DOM: ${JSON.stringify(primaryDom)}\n` +
          `secondary status DOM: ${JSON.stringify(secondaryDom)}`
      );
    }

    // Acquire the server lock as the owner while the teammate has the detail
    // open. The rendered Agent action must name the holder and remain blocked;
    // releasing the lock must restore the normal action without reopening.
    await callProjectsRpc(env, owner, "cloud_acquire_work_item_lock", {
      p_org_id: teamOrgId,
      p_work_item_id: workItemId,
      lock_payload: { activeShortId: workItemId },
    });
    unwrapOn(
      await invokeOn(second.client, "cloudRunSyncPass"),
      "secondary pull owner Work Item lock"
    );
    try {
      await second.client.waitUntil(
        async () =>
          executeOn(
            second.client,
            `
              const button = document.querySelector('[data-testid="work-item-start-agent-button"]');
              return !!button && button.disabled && button.textContent.includes(${JSON.stringify(PRIMARY_INSTANCE_MEMBER_NAME)});
            `
          ),
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "teammate did not render the owner's Work Item lock",
        }
      );
    } catch (error) {
      const [localState, buttonState] = await Promise.all([
        invokeOn(second.client, "cloudInspectProjectState", {
          projectSlug: PROJECT_SLUG,
          workItemId,
        }),
        executeOn(
          second.client,
          `
            const button = document.querySelector('[data-testid="work-item-start-agent-button"]');
            return button ? {
              disabled: button.disabled,
              text: button.textContent,
              outerHTML: button.outerHTML,
            } : null;
          `
        ),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; local=${JSON.stringify(localState)}; button=${JSON.stringify(buttonState)}`
      );
    }
    await callProjectsRpc(env, owner, "cloud_release_work_item_lock", {
      p_org_id: teamOrgId,
      p_work_item_id: workItemId,
    });
    unwrapOn(
      await invokeOn(second.client, "cloudRunSyncPass"),
      "secondary pull owner Work Item unlock"
    );
    await second.client.waitUntil(
      async () =>
        executeOn(
          second.client,
          `
            const button = document.querySelector('[data-testid="work-item-start-agent-button"]');
            return !!button && !button.textContent.includes(${JSON.stringify(PRIMARY_INSTANCE_MEMBER_NAME)});
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "teammate Work Item action did not clear the released lock",
      }
    );
  });

  it("F2. VantaNode reuses one persistent runner for consecutive Work Item Discussion turns", async function () {
    this.timeout(480_000);
    const capabilities = await readCloudCapabilities(env, teammate);
    if (capabilities.conversationEventsIdempotency !== true) {
      console.warn(
        "[cloud-dual-e2e] BLOCKED F2: cloud backend lacks conversationEventsIdempotency; client must execute zero plane turns."
      );
      this.skip();
      return;
    }
    unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "select Neonforge continuation workspace"
    );
    unwrapOn(
      await invokeOn(second.client, "ensureRepoSelected", {
        repoPath: SECONDARY_E2E_REPO_PATH,
      }),
      "select VantaNode continuation workspace before scope resolution"
    );
    const primaryIdePort = process.env.E2E_IDE_SERVER_PORT ?? "13847";
    const secondaryIdePort =
      process.env.E2E_SECONDARY_IDE_SERVER_PORT ?? "13848";
    await browser.waitUntil(
      async () => {
        try {
          const responses = await Promise.all(
            [primaryIdePort, secondaryIdePort].map((port) =>
              fetch(`http://127.0.0.1:${port}/api-docs/openapi.json`)
            )
          );
          return responses.every((response) => response.ok);
        } catch {
          return false;
        }
      },
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: `Neonforge/VantaNode IDE servers never became ready on ${primaryIdePort}/${secondaryIdePort}`,
      }
    );
    const [primaryScopeResolution, secondaryScopeResolution] =
      await Promise.all([
        invokeE2E("cloudResolveRepoScopeKeys", {
          repoPath: E2E_REPO_PATH,
        }),
        invokeOn(second.client, "cloudResolveRepoScopeKeys", {
          repoPath: SECONDARY_E2E_REPO_PATH,
        }),
      ]);
    const primaryScopeKeys = unwrap(
      primaryScopeResolution,
      "resolve Neonforge continuation repo scope"
    ).keys;
    const secondaryScopeKeys = unwrapOn(
      secondaryScopeResolution,
      "resolve VantaNode continuation repo scope"
    ).keys;
    if (
      !primaryScopeKeys?.includes(EXPECTED_REPO_NETWORK_SCOPE) ||
      !secondaryScopeKeys?.includes(EXPECTED_REPO_NETWORK_SCOPE)
    ) {
      throw new Error(
        `continuation workspaces do not share ${EXPECTED_REPO_NETWORK_SCOPE}: ${JSON.stringify({ primaryScopeKeys, secondaryScopeKeys })}`
      );
    }
    repoScopeKey = EXPECTED_REPO_NETWORK_SCOPE;
    if (!teamOrgId) {
      teamOrgId = await provisionContinuationTeam(env, owner, teammate);
    }
    const primaryOrgs = [
      {
        orgId: ownerPersonalOrgId,
        name: `${PRIMARY_INSTANCE_MEMBER_NAME} personal`,
        role: "owner",
      },
      { orgId: teamOrgId, name: TEAM_NAME, role: "owner" },
    ];
    const secondaryOrgs = [
      {
        orgId: teammatePersonalOrgId,
        name: `${SECONDARY_INSTANCE_MEMBER_NAME} personal`,
        role: "owner",
      },
      { orgId: teamOrgId, name: TEAM_NAME, role: "member" },
    ];
    unwrap(
      await invokeE2E("cloudSeedOrgs", { orgs: primaryOrgs }),
      "seed Neonforge team roster"
    );
    unwrapOn(
      await invokeOn(second.client, "cloudSeedOrgs", {
        orgs: secondaryOrgs,
      }),
      "seed VantaNode team roster"
    );
    const [primaryRosterReadback, secondaryRosterReadback] = await Promise.all([
      invokeE2E("cloudListOrgs"),
      invokeOn(second.client, "cloudListOrgs"),
    ]);
    if (
      !unwrap(primaryRosterReadback, "read Neonforge team roster").orgs.some(
        (org) => org.orgId === teamOrgId && org.role === "owner"
      ) ||
      !unwrapOn(
        secondaryRosterReadback,
        "read VantaNode team roster"
      ).orgs.some((org) => org.orgId === teamOrgId && org.role === "member")
    ) {
      throw new Error(
        "the two rendered stores did not retain the team fixture"
      );
    }

    sessionId = `neonforge-continuation-root-${RUN_ID}`;
    bindRunnableSourceSession(sessionId);
    await seedAndOpenCloudEligibleSession(sessionId, SESSION_TITLE, {
      touchedFilePath: join(E2E_REPO_PATH, SESSION_BLAME_FILE),
    });
    unwrap(
      await invokeE2E("cloudTagSessionToOrg", {
        sessionId,
        orgId: teamOrgId,
      }),
      "tag Neonforge continuation root to team"
    );
    await publishCloudSessionMetadata(env, owner, {
      orgId: teamOrgId,
      sessionId,
      title: SESSION_TITLE,
      repoScopeKey,
      visibility: "org",
      accessMode: "full_replay",
    });
    unwrapOn(
      await invokeOn(second.client, "ensureRepoSelected", {
        repoPath: SECONDARY_E2E_REPO_PATH,
      }),
      "select VantaNode continuation workspace"
    );
    if (E2E_PROVIDER_MODE === "mock") {
      unwrapOn(
        await invokeOn(second.client, "configure", {
          openaiApiKey: "sk-orgii-continuation-e2e-not-sent",
          model: FORK_E2E_MODEL,
          accountName: `VantaNode continuation ${RUN_ID}`,
          agentDefinitionId: "builtin:sde",
          repoPath: SECONDARY_E2E_REPO_PATH,
        }),
        "configure VantaNode continuation runtime"
      );
    }
    unwrapOn(
      await invokeOn(second.client, "cloudSeedProjectOrgAlias", {
        localOrgId: CONTINUATION_LOCAL_ORG_ID,
        externalOrgId: teamOrgId,
        name: TEAM_NAME,
      }),
      "seed VantaNode Project cloud-org alias"
    );
    unwrapOn(
      await invokeOn(
        second.client,
        "writeProject",
        PROJECT_SLUG,
        continuationProjectMeta(),
        "Isolated persistent-continuation fixture.",
        true
      ),
      "write VantaNode continuation Project"
    );
    unwrapOn(
      await invokeOn(
        second.client,
        "writeWorkItem",
        PROJECT_SLUG,
        CONTINUATION_WORK_ITEM_SHORT_ID,
        continuationWorkItemFrontmatter(sessionId),
        "Two rendered comments must reuse one hidden local runner."
      ),
      "write VantaNode continuation Work Item"
    );
    const workItemReadback = unwrapOn(
      await invokeOn(
        second.client,
        "readWorkItem",
        PROJECT_SLUG,
        CONTINUATION_WORK_ITEM_SHORT_ID
      ),
      "read VantaNode continuation Work Item"
    ).item;
    const workItemFrontmatter =
      workItemReadback.frontmatter ?? workItemReadback;
    workItemId = workItemFrontmatter.session_id ?? workItemFrontmatter.id;
    const linkedSessions =
      workItemFrontmatter.linkedSessions ??
      workItemFrontmatter.linked_sessions ??
      [];
    if (
      !workItemId ||
      !linkedSessions.some((entry) => entry.session_id === sessionId)
    ) {
      throw new Error(
        `VantaNode continuation fixture failed read-back: ${JSON.stringify(workItemReadback)}`
      );
    }
    await selectCloudOrgOn(second.client, teamOrgId);
    unwrapOn(
      await invokeOn(
        second.client,
        "openProjectWorkItemsTab",
        PROJECT_ID,
        PROJECT_NAME,
        PROJECT_SLUG
      ),
      "open VantaNode continuation Project"
    );

    await openWorkItemDiscussionOn(second.client, workItemId, "VantaNode");
    await postWorkItemDiscussionOn(second.client, {
      workItemId,
      body: FIRST_CONTINUATION_COMMENT,
      rootSessionId: sessionId,
      label: "VantaNode first",
    });
    await completeForkSetupOn(second.client, "VantaNode first continuation");

    const firstRecord = await waitForContinuationOn(
      second.client,
      teamOrgId,
      sessionId,
      (record) =>
        typeof record.continuationSessionId === "string" &&
        record.continuationSessionId.length > 0 &&
        Number.isSafeInteger(record.readThroughPlaneSeq) &&
        record.readThroughPlaneSeq >= 0,
      "VantaNode first"
    );
    const runnerSessionId = firstRecord.continuationSessionId;
    const firstRun = await waitForDiscussionRun(
      second.client,
      second,
      workItemId,
      (run) => run.status === "succeeded" && run.sessionId === runnerSessionId,
      "VantaNode first"
    );
    const firstTranscript = unwrapOn(
      await invokeOn(second.client, "readSdeTranscript", runnerSessionId),
      "VantaNode first runner transcript"
    ).result;
    if (
      firstTranscript?.ok !== true ||
      !Array.isArray(firstTranscript.messages)
    ) {
      throw new Error(
        `VantaNode first runner transcript unavailable: ${JSON.stringify(firstTranscript)}`
      );
    }

    const firstPlane = await listConversationPlane(
      env,
      teammate,
      teamOrgId,
      sessionId
    );
    const firstUserRow = firstPlane.find(
      (row) =>
        row.authorUserId === teammate.userId &&
        row.event?.source === "user" &&
        row.event?.displayText?.includes(FIRST_CONTINUATION_COMMENT)
    );
    if (
      !firstUserRow ||
      firstUserRow.authorDisplayName !== SECONDARY_INSTANCE_MEMBER_NAME ||
      firstUserRow.turnId !== firstRun.id
    ) {
      throw new Error(
        `first plane turn lost VantaNode attribution/run identity: ${JSON.stringify({ firstUserRow, firstRunId: firstRun.id })}`
      );
    }
    const firstTurnRows = firstPlane.filter(
      (row) => row.turnId === firstUserRow.turnId
    );
    if (!firstTurnRows.some((row) => row.event?.source === "assistant")) {
      throw new Error(
        `first plane turn has no agent tail: ${JSON.stringify(firstTurnRows)}`
      );
    }
    if (
      firstRecord.readThroughPlaneSeq < 0 ||
      firstRecord.readThroughPlaneSeq >= firstUserRow.seq
    ) {
      throw new Error(
        `first continuation read prefix must precede its own pushed row: ${JSON.stringify({ firstRecord, firstUserSeq: firstUserRow.seq })}`
      );
    }

    const hiddenRunnerRendered = await executeOn(
      second.client,
      `return !!document.querySelector(arguments[0]);`,
      [`[data-testid="sidebar-session-item-${runnerSessionId}"]`]
    );
    if (hiddenRunnerRendered) {
      throw new Error(
        `hidden VantaNode runner leaked into My Sessions: ${runnerSessionId}`
      );
    }

    // A deterministic owner-authored row is a setup fixture for the behavior
    // under test below: VantaNode's real second Discussion send must load this
    // row as the sole plane delta before resuming the persisted runner.
    const ownerDelta = await pushConversationPlaneSeed(
      env,
      owner,
      teamOrgId,
      sessionId,
      PRIMARY_PLANE_DELTA
    );
    if (
      ownerDelta.authorUserId !== owner.userId ||
      ownerDelta.authorDisplayName !== PRIMARY_INSTANCE_MEMBER_NAME ||
      ownerDelta.seq <= firstRecord.readThroughPlaneSeq
    ) {
      throw new Error(
        `Neonforge plane delta attribution/read prefix is wrong: ${JSON.stringify({ ownerDelta, firstRecord })}`
      );
    }

    await postWorkItemDiscussionOn(second.client, {
      workItemId,
      body: SECOND_CONTINUATION_COMMENT,
      rootSessionId: sessionId,
      label: "VantaNode second",
    });
    const secondRun = await waitForDiscussionRun(
      second.client,
      second,
      workItemId,
      (run) =>
        run.id !== firstRun.id &&
        run.status === "succeeded" &&
        run.sessionId === runnerSessionId,
      "VantaNode second"
    );
    const secondRecord = await waitForContinuationOn(
      second.client,
      teamOrgId,
      sessionId,
      (record) =>
        record.continuationSessionId === runnerSessionId &&
        Number.isSafeInteger(record.readThroughPlaneSeq) &&
        record.readThroughPlaneSeq >= ownerDelta.seq,
      "VantaNode second"
    );
    if (secondRecord.readThroughPlaneSeq <= firstRecord.readThroughPlaneSeq) {
      throw new Error(
        `VantaNode continuation read prefix did not advance: ${JSON.stringify({ firstRecord, secondRecord })}`
      );
    }

    const secondTranscript = unwrapOn(
      await invokeOn(second.client, "readSdeTranscript", runnerSessionId),
      "VantaNode resumed runner transcript"
    ).result;
    if (
      secondTranscript?.ok !== true ||
      !Array.isArray(secondTranscript.messages) ||
      secondTranscript.messages.length <= firstTranscript.messages.length
    ) {
      throw new Error(
        `VantaNode runner transcript did not append: ${JSON.stringify({ first: firstTranscript, second: secondTranscript })}`
      );
    }
    const resumedUserMessage = [...secondTranscript.messages]
      .reverse()
      .find((message) => message.role === "user");
    const resumedUserText = JSON.stringify(resumedUserMessage ?? {});
    if (
      !resumedUserText.includes(PRIMARY_PLANE_DELTA) ||
      !resumedUserText.includes(SECOND_CONTINUATION_COMMENT) ||
      resumedUserText.includes(FIRST_CONTINUATION_COMMENT)
    ) {
      throw new Error(
        `resumed prompt did not contain only the new plane delta: ${resumedUserText}`
      );
    }

    const secondPlane = await listConversationPlane(
      env,
      teammate,
      teamOrgId,
      sessionId
    );
    const secondUserRow = secondPlane.find(
      (row) =>
        row.seq > ownerDelta.seq &&
        row.authorUserId === teammate.userId &&
        row.event?.source === "user" &&
        row.event?.displayText?.includes(SECOND_CONTINUATION_COMMENT)
    );
    const secondTurnRows = secondPlane.filter(
      (row) => row.turnId === secondUserRow?.turnId
    );
    if (
      !secondUserRow ||
      secondUserRow.authorDisplayName !== SECONDARY_INSTANCE_MEMBER_NAME ||
      secondUserRow.turnId !== secondRun.id ||
      !secondTurnRows.some((row) => row.event?.source === "assistant")
    ) {
      throw new Error(
        `second plane turn lost VantaNode run identity/user/tail rows: ${JSON.stringify({ secondRunId: secondRun.id, secondTurnRows })}`
      );
    }
    if (
      secondRecord.readThroughPlaneSeq < ownerDelta.seq ||
      secondRecord.readThroughPlaneSeq >= secondUserRow.seq
    ) {
      throw new Error(
        `second continuation read prefix must include the owner delta and precede its own pushed row: ${JSON.stringify({ secondRecord, ownerDeltaSeq: ownerDelta.seq, secondUserSeq: secondUserRow.seq })}`
      );
    }
    const setupDialogStillOpen = await executeOn(
      second.client,
      `return !!document.querySelector('[data-testid="fork-session-setup"]');`
    );
    if (setupDialogStillOpen) {
      throw new Error("VantaNode second turn unexpectedly re-opened setup");
    }

    await selectCloudOrgOn(browser, teamOrgId);
    unwrap(
      await invokeE2E("openSession", sessionId),
      "Neonforge open root after VantaNode continuation"
    );
    await browser.waitUntil(
      async () =>
        execJS(`
          const list = document.querySelector('[data-testid="chat-message-list"]');
          return list?.textContent?.includes(${JSON.stringify(SECOND_CONTINUATION_COMMENT)}) === true;
        `),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg:
          "Neonforge root transcript did not render VantaNode's second turn",
      }
    );

    console.info(
      `[cloud-dual-e2e] persistent continuation evidence ${JSON.stringify({
        primary: PRIMARY_INSTANCE_MEMBER_NAME,
        secondary: SECONDARY_INSTANCE_MEMBER_NAME,
        rootSessionId: sessionId,
        runnerSessionId,
        firstRunId: firstRun.id,
        secondRunId: secondRun.id,
        firstReadThrough: firstRecord.readThroughPlaneSeq,
        ownerDeltaSeq: ownerDelta.seq,
        secondReadThrough: secondRecord.readThroughPlaneSeq,
        firstPlaneRows: firstTurnRows.length,
        secondPlaneRows: secondTurnRows.length,
      })}`
    );
  });

  it("G. enforces rendered admin/member boundaries and propagates rename and sharing floors live", async function () {
    this.timeout(300_000);

    await openWorkItemsLayerOn(second.client, "secondary");
    await clickRenderedOn(
      second.client,
      '[data-testid="sidebar-work-items-projects"]',
      "secondary Projects destination"
    );
    await waitForRenderedOn(
      second.client,
      `[data-testid="project-row-${PROJECT_ID}"]`,
      "secondary synced Project list row",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await openProjectContextMenuOn(second.client, PROJECT_ID, "secondary");
    const memberDeleteVisible = await executeOn(
      second.client,
      `return !!document.querySelector('[data-testid="context-menu-item-delete"]');`
    );
    if (memberDeleteVisible) {
      throw new Error(
        "plain member was offered the cloud Project delete action"
      );
    }
    await pressEscapeOn(second.client);

    await openWorkItemsLayerOn(browser, "primary");
    await clickRendered(
      '[data-testid="sidebar-work-items-projects"]',
      "primary Projects destination"
    );
    await waitForRendered(
      `[data-testid="project-row-${PROJECT_ID}"]`,
      "primary synced Project list row",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await openProjectContextMenuOn(browser, PROJECT_ID, "primary");
    await waitForRendered(
      '[data-testid="context-menu-item-delete"]',
      "owner Project delete action",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await pressEscape();

    await openCloudOrgPanelFromSidebar(teamOrgId);
    await openCloudOrgPanelOn(second.client, teamOrgId, "secondary");
    await selectCloudOrgManagementTabOn(
      second.client,
      "general",
      "secondary general"
    );
    await waitForRendered(
      '[data-testid="cloud-org-plan-section"]',
      "owner loaded cloud plan section",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const [ownerGeneralControls, memberGeneralControls] = await Promise.all([
      execJS(`
        return {
          plan: !!document.querySelector('[data-testid="cloud-org-plan-section"]'),
          repoScope: !!document.querySelector('[data-testid="cloud-org-repo-scope"]'),
          scopeAdd: !!document.querySelector('[data-testid="cloud-org-add-repo-scope"]'),
          scopeSave: !!document.querySelector('[data-testid="cloud-org-save-repo-scopes"]'),
          settings: !!document.querySelector('[data-testid="cloud-org-settings"]'),
          danger: !!document.querySelector('[data-testid="cloud-org-danger-zone"]'),
        };
      `),
      executeOn(
        second.client,
        `
          return {
            plan: !!document.querySelector('[data-testid="cloud-org-plan-section"]'),
            repoScope: !!document.querySelector('[data-testid="cloud-org-repo-scope"]'),
            scopeAdd: !!document.querySelector('[data-testid="cloud-org-add-repo-scope"]'),
            scopeSave: !!document.querySelector('[data-testid="cloud-org-save-repo-scopes"]'),
            settings: !!document.querySelector('[data-testid="cloud-org-settings"]'),
            danger: !!document.querySelector('[data-testid="cloud-org-danger-zone"]'),
          };
        `
      ),
    ]);
    await selectPrimaryCloudOrgManagementTab("members", "owner members");
    await selectCloudOrgManagementTabOn(
      second.client,
      "members",
      "secondary members"
    );
    await waitForRendered(
      '[data-testid="cloud-org-members"]',
      "owner loaded cloud member roster",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const [ownerMemberControls, memberMemberControls] = await Promise.all([
      execJS(`
        return {
          invites: !!document.querySelector('[data-testid="cloud-org-invites"]'),
        };
      `),
      executeOn(
        second.client,
        `
          return {
            invites: !!document.querySelector('[data-testid="cloud-org-invites"]'),
            leave: !!document.querySelector('[data-testid="cloud-org-leave"]'),
          };
        `
      ),
    ]);
    const ownerControls = {
      ...ownerGeneralControls,
      ...ownerMemberControls,
    };
    const memberControls = {
      ...memberGeneralControls,
      ...memberMemberControls,
    };
    if (
      !ownerControls.plan ||
      !ownerControls.repoScope ||
      !ownerControls.scopeAdd ||
      ownerControls.scopeSave ||
      !ownerControls.invites ||
      !ownerControls.settings ||
      !ownerControls.danger
    ) {
      throw new Error(
        `owner management surface is incomplete: ${JSON.stringify(ownerControls)}`
      );
    }
    if (
      !memberControls.plan ||
      !memberControls.repoScope ||
      memberControls.scopeAdd ||
      memberControls.invites ||
      memberControls.settings ||
      memberControls.danger ||
      !memberControls.leave ||
      memberControls.scopeSave
    ) {
      throw new Error(
        `member management surface exposes the wrong controls: ${JSON.stringify(memberControls)}`
      );
    }

    await selectPrimaryCloudOrgManagementTab("general", "owner general");
    await selectCloudOrgManagementTabOn(
      second.client,
      "general",
      "secondary general after boundary checks"
    );
    await typeRendered(
      '[data-testid="cloud-org-rename-input"]',
      RENAMED_TEAM_NAME,
      "owner renamed team"
    );
    await clickRendered(
      '[data-testid="cloud-org-rename-save"]',
      "owner save team rename"
    );
    await browser.waitUntil(
      async () =>
        execJS(
          `return document.querySelector('[data-testid="cloud-org-panel"]')?.textContent?.includes(${JSON.stringify(RENAMED_TEAM_NAME)}) === true;`
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "owner panel did not commit the renamed team",
      }
    );
    await second.client.waitUntil(
      async () =>
        executeOn(
          second.client,
          `return document.querySelector('[data-testid="cloud-org-panel"]')?.textContent?.includes(arguments[0]) === true;`,
          [RENAMED_TEAM_NAME]
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "member did not receive the renamed team live",
      }
    );

    await clickRendered(
      '[data-testid="cloud-org-sharing-floor-select"]',
      "owner org sharing floor"
    );
    await clickRendered(
      '[data-testid="cloud-org-sharing-floor-metadata"]',
      "owner require metadata sharing"
    );
    await browser.waitUntil(
      async () => {
        const debug = unwrap(
          await invokeE2E("cloudInspectDebugState", {}),
          "owner floor debug"
        );
        return debug.debug?.sharingFloorByOrg?.[teamOrgId] === "metadata_only";
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg:
          "owner floor mirror never committed metadata_only (RPC failed or select handler did not fire)",
      }
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-org-sharing-floor-member-note"]',
      "member effective org sharing floor",
      CLOUD_FETCH_TIMEOUT_MS
    ).catch(async (error) => {
      const [memberDebug, ownerDebug] = await Promise.all([
        invokeOn(second.client, "cloudInspectDebugState", {}),
        invokeE2E("cloudInspectDebugState", {}),
      ]);
      throw new Error(
        `${error.message}\nmember floor mirror: ${JSON.stringify(memberDebug?.debug?.sharingFloorByOrg ?? memberDebug)}\nowner floor mirror: ${JSON.stringify(ownerDebug?.debug?.sharingFloorByOrg ?? ownerDebug)}`
      );
    });
    const duplicateDefaultControlVisible = await executeOn(
      second.client,
      `return !!document.querySelector('[data-testid="cloud-org-default-access"]');`
    );
    if (duplicateDefaultControlVisible) {
      throw new Error(
        "member General still rendered a duplicate default sync level"
      );
    }

    await selectPrimaryCloudOrgManagementTab(
      "members",
      "owner members for teammate floor"
    );
    await clickRendered(
      `[data-testid="cloud-org-member-floor-${teammate.userId}"]`,
      "owner teammate sharing floor"
    );
    await clickRendered(
      '[data-testid="cloud-org-member-floor-option-full"]',
      "owner require teammate full replay"
    );
    await second.client.waitUntil(
      async () =>
        executeOn(
          second.client,
          `return document.querySelector('[data-testid="cloud-org-sharing-floor-member-note"]')?.parentElement?.textContent?.includes('Full replay') === true;`
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "member-specific sharing floor did not propagate live",
      }
    );

    await clickRendered(
      `[data-testid="cloud-org-member-floor-${teammate.userId}"]`,
      "owner clear teammate sharing floor"
    );
    await clickRendered(
      '[data-testid="cloud-org-member-floor-option-off"]',
      "owner clear teammate floor override"
    );
    await second.client.waitUntil(
      async () =>
        executeOn(
          second.client,
          `return document.querySelector('[data-testid="cloud-org-sharing-floor-member-note"]')?.parentElement?.textContent?.includes('Metadata') === true;`
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "clearing member floor did not restore the org floor",
      }
    );
  });

  it("H. handles leave, revoked and exhausted invites, and member reactivation through rendered UI", async function () {
    this.timeout(360_000);

    // The owner panel remains open from G. Mint and revoke a fresh link so
    // the removed member can exercise the real join dialog failure state.
    const revokedInvite = await createInviteFromOwner(inviteLink);
    if (!revokedInvite.inviteId) throw new Error("new invite row has no id");
    await clickRendered(
      `[data-testid="cloud-org-invite-revoke-${revokedInvite.inviteId}"]`,
      "owner revoke fresh invite"
    );
    await waitForGone(
      '[data-testid="cloud-org-invite-link"]',
      "revoked invite plaintext",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await selectCloudOrgManagementTabOn(
      second.client,
      "members",
      "member leave"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-org-leave"]',
      "member leave workspace"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-org-leave-confirm"]',
      "member confirm leave workspace"
    );
    await second.client.waitUntil(
      async () => {
        const listed = unwrapOn(
          await invokeOn(second.client, "cloudListOrgs"),
          "member roster after leave"
        );
        return !listed.orgs?.some((org) => org.orgId === teamOrgId);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "left workspace remained in the member roster",
      }
    );
    await browser.waitUntil(
      async () =>
        !execJS(
          `return Boolean(document.querySelector('[data-testid="cloud-org-member-row"][data-member-id=${JSON.stringify(teammate.userId)}]'));`
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "departed member remained in the owner roster",
      }
    );

    unwrapOn(
      await invokeOn(second.client, "cloudSeedPendingInvite", {
        link: revokedInvite.link,
      }),
      "member parse revoked team invite"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "member revoked invite dialog"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-confirm"]',
      "member submit revoked invite"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-error"]',
      "member revoked invite error",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await pressEscapeOn(second.client);

    // A one-use invite must reactivate the removed membership once and then
    // become exhausted if the member leaves and attempts to reuse it.
    await clickRendered(
      '[data-testid="cloud-org-invite-usage-select"]',
      "owner invite usage limit"
    );
    await clickRendered(
      '[data-testid="cloud-org-invite-usage-1"]',
      "owner one-use invite limit"
    );
    const oneUseInvite = await createInviteFromOwner();
    unwrapOn(
      await invokeOn(second.client, "cloudSeedPendingInvite", {
        link: oneUseInvite.link,
      }),
      "member parse one-use invite"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "member one-use invite dialog"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-confirm"]',
      "member accept one-use invite"
    );
    await waitForGoneOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "member accepted one-use invite",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await openCloudOrgPanelOn(second.client, teamOrgId, "reactivated member");
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-org-leave"]',
      "reactivated member leave again"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-org-leave-confirm"]',
      "reactivated member confirm second leave"
    );
    await second.client.waitUntil(
      async () => {
        const listed = unwrapOn(
          await invokeOn(second.client, "cloudListOrgs"),
          "member roster after second leave"
        );
        return !listed.orgs?.some((org) => org.orgId === teamOrgId);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "second leave did not clear the member roster",
      }
    );

    unwrapOn(
      await invokeOn(second.client, "cloudSeedPendingInvite", {
        link: oneUseInvite.link,
      }),
      "member retry exhausted invite"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "member exhausted invite dialog"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-confirm"]',
      "member submit exhausted invite"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-error"]',
      "member exhausted invite error",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await pressEscapeOn(second.client);

    // Restore membership with a fresh link so subsequent resilience and
    // destructive lifecycle scenarios retain two clients. The original B
    // link intentionally uses the product default limit and may already be
    // exhausted; never make the cleanup path depend on that default.
    const recoveryInvite = await createInviteFromOwner(oneUseInvite.link);
    unwrapOn(
      await invokeOn(second.client, "cloudSeedPendingInvite", {
        link: recoveryInvite.link,
      }),
      "member parse recovery invite"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "member recovery invite dialog"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-confirm"]',
      "member rejoin through recovery invite"
    );
    await waitForGoneOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "member final rejoin",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await selectCloudOrgOn(second.client, teamOrgId);
  });

  it("I. queues offline Work Item edits and deterministically resolves a two-writer OCC conflict", async function () {
    this.timeout(360_000);
    if (!workItemId) throw new Error("scenario F did not create a Work Item");

    await openWorkItemOn(browser, workItemId, "primary");
    await openWorkItemOn(second.client, workItemId, "secondary");

    // One client edits while its request endpoint is unreachable. The local
    // UI must remain usable, the other device must not see a phantom update,
    // and restoring connectivity must drain the durable outbox.
    await applyCloudEndpointOn(second.client, UNREACHABLE_CLOUD_ENDPOINT);
    try {
      await setWorkItemStatusOn(
        second.client,
        workItemId,
        "completed",
        "Done",
        "offline secondary"
      );
      await invokeOn(second.client, "cloudRunSyncPass");
      const leakedOfflineEdit = await renderedValueIsOn(
        browser,
        `[data-testid="work-item-property-status-${workItemId}"]`,
        "completed"
      );
      if (leakedOfflineEdit) {
        throw new Error(
          "offline Work Item edit appeared on the owner before reconnect"
        );
      }
    } finally {
      await applyCloudEndpointOn(second.client, env);
    }
    unwrapOn(
      await invokeOn(second.client, "cloudRunSyncPass"),
      "secondary reconnect Work Item sync"
    );
    try {
      await browser.waitUntil(
        async () =>
          renderedValueIsOn(
            browser,
            `[data-testid="work-item-property-status-${workItemId}"]`,
            "completed"
          ),
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 500,
          timeoutMsg:
            "queued offline Work Item edit did not drain after reconnect",
        }
      );
    } catch (error) {
      const [primaryState, secondaryState, primaryDom, secondaryDom] =
        await Promise.all([
          invokeE2E("cloudInspectProjectState", {
            projectSlug: PROJECT_SLUG,
            workItemId,
          }),
          invokeOn(second.client, "cloudInspectProjectState", {
            projectSlug: PROJECT_SLUG,
            workItemId,
          }),
          inspectRenderedNodesOn(
            browser,
            `[data-testid="work-item-property-status-${workItemId}"]`
          ),
          inspectRenderedNodesOn(
            second.client,
            `[data-testid="work-item-property-status-${workItemId}"]`
          ),
        ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `primary reconnect state: ${JSON.stringify(primaryState)}\n` +
          `secondary reconnect state: ${JSON.stringify(secondaryState)}\n` +
          `primary reconnect DOM: ${JSON.stringify(primaryDom)}\n` +
          `secondary reconnect DOM: ${JSON.stringify(secondaryDom)}`
      );
    }

    // Both devices now branch from the same server revision while offline.
    // Primary lands first; secondary then exercises the production
    // conflict→fresh-row→rebase→single-retry path. The later local intent is
    // retained and converges on both devices without a loop or error modal.
    await applyCloudEndpointOverride(UNREACHABLE_CLOUD_ENDPOINT);
    await applyCloudEndpointOn(second.client, UNREACHABLE_CLOUD_ENDPOINT);
    try {
      await setWorkItemStatusOn(
        browser,
        workItemId,
        "in_review",
        "In Review",
        "offline primary"
      );
      await setWorkItemStatusOn(
        second.client,
        workItemId,
        "cancelled",
        "Cancelled",
        "offline secondary conflict"
      );
      await invokeE2E("cloudRunSyncPass");
      await invokeOn(second.client, "cloudRunSyncPass");

      await applyCloudEndpointOverride(env);
      unwrap(
        await invokeE2E("cloudRunSyncPass"),
        "primary conflict first writer"
      );
      await browser.waitUntil(
        async () =>
          renderedValueIsOn(
            browser,
            `[data-testid="work-item-property-status-${workItemId}"]`,
            "in_review"
          ),
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 250,
          timeoutMsg: "primary first conflict writer did not reach the server",
        }
      );

      await applyCloudEndpointOn(second.client, env);
      unwrapOn(
        await invokeOn(second.client, "cloudRunSyncPass"),
        "secondary OCC rebase sync"
      );
    } finally {
      await applyCloudEndpointOverride(env);
      await applyCloudEndpointOn(second.client, env);
    }

    await Promise.all([
      browser.waitUntil(
        async () =>
          renderedValueIsOn(
            browser,
            `[data-testid="work-item-property-status-${workItemId}"]`,
            "cancelled"
          ),
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "primary did not converge on the rebased secondary edit",
        }
      ),
      second.client.waitUntil(
        async () =>
          renderedValueIsOn(
            second.client,
            `[data-testid="work-item-property-status-${workItemId}"]`,
            "cancelled"
          ),
        {
          timeout: CLOUD_FETCH_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "secondary did not retain its rebased local intent",
        }
      ),
    ]);
  });

  it("J. confirms an offline Work Item tombstone and a Project cascade across both open clients", async function () {
    this.timeout(360_000);
    if (!workItemId) throw new Error("scenario F did not create a Work Item");

    await executeOn(
      second.client,
      "window.__orgiiE2EAutoConfirmDestructive = true; return true;"
    );
    await applyCloudEndpointOn(second.client, UNREACHABLE_CLOUD_ENDPOINT);
    try {
      await clickRenderedOn(
        second.client,
        '[data-testid="work-item-delete"]',
        "secondary confirmed offline Work Item delete"
      );
      await waitForGoneOn(
        second.client,
        `[data-testid="sidebar-work-item-${workItemId}"]`,
        "secondary locally deleted Work Item",
        CLOUD_FETCH_TIMEOUT_MS
      );
      const ownerStillHasItem = await execJS(
        `return !!document.querySelector(${JSON.stringify(
          `[data-testid="sidebar-work-item-${workItemId}"]`
        )});`
      );
      if (!ownerStillHasItem) {
        throw new Error(
          "offline Work Item tombstone reached owner before reconnect"
        );
      }
    } finally {
      await applyCloudEndpointOn(second.client, env);
    }
    unwrapOn(
      await invokeOn(second.client, "cloudRunSyncPass"),
      "secondary offline Work Item delete sync"
    );
    await waitForGone(
      `[data-testid="sidebar-work-item-${workItemId}"]`,
      "owner remotely deleted Work Item",
      CLOUD_FETCH_TIMEOUT_MS
    );

    // Create one more item so deleting the Project proves cascade behavior,
    // including a teammate whose detail editor is open underneath the delete.
    await openWorkItemsLayerOn(browser, "primary");
    await clickRendered(
      '[data-testid="sidebar-create-work-item"]',
      "primary create cascade Work Item"
    );
    await waitForRendered(
      '[data-testid="create-work-item-title-input"]',
      "primary cascade Work Item form",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await selectManualCreateModeOn(
      browser,
      "work-item",
      "primary cascade Work Item"
    );
    await clickRendered(
      '[data-testid="create-work-item-project-select"] [data-field-row]',
      "primary cascade Project picker"
    );
    await clickRendered(
      `[data-testid="create-work-item-project-select-option-${PROJECT_ID}"]`,
      "primary cascade team Project"
    );
    await typeRendered(
      '[data-testid="create-work-item-title-input"]',
      CASCADE_WORK_ITEM_TITLE,
      "primary cascade Work Item title"
    );
    await clickRendered(
      '[data-testid="create-work-item-submit"]',
      "primary create cascade Work Item submit"
    );
    cascadeWorkItemId = await findSidebarWorkItemIdByTitleOn(
      browser,
      CASCADE_WORK_ITEM_TITLE
    );
    unwrap(await invokeE2E("cloudRunSyncPass"), "primary cascade item sync");
    await openWorkItemOn(
      second.client,
      cascadeWorkItemId,
      "secondary cascade target"
    );

    await executeOn(
      browser,
      "window.__orgiiE2EAutoConfirmDestructive = true; return true;"
    );
    await openWorkItemsLayerOn(browser, "primary");
    await clickRendered(
      '[data-testid="sidebar-work-items-projects"]',
      "primary Projects before cascade delete"
    );
    await waitForRendered(
      `[data-testid="project-row-${PROJECT_ID}"]`,
      "primary Project before cascade delete",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await openProjectContextMenuOn(browser, PROJECT_ID, "primary cascade");
    await clickRendered(
      '[data-testid="context-menu-item-delete"]',
      "owner confirmed Project cascade delete"
    );
    await waitForGone(
      `[data-testid="project-row-${PROJECT_ID}"]`,
      "owner deleted Project row",
      CLOUD_FETCH_TIMEOUT_MS
    );
    unwrap(await invokeE2E("cloudRunSyncPass"), "owner Project delete sync");

    try {
      await Promise.all([
        waitForGoneOn(
          second.client,
          `[data-testid="sidebar-project-overview-${PROJECT_SLUG}"]`,
          "secondary deleted Project sidebar entry",
          CLOUD_FETCH_TIMEOUT_MS
        ),
        waitForGoneOn(
          second.client,
          `[data-testid="sidebar-work-item-${cascadeWorkItemId}"]`,
          "secondary cascade-deleted Work Item",
          CLOUD_FETCH_TIMEOUT_MS
        ),
        waitForGoneOn(
          second.client,
          '[data-testid="chat-panel-work-item-detail"]',
          "secondary stale Work Item editor after Project delete",
          CLOUD_FETCH_TIMEOUT_MS
        ),
      ]);
    } catch (error) {
      const [projectState, rows] = await Promise.all([
        invokeOn(second.client, "cloudInspectProjectState", {
          projectSlug: PROJECT_SLUG,
        }),
        executeOn(
          second.client,
          `
            return Array.from(document.querySelectorAll(arguments[0])).map((node) => {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return {
                text: node.textContent,
                rect: rect.toJSON(),
                visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
              };
            });
          `,
          [`[data-testid="sidebar-project-overview-${PROJECT_SLUG}"]`]
        ),
      ]);
      console.info(
        `[cloud-dual-e2e] project cascade diagnostic ${JSON.stringify({ projectState, rows })}`
      );
      throw error;
    }
  });

  it("K. applies role boundaries, transfers ownership both ways, removes, and reactivates a member", async function () {
    this.timeout(360_000);

    await openCloudOrgPanelFromSidebar(teamOrgId);
    await openCloudOrgPanelOn(
      second.client,
      teamOrgId,
      "secondary role lifecycle"
    );
    await selectPrimaryCloudOrgManagementTab(
      "members",
      "owner role lifecycle members"
    );
    await Promise.all([
      executeOn(
        browser,
        "window.__orgiiE2EAutoConfirmDestructive = true; return true;"
      ),
      executeOn(
        second.client,
        "window.__orgiiE2EAutoConfirmDestructive = true; return true;"
      ),
    ]);

    await clickRendered(
      '[data-testid="cloud-org-invite-role-select"]',
      "owner invite role selector"
    );
    const viewerInviteRoleExists = await execJS(
      `return !!document.querySelector('[data-testid="cloud-org-invite-role-viewer"]');`
    );
    if (viewerInviteRoleExists) {
      throw new Error("removed viewer role remained in the invite selector");
    }
    await clickRendered(
      '[data-testid="cloud-org-invite-role-member"]',
      "owner keep member invite role"
    );

    // A member has no admin surface; promotion to admin receives it live.
    const memberHasAdminSurface = await executeOn(
      second.client,
      `return !!document.querySelector('[data-testid="cloud-org-invites"], [data-testid="cloud-org-settings"], [data-testid="cloud-org-danger-zone"]');`
    );
    if (memberHasAdminSurface) {
      throw new Error("member was offered an admin/owner management surface");
    }

    await clickRendered(
      `[data-testid="cloud-org-member-role-${teammate.userId}"]`,
      "owner member role selector"
    );
    const viewerRoleOptionExists = await execJS(
      `return !!document.querySelector('[data-testid="cloud-org-member-role-option-viewer"]');`
    );
    if (viewerRoleOptionExists) {
      throw new Error("removed viewer role remained in the member selector");
    }
    await clickRendered(
      '[data-testid="cloud-org-member-role-option-admin"]',
      "owner promote teammate to admin"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-org-invites"]',
      "promoted admin invite controls",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await selectCloudOrgManagementTabOn(
      second.client,
      "general",
      "promoted admin general"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-org-settings"]',
      "promoted admin settings",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const adminHasOwnerDanger = await executeOn(
      second.client,
      `return !!document.querySelector('[data-testid="cloud-org-danger-zone"]');`
    );
    if (adminHasOwnerDanger) {
      throw new Error("admin was offered the owner-only danger zone");
    }

    // Transfer ownership to the second rendered app, verify both sides flip
    // live, then transfer it back so removal is exercised by the original
    // owner rather than through an RPC shortcut.
    await selectPrimaryCloudOrgManagementTab(
      "general",
      "owner transfer settings"
    );
    await clickRendered(
      '[data-testid="cloud-org-transfer-select"]',
      "owner transfer target selector"
    );
    await clickRendered(
      `[data-testid="cloud-org-transfer-option-${teammate.userId}"]`,
      "owner select teammate as successor"
    );
    await clickRendered(
      '[data-testid="cloud-org-transfer-confirm"]',
      "owner confirm transfer to teammate"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-org-danger-zone"]',
      "new owner danger zone",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForGone(
      '[data-testid="cloud-org-danger-zone"]',
      "former owner danger zone",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-org-transfer-select"]',
      "new owner transfer target selector"
    );
    await clickRenderedOn(
      second.client,
      `[data-testid="cloud-org-transfer-option-${owner.userId}"]`,
      "new owner select original owner"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-org-transfer-confirm"]',
      "new owner transfer ownership back"
    );
    await waitForRendered(
      '[data-testid="cloud-org-danger-zone"]',
      "restored owner danger zone",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForGoneOn(
      second.client,
      '[data-testid="cloud-org-danger-zone"]',
      "restored admin owner-only danger zone",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await selectPrimaryCloudOrgManagementTab(
      "members",
      "restored owner members"
    );
    await clickRendered(
      `[data-testid="cloud-org-member-remove-${teammate.userId}"]`,
      "owner remove teammate"
    );
    await second.client.waitUntil(
      async () => {
        const listed = unwrapOn(
          await invokeOn(second.client, "cloudListOrgs"),
          "removed teammate org roster"
        );
        return !listed.orgs?.some((org) => org.orgId === teamOrgId);
      },
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "removed member retained the workspace",
      }
    );
    await waitForGoneOn(
      second.client,
      `[data-testid="sidebar-cloud-org-option-${teamOrgId}"]`,
      "removed teammate sidebar org",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForGoneOn(
      second.client,
      '[data-testid="cloud-org-panel"]',
      "removed teammate management surface",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForGoneOn(
      second.client,
      '[data-testid="cloud-team-sessions-filter"]',
      "removed teammate team sessions",
      CLOUD_FETCH_TIMEOUT_MS
    );

    // A removed membership is intentionally reactivatable through a fresh,
    // valid invite; this is distinct from the exhausted-link case in H.
    const removalRecoveryInvite = await createInviteFromOwner();
    unwrapOn(
      await invokeOn(second.client, "cloudSeedPendingInvite", {
        link: removalRecoveryInvite.link,
      }),
      "removed teammate parse recovery invite"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "removed teammate recovery invite dialog"
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-join-org-confirm"]',
      "removed teammate rejoin workspace"
    );
    await waitForGoneOn(
      second.client,
      '[data-testid="cloud-join-org-dialog"]',
      "removed teammate reactivated",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForGone(
      `[data-testid="cloud-org-invite-revoke-${removalRecoveryInvite.inviteId}"]`,
      "owner recovery invite exhausted after teammate reactivation",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await waitForGone(
      '[data-testid="cloud-org-invite-link"]',
      "owner exhausted recovery invite copy window",
      CLOUD_FETCH_TIMEOUT_MS
    );
    const rosterDiagnostic = unwrapOn(
      await invokeOn(second.client, "cloudInspectRosterState"),
      "reactivated teammate roster diagnostic"
    );
    console.info(
      `[cloud-dual-e2e] reactivation roster diagnostic ${JSON.stringify(rosterDiagnostic)}`
    );
    await openCloudOrgPanelOn(second.client, teamOrgId, "reactivated teammate");
  });

  it("L. requires exact typed confirmation and evicts both clients when the owner deletes the org", async function () {
    this.timeout(240_000);

    await openCloudOrgPanelFromSidebar(teamOrgId);
    await selectPrimaryCloudOrgManagementTab(
      "general",
      "owner general for org deletion"
    );
    await typeRendered(
      '[data-testid="cloud-org-delete-confirm-input"]',
      `${RENAMED_TEAM_NAME} typo`,
      "owner incorrect org delete confirmation"
    );
    const wrongConfirmationEnabled = await execJS(
      `return document.querySelector('[data-testid="cloud-org-delete-confirm"]')?.disabled === false;`
    );
    if (wrongConfirmationEnabled) {
      throw new Error("org deletion enabled for an inexact confirmation name");
    }

    await typeRendered(
      '[data-testid="cloud-org-delete-confirm-input"]',
      RENAMED_TEAM_NAME,
      "owner exact org delete confirmation"
    );
    await clickRendered(
      '[data-testid="cloud-org-delete-confirm"]',
      "owner delete org"
    );

    try {
      await Promise.all([
        browser.waitUntil(
          async () => {
            const listed = unwrap(
              await invokeE2E("cloudListOrgs"),
              "owner org roster after deletion"
            );
            return (
              !listed.orgs?.some((org) => org.orgId === teamOrgId) &&
              listed.orgs?.some((org) => org.orgId === ownerPersonalOrgId)
            );
          },
          {
            timeout: CLOUD_FETCH_TIMEOUT_MS,
            interval: 500,
            timeoutMsg:
              "deleted org remained for owner or personal org vanished",
          }
        ),
        second.client.waitUntil(
          async () => {
            const listed = unwrapOn(
              await invokeOn(second.client, "cloudListOrgs"),
              "teammate org roster after deletion"
            );
            return (
              !listed.orgs?.some((org) => org.orgId === teamOrgId) &&
              listed.orgs?.some((org) => org.orgId === teammatePersonalOrgId)
            );
          },
          {
            timeout: CLOUD_FETCH_TIMEOUT_MS,
            interval: 500,
            timeoutMsg:
              "deleted org remained for teammate or personal org vanished",
          }
        ),
        waitForGone(
          '[data-testid="cloud-org-panel"]',
          "owner deleted org panel",
          CLOUD_FETCH_TIMEOUT_MS
        ),
        waitForGoneOn(
          second.client,
          '[data-testid="cloud-org-panel"]',
          "teammate deleted org panel",
          CLOUD_FETCH_TIMEOUT_MS
        ),
      ]);
    } catch (error) {
      const deletionDiagnostic = await invokeOn(
        second.client,
        "cloudInspectRosterState"
      );
      console.info(
        `[cloud-dual-e2e] deletion roster diagnostic ${JSON.stringify(deletionDiagnostic)}`
      );
      throw error;
    }
  });
});
