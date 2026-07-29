import { e2eUrl } from "../../support/core/e2eBaseUrl.mjs";

const MOUNT_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 180_000;
const API_AGENT_TYPE = process.env.E2E_API_AGENT_TYPE ?? "openai_api";
const E2E_REPO_PATH = process.env.E2E_REPO_PATH;

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function postJsonFromNode(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      ok: response.ok,
      status: response.status,
      data: await response.json(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { error: String(error?.message ?? error) },
    };
  }
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
    window.__e2e[method].apply(null, rest)
      .then(cb)
      .catch((error) => cb({ ok: false, error: String(error && error.message || error) }));
  `,
    [method, ...args]
  );
}

function unwrap(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed: ${result?.error ?? "unknown"}`);
  }
  return result;
}

function findReusableApiAccount(accounts, accountName, model) {
  return accounts.find(
    (account) =>
      account.agent_type === API_AGENT_TYPE &&
      account.enabled &&
      account.has_api_key &&
      (!accountName ||
        account.name === accountName ||
        account.id === accountName) &&
      (account.enabled_models ?? []).includes(model)
  );
}

const js = {
  exists: (selector) =>
    `return !!document.querySelector(${JSON.stringify(selector)});`,
  type: (selector, text) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    element.focus();
    const ok = document.execCommand("insertText", false, ${JSON.stringify(text)});
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: ${JSON.stringify(text)},
    }));
    return ok || (element.textContent || "").includes(${JSON.stringify(text)})
      ? "typed"
      : "insert-failed";
  `,
  click: (selector) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    if (element.disabled) return "disabled";
    element.click();
    return "clicked";
  `,
  mode: `
    const creator = document.querySelector(".session-creator-chat-panel");
    const history = document.querySelector('[data-testid="chat-message-list"]');
    return creator ? "creator" : history ? "chat" : "unknown";
  `,
  latestAssistantText: `
    const bubbles = Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]'));
    if (bubbles.length === 0) return "";
    const latest = bubbles[bubbles.length - 1];
    return (latest.textContent || "").trim();
  `,
  countAssistant: `
    return document.querySelectorAll('[data-testid="chat-message-assistant"]').length;
  `,
  bodyText: `return document.body.innerText || "";`,
};

async function ensureActiveSession(
  reuseAccount,
  openaiApiKey,
  openaiModel,
  openaiBaseUrl
) {
  if (!E2E_REPO_PATH) {
    throw new Error("E2E_REPO_PATH was not initialized by the WDIO runner");
  }

  const existing = await invokeE2E("getActiveSessionId");
  if (existing && existing.ok && existing.sessionId) {
    return existing.sessionId;
  }

  let configured;
  if (reuseAccount) {
    configured = await invokeE2E("configureWithExistingKey", {
      accountName: reuseAccount,
      model: openaiModel,
      repoPath: E2E_REPO_PATH,
    });
  } else {
    configured = await invokeE2E("configure", {
      openaiApiKey,
      model: openaiModel,
      baseUrl: openaiBaseUrl || undefined,
      repoPath: E2E_REPO_PATH,
    });
  }
  unwrap(configured, "configure memory smoke session");
  await browser.pause(800);

  const prompt = "Reply with the single word OK.";
  const inputSelector = '[data-testid="chat-input"] [contenteditable="true"]';
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: MOUNT_TIMEOUT_MS,
    timeoutMsg: "chat input never mounted",
  });
  await execJS(js.type(inputSelector, prompt));
  await browser.pause(400);
  await browser.waitUntil(
    async () =>
      (await execJS(js.click('[data-testid="chat-send-button"]'))) ===
      "clicked",
    { timeout: 15_000, timeoutMsg: "send-button never clickable" }
  );
  await browser.waitUntil(async () => (await execJS(js.mode)) === "chat", {
    timeout: 30_000,
    timeoutMsg: "session never transitioned to chat view",
  });
  await browser.waitUntil(
    async () => {
      const text = await execJS(js.latestAssistantText);
      return text && text.length > 0;
    },
    { timeout: REPLY_TIMEOUT_MS, timeoutMsg: "no assistant reply" }
  );

  let sessionId = null;
  await browser.waitUntil(
    async () => {
      const result = await invokeE2E("getActiveSessionId");
      if (result && result.ok && result.sessionId) {
        sessionId = result.sessionId;
        return true;
      }
      return false;
    },
    { timeout: 15_000, timeoutMsg: "activeSessionId never populated" }
  );
  return sessionId;
}

async function sendFollowUp(prompt, expectedText) {
  const inputSelector = '[data-testid="chat-input"] [contenteditable="true"]';
  const sendSelector = '[data-testid="chat-send-button"]';

  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const element = document.querySelector(${JSON.stringify(sendSelector)});
        return element ? (element.getAttribute("data-state") || "") : "";
      `);
      return state === "submit" || state === "retry";
    },
    { timeout: 30_000, timeoutMsg: "chat never returned to a sendable state" }
  );
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: 15_000,
    timeoutMsg: "chat input not mounted",
  });
  await execJS(js.type(inputSelector, prompt));
  await browser.pause(400);
  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const element = document.querySelector(${JSON.stringify(sendSelector)});
        return element ? (element.getAttribute("data-state") || "") : "";
      `);
      if (state !== "submit") return false;
      return (await execJS(js.click(sendSelector))) === "clicked";
    },
    { timeout: 15_000, timeoutMsg: "send-button never reached submit state" }
  );
  await browser.waitUntil(
    async () => {
      const text = await execJS(js.latestAssistantText);
      return text.includes(expectedText);
    },
    { timeout: REPLY_TIMEOUT_MS, timeoutMsg: "no follow-up assistant reply" }
  );
  return execJS(js.latestAssistantText);
}

describe("Core session memory UI", () => {
  let reuseAccount;
  let openaiApiKey;
  let openaiModel;
  let openaiBaseUrl;
  let activeSessionId;
  let agentDefId;
  let agentScope;
  const seededLearnings = new Set();

  before(async () => {
    reuseAccount = process.env.E2E_OPENAI_ACCOUNT;
    openaiApiKey = process.env.OPENAI_API_KEY;
    openaiModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    openaiBaseUrl = process.env.OPENAI_BASE_URL;

    await browser.waitUntil(
      async () => execJS(js.exists('[data-testid="chat-panel"]')),
      { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "chat-panel never mounted" }
    );
    await browser.waitUntil(
      async () =>
        execJS(
          `return !!(window.__e2e
            && window.__e2e.promptDump
            && window.__e2e.getActiveSessionId
            && window.__e2e.resetToNewSession
            && window.__e2e.navigateTo
            && window.__e2e.listAccounts
            && window.__e2e.debugSeedLearning
            && window.__e2e.learningsList
            && window.__e2e.learningsDelete
            && window.__e2e.learningsGetStatus
            && window.__e2e.writeWorkspaceMemory
            && window.__e2e.readWorkspaceMemory
            && window.__e2e.listWorkspaceMemory
            && window.__e2e.clearWorkspaceMemory
            && window.__e2e.debugMemoryPrefetchSection);`
        ),
      {
        timeout: 10_000,
        timeoutMsg: "required __e2e memory helpers never exposed",
      }
    );

    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo(memory setup)"
    );
    unwrap(
      await invokeE2E("resetToNewSession"),
      "resetToNewSession(memory setup)"
    );

    if (!reuseAccount && !openaiApiKey) {
      const accounts = unwrap(
        await invokeE2E("listAccounts"),
        "listAccounts(memory setup)"
      ).accounts;
      const account = findReusableApiAccount(accounts, undefined, openaiModel);
      if (!account) {
        console.log(
          `[session-memory-ui] no E2E_OPENAI_ACCOUNT, OPENAI_API_KEY, or enabled ${API_AGENT_TYPE} account with ${openaiModel}; skipping.`
        );
        return;
      }
      reuseAccount = account.name ?? account.id;
    }

    activeSessionId = await ensureActiveSession(
      reuseAccount,
      openaiApiKey,
      openaiModel,
      openaiBaseUrl
    );
    const dump = unwrap(
      await invokeE2E("promptDump", activeSessionId),
      "promptDump(initial)"
    ).dump;
    agentDefId = dump.agentDefinitionId ?? null;
    if (!agentDefId) {
      throw new Error(
        "active session has no agent_definition_id for memory smoke"
      );
    }
    agentScope = `agent:${agentDefId}`;
  });

  after(async () => {
    for (const id of seededLearnings) {
      try {
        await invokeE2E("learningsDelete", id);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("discovers semantic models and renders rerank controls in canonical Memory", async () => {
    unwrap(
      await invokeE2E(
        "navigateTo",
        "/orgii/app/settings/integrations/models?modelsTab=embedding"
      ),
      "navigateTo(semantic models summary)"
    );
    await browser.waitUntil(
      async () =>
        execJS(js.exists('[data-testid="semantic-models-open-memory"]')),
      {
        timeout: MOUNT_TIMEOUT_MS,
        timeoutMsg: "semantic models shortcut did not render",
      }
    );
    expect(
      await execJS(js.click('[data-testid="semantic-models-open-memory"]'))
    ).toBe("clicked");
    await browser.waitUntil(
      async () =>
        browser.executeScript(
          `return window.location.search.includes("rulesTab=memory");`,
          []
        ),
      {
        timeout: MOUNT_TIMEOUT_MS,
        timeoutMsg: "Memory deep link did not activate",
      }
    );
    await browser.waitUntil(
      async () =>
        execJS(js.exists('[data-testid="session-memory-rerank-provider"]')),
      {
        timeout: MOUNT_TIMEOUT_MS,
        timeoutMsg: "rerank provider control did not render",
      }
    );
    expect(
      await execJS(js.exists('[data-testid="session-memory-rerank-model"]'))
    ).toBe(true);
    expect(await execJS(js.bodyText)).toContain("qwen/qwen3-vl-rerank");
  });

  it("renders session memory, agent memory, extract memory, and auto dream smoke state", async () => {
    if (!reuseAccount && !openaiApiKey) return;

    const fingerprint = `__MEM_RENDERED_${Date.now()}__`;
    const learning = unwrap(
      await invokeE2E("debugSeedLearning", {
        agentScope,
        content: `Rendered agent memory content ${fingerprint}`,
        takeaway: `Rendered agent memory takeaway ${fingerprint}`,
        category: "pattern",
        source: "reflection",
        status: "active",
      }),
      "debugSeedLearning(rendered)"
    );
    seededLearnings.add(learning.learningId);

    const list = unwrap(
      await invokeE2E("learningsList", {
        agentScope,
        status: "active",
        search: fingerprint,
        limit: 5,
      }),
      "learningsList(rendered)"
    );
    expect(JSON.stringify(list.learnings)).toContain(fingerprint);

    const reply = await sendFollowUp(
      "Reply with exactly ORGII_MEMORY_RENDERED_SMOKE_READY and no other words.",
      "ORGII_MEMORY_RENDERED_SMOKE_READY"
    );
    expect(reply).toContain("ORGII_MEMORY_RENDERED_SMOKE_READY");
    expect(await execJS(js.bodyText)).toContain(
      "ORGII_MEMORY_RENDERED_SMOKE_READY"
    );
    expect(await execJS(js.countAssistant)).toBeGreaterThan(0);

    const status = unwrap(
      await invokeE2E("learningsGetStatus", agentScope),
      "learningsGetStatus(rendered)"
    );
    expect(JSON.stringify(status.report)).toContain(agentDefId);

    const tmpRoot = unwrap(await invokeE2E("getOrgiiRoot"), "getOrgiiRoot");
    const workspace = `${tmpRoot.path}/__e2e-memory-rendered-smoke`;
    const filename = `rendered-${Date.now()}.md`;
    const workspaceBody = [
      "---",
      "description: e2e rendered memory fixture",
      "type: workspace",
      "---",
      "",
      `Rendered workspace memory marker: ${fingerprint}`,
    ].join("\n");

    unwrap(
      await invokeE2E(
        "writeWorkspaceMemory",
        workspace,
        filename,
        workspaceBody
      ),
      "writeWorkspaceMemory(rendered)"
    );

    try {
      const files = unwrap(
        await invokeE2E("listWorkspaceMemory", workspace),
        "listWorkspaceMemory(rendered)"
      );
      expect(JSON.stringify(files.files)).toContain(filename);
      const detail = unwrap(
        await invokeE2E("readWorkspaceMemory", workspace, filename),
        "readWorkspaceMemory(rendered)"
      );
      expect(JSON.stringify(detail.detail)).toContain(fingerprint);
      const section = unwrap(
        await invokeE2E(
          "debugMemoryPrefetchSection",
          workspace,
          "Rendered memory smoke"
        ),
        "debugMemoryPrefetchSection(rendered)"
      );
      expect(section.section).toContain(fingerprint);
    } finally {
      try {
        await invokeE2E("clearWorkspaceMemory", workspace);
      } catch {
        // best-effort cleanup
      }
    }

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts(memory)"
    ).accounts;
    const nativeAccount = reuseAccount
      ? findReusableApiAccount(accounts, reuseAccount, openaiModel)
      : undefined;
    if (reuseAccount && !nativeAccount) {
      throw new Error(
        `memory rendered smoke account ${reuseAccount} with model ${openaiModel} not found`
      );
    }

    const nativeMemoryResponse = await postJsonFromNode(
      e2eUrl("/agent/test/sde"),
      {
        content:
          "Reply with exactly ORGII_NATIVE_MEMORY_FLAGS_READY and no other words.",
        session_id: `sdeagent-e2e-memory-flags-${Date.now()}`,
        model: openaiModel,
        account_id: nativeAccount?.id,
        workspace_path: workspace,
        enable_extract_memories: true,
        enable_auto_dream: true,
        no_cleanup: false,
      }
    );
    if (!nativeMemoryResponse.ok || nativeMemoryResponse.data?.error) {
      throw new Error(
        `native memory flags smoke failed: ${JSON.stringify(nativeMemoryResponse)}`
      );
    }
    expect(
      nativeMemoryResponse.data.runtime_snapshot.extractMemoriesEnabled
    ).toBe(true);
    expect(nativeMemoryResponse.data.runtime_snapshot.autoDreamEnabled).toBe(
      true
    );
    expect(nativeMemoryResponse.data.content).toContain(
      "ORGII_NATIVE_MEMORY_FLAGS_READY"
    );
  });
});
