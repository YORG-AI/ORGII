import { createStore } from "jotai/vanilla";
import { beforeEach } from "vitest";

import {
  SESSION_BRANCH_TAGS_VISIBLE_STORAGE_KEY,
  clearSessionSidebarRevealAtom,
  requestSessionSidebarRevealAtom,
  sessionBranchTagsVisibleAtom,
  sessionSidebarRevealRequestAtom,
} from "../sidebarAtom";

beforeEach(() => {
  localStorage.removeItem(SESSION_BRANCH_TAGS_VISIBLE_STORAGE_KEY);
});

function hydratedStore(): ReturnType<typeof createStore> {
  const store = createStore();
  store.sub(sessionBranchTagsVisibleAtom, () => undefined);
  return store;
}

describe("sessionBranchTagsVisibleAtom", () => {
  it("hides branch tags by default", () => {
    expect(hydratedStore().get(sessionBranchTagsVisibleAtom)).toBe(false);
  });

  it("persists an enabled choice for the future settings control", () => {
    const writer = hydratedStore();
    writer.set(sessionBranchTagsVisibleAtom, true);

    expect(
      JSON.parse(
        localStorage.getItem(SESSION_BRANCH_TAGS_VISIBLE_STORAGE_KEY) ?? "null"
      )
    ).toBe(true);
    expect(hydratedStore().get(sessionBranchTagsVisibleAtom)).toBe(true);
  });

  it("falls back to hidden for a malformed stored value", () => {
    localStorage.setItem(
      SESSION_BRANCH_TAGS_VISIBLE_STORAGE_KEY,
      JSON.stringify("visible")
    );

    expect(hydratedStore().get(sessionBranchTagsVisibleAtom)).toBe(false);
  });
});

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
      issuedAt: expect.any(Number),
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
      issuedAt: expect.any(Number),
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
