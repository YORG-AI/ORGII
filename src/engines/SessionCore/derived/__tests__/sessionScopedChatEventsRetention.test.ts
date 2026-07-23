/**
 * Session-scoped atom family retention tests
 *
 * Pins the family GC contract: jotai-family pins every created atom in a
 * strong Map, so entries must be explicitly removed once the session's
 * snapshot atom has been unmounted for SESSION_FAMILY_RETAIN_MS — and must
 * NOT be removed while mounted or when remounted within the grace period.
 * Removal is observable as an identity change: the family returns a fresh
 * atom object for the same sessionId after its entry was removed.
 */
import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_FAMILY_RETAIN_MS,
  chatEventsForSessionAtomFamily,
  sessionScopedPlanningMetaAtomFamily,
} from "@src/engines/SessionCore/derived/sessionScopedChatEvents";

const subscribers = new Map<string, (snapshot: unknown) => void>();
const { loadFromCache } = vi.hoisted(() => ({
  loadFromCache: vi.fn(() => Promise.resolve()),
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getLatestSessionSnapshot: () => null,
    subscribeSession: (
      sessionId: string,
      listener: (snapshot: unknown) => void
    ) => {
      subscribers.set(sessionId, listener);
      return () => subscribers.delete(sessionId);
    },
    loadFromCache,
  },
  isStreamingSnapshot: (snapshot: unknown) =>
    Boolean((snapshot as { streaming?: boolean })?.streaming),
}));

describe("session-scoped atom family retention", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    loadFromCache.mockClear();
    store = createStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    subscribers.clear();
  });

  it("removes family entries after the retain window once unmounted", () => {
    const sessionId = "retention-removed";
    const chatAtomBefore = chatEventsForSessionAtomFamily(sessionId);
    const metaAtomBefore = sessionScopedPlanningMetaAtomFamily(sessionId);

    const unsub = store.sub(chatAtomBefore, () => {});
    unsub();
    vi.advanceTimersByTime(SESSION_FAMILY_RETAIN_MS + 1);

    expect(chatEventsForSessionAtomFamily(sessionId)).not.toBe(chatAtomBefore);
    expect(sessionScopedPlanningMetaAtomFamily(sessionId)).not.toBe(
      metaAtomBefore
    );
  });

  it("keeps family entries while still mounted", () => {
    const sessionId = "retention-mounted";
    const chatAtomBefore = chatEventsForSessionAtomFamily(sessionId);

    const unsub = store.sub(chatAtomBefore, () => {});
    vi.advanceTimersByTime(SESSION_FAMILY_RETAIN_MS * 3);

    expect(chatEventsForSessionAtomFamily(sessionId)).toBe(chatAtomBefore);
    unsub();
  });

  it("cancels a pending removal when remounted within the grace period", () => {
    const sessionId = "retention-remounted";
    const chatAtomBefore = chatEventsForSessionAtomFamily(sessionId);

    const firstMount = store.sub(chatAtomBefore, () => {});
    firstMount();
    vi.advanceTimersByTime(SESSION_FAMILY_RETAIN_MS / 2);

    const secondMount = store.sub(
      chatEventsForSessionAtomFamily(sessionId),
      () => {}
    );
    vi.advanceTimersByTime(SESSION_FAMILY_RETAIN_MS * 2);

    expect(chatEventsForSessionAtomFamily(sessionId)).toBe(chatAtomBefore);
    secondMount();
  });

  it("restarts the grace period on each unmount", () => {
    const sessionId = "retention-restarted";
    const chatAtomBefore = chatEventsForSessionAtomFamily(sessionId);

    const firstMount = store.sub(chatAtomBefore, () => {});
    firstMount();
    vi.advanceTimersByTime(SESSION_FAMILY_RETAIN_MS / 2);

    // Remount + unmount again: the clock restarts from the second unmount.
    const secondMount = store.sub(
      chatEventsForSessionAtomFamily(sessionId),
      () => {}
    );
    secondMount();
    vi.advanceTimersByTime(SESSION_FAMILY_RETAIN_MS - 1);
    expect(chatEventsForSessionAtomFamily(sessionId)).toBe(chatAtomBefore);

    vi.advanceTimersByTime(2);
    expect(chatEventsForSessionAtomFamily(sessionId)).not.toBe(chatAtomBefore);
  });

  it("does not hydrate an inactive external session when a derived surface mounts it", () => {
    const unsub = store.sub(
      chatEventsForSessionAtomFamily("codexapp-inactive-large-session"),
      () => {}
    );

    expect(loadFromCache).not.toHaveBeenCalled();
    unsub();
  });

  it("keeps native session-scoped cache hydration unchanged", () => {
    const unsub = store.sub(
      chatEventsForSessionAtomFamily("sdeagent-native-session"),
      () => {}
    );

    expect(loadFromCache).toHaveBeenCalledOnce();
    expect(loadFromCache).toHaveBeenCalledWith("sdeagent-native-session");
    unsub();
  });
});
