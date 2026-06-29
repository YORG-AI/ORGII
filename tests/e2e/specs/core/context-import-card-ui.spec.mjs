import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { e2eUrl } from "../../support/core/e2eBaseUrl.mjs";

const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 15_000;
const RUN_ID = Date.now();
const E2E_REPO_PATH = process.env.E2E_REPO_PATH ?? "/tmp/orgii-e2e-workspace-repo";
const REPORT_DIR = process.env.ORG2_CONTEXT_IMPORT_REPORT_DIR ?? "/tmp/org2-context-import-card-ui";

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function waitForFrontendReady() {
  const port = process.env.E2E_FRONTEND_PORT ?? "1998";
  const url = `http://127.0.0.1:${port}`;
  await browser.waitUntil(
    async () => {
      try {
        const response = await fetch(url, { method: "GET" });
        return response.ok;
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

async function invokeE2E(method, ...args) {
  return browser.executeAsyncScript(
    `
    const cb = arguments[arguments.length - 1];
    const method = arguments[0];
    const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
    if (!window.__e2e || typeof window.__e2e[method] !== "function") {
      cb({ ok: false, error: "window.__e2e." + method + " not available" });
      return;
    }
    Promise.resolve(window.__e2e[method].apply(null, rest))
      .then(cb)
      .catch((e) => cb({ ok: false, error: String(e && e.message || e) }));
  `,
    [method, ...args]
  );
}

async function waitForApp() {
  await waitForFrontendReady();
  await browser.setTimeout({ script: 5_000 });
  await execJS(`localStorage.setItem('orgii:auth_skipped', '1'); return true;`);
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
    { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "document never became script-readable" }
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
          `return !!(window.__e2e && window.__e2e.seedChatEvents && window.__e2e.navigateTo);`
        );
      } catch {
        return false;
      }
    },
    { timeout: 20_000, timeoutMsg: "window.__e2e helpers never exposed" }
  );
}

function makeContextImportEvents(sessionId) {
  const baseTime = Date.now();
  const snapshotId = `ctx-snap-${RUN_ID}`;
  return [
    {
      id: `user-context-import-${RUN_ID}`,
      chunk_id: `user-context-import-${RUN_ID}`,
      sessionId,
      createdAt: new Date(baseTime).toISOString(),
      functionName: "user_message",
      uiCanonical: "user_message",
      actionType: "raw",
      args: {},
      result: {
        type: "user",
        message: "Import source context for cache-surface validation",
        is_delta: false,
      },
      source: "user",
      displayText: "Import source context for cache-surface validation",
      displayStatus: "completed",
      displayVariant: "message",
      activityStatus: "processed",
      isDelta: false,
    },
    {
      id: `tool-context-import-${RUN_ID}`,
      chunk_id: `tool-context-import-${RUN_ID}`,
      sessionId,
      createdAt: new Date(baseTime + 1_000).toISOString(),
      functionName: "import_context",
      uiCanonical: "import_context",
      actionType: "tool_call",
      args: {
        source_kind: "session",
        source_id: "source-session-cache-context",
        title: "Cache Context Source Session",
        token_estimate: 4321,
        pinned: true,
      },
      result: {
        success: true,
        status: "completed",
        source_kind: "session",
        source_id: "source-session-cache-context",
        title: "Cache Context Source Session",
        token_estimate: 4321,
        pinned: true,
        stable_prefix_tokens: 1200,
        volatile_context_tokens: 340,
        imported_context_count: 1,
        cache_read_tokens: 900,
        cache_write_tokens: 100,
        snippet: "Hydrated snippet: cache context source decision.",
        namespace: "session:source-session-cache-context",
        snapshot_id: snapshotId,
        observation: `Imported context snapshot ${snapshotId} from session:source-session-cache-context into namespace session:source-session-cache-context`,
      },
      source: "assistant",
      displayText: "Imported context snapshot",
      displayStatus: "completed",
      displayVariant: "tool_call",
      activityStatus: "agent",
      isDelta: false,
    },
    {
      id: `assistant-context-import-${RUN_ID}`,
      chunk_id: `assistant-context-import-${RUN_ID}`,
      sessionId,
      createdAt: new Date(baseTime + 2_000).toISOString(),
      functionName: "assistant_message",
      uiCanonical: "agent_message",
      actionType: "assistant",
      args: {},
      result: {
        content: "Context import card rendered for cache debug/source chip validation.",
        observation: "Context import card rendered for cache debug/source chip validation.",
        is_delta: false,
        role: "assistant",
      },
      source: "assistant",
      displayText: "Context import card rendered for cache debug/source chip validation.",
      displayStatus: "completed",
      displayVariant: "message",
      activityStatus: "agent",
      isDelta: false,
    },
  ];
}

describe("Context import card UI", () => {
  before(async () => {
    await waitForApp();
    const repo = await invokeE2E("ensureRepoSelected", {
      repoPath: E2E_REPO_PATH,
      repoName: "E2E Fixture Repo",
    });
    if (!repo || repo.ok !== true) throw new Error(`ensureRepoSelected failed: ${repo?.error ?? "unknown"}`);
    const navigation = await invokeE2E("navigateTo", "/orgii/workstation/code");
    if (!navigation || navigation.ok !== true) throw new Error(`navigateTo failed: ${navigation?.error ?? "unknown"}`);
  });

  it("renders import_context result as ContextImportCard and captures screenshot", async () => {
    const sessionId = `e2e-context-import-${RUN_ID}`;
    const events = makeContextImportEvents(sessionId);
    const seed = await invokeE2E("seedChatEvents", sessionId, events);
    if (!seed || seed.ok !== true) throw new Error(`seedChatEvents failed: ${seed?.error ?? "unknown"}`);
    const nav = await invokeE2E("openSession", sessionId);
    if (!nav || nav.ok !== true) throw new Error(`openSession failed: ${nav?.error ?? "unknown"}`);

    await browser.waitUntil(
      async () => {
        const state = await execJS(`
          const body = document.body.innerText || '';
          const cardLike = body.includes('Cache Context Source Session')
            && body.includes('session:source-session-cache-context')
            && body.includes('session')
            && body.includes('4321 tokens est.')
            && body.includes('ctx-snap')
            && body.includes('stable prefix')
            && body.includes('cache read');
          const rawFallback = body.includes('Imported context snapshot ctx-snap') && !body.includes('4321 tokens est.');
          return { cardLike, rawFallback, body: body.slice(0, 4000) };
        `);
        if (state.rawFallback) throw new Error(`raw fallback rendered instead of ContextImportCard: ${state.body}`);
        return state.cardLike;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: `ContextImportCard never rendered: ${JSON.stringify(await execJS(`return { body: (document.body.innerText || '').slice(0, 4000) };`))}`,
      }
    );

    await mkdir(REPORT_DIR, { recursive: true });
    const screenshotPath = path.join(REPORT_DIR, "context-import-card.png");
    await browser.saveScreenshot(screenshotPath);
    const snapshot = await execJS(`
      const body = document.body.innerText || '';
      return {
        hasTitle: body.includes('Cache Context Source Session'),
        hasNamespace: body.includes('session:source-session-cache-context'),
        hasTokenEstimate: body.includes('4321 tokens est.'),
        hasSnapshotPrefix: body.includes('ctx-snap'),
        hasStablePrefix: body.includes('stable prefix'),
        hasCacheRead: body.includes('cache read'),
        renderedToolNames: Array.from(document.querySelectorAll('[data-tool-call-name]')).map(n => n.getAttribute('data-tool-call-name')).filter(Boolean),
      };
    `);
    await browser.executeScript(`return true;`, []);
    if (!snapshot.hasTitle || !snapshot.hasNamespace || !snapshot.hasTokenEstimate || !snapshot.hasSnapshotPrefix || !snapshot.hasStablePrefix || !snapshot.hasCacheRead) {
      throw new Error(`ContextImportCard assertions failed: ${JSON.stringify(snapshot)}`);
    }
  });
});
