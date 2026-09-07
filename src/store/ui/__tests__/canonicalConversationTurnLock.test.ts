import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationRootLocator } from "@src/engines/SessionCore/conversations/conversationTypes";
import { QueuedConversationBusyError } from "@src/engines/SessionCore/conversations/queuedConversationContract";

import { withCanonicalConversationTurnLock } from "../messageQueueRepository";

function installSerialWebLocks(): string[] {
  const requested: string[] = [];
  const held = new Set<string>();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(
        name: string,
        options: LockOptions,
        callback: (lock: { name: string } | null) => Promise<T>
      ): Promise<T> => {
        requested.push(name);
        if (options.ifAvailable && held.has(name)) return callback(null);
        held.add(name);
        return callback({ name }).finally(() => held.delete(name));
      },
    },
  });
  return requested;
}

function root(conversationId: string): ConversationRootLocator {
  return {
    authority: "local-session",
    authorityScope: [],
    conversationId,
  };
}

describe("canonical conversation cross-window turn lock", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a second webview queue while the same root is owned", async () => {
    const requested = installSerialWebLocks();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withCanonicalConversationTurnLock(
      root("root-1"),
      async () => {
        order.push("first:start");
        await firstGate;
        order.push("first:end");
        return 1;
      }
    );
    const second = withCanonicalConversationTurnLock(
      root("root-1"),
      async () => {
        order.push("second:start");
        return 2;
      }
    );

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    await expect(second).rejects.toBeInstanceOf(QueuedConversationBusyError);
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).resolves.toBe(1);

    await expect(
      withCanonicalConversationTurnLock(root("root-1"), async () => {
        order.push("second:retry");
        return 2;
      })
    ).resolves.toBe(2);
    expect(order).toEqual(["first:start", "first:end", "second:retry"]);
    expect(new Set(requested)).toHaveLength(1);
  });

  it("does not serialize independent canonical roots", async () => {
    installSerialWebLocks();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    const first = withCanonicalConversationTurnLock(
      root("root-a"),
      async () => {
        await firstGate;
      }
    );
    const second = withCanonicalConversationTurnLock(
      root("root-b"),
      async () => {
        secondStarted = true;
      }
    );

    await vi.waitFor(() => expect(secondStarted).toBe(true));
    releaseFirst();
    await Promise.all([first, second]);
  });

  it("fails closed when the web lock manager rejects acquisition", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: vi.fn().mockRejectedValue(new Error("locks unavailable")),
      },
    });
    const run = vi.fn().mockResolvedValue("ok");

    await expect(
      withCanonicalConversationTurnLock(root("root-fallback"), run)
    ).rejects.toThrow("canonical conversation lock acquisition failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed when Web Locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const run = vi.fn().mockResolvedValue("ok");

    await expect(
      withCanonicalConversationTurnLock(root("root-missing-locks"), run)
    ).rejects.toThrow("canonical conversation lock is unavailable");
    expect(run).not.toHaveBeenCalled();
  });

  it("never replays a provider failure outside the acquired lock", async () => {
    installSerialWebLocks();
    const failure = new Error("provider failed");
    const run = vi.fn().mockRejectedValue(failure);

    await expect(
      withCanonicalConversationTurnLock(root("root-failure"), run)
    ).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
