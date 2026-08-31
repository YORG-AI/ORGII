/**
 * SessionGenerationGuard — unit tests
 *
 * Regression target:
 *   Several session-scoped flows used to write atoms based on the
 *   resolution of in-flight async work, with no check that the work
 *   was still the most recent invocation. On rapid A → B → A switches
 *   the older A invocation could land its results on top of the newer
 *   A's freshly settled state.
 *
 *   `SessionGenerationGuard` is the small reusable utility used by
 *   session-scoped async hooks to make
 *   this protection explicit and testable. These tests pin down the
 *   contract:
 *
 *   - Each `issue(key)` ticket starts as current.
 *   - A new ticket for the SAME key invalidates older tickets for
 *     that key.
 *   - Tickets for different keys are independent.
 *   - `dispose()` invalidates EVERY ticket (existing and future)
 *     atomically — the React effect cleanup pattern.
 *   - `forget(key)` resets the generation counter for one key and
 *     leaves siblings alone.
 *   - `peek` / `size` / `isDisposed` are reliable diagnostics.
 */
import { describe, expect, it } from "vitest";

import { SessionGenerationGuard } from "../sessionGenerationGuard";

describe("SessionGenerationGuard — issue + isCurrent", () => {
  it("the first ticket for a key is current", () => {
    const guard = new SessionGenerationGuard();
    const t = guard.issue("s1");
    expect(t.key).toBe("s1");
    expect(t.isCurrent()).toBe(true);
    expect(t.isStale()).toBe(false);
  });

  it("isCurrent / isStale are inverses", () => {
    const guard = new SessionGenerationGuard();
    const t = guard.issue("s1");
    expect(t.isCurrent()).toBe(!t.isStale());
    guard.issue("s1");
    expect(t.isCurrent()).toBe(!t.isStale());
  });

  it("repeated issue on the same key advances the generation", () => {
    const guard = new SessionGenerationGuard();
    expect(guard.peek("s1")).toBe(0);
    guard.issue("s1");
    expect(guard.peek("s1")).toBe(1);
    guard.issue("s1");
    expect(guard.peek("s1")).toBe(2);
    guard.issue("s1");
    expect(guard.peek("s1")).toBe(3);
  });

  it("the ticket's `generation` field captures the issue-time value", () => {
    const guard = new SessionGenerationGuard();
    const t1 = guard.issue("s1");
    const t2 = guard.issue("s1");
    const t3 = guard.issue("s1");
    expect(t1.generation).toBe(1);
    expect(t2.generation).toBe(2);
    expect(t3.generation).toBe(3);
  });
});

describe("SessionGenerationGuard — supersession (REGRESSION GUARD)", () => {
  it("an older ticket becomes stale when a newer ticket is issued for the same key", () => {
    const guard = new SessionGenerationGuard();
    const older = guard.issue("s1");
    expect(older.isCurrent()).toBe(true);

    guard.issue("s1");
    expect(older.isCurrent()).toBe(false);
    expect(older.isStale()).toBe(true);
  });

  it("only the LATEST ticket for a key is current", () => {
    const guard = new SessionGenerationGuard();
    const t1 = guard.issue("s1");
    const t2 = guard.issue("s1");
    const t3 = guard.issue("s1");
    expect(t1.isCurrent()).toBe(false);
    expect(t2.isCurrent()).toBe(false);
    expect(t3.isCurrent()).toBe(true);
  });

  it("supersession does NOT cross keys", () => {
    const guard = new SessionGenerationGuard();
    const a1 = guard.issue("a");
    const b1 = guard.issue("b");
    const a2 = guard.issue("a");

    expect(a1.isCurrent()).toBe(false);
    expect(a2.isCurrent()).toBe(true);

    // b1 should still be current — issuing on "a" doesn't affect "b".
    expect(b1.isCurrent()).toBe(true);
  });

  it("handles rapid A→B→A churn correctly", () => {
    const guard = new SessionGenerationGuard();
    const ticketsForA: ReturnType<SessionGenerationGuard["issue"]>[] = [];

    for (let i = 0; i < 20; i++) {
      ticketsForA.push(guard.issue("a"));
      guard.issue("b");
    }

    // The most recent A ticket is the last one we pushed.
    const last = ticketsForA[ticketsForA.length - 1];
    expect(last.isCurrent()).toBe(true);
    for (let i = 0; i < ticketsForA.length - 1; i++) {
      expect(ticketsForA[i].isCurrent()).toBe(false);
    }
  });
});

describe("SessionGenerationGuard — dispose", () => {
  it("disposing the guard invalidates all current tickets", () => {
    const guard = new SessionGenerationGuard();
    const a = guard.issue("a");
    const b = guard.issue("b");
    const c = guard.issue("c");

    expect(a.isCurrent()).toBe(true);
    expect(b.isCurrent()).toBe(true);
    expect(c.isCurrent()).toBe(true);

    guard.dispose();

    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(false);
    expect(c.isCurrent()).toBe(false);
    expect(a.isStale()).toBe(true);
    expect(b.isStale()).toBe(true);
    expect(c.isStale()).toBe(true);
  });

  it("tickets issued AFTER dispose are immediately stale", () => {
    const guard = new SessionGenerationGuard();
    guard.dispose();
    const t = guard.issue("s1");
    expect(t.isCurrent()).toBe(false);
    expect(t.isStale()).toBe(true);
    expect(t.generation).toBe(-1);
  });

  it("dispose is idempotent", () => {
    const guard = new SessionGenerationGuard();
    guard.dispose();
    guard.dispose();
    guard.dispose();
    expect(guard.isDisposed()).toBe(true);
  });

  it("isDisposed reflects the disposal flag", () => {
    const guard = new SessionGenerationGuard();
    expect(guard.isDisposed()).toBe(false);
    guard.dispose();
    expect(guard.isDisposed()).toBe(true);
  });

  it("dispose clears the size counter", () => {
    const guard = new SessionGenerationGuard();
    guard.issue("a");
    guard.issue("b");
    guard.issue("c");
    expect(guard.size()).toBe(3);
    guard.dispose();
    expect(guard.size()).toBe(0);
  });
});

describe("SessionGenerationGuard — forget", () => {
  it("forget(key) drops only that key's bookkeeping", () => {
    const guard = new SessionGenerationGuard();
    guard.issue("a");
    guard.issue("b");
    guard.issue("c");
    expect(guard.size()).toBe(3);

    guard.forget("b");

    expect(guard.size()).toBe(2);
    expect(guard.peek("a")).toBe(1);
    expect(guard.peek("b")).toBe(0);
    expect(guard.peek("c")).toBe(1);
  });

  it("after forget, the next issue resets the generation to 1", () => {
    const guard = new SessionGenerationGuard();
    guard.issue("s1");
    guard.issue("s1");
    guard.issue("s1");
    expect(guard.peek("s1")).toBe(3);

    guard.forget("s1");
    const t = guard.issue("s1");
    expect(t.generation).toBe(1);
  });

  it("forget invalidates prior tickets for the forgotten key", () => {
    const guard = new SessionGenerationGuard();
    const t = guard.issue("s1");
    expect(t.isCurrent()).toBe(true);
    guard.forget("s1");
    expect(t.isCurrent()).toBe(false);
    expect(t.isStale()).toBe(true);
  });

  it("forget is safe on an unknown key", () => {
    const guard = new SessionGenerationGuard();
    expect(() => guard.forget("never-issued")).not.toThrow();
    expect(guard.size()).toBe(0);
  });
});

describe("SessionGenerationGuard — diagnostics", () => {
  it("size returns the number of distinct keys", () => {
    const guard = new SessionGenerationGuard();
    expect(guard.size()).toBe(0);
    guard.issue("a");
    expect(guard.size()).toBe(1);
    guard.issue("a"); // same key — size stays the same
    expect(guard.size()).toBe(1);
    guard.issue("b");
    expect(guard.size()).toBe(2);
  });

  it("peek returns 0 for unknown keys", () => {
    const guard = new SessionGenerationGuard();
    expect(guard.peek("unknown")).toBe(0);
  });

  it("peek does NOT advance the generation", () => {
    const guard = new SessionGenerationGuard();
    guard.issue("s1");
    expect(guard.peek("s1")).toBe(1);
    expect(guard.peek("s1")).toBe(1);
    expect(guard.peek("s1")).toBe(1);
  });
});

describe("SessionGenerationGuard — modeling real session-switch scenarios", () => {
  it("simulates the rapid A → B → A bug scenario", async () => {
    const guard = new SessionGenerationGuard();

    // First load for session A — takes 100ms.
    const ticketA1 = guard.issue("A");
    const a1Result = new Promise<string>((resolve) =>
      setTimeout(() => resolve("a1-loaded"), 100)
    );

    // User switches to B.
    const ticketB = guard.issue("B");
    expect(ticketB.isCurrent()).toBe(true);
    // A1 is still valid until a newer A invocation supersedes it —
    // switching to B leaves it alone.
    expect(ticketA1.isCurrent()).toBe(true);

    // User switches back to A. NEW load for A.
    const ticketA2 = guard.issue("A");
    expect(ticketA2.isCurrent()).toBe(true);
    expect(ticketA1.isCurrent()).toBe(false); // <-- the regression fix

    // When a1's old request finally resolves, the consumer can detect
    // it's stale and abandon writing its result.
    const result = await a1Result;
    expect(result).toBe("a1-loaded");
    expect(ticketA1.isStale()).toBe(true); // <-- consumer must check this
  });

  it("models hook unmount via dispose", () => {
    const guard = new SessionGenerationGuard();
    const ticket = guard.issue("s1");

    // Imagine an in-flight Promise about to resolve...
    // The component unmounts:
    guard.dispose();

    // ...and now when the promise resolves, the consumer sees stale.
    expect(ticket.isStale()).toBe(true);
  });

  it("guards are independent (modeling per-hook-instance use)", () => {
    const guardA = new SessionGenerationGuard();
    const guardB = new SessionGenerationGuard();

    const tA = guardA.issue("session-1");
    const tB = guardB.issue("session-1");

    guardA.dispose();

    // Disposing guardA does NOT affect guardB's tickets.
    expect(tA.isCurrent()).toBe(false);
    expect(tB.isCurrent()).toBe(true);
  });
});

describe("SessionGenerationGuard — many keys / large generation numbers", () => {
  it("handles 1000 unique keys", () => {
    const guard = new SessionGenerationGuard();
    for (let i = 0; i < 1000; i++) {
      guard.issue(`session-${i}`);
    }
    expect(guard.size()).toBe(1000);
  });

  it("handles 10000 advances on a single key", () => {
    const guard = new SessionGenerationGuard();
    let lastTicket = guard.issue("s1");
    for (let i = 0; i < 10_000; i++) {
      const newer = guard.issue("s1");
      expect(lastTicket.isCurrent()).toBe(false);
      lastTicket = newer;
    }
    expect(lastTicket.isCurrent()).toBe(true);
    expect(guard.peek("s1")).toBe(10_001);
  });
});
