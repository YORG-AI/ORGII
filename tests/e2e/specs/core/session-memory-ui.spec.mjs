import { e2eUrl } from "../../support/core/e2eBaseUrl.mjs";

const MOUNT_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 180_000;
const API_AGENT_TYPE = process.env.E2E_API_AGENT_TYPE ?? "openai_api";
const E2E_REPO_PATH = process.env.E2E_REPO_PATH;

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function postJsonFromNode(url, body, { attempts = 8, delayMs = 1000 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let data;
      try {
        data = await response.json();
      } catch (error) {
        data = { error: `invalid json: ${String(error?.message ?? error)}` };
      }
      last = {
        ok: response.ok,
        status: response.status,
        data,
        url,
        attempt,
      };
      if (response.ok && !data?.error) return last;
    } catch (error) {
      last = {
        ok: false,
        status: 0,
        data: { error: String(error?.message ?? error) },
        url,
        attempt,
      };
    }
    if (attempt < attempts) {
      await browser.pause(delayMs);
    }
  }
  return last ?? {
    ok: false,
    status: 0,
    data: { error: "postJsonFromNode: no attempts ran" },
    url,
  };
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
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const ok = document.execCommand("insertText", false, ${JSON.stringify(text)});
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: ${JSON.stringify(text)},
      })
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    const textNow = element.textContent || "";
    return ok || textNow.includes(${JSON.stringify(text)}) ? "typed" : "insert-failed:" + textNow.slice(0, 80);
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
    return { sessionId: existing.sessionId, accountId: null };
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
  const configuredAccountId =
    configured.accountId ?? configured.account_id ?? null;
  // Force key-vault shared cache reload so useValidatedLastPair can see the
  // account just written via rpc.validation.saveKey (bypasses useLocalKeys.saveKey).
  unwrap(await invokeE2E("listAccounts"), "listAccounts after configure");
  await browser.pause(800);

  // configure()/pinSession write creatorDefaultModelSelectionAtom, but
  // useValidatedLastPair also requires the account to be present in the
  // shared key-vault cache. Wait until the creator actually accepts the
  // pinned model/account (and repo) before typing+send.
  let selectionDiag = null;
  await browser.waitUntil(
    async () => {
      const inspected = await invokeE2E("inspectCreatorSelection");
      selectionDiag = inspected;
      if (!inspected || inspected.ok !== true) return false;
      const modelSelection = inspected.modelSelection ?? null;
      const creator = inspected.creator ?? null;
      const hasModel =
        !!(modelSelection && (modelSelection.model || modelSelection.selectedAccountId));
      const hasRepo = !!(creator && creator.source && creator.source.repoId);
      return hasModel && hasRepo;
    },
    {
      timeout: 20_000,
      timeoutMsg: `creator model/repo selection never became valid after configure: ${JSON.stringify(selectionDiag)}`,
    }
  );

  const prompt = "Reply with the single word OK.";
  const inputSelector = '[data-testid="chat-input"] [contenteditable="true"]';
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: MOUNT_TIMEOUT_MS,
    timeoutMsg: "chat input never mounted",
  });
  const typed = await execJS(js.type(inputSelector, prompt));
  if (typed !== "typed") {
    throw new Error(`composer type failed: ${typed}`);
  }
  await browser.pause(400);
  let sendDiag = null;
  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const btn = document.querySelector('[data-testid="chat-send-button"]');
        const editor = document.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
        const modelPill = document.querySelector('[data-testid="chat-model-pill-model"]');
        const repoPill = document.querySelector('[data-testid="chat-repo-pill"], [data-testid="session-creator-repo-pill"], [data-repo-pill]');
        return JSON.stringify({
          btn: btn ? {
            disabled: !!btn.disabled,
            state: btn.getAttribute('data-state'),
            aria: btn.getAttribute('aria-label'),
          } : null,
          editorText: editor ? (editor.textContent || '').slice(0, 120) : null,
          modelPill: modelPill ? (modelPill.textContent || '').slice(0, 80) : null,
          repoPill: repoPill ? (repoPill.textContent || '').slice(0, 80) : null,
        });
      `);
      const parsed = JSON.parse(state);
      sendDiag = parsed;
      if (parsed?.btn && !parsed.btn.disabled) {
        const click = await execJS(js.click('[data-testid="chat-send-button"]'));
        if (click === "clicked") return true;
      }
      return false;
    },
    {
      timeout: 20_000,
      timeoutMsg: `send-button never clickable: ${JSON.stringify(sendDiag)}`,
    }
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
  return { sessionId, accountId: configuredAccountId };
}

async function ensureChatSurface(sessionId) {
  if (sessionId) {
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo(workstation before chat follow-up)"
    );
    unwrap(await invokeE2E("openSession", sessionId), "openSession(follow-up)");
  }
  await browser.waitUntil(
    async () => (await execJS(js.mode)) === "chat",
    {
      timeout: 30_000,
      timeoutMsg: "chat surface never mounted for follow-up",
    }
  );

  // If the previous turn left the composer in Stop (runtime still active /
  // stale blocking events), interrupt once so a follow-up is not silently
  // queued behind a turn that will never flush in this smoke.
  const stopState = await execJS(`
    const element = document.querySelector('[data-testid="chat-send-button"]');
    return element ? (element.getAttribute('data-state') || '') : '';
  `);
  if (stopState === "stop" || stopState === "working") {
    await execJS(js.click('[data-testid="chat-send-button"]'));
    await browser.pause(800);
  }

  let chatDiag = null;
  await browser.waitUntil(
    async () => {
      const inspected = await invokeE2E("inspectChatState");
      chatDiag = inspected;
      if (!inspected || inspected.ok !== true) return false;
      const runtime = inspected.runtimeStatus;
      const queued = Array.isArray(inspected.queuedMessages)
        ? inspected.queuedMessages.length
        : 0;
      return (
        (runtime === "idle" ||
          runtime === "completed" ||
          runtime === "failed" ||
          runtime === "cancelled") &&
        queued === 0
      );
    },
    {
      timeout: 60_000,
      timeoutMsg: `chat runtime never became idle before follow-up: ${JSON.stringify(chatDiag)}`,
    }
  );
}

async function sendFollowUp(prompt, expectedText, sessionId) {
  const inputSelector = '[data-testid="chat-input"] [contenteditable="true"]';
  const sendSelector = '[data-testid="chat-send-button"]';

  await ensureChatSurface(sessionId);
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: 15_000,
    timeoutMsg: "chat input not mounted",
  });

  // Chat InputActions prioritizes non-empty input over the working/stop
  // indicator. If the previous turn left the button on data-state=stop with an
  // empty composer, waiting for submit first deadlocks. Type first so the
  // button flips to submit (queued send while working is supported).
  const typed = await execJS(js.type(inputSelector, prompt));
  if (typed !== "typed") {
    throw new Error(`follow-up composer type failed: ${typed}`);
  }
  await browser.pause(400);

  let sendStateDiag = null;
  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const element = document.querySelector(${JSON.stringify(sendSelector)});
        const editor = document.querySelector(${JSON.stringify(inputSelector)});
        return JSON.stringify({
          state: element ? (element.getAttribute("data-state") || "") : "",
          disabled: element ? !!element.disabled : null,
          editorText: editor ? (editor.textContent || "").slice(0, 120) : null,
        });
      `);
      sendStateDiag = JSON.parse(state);
      if (sendStateDiag.state !== "submit" || sendStateDiag.disabled) return false;
      return (await execJS(js.click(sendSelector))) === "clicked";
    },
    {
      timeout: 30_000,
      timeoutMsg: `follow-up send-button never reached clickable submit: ${JSON.stringify(sendStateDiag)}`,
    }
  );
  let replyDiag = null;
  await browser.waitUntil(
    async () => {
      const text = await execJS(js.latestAssistantText);
      const inspected = await invokeE2E("inspectChatState");
      replyDiag = {
        text: String(text || "").slice(0, 240),
        runtimeStatus: inspected?.runtimeStatus,
        queued: Array.isArray(inspected?.queuedMessages)
          ? inspected.queuedMessages.length
          : null,
        turnPhase: inspected?.turnPhase,
        isSessionActive: inspected?.isSessionActive,
      };
      return text.includes(expectedText);
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      timeoutMsg: `no follow-up assistant reply: ${JSON.stringify(replyDiag)}`,
    }
  );
  return execJS(js.latestAssistantText);
}

describe("Core session memory UI", () => {
  let reuseAccount;
  let openaiApiKey;
  let openaiModel;
  let openaiBaseUrl;
  let activeSessionId;
  let configuredAccountId;
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

    const ensured = await ensureActiveSession(
      reuseAccount,
      openaiApiKey,
      openaiModel,
      openaiBaseUrl
    );
    activeSessionId = ensured.sessionId;
    configuredAccountId = ensured.accountId;
    if (!configuredAccountId) {
      const accounts = unwrap(
        await invokeE2E("listAccounts"),
        "listAccounts(resolve configured account)"
      ).accounts;
      const account = findReusableApiAccount(
        accounts,
        reuseAccount,
        openaiModel
      );
      configuredAccountId = account?.id ?? null;
    }
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
      "ORGII_MEMORY_RENDERED_SMOKE_READY",
      activeSessionId
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
    const nativeAccount =
      (configuredAccountId &&
        accounts.find((account) => account.id === configuredAccountId)) ||
      findReusableApiAccount(accounts, reuseAccount, openaiModel);
    if (!nativeAccount?.id) {
      throw new Error(
        `memory rendered smoke could not resolve api account for model ${openaiModel}; configuredAccountId=${configuredAccountId}`
      );
    }

    const nativeEndpoint = e2eUrl("/agent/test/sde");
    // IDE HTTP comes up with the launched org2 binary; give it a moment after
    // the GUI session path before hitting the native SDE test endpoint.
    await browser.waitUntil(
      async () => {
        try {
          const response = await fetch(nativeEndpoint, { method: "OPTIONS" });
          return response.status > 0;
        } catch {
          try {
            const response = await fetch(e2eUrl("/"), { method: "GET" });
            return response.status > 0;
          } catch {
            return false;
          }
        }
      },
      {
        timeout: 30_000,
        timeoutMsg: `IDE base URL never became reachable: ${e2eUrl("/")}`,
      }
    );

    const nativeMemoryResponse = await postJsonFromNode(
      nativeEndpoint,
      {
        content:
          "Reply with exactly ORGII_NATIVE_MEMORY_FLAGS_READY and no other words.",
        session_id: `sdeagent-e2e-memory-flags-${Date.now()}`,
        model: openaiModel,
        account_id: nativeAccount.id,
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
