/* global browser, process, fetch */
/**
 * cloudOrgUiDriver.mjs — rendered-DOM driver for the managed ORG2 Cloud org
 * UI plus the `__e2e.cloud*` bridge helpers.
 *
 * Design contract (see cloud-org-ui.spec.mjs):
 * - Every user-visible action goes through the production click path
 *   (sidebar org selector, SelectionGrid cards, real inputs, header menus).
 * - `__e2e.cloud*` helpers only SEED store state that has no
 *   WebDriver-reachable entry (persisted auth atom, in-memory orgs atom,
 *   deep-link pending invite, the native-menu-only sync-level dialog) and
 *   READ store ground truth back for assertions.
 * - Two modes, decided by tests/e2e/.env:
 *   - LIVE (E2E_CLOUD_* set): the app's cloud endpoint is pointed at a REAL
 *     throwaway org2_cloud Supabase project via the Phase C endpoint
 *     override, and a real JWT is minted through the cloud harness's
 *     password-user trick (GoTrue admin create + password grant — see
 *     ORGII-cloud-infra scripts/cloud/cloud-integration-test.mjs).
 *   - OFFLINE (unset): the endpoint override points at an .invalid host so
 *     no request can ever reach the official managed backend; every surface
 *     reachable without a live backend is still exercised, the rest SKIPs
 *     loudly.
 * - No fixed sleeps: every wait is a browser.waitUntil on rendered DOM or on
 *   bridge-read store state.
 *
 * NOTE: intentionally depends only on agentOrgUiDriver.mjs — the collab
 * driver (collabOrgUiDriver.mjs) is deleted in cloud-parity Phase E and must
 * not be imported here.
 */
import {
  E2E_REPO_PATH,
  RENDER_TIMEOUT_MS,
  RUN_ID,
  execJS,
  invokeE2E,
  js,
  unwrap,
  waitForApp,
} from "./agentOrgUiDriver.mjs";

export {
  E2E_REPO_PATH,
  RENDER_TIMEOUT_MS,
  RUN_ID,
  execJS,
  invokeE2E,
  js,
  unwrap,
  waitForApp,
};

/** Live Supabase round-trips (create_org + invite mint) before render. */
export const CLOUD_CREATE_ORG_TIMEOUT_MS = 60_000;

/** Panel/section fetches against the live backend (entitlement + members). */
export const CLOUD_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_CLOUD_FETCH_TIMEOUT_MS ?? "45000",
  10
);

/**
 * `org2_cloud.schema_version` this app build speaks — MUST mirror
 * `ORG2_CLOUD_EXPECTED_SCHEMA_VERSION` in src/features/Org2Cloud/config.ts
 * (the app gates custom-endpoint sync on an exact match, so a drifted test
 * project would silently exercise a gated app; the suite skips instead).
 * Pre-release the backend ships as ONE consolidated baseline (version 1,
 * comment + task RPCs included), so the comment scenarios H–L have their
 * RPCs whenever the gate passes.
 */
export const CLOUD_EXPECTED_SCHEMA_VERSION = Number.parseInt(
  process.env.E2E_CLOUD_EXPECTED_SCHEMA_VERSION ?? "1",
  10
);

/** Same key `org2CloudEndpointOverrideAtom` persists through (config.ts). */
const CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY =
  "orgii:org2-cloud-v1:endpointOverride";

/**
 * OFFLINE endpoint: RFC 2606 reserved TLD, so DNS resolution fails fast and
 * deterministically — no cloud request from the offline suite can ever reach
 * the OFFICIAL managed backend (which is what the app would use with no
 * override).
 */
export const OFFLINE_CLOUD_ENDPOINT = {
  webOrigin: "https://orgii-e2e-cloud-offline.invalid",
  supabaseUrl: "https://orgii-e2e-cloud-offline.invalid",
  anonKey: "orgii-e2e-offline-anon-key",
};

// ============================================================================
// Environment gating (LIVE mode)
// ============================================================================

/**
 * Reads the cloud backend credentials from the WDIO Node process env
 * (dotenv loads tests/e2e/.env). Returns null when not provisioned — the
 * LIVE scenarios must SKIP, not fail: missing credentials are an infra gap.
 *
 * Auth needs ONE of:
 * - E2E_CLOUD_SERVICE_KEY — service_role key of the THROWAWAY test project;
 *   the driver mints a fresh confirmed user via the GoTrue admin API and
 *   signs it in with the password grant (the cloud harness's
 *   password-user trick), then soft-deletes it in cleanup.
 * - E2E_CLOUD_EMAIL + E2E_CLOUD_PASSWORD — a pre-provisioned password user.
 */
export function cloudEnv() {
  const supabaseUrl = (process.env.E2E_CLOUD_SUPABASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const anonKey = (process.env.E2E_CLOUD_ANON_KEY ?? "").trim();
  if (!supabaseUrl || !anonKey) return null;
  return {
    supabaseUrl,
    anonKey,
    webOrigin:
      (process.env.E2E_CLOUD_WEB_ORIGIN ?? "").trim() ||
      "https://org2-cloud-infra.vercel.app",
    serviceKey: (process.env.E2E_CLOUD_SERVICE_KEY ?? "").trim() || null,
    email: (process.env.E2E_CLOUD_EMAIL ?? "").trim() || null,
    password: (process.env.E2E_CLOUD_PASSWORD ?? "").trim() || null,
  };
}

async function jsonRequest(url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: response.ok, status: response.status, json };
}

/**
 * Verifies the org2_cloud schema on the target project through the same
 * anon `schema_version` RPC the app's endpoint gate uses. A missing or
 * drifted schema is a provisioning gap → `{ ready:false, reason }` so the
 * suite can skip the live scenarios honestly instead of green-washing.
 */
export async function ensureCloudSchemaReady(env) {
  const result = await jsonRequest(
    `${env.supabaseUrl}/rest/v1/rpc/schema_version`,
    {
      method: "POST",
      headers: {
        apikey: env.anonKey,
        authorization: `Bearer ${env.anonKey}`,
        "content-type": "application/json",
        "content-profile": "org2_cloud",
        "accept-profile": "org2_cloud",
      },
      body: {},
    }
  );
  if (!result.ok || typeof result.json !== "number") {
    return {
      ready: false,
      schemaVersion: null,
      reason: `schema_version() failed against ${env.supabaseUrl} (status=${result.status}) — is org2_cloud exposed and migrated?`,
    };
  }
  if (result.json !== CLOUD_EXPECTED_SCHEMA_VERSION) {
    return {
      ready: false,
      schemaVersion: result.json,
      reason: `org2_cloud schema_version=${result.json}, app expects ${CLOUD_EXPECTED_SCHEMA_VERSION} — apply the missing ORGII-cloud-infra migrations to the E2E project`,
    };
  }
  return { ready: true, schemaVersion: result.json, reason: null };
}

/**
 * Mints a real cloud JWT (the harness's password-user trick): admin-create a
 * confirmed throwaway user when a service key is provided, then sign in with
 * the GoTrue password grant. Returns `{ ok:false, reason }` when the env
 * carries no auth capability — the caller skips live scenarios.
 */
export async function provisionCloudUser(
  env,
  identitySuffix = "",
  displayName = ""
) {
  let email = env.email;
  let password = env.password;
  let createdByAdmin = false;
  if (env.serviceKey) {
    const safeSuffix = String(identitySuffix)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const identityPart = safeSuffix ? `-${safeSuffix}` : "";
    email = `orgii-e2e-cloud-${RUN_ID}${identityPart}@example.com`;
    password = `Pw!orgii-e2e-${RUN_ID}${identityPart}`;
    const created = await jsonRequest(
      `${env.supabaseUrl}/auth/v1/admin/users`,
      {
        method: "POST",
        headers: {
          apikey: env.serviceKey,
          authorization: `Bearer ${env.serviceKey}`,
          "content-type": "application/json",
        },
        body: {
          email,
          password,
          email_confirm: true,
          ...(displayName
            ? { user_metadata: { display_name: displayName } }
            : {}),
        },
      }
    );
    const createdId = created.json?.id ?? created.json?.user?.id;
    if (!created.ok || !createdId) {
      return {
        ok: false,
        reason: `GoTrue admin user create failed: status=${created.status} body=${JSON.stringify(created.json)?.slice(0, 200)}`,
      };
    }
    createdByAdmin = true;
  } else if (!email || !password) {
    return {
      ok: false,
      reason:
        "no cloud auth capability: set E2E_CLOUD_SERVICE_KEY (throwaway project) or E2E_CLOUD_EMAIL + E2E_CLOUD_PASSWORD",
    };
  }
  const session = await jsonRequest(
    `${env.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: env.anonKey, "content-type": "application/json" },
      body: { email, password },
    }
  );
  const accessToken = session.json?.access_token;
  const refreshToken = session.json?.refresh_token;
  const userId = session.json?.user?.id;
  if (!session.ok || !accessToken || !refreshToken || !userId) {
    return {
      ok: false,
      reason: `password sign-in failed for ${email} (is the Email provider enabled?): status=${session.status} body=${JSON.stringify(session.json)?.slice(0, 200)}`,
    };
  }
  const expiresAt =
    typeof session.json?.expires_at === "number"
      ? session.json.expires_at
      : Math.floor(Date.now() / 1000) + (session.json?.expires_in ?? 3600);
  return {
    ok: true,
    user: {
      userId,
      email,
      accessToken,
      refreshToken,
      expiresAt,
      createdByAdmin,
    },
  };
}

/** Best-effort soft-delete of an admin-provisioned throwaway user. */
export async function cleanupCloudUser(env, user) {
  if (!env?.serviceKey || !user?.createdByAdmin) return;
  try {
    // Soft delete is REQUIRED: orgs.owner_user_id references auth.users
    // without cascade, so a hard delete of an org owner hits the FK.
    await jsonRequest(`${env.supabaseUrl}/auth/v1/admin/users/${user.userId}`, {
      method: "DELETE",
      headers: {
        apikey: env.serviceKey,
        authorization: `Bearer ${env.serviceKey}`,
        "content-type": "application/json",
      },
      body: { should_soft_delete: true },
    });
  } catch {
    // Cleanup is hygiene, never a test failure.
  }
}

// ============================================================================
// Endpoint override (Phase C seam — resolved per call, no reload needed)
// ============================================================================

/**
 * Points every cloud client at `endpoint` via the Phase C localStorage
 * override (`getCloudEndpoint()` re-reads it on every call, so this takes
 * effect immediately). A raw localStorage write is the PRODUCTION storage
 * shape — the settings card persists through the same key/schema.
 */
export async function applyCloudEndpointOverride(endpoint) {
  const value = JSON.stringify({
    webOrigin: endpoint.webOrigin,
    supabaseUrl: endpoint.supabaseUrl,
    anonKey: endpoint.anonKey,
  });
  await execJS(`
    window.localStorage.setItem(
      ${JSON.stringify(CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY)},
      ${JSON.stringify(value)}
    );
    return true;
  `);
}

export async function clearCloudEndpointOverride() {
  await execJS(`
    window.localStorage.removeItem(
      ${JSON.stringify(CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY)}
    );
    return true;
  `);
}

// ============================================================================
// Low-level rendered helpers
// ============================================================================

export async function waitForRendered(
  selector,
  label,
  timeout = RENDER_TIMEOUT_MS
) {
  try {
    await browser.waitUntil(async () => execJS(js.exists(selector)), {
      timeout,
      interval: 250,
      timeoutMsg: `${label} never rendered: ${selector}`,
    });
  } catch (error) {
    const diagnostic = await execJS(`
      return {
        pathname: window.location.pathname,
        readyState: document.readyState,
        title: document.title,
        bodyText: (document.body?.innerText ?? "").slice(0, 2000),
        bodyHtml: (document.body?.innerHTML ?? "").slice(0, 2000),
        testIds: Array.from(document.querySelectorAll("[data-testid]"))
          .slice(0, 80)
          .map((element) => element.getAttribute("data-testid")),
        storageKeys: Object.keys(window.localStorage).sort(),
      };
    `);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `primary render diagnostic: ${JSON.stringify(diagnostic)}`
    );
  }
}

export async function waitForGone(
  selector,
  label,
  timeout = RENDER_TIMEOUT_MS
) {
  await browser.waitUntil(async () => !(await execJS(js.exists(selector))), {
    timeout,
    interval: 250,
    timeoutMsg: `${label} never left the DOM: ${selector}`,
  });
}

export async function clickRendered(
  selector,
  label,
  timeout = RENDER_TIMEOUT_MS
) {
  await waitForRendered(selector, label, timeout);
  let result = "missing";
  await browser.waitUntil(
    async () => {
      result = await execJS(js.click(selector));
      return result === "clicked";
    },
    {
      timeout,
      interval: 100,
      timeoutMsg: `${label} click failed (${selector}): ${result}`,
    }
  );
}

export async function typeRendered(selector, value, label) {
  await waitForRendered(selector, label);
  const result = await execJS(js.inputValue(selector, value));
  if (result !== "typed") {
    throw new Error(
      `${label} input did not accept value (${selector}): ${result}`
    );
  }
}

/** Escape closes ModalSystem dialogs (escToExit defaults true). */
export async function pressEscape() {
  await execJS(`
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    return true;
  `);
}

// ============================================================================
// Create-org form (rendered production path — shared with the collab flow)
// ============================================================================

/**
 * Opens the create-org form the way a user does: sidebar org selector
 * dropdown → "Add ORG" row (the row lives INSIDE the Select dropdown portal,
 * so it must be revealed by clicking the selector first).
 */
export async function openCreateOrgFormFromSidebar() {
  unwrap(
    await invokeE2E("navigateTo", "/orgii/workstation/code"),
    "navigateTo workstation before add-org"
  );
  await clickRendered(
    '[data-testid="sidebar-org-selector"]',
    "sidebar org selector"
  );
  await clickRendered(
    '[data-testid="sidebar-add-org"]',
    "sidebar add-org action"
  );
  await waitForRendered(
    '[data-testid="create-collab-org-body"]',
    "create org form"
  );
}

// ============================================================================
// Cloud auth + orgs seeding (bridge)
// ============================================================================

/** Deterministic FAKE identity for OFFLINE mode (tokens never leave the app). */
export function offlineCloudUser() {
  return {
    userId: `e2e-cloud-user-${RUN_ID}`,
    accessToken: `e2e-offline-access-${RUN_ID}`,
    refreshToken: `e2e-offline-refresh-${RUN_ID}`,
    // Far-future expiry: ensureFreshSession never attempts a (doomed)
    // network refresh during the offline suite.
    expiresAt: Math.floor(Date.now() / 1000) + 6 * 3600,
    displayName: `E2E Cloud User ${RUN_ID}`,
    createdByAdmin: false,
  };
}

/**
 * Seeds `org2CloudOrgsAtom` and waits until the bridge reads the org back.
 * Re-seeds inside the poll: the auth write triggers a real (offline: failing)
 * `list_my_orgs` fetch that degrades to `[]` and would clobber a single
 * fire-and-forget seed that raced it.
 */
export async function seedCloudOrgUntilListed(org) {
  await browser.waitUntil(
    async () => {
      unwrap(
        await invokeE2E("cloudSeedOrgs", { orgs: [org] }),
        "cloudSeedOrgs"
      );
      const listed = unwrap(await invokeE2E("cloudListOrgs"), "cloudListOrgs");
      return (listed.orgs ?? []).some((row) => row?.orgId === org.orgId);
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `seeded cloud org ${org.orgId} never stuck in org2CloudOrgsAtom`,
    }
  );
}

/**
 * LIVE mode: waits for the real `list_my_orgs` fetch (kicked by the auth
 * seed) to land at least one org — migration 0008 auto-provisions a personal
 * org on signup, so a fresh throwaway user always has one.
 */
export async function waitForRealCloudOrgs(timeout = CLOUD_FETCH_TIMEOUT_MS) {
  let orgs = [];
  await browser.waitUntil(
    async () => {
      const listed = unwrap(await invokeE2E("cloudListOrgs"), "cloudListOrgs");
      orgs = listed.orgs ?? [];
      return orgs.length > 0;
    },
    {
      timeout,
      interval: 1_000,
      timeoutMsg:
        "list_my_orgs never returned an org for the provisioned user (0008 personal-org trigger missing?)",
    }
  );
  return orgs;
}

// ============================================================================
// Sidebar scope + panel navigation
// ============================================================================

/**
 * Selects a cloud org as the sidebar scope (dropdown option carries the
 * stable `sidebar-cloud-org-option-<orgId>` testid) and opens its management
 * panel via the explicit manage button — same two-step UX as collab orgs
 * (selection only switches scope; the panel needs `sidebar-org-manage`).
 */
async function waitForCloudOrgOption(orgId, seedOrg) {
  const selector = `[data-testid="sidebar-cloud-org-option-${orgId}"]`;
  // The caller makes one user click, but a controlled Select can close when
  // its option list or route changes (the management-panel → workstation
  // transition is one such boundary). Poll both the authoritative roster
  // and the popup state, reopening only when the trigger says it is closed.
  // OFFLINE retries may also clear the roster, so only that mode re-seeds.
  await browser.waitUntil(
    async () => {
      const listed = unwrap(
        await invokeE2E("cloudListOrgs"),
        "cloudListOrgs(rendered option)"
      );
      if (!listed.orgs?.some((org) => org.orgId === orgId)) {
        if (!seedOrg) return false;
        unwrap(
          await invokeE2E("cloudSeedOrgs", { orgs: [seedOrg] }),
          "cloudSeedOrgs(rendered option)"
        );
      }
      if (await execJS(js.exists(selector))) return true;
      const selectorOpen = await execJS(`
        return document
          .querySelector('[data-testid="sidebar-org-selector"]')
          ?.classList.contains('select-open') === true;
      `);
      if (!selectorOpen) {
        await execJS(`
          document.querySelector('[data-testid="sidebar-org-selector"]')?.click();
          return true;
        `);
      }
      return false;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `sidebar cloud org option ${orgId} never rendered`,
    }
  );
}

async function waitForActiveCloudOrgScope(orgId) {
  const selectorValue = `cloud:${orgId}`;
  await browser.waitUntil(
    async () =>
      execJS(`
        const scopes = Array.from(
          document.querySelectorAll('[data-testid="sidebar-org-selector-scope"]')
        );
        return scopes.length > 0 && scopes.every(
          (scope) => scope.getAttribute('data-org-id') === ${JSON.stringify(selectorValue)}
        );
      `),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `sidebar selector never committed cloud org ${orgId}`,
    }
  );
}

export async function openCloudOrgPanelFromSidebar(orgId, seedOrg = null) {
  unwrap(
    await invokeE2E("navigateTo", "/orgii/workstation/code"),
    "navigateTo workstation before cloud org open"
  );
  await clickRendered(
    '[data-testid="sidebar-org-selector"]',
    "sidebar org selector"
  );
  await waitForCloudOrgOption(orgId, seedOrg);
  await clickRendered(
    `[data-testid="sidebar-cloud-org-option-${orgId}"]`,
    `sidebar cloud org option ${orgId}`
  );
  await waitForActiveCloudOrgScope(orgId);
  if (seedOrg) {
    unwrap(
      await invokeE2E("cloudSeedOrgs", { orgs: [seedOrg] }),
      "cloudSeedOrgs(before manage menu)"
    );
  }
  // Selecting an option closes the Select dropdown; management is an
  // explicit footer action inside that dropdown, so reopen it.
  await clickRendered(
    '[data-testid="sidebar-org-selector"]',
    "sidebar org selector for manage"
  );
  if (seedOrg) {
    await browser.waitUntil(
      async () => {
        const listed = unwrap(
          await invokeE2E("cloudListOrgs"),
          "cloudListOrgs(manage button)"
        );
        if (!listed.orgs?.some((org) => org.orgId === orgId)) {
          unwrap(
            await invokeE2E("cloudSeedOrgs", { orgs: [seedOrg] }),
            "cloudSeedOrgs(manage button)"
          );
        }
        return execJS(js.exists('[data-testid="sidebar-org-manage"]'));
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "seeded cloud org never rendered its manage button",
      }
    );
  }
  await clickRendered(
    '[data-testid="sidebar-org-manage"]',
    "sidebar org manage button"
  );
  await waitForRendered('[data-testid="cloud-org-panel"]', "cloud org panel");
}

/**
 * Scope-only selection (no panel): used to assert the sidebar "Team
 * sessions" section, which renders whenever a cloud org is the active scope.
 */
export async function selectCloudOrgScopeFromSidebar(orgId, seedOrg = null) {
  unwrap(
    await invokeE2E("navigateTo", "/orgii/workstation/code"),
    "navigateTo workstation before cloud scope select"
  );
  await clickRendered(
    '[data-testid="sidebar-org-selector"]',
    "sidebar org selector"
  );
  await waitForCloudOrgOption(orgId, seedOrg);
  await clickRendered(
    `[data-testid="sidebar-cloud-org-option-${orgId}"]`,
    `sidebar cloud org option ${orgId}`
  );
  await waitForActiveCloudOrgScope(orgId);
  if (seedOrg) {
    await browser.waitUntil(
      async () => {
        const listed = unwrap(
          await invokeE2E("cloudListOrgs"),
          "cloudListOrgs(Team sessions)"
        );
        if (!listed.orgs?.some((org) => org.orgId === orgId)) {
          unwrap(
            await invokeE2E("cloudSeedOrgs", { orgs: [seedOrg] }),
            "cloudSeedOrgs(Team sessions)"
          );
        }
        return execJS(js.exists('[data-testid="cloud-team-sessions-empty"]'));
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "seeded cloud org never rendered Team sessions",
      }
    );
  }
}

/** Selects the local Personal scope across the same controlled-Select races. */
export async function selectPersonalScopeFromSidebar() {
  const selector = '[data-testid="sidebar-personal-org-option"]';
  await browser.waitUntil(
    async () => {
      if (await execJS(js.exists(selector))) {
        await execJS(
          `document.querySelector(${JSON.stringify(selector)})?.click()`
        );
        return true;
      }
      const selectorOpen = await execJS(`
        return document
          .querySelector('[data-testid="sidebar-org-selector"]')
          ?.classList.contains('select-open') === true;
      `);
      if (!selectorOpen) {
        await execJS(`
          document.querySelector('[data-testid="sidebar-org-selector"]')?.click();
          return true;
        `);
      }
      return false;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg:
        "Personal org option never stabilized in the sidebar selector",
    }
  );
}

/**
 * Opens the native-context-menu-backed dialog through its E2E seam, then
 * performs the actual access-level choice through the rendered Select.
 */
export async function setCloudSessionModeViaDialog(
  sessionId,
  orgId,
  mode,
  seedOrg = null
) {
  unwrap(
    await invokeE2E("cloudOpenSyncLevelDialog", { sessionId }),
    "cloudOpenSyncLevelDialog(set mode)"
  );
  const trigger = `[data-testid="session-sync-level-mode-${orgId}"]`;
  const option = `[data-testid="session-sync-level-mode-option-${orgId}-${mode}"]`;
  if (seedOrg) {
    await browser.waitUntil(
      async () => {
        if (await execJS(js.exists(trigger))) return true;
        unwrap(
          await invokeE2E("cloudSeedOrgs", { orgs: [seedOrg] }),
          "cloudSeedOrgs(sync-level mode)"
        );
        return execJS(js.exists(trigger));
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `seeded sync-level trigger for ${orgId} never rendered`,
      }
    );
  }
  await clickRendered(trigger, `sync-level trigger for ${orgId}`);
  await clickRendered(option, `sync-level ${mode} option for ${orgId}`);
  await browser.waitUntil(
    async () => {
      const selected = await execJS(`
        return document.querySelector(${JSON.stringify(trigger)})
          ?.querySelector('.select-value')?.textContent?.trim() ?? '';
      `);
      return selected.length > 0;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `sync-level trigger did not render its selected ${mode} value`,
    }
  );
  await pressEscape();
  await waitForGone(
    `[data-testid="session-sync-level-org-${orgId}"]`,
    "sync-level dialog after mode selection"
  );
}

/** Chooses Everyone/Only-me through the same rendered sync-level dialog. */
export async function setCloudSessionVisibilityViaDialog(
  sessionId,
  orgId,
  visibility
) {
  unwrap(
    await invokeE2E("cloudOpenSyncLevelDialog", { sessionId }),
    "cloudOpenSyncLevelDialog(set visibility)"
  );
  const trigger = `[data-testid="session-sync-level-visibility-${orgId}"]`;
  const option = `[data-testid="session-sync-level-visibility-option-${visibility}"]`;
  await clickRendered(trigger, `sync-level visibility trigger for ${orgId}`);
  await clickRendered(option, `sync-level visibility ${visibility}`);
  await pressEscape();
  await waitForGone(
    `[data-testid="session-sync-level-org-${orgId}"]`,
    "sync-level dialog after visibility selection"
  );
}

// ============================================================================
// Session comments + in-place agent pickup (2026-07-11 rework)
// ============================================================================
//
// Same contract as everything above: assertions and clicks stay on the
// rendered production DOM (comment composer, the tri-state thread status,
// the `@agent ` pickup receipt on the turn chrome, the slash
// Address-comments flyout, sidebar chips). The two direct-RPC helpers
// below are test FIXTURE, not the surface under test:
// - `publishCloudSessionMetadata` — the production push path is the sync
//   engine's 60s pass gated on org repo scopes + the access-ladder opt-in;
//   driving that from WebDriver would be minutes of setup for a plane the
//   cloud integration harness already covers. The comments/tasks RPCs
//   assert the session row exists and is readable, so the row is seeded
//   server-side with the same `toRemoteMetadata` wire shape the engine
//   pushes (accessMode full_replay: turn anchors are server-gated on it).
// - `listCloudCommentTasks` — ground-truth read that the `@agent ` prefix
//   created a pickup task server-side (`state`/`attempt` prove the row
//   exists and stayed unclaimed without driving a live agent turn).

/** Member-tier org2_cloud RPC as the provisioned user (throws on failure). */
async function cloudMemberRpc(env, accessToken, functionName, body) {
  const result = await jsonRequest(
    `${env.supabaseUrl}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: env.anonKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "content-profile": "org2_cloud",
        "accept-profile": "org2_cloud",
      },
      body,
    }
  );
  if (!result.ok) {
    throw new Error(
      `${functionName} failed: status=${result.status} body=${JSON.stringify(result.json)?.slice(0, 300)}`
    );
  }
  return result.json;
}

/**
 * Seeds the session's server row via `cloud_upsert_session_metadata` (see
 * the section comment for why this is a fixture RPC and not the engine
 * push). The payload mirrors `toRemoteMetadata` (collabSyncUtils.ts): the
 * listing parses rows with RemoteTeammateSessionMetadataSchema, so the
 * required keys (id, the owner fields, sourceSessionId, title) must all
 * be present.
 */
export async function publishCloudSessionMetadata(
  env,
  user,
  {
    orgId,
    sessionId,
    title,
    repoScopeKey,
    visibility = "org",
    accessMode = "full_replay",
  }
) {
  if (typeof repoScopeKey !== "string" || repoScopeKey.trim().length === 0) {
    throw new Error(
      "publishCloudSessionMetadata requires the org-approved repoScopeKey; an explicit client tag never bypasses server scope governance"
    );
  }
  return cloudMemberRpc(
    env,
    user.accessToken,
    "cloud_upsert_session_metadata",
    {
      p_org_id: orgId,
      p_session_id: sessionId,
      metadata: {
        id: `${orgId}:${user.userId}:${sessionId}`,
        orgId,
        ownerMemberId: user.userId,
        ownerUserId: user.userId,
        ownerDisplayName: user.email ?? `e2e-cloud-${RUN_ID}`,
        ownerIdentityKind: "human",
        sourceSessionId: sessionId,
        title,
        repoScopeKey,
        status: "completed",
        accessMode,
        visibility,
        replayLevel: accessMode === "full_replay" ? "replay" : "metadata",
        lastActivityAt: new Date().toISOString(),
      },
    }
  );
}

/** Ground-truth task rows for the org (`cloud_list_comment_tasks`). */
export async function listCloudCommentTasks(env, user, orgId) {
  const payload = await cloudMemberRpc(
    env,
    user.accessToken,
    "cloud_list_comment_tasks",
    { p_org_id: orgId }
  );
  return payload?.tasks ?? [];
}

/** Turn-anchored comment toggle (TurnCommentChrome under the user turn). */
export function turnCommentToggleSelector(anchorEventId) {
  return `[data-testid="session-comment-toggle-${anchorEventId}"]`;
}

/**
 * Opens the inline per-turn comment panel through the production toggle
 * (renders only once the session resolves to a cloud comment target —
 * tagged to a member org).
 */
export async function openTurnCommentPanel(anchorEventId) {
  const composerSelector = '[data-testid="session-comment-composer"] textarea';
  // This helper promises an open panel, not a toggle. Consecutive scenarios
  // intentionally reuse the same live session, so React can preserve the
  // already-open turn state across openSession calls.
  if (await execJS(js.exists(composerSelector))) return;
  await clickRendered(
    turnCommentToggleSelector(anchorEventId),
    `turn comment toggle ${anchorEventId}`
  );
  await waitForRendered(composerSelector, "turn comment composer");
}

/**
 * Types into the open panel's top-level composer and submits. The send
 * button enables only after React processes the input event, so the click
 * is retried until it lands; the posted row is the success signal (the
 * composer clears ONLY on a successful add).
 */
async function postOpenComment(body) {
  await typeRendered(
    '[data-testid="session-comment-composer"] textarea',
    body,
    "comment composer textarea"
  );
  await browser.waitUntil(
    async () =>
      (await execJS(
        js.click('[data-testid="session-comment-composer"] button')
      )) === "clicked",
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: "comment composer send button never became clickable",
    }
  );
  await waitForRendered(
    '[data-testid="session-comment-row"]',
    "posted comment row",
    CLOUD_FETCH_TIMEOUT_MS
  );
}

export async function postTurnComment(body) {
  await postOpenComment(body);
}

/** Opens the header-level session-notes dialog and posts an unanchored note. */
export async function postSessionNote(body) {
  await clickRendered(
    '[data-testid="session-notes-button"]',
    "session notes button"
  );
  await waitForRendered(
    '[data-testid="session-comment-composer"] textarea',
    "session note composer"
  );
  await postOpenComment(body);
}

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-input"] [contenteditable="true"]';

export function agentTurnBadgeSelector(anchorEventId) {
  return `[data-testid="session-comment-agent-badge-${anchorEventId}"]`;
}

export async function waitForAgentTurnBadge(
  anchorEventId,
  timeout = CLOUD_FETCH_TIMEOUT_MS
) {
  await waitForRendered(
    agentTurnBadgeSelector(anchorEventId),
    `agent turn badge (${anchorEventId})`,
    timeout
  );
}

export function threadStatusSelector(status) {
  return `[data-testid="session-comment-status-${status}"]`;
}

export async function setThreadStatus(status) {
  await clickRendered(
    threadStatusSelector(status),
    `thread status segment (${status})`
  );
}

async function clickWithMouseEvents(selector, label) {
  const result = await execJS(`
    const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const element = candidates[candidates.length - 1] ?? null;
    if (!element) return "missing";
    if (element.disabled) return "disabled";
    const target = element.firstElementChild || element;
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    target.click();
    return "clicked";
  `);
  if (result !== "clicked") {
    throw new Error(`${label} did not click (${selector}): ${result}`);
  }
}

export async function focusChatComposer() {
  const result = await execJS(`
    const editors = Array.from(document.querySelectorAll(${JSON.stringify(CHAT_COMPOSER_SELECTOR)}));
    const editor = editors[editors.length - 1] ?? null;
    if (!editor) return "missing";
    editor.focus();
    return document.activeElement === editor ? "focused" : "focus-failed";
  `);
  if (result !== "focused") {
    throw new Error(`chat composer focus failed: ${result}`);
  }
}

export async function chatComposerText() {
  return execJS(`
    const editors = Array.from(document.querySelectorAll(${JSON.stringify(CHAT_COMPOSER_SELECTOR)}));
    const editor = editors[editors.length - 1] ?? null;
    return editor ? (editor.textContent || "") : null;
  `);
}

export async function hasAddressCommentsPill() {
  return execJS(`
    return Array.from(
      document.querySelectorAll('[data-composer-pill="true"][data-icon-type="skill"]')
    ).some((pill) =>
      (pill.getAttribute('data-file-path') || '').startsWith('/address-comments:')
    );
  `);
}

export async function clearChatComposer() {
  await focusChatComposer();
  await execJS(`
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    return true;
  `);
}

export async function openAddressCommentsFlyout() {
  await waitForRendered(CHAT_COMPOSER_SELECTOR, "chat composer");
  await clearChatComposer();
  const editor = await browser.$(CHAT_COMPOSER_SELECTOR);
  await editor.click();
  await browser.keys("/");
  const nativeKeyLanded = await execJS(`
    return document.querySelector(${JSON.stringify(CHAT_COMPOSER_SELECTOR)})?.textContent?.includes('/') === true;
  `);
  if (!nativeKeyLanded) {
    const fallbackResult = await execJS(js.type(CHAT_COMPOSER_SELECTOR, "/"));
    if (fallbackResult !== "typed") {
      throw new Error(
        `slash input did not reach the rendered composer through WebDriver or InputEvent fallback: ${fallbackResult}`
      );
    }
  }
  try {
    await waitForRendered(
      '[data-testid="slash-command-menu"]',
      "slash command menu"
    );
  } catch (error) {
    const diagnostic = await execJS(`
      const editor = document.querySelector(${JSON.stringify(CHAT_COMPOSER_SELECTOR)});
      return {
        activeIsEditor: document.activeElement === editor,
        editable: editor?.getAttribute('contenteditable') ?? null,
        text: editor?.textContent ?? null,
        chatInputText: document.querySelector('[data-testid="chat-input"]')?.textContent?.slice(0, 500) ?? null,
      };
    `);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; composer=${JSON.stringify(diagnostic)}`
    );
  }
  try {
    await browser.waitUntil(
      async () => {
        const result = await execJS(`
          const rows = Array.from(
            document.querySelectorAll('[data-testid="slash-command-item"][data-slash-category="action"]')
          );
        const row = rows.find(
          (candidate) =>
            candidate.getAttribute("data-slash-source") ===
            "org2cloud-address-comments"
        );
          if (!row) return "missing";
          const target = row.firstElementChild || row;
          target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
          target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
          target.click();
          return "clicked";
        `);
        return result === "clicked";
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 500,
        timeoutMsg:
          "Address-comments action row never appeared in the slash menu (terminal owned session, tagged org, and at least one unresolved thread are its gates)",
      }
    );
  } catch (error) {
    const active = unwrap(
      await invokeE2E("getActiveSessionId"),
      "getActiveSessionId(address comments diagnostic)"
    );
    const debug = unwrap(
      await invokeE2E("cloudInspectDebugState", {
        sessionId: active.sessionId ?? undefined,
      }),
      "cloudInspectDebugState(address comments)"
    ).debug;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; cloud=${JSON.stringify(debug)}`
    );
  }
  await waitForRendered(
    '[data-testid="address-comments-flyout"]',
    "address comments flyout"
  );
  return execJS(`
    return document.querySelectorAll('[data-testid="address-comments-thread-option"]').length;
  `);
}

export async function confirmAddressCommentsFlyout() {
  await clickWithMouseEvents(
    '[data-testid="address-comments-confirm"]',
    "address comments confirm"
  );
  await waitForGone(
    '[data-testid="address-comments-flyout"]',
    "address comments flyout (confirmed)"
  );
}

/** Sidebar Team-sessions row for a session that is MINE (bare local id). */
export function cloudSessionRowSelector(sessionId) {
  return `[data-testid="sidebar-cloud-session-item-${sessionId}"]`;
}

/**
 * Agent-task chip inside the row's trailing accessory slot; variant is
 * "attention" (open count) or "active" (live-lease pulse).
 */
export function sessionTasksBadgeSelector(sessionId, variant) {
  return `${cloudSessionRowSelector(sessionId)} [data-testid="session-tasks-badge"][data-variant="${variant}"]`;
}

/**
 * Clicks every sidebar section-header refresh action. The cloud
 * Team-sessions section's refresh is the production TTL-bypass for its
 * listing (the atom caches for 60s); the buttons are hover-revealed but
 * `.click()` fires on display:none elements, and refreshing any sibling
 * section that also carries a refresh action is a harmless re-read.
 * Returns how many refresh actions were clicked.
 */
export async function clickSidebarSectionRefreshActions() {
  return execJS(`
    const cloudRefresh = document.querySelector('[data-testid="cloud-team-sessions-refresh"]');
    if (cloudRefresh) {
      cloudRefresh.click();
      return 1;
    }
    const buttons = Array.from(
      document.querySelectorAll('.group\\\\/section-title button')
    ).filter((button) => button.querySelector('svg.lucide-refresh-cw'));
    buttons.forEach((button) => button.click());
    return buttons.length;
  `);
}

/**
 * Waits for the session row's agent-task chip under the ACTIVE cloud
 * scope, re-clicking the section refresh each poll (the listing was
 * typically fetched BEFORE the task existed, and its TTL would otherwise
 * serve the stale rows for up to 60s). Resolves with the chip's rendered
 * text (the open-count for the "attention" variant).
 */
export async function waitForSessionTasksBadge(
  sessionId,
  variant,
  timeout = CLOUD_FETCH_TIMEOUT_MS
) {
  const selector = sessionTasksBadgeSelector(sessionId, variant);
  // Capture the count in the SAME DOM read that proves the badge exists.
  // A background cloud-list refresh can legitimately replace the row between
  // `waitUntil` resolving and a follow-up query; doing a second read here
  // turned a rendered, asserted badge into a flaky `null` (TOCTOU).
  let renderedCount = null;
  try {
    await browser.waitUntil(
      async () => {
        const count = await execJS(`
          return document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-count') ?? null;
        `);
        if (count !== null) {
          renderedCount = count;
          return true;
        }
        await clickSidebarSectionRefreshActions();
        const refreshedCount = await execJS(`
          return document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-count') ?? null;
        `);
        if (refreshedCount !== null) renderedCount = refreshedCount;
        return refreshedCount !== null;
      },
      {
        timeout,
        interval: 2_000,
        timeoutMsg: `session tasks badge (${variant}) never rendered for ${sessionId}: ${selector}`,
      }
    );
  } catch (error) {
    const debug = unwrap(
      await invokeE2E("cloudInspectDebugState", { sessionId }),
      "cloudInspectDebugState(session tasks badge)"
    ).debug;
    const diagnostic = await execJS(`
      return {
        refreshCount: document.querySelectorAll('[data-testid="cloud-team-sessions-refresh"]').length,
        rowCount: document.querySelectorAll('[data-testid^="sidebar-cloud-session-item-"]').length,
        targetRowText: document.querySelector(${JSON.stringify(cloudSessionRowSelector(sessionId))})?.textContent?.trim() ?? null,
        sectionText: document.querySelector('[data-testid="cloud-team-sessions-empty"]')?.textContent?.trim() ?? null,
      };
    `);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; sidebar=${JSON.stringify(diagnostic)}; cloud=${JSON.stringify(debug)}`
    );
  }
  return renderedCount;
}

// ============================================================================
// Session seeding for the dialog scenarios
// ============================================================================

/**
 * Seeds a minimal completed session and opens it in the chat panel so the
 * header (and its more-menu) renders. The event shapes mirror the canonical
 * chat-rendering spec factories.
 */
export async function seedAndOpenCloudEligibleSession(
  sessionId,
  title,
  { touchedFilePath } = {}
) {
  // The share gate resolves git remotes through the production IDE server.
  // Register this checkout before asking that resolver to prime; a bare
  // sessionsAtom repoPath is not enough for the server to serve remotes.
  unwrap(
    await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
    "ensureRepoSelected(cloud share repo)"
  );
  unwrap(
    await invokeE2E("seedSidebarSession", {
      sessionId,
      name: title,
      repoPath: E2E_REPO_PATH,
    }),
    "seedSidebarSession"
  );
  // A preceding org-management scenario leaves the chat panel in the
  // CLOUD_ORG content mode. Re-open the seeded session through the same E2E
  // bridge used by session-navigation specs so the production header is not
  // hidden behind stale management content. `seedChatEvents` below then
  // installs the deterministic rendered history after this load completes.
  unwrap(await invokeE2E("openSession", sessionId), "openSession");
  const base = Date.now();
  const userEventId = `user-${sessionId}`;
  const toolEventId = `tool-${sessionId}`;
  const assistantEventId = `assistant-${sessionId}`;
  const events = [
    {
      id: userEventId,
      chunk_id: userEventId,
      sessionId,
      createdAt: new Date(base).toISOString(),
      functionName: "user_message",
      uiCanonical: "user_message",
      actionType: "raw",
      args: {},
      result: { type: "user", message: title, is_delta: false },
      source: "user",
      displayText: title,
      displayStatus: "completed",
      displayVariant: "message",
      activityStatus: "processed",
      isDelta: false,
    },
    ...(touchedFilePath
      ? [
          {
            id: toolEventId,
            chunk_id: toolEventId,
            sessionId,
            createdAt: new Date(base + 500).toISOString(),
            functionName: "read_file",
            uiCanonical: "read_file",
            actionType: "tool_call",
            args: { file_path: touchedFilePath },
            result: { success: true, call_id: toolEventId },
            source: "tool",
            displayText: `Read ${touchedFilePath}`,
            displayStatus: "completed",
            displayVariant: "tool",
            activityStatus: "processed",
            isDelta: false,
          },
        ]
      : []),
    {
      id: assistantEventId,
      chunk_id: assistantEventId,
      sessionId,
      createdAt: new Date(base + 1_000).toISOString(),
      functionName: "assistant_message",
      uiCanonical: "agent_message",
      actionType: "assistant",
      args: {},
      result: {
        content: "CLOUD_E2E_OK",
        observation: "CLOUD_E2E_OK",
        is_delta: false,
        role: "assistant",
      },
      source: "assistant",
      displayText: "CLOUD_E2E_OK",
      displayStatus: "completed",
      displayVariant: "message",
      activityStatus: "agent",
      isDelta: false,
    },
  ];
  unwrap(
    await invokeE2E("seedChatEvents", sessionId, events, {
      chatPanelMaximized: true,
    }),
    "seedChatEvents"
  );
}
