/* global browser, describe, before, after, it, process */
import { join } from "node:path";

import {
  CLOUD_CREATE_ORG_TIMEOUT_MS,
  CLOUD_FETCH_TIMEOUT_MS,
  E2E_REPO_PATH,
  RUN_ID,
  applyCloudEndpointOverride,
  cleanupCloudUser,
  clickRendered,
  cloudEnv,
  ensureCloudSchemaReady,
  execJS,
  invokeE2E,
  openCloudOrgPanelFromSidebar,
  openCreateOrgFormFromSidebar,
  openTurnCommentPanel,
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

const TEAM_NAME = `Dual-instance Team ${RUN_ID}`;
const RENAMED_TEAM_NAME = `Renamed dual team ${RUN_ID}`;
const SESSION_ID = `dual-instance-session-${RUN_ID}`;
const SESSION_TITLE = `Dual instance restricted share ${RUN_ID}`;
const SESSION_BLAME_FILE = "package.json";
const COMMENT_BODY = `@agent dual-instance task ${RUN_ID}`;
const SESSION_NOTE_BODY = `Dual-instance session note ${RUN_ID}`;
const EDITED_COMMENT_BODY = `@agent dual-instance edited task ${RUN_ID}`;
const EDITED_COMMENT_BRIEF = EDITED_COMMENT_BODY.slice("@agent ".length);
const REPLY_BODY = `Owner reply from the other instance ${RUN_ID}`;
const SEND_BODY = `Continue this work from the matching workspace ${RUN_ID}`;
const PROJECT_NAME = `Dual cloud project ${RUN_ID}`;
const PROJECT_SLUG = PROJECT_NAME.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
const PROJECT_ID = `proj-${PROJECT_SLUG}`;
const WORK_ITEM_TITLE = `Dual synced work item ${RUN_ID}`;
const CASCADE_WORK_ITEM_TITLE = `Project cascade item ${RUN_ID}`;
const UNREACHABLE_CLOUD_ENDPOINT = {
  webOrigin: "http://127.0.0.1:1",
  supabaseUrl: "http://127.0.0.1:1",
  anonKey: "offline-anon-key",
};
const REMOTE_ROW_SELECTOR = `[data-testid="sidebar-cloud-session-item-${SESSION_ID}"]`;
const REPO_SCOPE_KEY =
  process.env.E2E_REPO_SCOPE_KEY ?? "github.com/orgii/e2e-workspace";
const FORK_E2E_MODEL = "gpt-4o-mini";

async function completeForkSetupOn(client, label) {
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
  await client.waitUntil(
    async () =>
      executeOn(
        client,
        `
          const account = document.querySelector('[data-testid="fork-setup-account"]');
          const model = document.querySelector('[data-testid="fork-setup-model"]');
          const submit = document.querySelector('[data-testid="fork-setup-submit"]');
          return !!account?.querySelector('.select-value')?.textContent?.trim() &&
            !!model?.querySelector('.select-value')?.textContent?.trim() &&
            !!submit && !submit.disabled;
        `
      ),
    {
      timeout: CLOUD_FETCH_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} account/model defaults never became runnable`,
    }
  );
  await clickRenderedOn(
    client,
    '[data-testid="fork-setup-submit"]',
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
  const toggle = '[data-testid="code-editor-timeline-section-toggle"]';
  await waitForRenderedOn(client, toggle, "secondary Timeline section");
  const collapsed = await executeOn(
    client,
    `return document.querySelector(arguments[0])?.getAttribute('data-collapsed') === 'true';`,
    [toggle]
  );
  if (collapsed) {
    await clickRenderedOn(client, toggle, "secondary expand Timeline section");
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
  const opened = await executeOn(
    client,
    `
      const row = document.querySelector(arguments[0]);
      if (!row) return false;
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 24,
        clientY: rect.top + 20,
      }));
      return true;
    `,
    [`[data-testid="project-row-${projectId}"]`]
  );
  if (!opened) throw new Error(`${label} Project row was not rendered`);
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
      return (
        link.startsWith("orgii://cloud/join?invite=") && link !== previousLink
      );
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

async function postCommentOn(client, body) {
  await typeRenderedOn(
    client,
    '[data-testid="session-comment-composer"] textarea',
    body,
    "secondary comment body"
  );
  await client.waitUntil(
    async () => {
      const result = await executeOn(
        client,
        `
          const button = document.querySelector('[data-testid="session-comment-composer"] button');
          if (!button || button.disabled) return false;
          button.click();
          return true;
        `
      );
      return result === true;
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "secondary comment submit never enabled",
    }
  );
  await waitForRenderedOn(
    client,
    '[data-testid="session-comment-row"]',
    "secondary posted comment",
    CLOUD_FETCH_TIMEOUT_MS
  );
}

async function openWorkItemsLayerOn(client, label) {
  const layerVisible = await executeOn(
    client,
    "return !!document.querySelector('[data-testid=\"sidebar-create-project\"]');"
  );
  if (!layerVisible) {
    await clickRenderedOn(
      client,
      '[data-testid="sidebar-toggle-work-items"]',
      `${label} Work Items navigation`
    );
  }
  await waitForRenderedOn(
    client,
    '[data-testid="sidebar-create-project"]',
    `${label} Work Items layer`,
    CLOUD_FETCH_TIMEOUT_MS
  );
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
  await waitForRenderedOn(
    client,
    `[data-testid="sidebar-work-item-${workItemId}"]`,
    `${label} Work Item sidebar row`,
    CLOUD_FETCH_TIMEOUT_MS
  );
  await clickRenderedOn(
    client,
    `[data-testid="sidebar-work-item-${workItemId}"]`,
    `${label} open Work Item`
  );
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
      "dual-owner",
      "Dual Owner"
    );
    if (!ownerResult.ok) throw new Error(ownerResult.reason);
    owner = ownerResult.user;
    const teammateResult = await provisionCloudUser(
      env,
      "dual-teammate",
      "Dual Teammate"
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
        displayName: "Dual Owner",
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
    await seedAuthOn(second.client, env, teammate, "Dual Teammate");

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
    if (!String(inviteLink).startsWith("orgii://cloud/join?invite=")) {
      throw new Error("rendered team invite is not a valid orgii join link");
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

    // The owner's already-open panel must receive roster invalidation live.
    await browser.waitUntil(
      async () =>
        execJS(
          `return document.querySelectorAll('[data-testid="cloud-org-member-row"]').length >= 2;`
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "owner panel did not receive the joined teammate live",
      }
    );
  });

  it("C. directly shares a restricted replay without a link; teammate receives, filters, imports, forks, and comments", async function () {
    this.timeout(360_000);
    unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "primary ensure shared repository"
    );
    unwrapOn(
      await invokeOn(second.client, "ensureRepoSelected", {
        repoPath: E2E_REPO_PATH,
      }),
      "secondary ensure shared repository"
    );
    unwrapOn(
      await invokeOn(second.client, "addAccount", {
        openaiApiKey: "sk-orgii-rendered-e2e-not-sent",
        model: FORK_E2E_MODEL,
        accountName: `Cloud fork rendered E2E ${RUN_ID}`,
      }),
      "secondary seed rendered fork account"
    );

    await openCloudOrgPanelFromSidebar(teamOrgId);
    await selectPrimaryCloudOrgManagementTab(
      "repo-scope",
      "primary team repo scope"
    );
    await waitForRendered(
      '[data-testid="cloud-org-repo-scope"]',
      "primary team repo scope",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await browser.waitUntil(
      async () =>
        execJS(
          `
            const expected = ${JSON.stringify(REPO_SCOPE_KEY)};
            const labels = [...document.querySelectorAll('[data-testid="cloud-org-repo-scope"] button span[title]')];
            const button = labels.find((label) => label.getAttribute('title') === expected)?.closest('button');
            return !!button && !button.disabled;
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "primary repo scope option never became available",
      }
    );
    await execJS(`
      const expected = ${JSON.stringify(REPO_SCOPE_KEY)};
      const labels = [...document.querySelectorAll('[data-testid="cloud-org-repo-scope"] button span[title]')];
      labels.find((label) => label.getAttribute('title') === expected)?.closest('button')?.click();
      return true;
    `);
    await browser.waitUntil(
      async () =>
        execJS(
          `
            const button = document.querySelector('[data-testid="cloud-org-save-repo-scopes"]');
            return !!button && !button.disabled;
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
            return !!section && !!save && save.disabled && section.textContent.includes(${JSON.stringify(REPO_SCOPE_KEY)});
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "team repo scope never reached its saved state",
      }
    );

    await seedAndOpenCloudEligibleSession(SESSION_ID, SESSION_TITLE, {
      touchedFilePath: join(E2E_REPO_PATH, SESSION_BLAME_FILE),
    });
    unwrap(
      await invokeE2E("cloudTagSessionToOrg", {
        sessionId: SESSION_ID,
        orgId: teamOrgId,
      }),
      "tag owner session to team"
    );
    // Start at metadata-only: the rendered directed-share button must promote
    // and publish the full replay itself before creating the grant. This is
    // the one-click UX contract; no hidden pre-share sync-level step.
    await setCloudSessionModeViaDialog(SESSION_ID, teamOrgId, "metadata_only");
    await setCloudSessionVisibilityViaDialog(
      SESSION_ID,
      teamOrgId,
      "restricted"
    );
    await publishCloudSessionMetadata(env, owner, {
      orgId: teamOrgId,
      sessionId: SESSION_ID,
      title: SESSION_TITLE,
      repoScopeKey: REPO_SCOPE_KEY,
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
      [`[data-testid="sidebar-cloud-session-item-${SESSION_ID}"]`]
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
      REMOTE_ROW_SELECTOR,
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
      REMOTE_ROW_SELECTOR,
      "directed session under Shared with me filter"
    );

    await clickRenderedOn(
      second.client,
      REMOTE_ROW_SELECTOR,
      "secondary import/replay shared session"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-imported-from-chip"]',
      "secondary imported-from provenance",
      CLOUD_FETCH_TIMEOUT_MS
    );

    const importedState = unwrapOn(
      await invokeOn(second.client, "inspectChatState"),
      "secondary imported replay state"
    );
    const importedSessionId = importedState.activeSessionId;
    if (!importedSessionId || importedSessionId === SESSION_ID) {
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
            repoPath: E2E_REPO_PATH,
            filePath: SESSION_BLAME_FILE,
          }),
          "secondary Team Session Blame projection"
        );
        collaborationHistory = result.history?.sessions?.find(
          (session) =>
            session.sessionId === importedSessionId &&
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
        `${teamOrgId}:${owner.userId}:${SESSION_ID}` ||
      collaborationHistory.collaborationOrigin?.ownerDisplayName !==
        "Dual Owner" ||
      collaborationHistory.actionCounts?.read !== 1
    ) {
      throw new Error(
        `Team Session Blame identity/actions are wrong: ${JSON.stringify(collaborationHistory)}`
      );
    }

    // Deliberately hide the owner row with a member filter, then leave the
    // team scope. Clicking blame must restore the exact cloud org and row
    // without rewriting that saved filter.
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-team-sessions-filter"]',
      "secondary Team filter before blame navigation"
    );
    await clickRenderedOn(
      second.client,
      `[data-testid="sidebar-cloud-filter-member-${teammate.userId}"]`,
      "secondary filter to own sessions"
    );
    await waitForGoneOn(
      second.client,
      REMOTE_ROW_SELECTOR,
      "owner row under teammate-only filter"
    );
    await selectCloudOrgOn(second.client, teammatePersonalOrgId);
    await openFileTimelineOn(
      second.client,
      join(E2E_REPO_PATH, SESSION_BLAME_FILE)
    );
    const teamBlameSelector =
      `[data-testid="session-blame-session"]` +
      `[data-session-id="${importedSessionId}"]` +
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
    if (!String(blameText).includes("@Dual Owner")) {
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
            [REMOTE_ROW_SELECTOR]
          ),
        ]);
        return (
          state.ok === true &&
          state.activeSessionId === importedSessionId &&
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
    if (!String(viewerLabel).includes("Dual Owner")) {
      throw new Error(`viewer chip did not identify the owner: ${viewerLabel}`);
    }
    unwrap(await invokeE2E("resetToNewSession"), "owner leave shared session");
    await waitForGoneOn(
      second.client,
      ownerViewerChip,
      "secondary owner viewer chip after owner leaves",
      CLOUD_FETCH_TIMEOUT_MS
    );
    unwrap(await invokeE2E("openSession", SESSION_ID), "owner reopen session");
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
    await openTurnCommentPanel(`user-${SESSION_ID}`);
    await clickRenderedOn(
      second.client,
      `[data-testid="session-comment-toggle-user-${SESSION_ID}"]`,
      "secondary turn comment toggle"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-comment-composer"] textarea',
      "secondary turn comment composer"
    );
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
    await waitForRendered(
      `[data-testid="session-comment-agent-badge-user-${SESSION_ID}"]`,
      "owner realtime @agent task badge",
      CLOUD_FETCH_TIMEOUT_MS
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

    await clickRenderedOn(
      second.client,
      '[data-testid="session-fork-button"]',
      "secondary fork imported session"
    );
    await completeForkSetupOn(second.client, "secondary explicit fork");
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-forked-from-chip"]',
      "secondary fork provenance",
      CLOUD_FETCH_TIMEOUT_MS
    );
  });

  it("D. syncs comment CRUD/status, intercepts send into a same-remote fork, and revokes directed access live", async function () {
    this.timeout(360_000);

    // C ends on a writable fork. Re-open the remote row to return to its
    // imported replay before exercising edit/status and intercept-send.
    await clickRenderedOn(
      second.client,
      REMOTE_ROW_SELECTOR,
      "secondary reopen imported replay"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="session-imported-from-chip"]',
      "secondary imported replay provenance",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      `[data-testid="session-comment-toggle-user-${SESSION_ID}"]`,
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
        invokeE2E("cloudInspectDebugState", { sessionId: SESSION_ID }),
        invokeOn(second.client, "cloudInspectDebugState", {
          sessionId: SESSION_ID,
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
          if (!button || button.disabled) return false;
          button.click();
          return true;
        `),
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "owner reply submit never enabled",
      }
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
          invokeE2E("cloudInspectDebugState", { sessionId: SESSION_ID }),
          invokeOn(second.client, "cloudInspectDebugState", {
            sessionId: secondaryActive ?? SESSION_ID,
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
      REMOTE_ROW_SELECTOR,
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
    const link = String(
      (await execJS(
        `return document.querySelector('[data-testid="cloud-session-share-created-link"]')?.textContent?.trim() ?? '';`
      )) ?? ""
    );
    if (!link.startsWith("orgii://cloud/session?share=")) {
      throw new Error("generated session ticket is not a valid orgii link");
    }

    await clickRenderedOn(
      second.client,
      '[data-testid="sidebar-new-session"]',
      "secondary open a real New Session"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="import-session-trigger"]',
      "secondary Import entry after New Session",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="import-session-trigger"]',
      "secondary Import entry"
    );
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
      '[data-testid="session-imported-from-chip"]',
      "secondary link-import provenance",
      CLOUD_FETCH_TIMEOUT_MS
    );

    await clickRendered(
      '[data-testid="cloud-session-share-created-link-revoke"]',
      "owner revoke one-shot link"
    );
    await waitForGone(
      '[data-testid="cloud-session-share-created-link"]',
      "owner one-shot plaintext after revoke"
    );

    await clickRenderedOn(
      second.client,
      '[data-testid="sidebar-new-session"]',
      "secondary New Session before revoked-link retry"
    );
    await waitForRenderedOn(
      second.client,
      '[data-testid="import-session-trigger"]',
      "secondary Import entry for revoked-link retry",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="import-session-trigger"]',
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
        repoPath: E2E_REPO_PATH,
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
              return !!button && button.disabled && button.textContent.includes('Dual Owner');
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
            return !!button && !button.textContent.includes('Dual Owner');
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "teammate Work Item action did not clear the released lock",
      }
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
          settings: !!document.querySelector('[data-testid="cloud-org-settings"]'),
          danger: !!document.querySelector('[data-testid="cloud-org-danger-zone"]'),
        };
      `),
      executeOn(
        second.client,
        `
          return {
            plan: !!document.querySelector('[data-testid="cloud-org-plan-section"]'),
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
    await selectCloudOrgManagementTabOn(
      second.client,
      "repo-scope",
      "secondary repo scope"
    );
    const memberScopeControls = await executeOn(
      second.client,
      `return { scopeSave: !!document.querySelector('[data-testid="cloud-org-save-repo-scopes"]') };`
    );
    const ownerControls = {
      ...ownerGeneralControls,
      ...ownerMemberControls,
    };
    const memberControls = {
      ...memberGeneralControls,
      ...memberMemberControls,
      ...memberScopeControls,
    };
    if (
      !ownerControls.plan ||
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
    await waitForRenderedOn(
      second.client,
      '[data-testid="cloud-org-sharing-floor-member-note"]',
      "member effective org sharing floor",
      CLOUD_FETCH_TIMEOUT_MS
    );
    await clickRenderedOn(
      second.client,
      '[data-testid="cloud-org-default-access-select"]',
      "member default sharing level"
    );
    const belowOrgFloorVisible = await executeOn(
      second.client,
      `return !!document.querySelector('[data-testid="cloud-org-default-access-off"]');`
    );
    if (belowOrgFloorVisible) {
      throw new Error(
        "member could select a default below the org sharing floor"
      );
    }
    await pressEscapeOn(second.client);

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
          `return document.querySelector('[data-testid="cloud-org-default-access-select"]')?.textContent?.includes('Full replay') === true;`
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
          `return document.querySelector('[data-testid="cloud-org-default-access-select"]')?.textContent?.includes('Metadata') === true;`
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
        execJS(
          `
            const row = document.querySelector('[data-testid="cloud-org-member-row"][data-member-id=${JSON.stringify(teammate.userId)}]');
            return row?.textContent?.includes('removed') === true;
          `
        ),
      {
        timeout: CLOUD_FETCH_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "owner roster did not receive the member leave live",
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
