/**
 * Rendered-user driver for bounded external replay acceptance.
 *
 * Debug helpers in this module are limited to deterministic setup, reset, and
 * observation. Opening a session, changing pagination, selecting a round, and
 * scrolling history all go through the same rendered controls a user uses.
 */

export const MIB = 1024 * 1024;
export const REPLAY_MAX_IPC_BYTES = 4 * MIB;
export const REPLAY_MAX_EVENTS = 200;

const MOUNT_TIMEOUT_MS = 60_000;

export async function execJS(script) {
  return browser.executeScript(script, []);
}

export async function waitForRenderedSelector(
  selector,
  { timeout = 20_000, label = selector } = {}
) {
  const encodedSelector = JSON.stringify(selector);
  await browser.waitUntil(
    async () =>
      execJS(`
        const element = document.querySelector(${encodedSelector});
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return (
          element.getClientRects().length > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      `),
    {
      timeout,
      interval: 100,
      timeoutMsg: `${label} did not become rendered and visible`,
    }
  );
}

export async function clickRenderedSelector(
  selector,
  { timeout = 20_000, label = selector, clickCount = 1 } = {}
) {
  const encodedSelector = JSON.stringify(selector);
  await waitForRenderedSelector(selector, { timeout, label });
  const clicked = await execJS(`
    const element = document.querySelector(${encodedSelector});
    if (!element || element.getClientRects().length === 0) return false;
    element.scrollIntoView({ block: "center", inline: "nearest" });
    for (let index = 0; index < ${Number(clickCount)}; index += 1) {
      element.click();
    }
    return true;
  `);
  if (!clicked) {
    throw new Error(`${label} disappeared before its rendered click`);
  }
}

export async function waitForRenderedSelectorAbsent(
  selector,
  { timeout = 10_000, label = selector } = {}
) {
  const encodedSelector = JSON.stringify(selector);
  await browser.waitUntil(
    async () =>
      execJS(`return document.querySelector(${encodedSelector}) == null;`),
    {
      timeout,
      interval: 100,
      timeoutMsg: `${label} did not leave the rendered DOM`,
    }
  );
}

export async function renderedSelectorSnapshot(selector) {
  return execJS(`
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const style = window.getComputedStyle(element);
    return {
      text: element.innerText ?? element.textContent ?? "",
      disabled:
        element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement
          ? element.disabled
          : element.getAttribute("aria-disabled") === "true",
      visible:
        element.getClientRects().length > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden",
      attributes: Object.fromEntries(
        Array.from(element.attributes).map((attribute) => [
          attribute.name,
          attribute.value,
        ])
      ),
    };
  `);
}

export async function waitForRenderedSelectorEnabled(
  selector,
  { timeout = 20_000, label = selector } = {}
) {
  await browser.waitUntil(
    async () => {
      const snapshot = await renderedSelectorSnapshot(selector);
      return Boolean(snapshot?.visible && !snapshot.disabled);
    },
    {
      timeout,
      interval: 100,
      timeoutMsg: `${label} did not become rendered and enabled`,
    }
  );
}

export async function setRenderedInputValue(
  selector,
  value,
  { timeout = 20_000, label = selector } = {}
) {
  await waitForRenderedSelector(selector, { timeout, label });
  const updated = await execJS(`
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    if (!setter) return false;
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: ${JSON.stringify(value)},
        inputType: "insertText",
      })
    );
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  `);
  if (!updated) {
    throw new Error(`${label} could not receive its rendered input value`);
  }
}

export async function invokeTauriCommand(command, args = {}) {
  const envelope = await browser.executeAsyncScript(
    `
      const cb = arguments[arguments.length - 1];
      const command = arguments[0];
      const args = arguments[1];
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== "function") {
        cb({ ok: false, error: "Tauri invoke is unavailable" });
        return;
      }
      Promise.resolve(invoke(command, args))
        .then((result) => cb({ ok: true, result }))
        .catch((error) => cb({ ok: false, error: String(error?.message || error) }));
    `,
    [command, args]
  );
  if (envelope?.ok !== true) {
    throw new Error(
      `Tauri ${command} failed: ${envelope?.error ?? "unknown error"}`
    );
  }
  return envelope.result;
}

export async function invokeE2E(method, ...args) {
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
        .catch((error) =>
          cb({ ok: false, error: String(error && error.message || error) })
        );
    `,
    [method, ...args]
  );
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

export async function setPaginationEnabledViaUi(enabled) {
  const switchSelector = 'button[role="switch"][aria-label="Pagination"]';
  let menuOpened = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await clickRenderedSelector(
      '[data-testid="chat-panel-header-more-button"]',
      { label: "chat panel header menu" }
    );
    const opened = await browser
      .waitUntil(
        async () => Boolean(await renderedSelectorSnapshot(switchSelector)),
        { timeout: 2_000 }
      )
      .then(() => true)
      .catch(() => false);
    if (opened) {
      menuOpened = true;
      break;
    }
    await browser.keys(["Escape"]);
    await browser.pause(250);
  }
  if (!menuOpened) {
    throw new Error("pagination menu did not open after six rendered clicks");
  }
  await waitForRenderedSelectorEnabled(switchSelector, {
    label: "pagination switch",
  });
  const isEnabled =
    (await renderedSelectorSnapshot(switchSelector))?.attributes[
      "aria-checked"
    ] === "true";
  if (isEnabled !== enabled) {
    await clickCurrentRenderedSelector(switchSelector);
    await browser.waitUntil(
      async () =>
        ((await renderedSelectorSnapshot(switchSelector))?.attributes[
          "aria-checked"
        ] ===
          "true") ===
        enabled,
      {
        timeout: 10_000,
        timeoutMsg: `pagination switch did not become ${enabled ? "enabled" : "disabled"}`,
      }
    );
  }
  await browser.keys(["Escape"]);
}

async function renderedSelectorCenter(selector) {
  await waitForRenderedSelector(selector, {
    label: `${selector} wheel origin`,
  });
  const center = await execJS(`
    const element = document.querySelector(${JSON.stringify(selector)});
    const rect = element?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  `);
  if (!center) {
    throw new Error(`${selector} disappeared before its wheel action`);
  }
  return center;
}

export async function performWheelGesture(selector, deltaY, duration = 80) {
  const center = await renderedSelectorCenter(selector);
  await browser
    .action("wheel")
    .scroll({
      origin: "viewport",
      x: center.x,
      y: center.y,
      deltaX: 0,
      deltaY,
      duration,
    })
    .perform();
}

export async function performWheelBurst(selector, deltaY, count) {
  const center = await renderedSelectorCenter(selector);
  const action = browser.action("wheel");
  for (let index = 0; index < count; index += 1) {
    action.scroll({
      origin: "viewport",
      x: center.x,
      y: center.y,
      deltaX: 0,
      deltaY,
      duration: 0,
    });
  }
  await action.perform();
}

export async function clickCurrentRenderedSelector(selector) {
  const clicked = await execJS(`
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.focus();
    element.click();
    return true;
  `);
  if (!clicked) {
    throw new Error(`rendered element disappeared before click: ${selector}`);
  }
}

export async function ensureTurnPageItemVisibleWithUserSort(pageIndex) {
  const selector = `[data-testid="turn-page-list-item"][data-turn-page-index="${pageIndex}"]`;
  await browser.waitUntil(
    () =>
      execJS(`
        return Boolean(
          document.querySelector('[data-testid="turn-page-list"]')
        );
      `),
    {
      timeout: 10_000,
      timeoutMsg: "turn-page-list did not render",
    }
  );
  const itemIsVisible = await execJS(`
    return Boolean(document.querySelector(${JSON.stringify(selector)}));
  `);
  if (itemIsVisible) return;

  let hasSortButton = false;
  try {
    await browser.waitUntil(
      async () => {
        hasSortButton = Boolean(
          await execJS(`
            return Boolean(document.querySelector(
              '[data-testid="turn-page-list"] button[aria-label="Sort"]'
            ))
          `)
        );
        return hasSortButton;
      },
      { timeout: 5_000, interval: 50 }
    );
  } catch {
    // Pagination mode intentionally has no sort toolbar. The diagnostics below
    // distinguish that expected shape from a missing edge row.
  }
  if (hasSortButton) {
    console.log(
      `[issue-443-real-codex] clicking catalog sort for Round ${pageIndex + 1}`
    );
    const clicked = await execJS(`
      const button = document.querySelector(
        '[data-testid="turn-page-list"] button[aria-label="Sort"]'
      );
      if (!button) return false;
      button.focus();
      button.click();
      return true;
    `);
    if (!clicked) {
      throw new Error("turn-page-list sort button disappeared before click");
    }
    console.log(
      `[issue-443-real-codex] catalog sort completed for Round ${pageIndex + 1}`
    );
    await browser.waitUntil(
      () =>
        execJS(`
          return Boolean(document.querySelector(${JSON.stringify(selector)}));
        `),
      {
        timeout: 5_000,
        interval: 50,
        timeoutMsg: `turn-page-list item ${pageIndex} did not become visible after user sort`,
      }
    );
    return;
  }
  const snapshot = await execJS(`
    const root = document.querySelector(
      '[data-testid="turn-page-list"] .overflow-y-auto'
    );
    return {
      scrollTop: root?.scrollTop ?? null,
      scrollHeight: root?.scrollHeight ?? null,
      clientHeight: root?.clientHeight ?? null,
      renderedPageIndices: Array.from(
        document.querySelectorAll('[data-testid="turn-page-list-item"]')
      ).map((item) => item.getAttribute('data-turn-page-index')),
      buttons: Array.from(
        document.querySelectorAll('[data-testid="turn-page-list"] button')
      ).slice(0, 4).map((button) => ({
        ariaLabel: button.getAttribute('aria-label'),
        title: button.getAttribute('title'),
        testId: button.getAttribute('data-testid'),
      })),
    };
  `);
  throw new Error(
    `turn-page-list item ${pageIndex} is not an edge row reachable by user sort: ${JSON.stringify(snapshot)}`
  );
}

export async function getChatViewportSnapshot(markers, pinnedMarkers = []) {
  return execJS(`
    const markers = ${JSON.stringify(markers)};
    const pinnedMarkers = ${JSON.stringify(pinnedMarkers)};
    const root = document.querySelector('[data-testid="chat-history-scroll-root"]');
    const list = document.querySelector(
      '[data-chat-view-root] [data-testid="chat-message-list"]'
    );
    const pinnedHeader = document.querySelector(
      '[data-chat-pinned-header-layer]'
    );
    if (!root || !list) {
      return {
        rootMissing: !root,
        listMissing: !list,
        markers: [],
        pinnedMarkers: [],
        chatText: "",
      };
    }
    const rootRect = root.getBoundingClientRect();
    const pinnedHeaderRect = pinnedHeader?.getBoundingClientRect() ?? null;
    const pinnedHeaderText = pinnedHeader?.innerText || "";
    const groups = Array.from(list.querySelectorAll('[data-chat-group-index]'));
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      rootRect: { top: rootRect.top, bottom: rootRect.bottom },
      chatText: (list.innerText || "").slice(0, 16000),
      markers: markers.map((marker) => {
        const group = groups.find((candidate) =>
          (candidate.innerText || "").includes(marker)
        );
        const rect = group?.getBoundingClientRect() ?? null;
        return {
          marker,
          inRenderedList: Boolean(group),
          visible: Boolean(
            rect &&
              rect.bottom > rootRect.top + 1 &&
              rect.top < rootRect.bottom - 1
          ),
          rect: rect ? { top: rect.top, bottom: rect.bottom } : null,
        };
      }),
      pinnedHeaderText,
      pinnedMarkers: pinnedMarkers.map((marker) => ({
        marker,
        inPinnedHeader: pinnedHeaderText.includes(marker),
        visible: Boolean(
          pinnedHeaderRect &&
            pinnedHeaderRect.width > 0 &&
            pinnedHeaderRect.height > 0
        ),
      })),
    };
  `);
}

export async function waitForChatTurn({
  markers,
  label,
  visibleMarker = markers[0],
  pinnedMarkers = [],
  excludes = [],
}) {
  let snapshot = null;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await getChatViewportSnapshot(markers, pinnedMarkers);
        const target = snapshot?.markers?.find(
          (entry) => entry.marker === visibleMarker
        );
        return (
          snapshot?.markers?.every((entry) => entry.inRenderedList) &&
          snapshot?.pinnedMarkers?.every(
            (entry) => entry.inPinnedHeader && entry.visible
          ) &&
          Boolean(target?.visible) &&
          excludes.every(
            (excluded) =>
              !`${String(snapshot?.chatText ?? "")}\n${String(
                snapshot?.pinnedHeaderText ?? ""
              )}`.includes(excluded)
          )
        );
      },
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: `${label} did not paint inside the active chat viewport`,
      }
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; final viewport=${JSON.stringify(snapshot)}`
    );
  }
  return snapshot;
}

export async function getChatScrollMetrics() {
  return execJS(`
    const root = document.querySelector('[data-testid="chat-history-scroll-root"]');
    if (!root) throw new Error("chat history scroll root is missing");
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    };
  `);
}

export async function positionChatNearPhysicalTopForBurst(topOffset = 1) {
  // Deterministic setup only. The edge crossing and repeated pressure are real
  // W3C wheel actions in `performWheelBurst`.
  return execJS(`
    const root = document.querySelector('[data-testid="chat-history-scroll-root"]');
    if (!root) throw new Error("chat history scroll root is missing");
    root.scrollTop = Math.min(
      ${topOffset},
      Math.max(0, root.scrollHeight - root.clientHeight)
    );
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    };
  `);
}

export async function assertNoReplayFatalError(label) {
  const body = String(await execJS("return document.body.innerText || '';"));
  if (
    body.includes("App error") ||
    body.includes("Bounded replay window requires")
  ) {
    throw new Error(`${label} surfaced a fatal replay wire-budget error`);
  }
}
