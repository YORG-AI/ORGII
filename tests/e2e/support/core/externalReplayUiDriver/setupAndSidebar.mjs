import { execJS, invokeE2E, invokeTauriCommand } from "./bridge.mjs";
import {
  clickRenderedSelector,
  renderedSelectorSnapshot,
  waitForRenderedSelector,
} from "./renderedControls.mjs";

const MOUNT_TIMEOUT_MS = 60_000;

async function waitForFrontendReady() {
  const port = process.env.E2E_FRONTEND_PORT ?? "1998";
  const url = `http://127.0.0.1:${port}/__orgii_webpack_ready__`;
  await browser.waitUntil(
    async () => {
      try {
        const response = await fetch(url, { method: "GET" });
        if (!response.ok) return false;
        const status = await response.json();
        return status?.ready === true;
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: `frontend dev server never became ready at ${url}`,
    }
  );
}

export async function prepareExternalReplayRenderedUi(repoPath) {
  await waitForFrontendReady();
  await browser.setTimeout({ script: 240_000 });
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return document.readyState === 'complete' || document.readyState === 'interactive';`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: "app document never became script-readable",
    }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(`
          localStorage.setItem('orgii:auth_skipped', '1');
          return true;
        `);
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      interval: 500,
      timeoutMsg:
        "auth skip state could not be written to browser localStorage",
    }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!document.querySelector('[data-testid="chat-panel"]');`
        );
      } catch {
        return false;
      }
    },
    { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "chat-panel never mounted" }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!(window.__e2e && window.__e2e.inspectChatState && window.__e2e.resetToNewSession);`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: 20_000,
      timeoutMsg: "external replay observation helpers never exposed",
    }
  );

  // Repository selection and route navigation are deterministic setup only.
  // Every session-open assertion below still uses the rendered sidebar row.
  const repo = await invokeE2E("ensureRepoSelected", {
    repoPath,
    repoName: "E2E Fixture Repo",
  });
  if (!repo || repo.ok !== true) {
    throw new Error(`ensureRepoSelected failed: ${repo?.error ?? "unknown"}`);
  }
  const navigation = await invokeE2E("navigateTo", "/orgii/workstation/code");
  if (!navigation || navigation.ok !== true) {
    throw new Error(`navigateTo failed: ${navigation?.error ?? "unknown"}`);
  }
}

export async function getRpcCounts() {
  return execJS("return { ...(window.__orgiiE2ERpcCounts || {}) };");
}

export function rpcCountDelta(after, before, command) {
  return Number(after?.[command] ?? 0) - Number(before?.[command] ?? 0);
}

export async function rescanCodexSource() {
  // This is source-discovery setup, not the user-visible behavior assertion.
  // The critical open still waits for and clicks the production sidebar row.
  await invokeTauriCommand("external_history_rescan_source", {
    source: "codex_app",
    clear: false,
  });
}

export async function refreshSessionRosterViaUi() {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const refreshStartedAtMs = Number(await execJS("return Date.now();"));
      // Keep the production rendered controls and their React handlers. The
      // query and click must happen in the same WebKit realm: tauri-wd 0.1.3
      // does not deserialize execute-script element references back to DOM
      // nodes, so WebdriverIO's Node.contains visibility probe cannot be used.
      await browser.waitUntil(
        async () =>
          execJS(`
            const trigger = document.querySelector('button[aria-label="Group by"]');
            return Boolean(trigger && trigger.getClientRects().length > 0);
          `),
        {
          timeout: 20_000,
          timeoutMsg: "rendered Group by trigger did not become visible",
        }
      );
      const opened = await execJS(`
        const trigger = document.querySelector('button[aria-label="Group by"]');
        if (!trigger) return false;
        trigger.click();
        return true;
      `);
      if (!opened) throw new Error("rendered Group by trigger disappeared");

      await browser.waitUntil(
        async () =>
          execJS(`
            return Array.from(document.querySelectorAll('[role="option"]')).some(
              (option) =>
                option.textContent?.trim() === "Refresh" &&
                option.getClientRects().length > 0
            );
          `),
        {
          timeout: 3_000,
          timeoutMsg: "rendered Refresh option did not become visible",
        }
      );
      const refreshed = await execJS(`
        const option = Array.from(document.querySelectorAll('[role="option"]')).find(
          (candidate) => candidate.textContent?.trim() === "Refresh"
        );
        if (!option) return false;
        option.click();
        return true;
      `);
      if (!refreshed) throw new Error("rendered Refresh option disappeared");

      await browser.waitUntil(
        async () =>
          execJS(`
            return !Array.from(document.querySelectorAll('[role="option"]')).some(
              (option) => option.textContent?.trim() === "Refresh"
            );
          `),
        {
          timeout: 10_000,
          timeoutMsg: "rendered Refresh menu did not close",
        }
      );
      // The menu closes as soon as the async refresh starts. Wait for the
      // production refresh's final source-signature publication so a second
      // user action cannot race the still-running roster generation.
      await browser.waitUntil(
        async () =>
          execJS(`
            try {
              const config = JSON.parse(
                localStorage.getItem("orgii:dataSourceConfig") || "{}"
              );
              return Object.values(config).some(
                (source) =>
                  Number(source?.lastScannedAt || 0) >=
                  ${Number(refreshStartedAtMs)}
              );
            } catch {
              return false;
            }
          `),
        {
          timeout: 120_000,
          interval: 100,
          timeoutMsg: "rendered sidebar Refresh did not finish its roster load",
        }
      );
      return;
    } catch (error) {
      lastError = error;
      await browser.pause(100);
    }
  }
  throw new Error(
    `rendered sidebar Refresh action did not complete: ${
      lastError?.message ?? lastError ?? "unknown error"
    }`
  );
}

async function expandCodexSectionIfCollapsed() {
  const selector = '[data-sidebar-section-toggle="external_history:codex_app"]';
  const snapshot = await renderedSelectorSnapshot(selector);
  if (!snapshot) return;
  if (snapshot.attributes["aria-expanded"] === "false") {
    await clickRenderedSelector(selector, {
      label: "Codex App sidebar section",
    });
    await browser.waitUntil(
      async () =>
        (await renderedSelectorSnapshot(selector))?.attributes[
          "aria-expanded"
        ] === "true",
      {
        timeout: 10_000,
        timeoutMsg: "Codex App sidebar section did not expand",
      }
    );
  }
}

export async function waitForSidebarSessionRow(sessionId) {
  const selector = `[data-testid="sidebar-session-item-${sessionId}"]`;
  await browser.waitUntil(
    async () => {
      if (await renderedSelectorSnapshot(selector)) return true;
      await expandCodexSectionIfCollapsed();
      return Boolean(await renderedSelectorSnapshot(selector));
    },
    {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: `production sidebar never listed ${sessionId}`,
    }
  );
  await waitForRenderedSelector(selector, {
    timeout: 20_000,
    label: `sidebar session ${sessionId}`,
  });
}

export async function openCodexSessionFromSidebar(sessionId, label) {
  await waitForSidebarSessionRow(sessionId);
  await clickRenderedSelector(
    `[data-testid="sidebar-session-item-${sessionId}"]`,
    { label: `${label} sidebar row` }
  );

  let state = null;
  await browser.waitUntil(
    async () => {
      state = await invokeE2E("inspectChatState");
      return (
        state?.activeSessionId === sessionId &&
        state?.coreSessionId === sessionId &&
        Number(state?.chatEventCount ?? 0) > 0
      );
    },
    {
      timeout: 180_000,
      interval: 100,
      timeoutMsg: `${label} did not open from its rendered sidebar row`,
    }
  );
  return state;
}

export async function resetToNewSession(label) {
  // Reset is deliberately debug-driven: it only establishes a fresh episode.
  // The following open is always another real rendered sidebar click.
  const reset = await invokeE2E("resetToNewSession");
  if (!reset || reset.ok !== true) {
    throw new Error(`${label} reset failed: ${reset?.error ?? "unknown"}`);
  }
}
