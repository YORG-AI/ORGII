import { createStore } from "jotai/vanilla";

import {
  clearSessionSidebarRevealAtom,
  requestSessionSidebarRevealAtom,
  sessionSidebarRevealRequestAtom,
} from "../sidebarAtom";

describe("requestSessionSidebarRevealAtom", () => {
  it("normalizes identities and increments repeated reveal requests", () => {
    const store = createStore();

    store.set(requestSessionSidebarRevealAtom, {
      sessionId: " child-session ",
      parentSessionId: " root-session ",
    });
    expect(store.get(sessionSidebarRevealRequestAtom)).toEqual({
      sessionId: "child-session",
      parentSessionId: "root-session",
      requestId: 1,
    });

    store.set(requestSessionSidebarRevealAtom, {
      sessionId: "child-session",
      parentSessionId: "root-session",
    });
    expect(store.get(sessionSidebarRevealRequestAtom)?.requestId).toBe(2);
  });

  it("ignores an empty canonical session ID", () => {
    const store = createStore();

    store.set(requestSessionSidebarRevealAtom, { sessionId: "   " });

    expect(store.get(sessionSidebarRevealRequestAtom)).toBeNull();
  });

  it("preserves an exact Team Session reveal target", () => {
    const store = createStore();

    store.set(requestSessionSidebarRevealAtom, {
      sessionId: " imported-session-1 ",
      sidebarItemId: " cloudremote-org-1|org-1:user-1:source-1 ",
      cloudOrgId: " org-1 ",
    });

    expect(store.get(sessionSidebarRevealRequestAtom)).toEqual({
      sessionId: "imported-session-1",
      sidebarItemId: "cloudremote-org-1|org-1:user-1:source-1",
      cloudOrgId: "org-1",
      requestId: 1,
    });
  });

  it("clears only the reveal request that was actually completed", () => {
    const store = createStore();
    store.set(requestSessionSidebarRevealAtom, { sessionId: "session-a" });
    const firstRequestId = store.get(
      sessionSidebarRevealRequestAtom
    )!.requestId;
    store.set(requestSessionSidebarRevealAtom, { sessionId: "session-b" });

    store.set(clearSessionSidebarRevealAtom, firstRequestId);
    expect(store.get(sessionSidebarRevealRequestAtom)?.sessionId).toBe(
      "session-b"
    );

    store.set(
      clearSessionSidebarRevealAtom,
      store.get(sessionSidebarRevealRequestAtom)!.requestId
    );
    expect(store.get(sessionSidebarRevealRequestAtom)).toBeNull();

    store.set(requestSessionSidebarRevealAtom, { sessionId: "session-c" });
    expect(store.get(sessionSidebarRevealRequestAtom)?.requestId).toBe(3);
  });
});
