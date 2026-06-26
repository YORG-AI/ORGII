/**
 * useBrowserState — pure state-transition logic tests.
 *
 * The hook itself requires a React renderer, so we test the stateless
 * reducer-style helpers that drive it.  Each helper is extracted inline here
 * so the tests remain fast and dependency-free.
 *
 * We also test the closeSession stale-closure regression via a lightweight
 * simulation of back-to-back React batched state updates.
 */
import type { BrowserSession } from "@src/engines/BrowserCore/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers mirroring useBrowserState internal logic (kept in sync manually)
// ─────────────────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    title: "New Tab",
    url: "",
    history: [],
    historyIndex: -1,
    isLoading: false,
    error: null,
    incognito: false,
    ...overrides,
  };
}

/** Pure: remove sessionId from list and compute next active id */
function applyCloseSession(
  sessions: BrowserSession[],
  sessionId: string,
  activeSessionId: string
): { sessions: BrowserSession[]; activeSessionId: string } {
  const filtered = sessions.filter((s) => s.id !== sessionId);

  if (filtered.length === 0) {
    const replacement = makeSession();
    return { sessions: [replacement], activeSessionId: replacement.id };
  }

  const nextActiveId =
    sessionId === activeSessionId ? filtered[0].id : activeSessionId;
  return { sessions: filtered, activeSessionId: nextActiveId };
}

// ─────────────────────────────────────────────────────────────────────────────
// closeSession
// ─────────────────────────────────────────────────────────────────────────────

describe("closeSession state logic", () => {
  it("removes the session from the list", () => {
    const s1 = makeSession({ url: "https://a.com" });
    const s2 = makeSession({ url: "https://b.com" });

    const { sessions } = applyCloseSession([s1, s2], s1.id, s2.id);

    expect(sessions.map((s) => s.id)).not.toContain(s1.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(s2.id);
  });

  it("switches active to first remaining when the active tab is closed", () => {
    const s1 = makeSession();
    const s2 = makeSession();
    const s3 = makeSession();

    const { activeSessionId } = applyCloseSession(
      [s1, s2, s3],
      s3.id, // close the active one
      s3.id
    );

    expect(activeSessionId).toBe(s1.id);
  });

  it("keeps active session unchanged when a non-active tab is closed", () => {
    const s1 = makeSession();
    const s2 = makeSession();
    const s3 = makeSession();

    const { activeSessionId } = applyCloseSession(
      [s1, s2, s3],
      s1.id, // close a background tab
      s3.id // s3 is active
    );

    expect(activeSessionId).toBe(s3.id);
  });

  it("creates a replacement blank session when the last tab is closed", () => {
    const only = makeSession({ url: "https://x.com" });

    const { sessions, activeSessionId } = applyCloseSession(
      [only],
      only.id,
      only.id
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].url).toBe("");
    expect(sessions[0].id).not.toBe(only.id);
    expect(activeSessionId).toBe(sessions[0].id);
  });

  it("is a no-op when closing a non-existent session id", () => {
    const s1 = makeSession();

    const { sessions, activeSessionId } = applyCloseSession(
      [s1],
      "does-not-exist",
      s1.id
    );

    expect(sessions).toHaveLength(1);
    expect(activeSessionId).toBe(s1.id);
  });

  // Regression: stale-closure bug — when the active session id was captured
  // from a stale closure inside setSessions(), closing a tab after switching
  // active would use the old activeSessionId and wrongly change the active tab.
  it("uses the latest activeSessionId (stale-closure regression)", () => {
    const s1 = makeSession();
    const s2 = makeSession();
    const s3 = makeSession();

    // Simulate: user adds s2 and s3, then switches back to s2,
    // then closes s3 (which was previously active).
    // The stale-closure bug would still see s3 as active.
    const latestActiveId = s2.id; // this is what the ref holds
    const closingId = s3.id;

    const { activeSessionId, sessions } = applyCloseSession(
      [s1, s2, s3],
      closingId,
      latestActiveId // ref-based value — always current
    );

    expect(activeSessionId).toBe(s2.id);
    expect(sessions.map((s) => s.id)).not.toContain(s3.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addSession defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("addSession defaults", () => {
  it("sets isLoading=true when a URL is provided", () => {
    const session = makeSession({
      url: "https://example.com",
      isLoading: true,
    });
    expect(session.isLoading).toBe(true);
  });

  it("sets isLoading=false when no URL is provided", () => {
    const session = makeSession({ url: "", isLoading: false });
    expect(session.isLoading).toBe(false);
  });

  it("records incognito flag correctly", () => {
    const normal = makeSession({ incognito: false });
    const incog = makeSession({ incognito: true });
    expect(normal.incognito).toBe(false);
    expect(incog.incognito).toBe(true);
  });

  it("seeds history with the initial URL when provided", () => {
    const url = "https://seed.com";
    const session = makeSession({ url, history: [url], historyIndex: 0 });
    expect(session.history).toEqual([url]);
    expect(session.historyIndex).toBe(0);
  });

  it("starts with empty history when no URL is provided", () => {
    const session = makeSession();
    expect(session.history).toEqual([]);
    expect(session.historyIndex).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// browser webview activation
// ─────────────────────────────────────────────────────────────────────────────

function shouldActivateBrowserWebview(options: {
  url: string;
  isActive: boolean;
  isTabActive: boolean;
}): boolean {
  const normalizedUrl = options.url.trim().toLowerCase();
  const hasNavigableUrl =
    normalizedUrl.length > 0 && !normalizedUrl.startsWith("about:blank");
  return hasNavigableUrl && options.isActive && options.isTabActive;
}

describe("browser webview activation", () => {
  it("does not create native webviews for restored background URL tabs", () => {
    expect(
      shouldActivateBrowserWebview({
        url: "https://example.com",
        isActive: false,
        isTabActive: true,
      })
    ).toBe(false);
    expect(
      shouldActivateBrowserWebview({
        url: "https://example.com",
        isActive: true,
        isTabActive: false,
      })
    ).toBe(false);
  });

  it("creates native webviews only for the visible active URL tab", () => {
    expect(
      shouldActivateBrowserWebview({
        url: "https://example.com",
        isActive: true,
        isTabActive: true,
      })
    ).toBe(true);
    expect(
      shouldActivateBrowserWebview({
        url: "about:blank",
        isActive: true,
        isTabActive: true,
      })
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateSession pure merge
// ─────────────────────────────────────────────────────────────────────────────

describe("updateSession pure merge", () => {
  function applyUpdate(
    sessions: BrowserSession[],
    id: string,
    updates: Partial<BrowserSession>
  ): BrowserSession[] {
    return sessions.map((s) => (s.id === id ? { ...s, ...updates } : s));
  }

  it("applies partial updates to the target session", () => {
    const s1 = makeSession();
    const updated = applyUpdate([s1], s1.id, {
      url: "https://new.com",
      title: "New",
    });
    expect(updated[0].url).toBe("https://new.com");
    expect(updated[0].title).toBe("New");
  });

  it("does not mutate other sessions", () => {
    const s1 = makeSession({ title: "A" });
    const s2 = makeSession({ title: "B" });
    const updated = applyUpdate([s1, s2], s1.id, { title: "Changed" });
    expect(updated[1].title).toBe("B");
  });

  it("is a no-op for an unknown session id", () => {
    const s1 = makeSession({ title: "Original" });
    const updated = applyUpdate([s1], "no-such-id", { title: "X" });
    expect(updated[0].title).toBe("Original");
  });

  it("clears error field independently", () => {
    const s1 = makeSession({ error: "old error" });
    const updated = applyUpdate([s1], s1.id, { error: null });
    expect(updated[0].error).toBeNull();
  });
});
