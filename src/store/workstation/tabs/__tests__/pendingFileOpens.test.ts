import { afterEach, describe, expect, it } from "vitest";

import {
  clearPendingFileOpensForSession,
  consumePendingFileOpens,
  queueFileOpens,
} from "../pendingFileOpens";

const GLOBAL = { kind: "global" } as const;
const SESSION_A = { kind: "session", sessionId: "session-a" } as const;
const SESSION_B = { kind: "session", sessionId: "session-b" } as const;

afterEach(() => {
  consumePendingFileOpens(GLOBAL);
  consumePendingFileOpens(SESSION_A);
  consumePendingFileOpens(SESSION_B);
});

describe("workspace-scoped pending file opens", () => {
  it("returns an empty array when nothing was queued", () => {
    expect(consumePendingFileOpens(GLOBAL)).toEqual([]);
  });

  it("captures a workspace with the queued files", () => {
    queueFileOpens(SESSION_A, [
      { path: "/foo/bar.ts" },
      { path: "/foo/baz.ts", line: 10 },
    ]);

    expect(consumePendingFileOpens(SESSION_B)).toEqual([]);
    expect(consumePendingFileOpens(SESSION_A)).toEqual([
      { path: "/foo/bar.ts" },
      { path: "/foo/baz.ts", line: 10 },
    ]);
  });

  it("empties only the consumed workspace queue", () => {
    queueFileOpens(SESSION_A, [{ path: "/a.ts" }]);
    queueFileOpens(SESSION_B, [{ path: "/b.ts" }]);

    expect(consumePendingFileOpens(SESSION_A)).toEqual([{ path: "/a.ts" }]);
    expect(consumePendingFileOpens(SESSION_A)).toEqual([]);
    expect(consumePendingFileOpens(SESSION_B)).toEqual([{ path: "/b.ts" }]);
  });

  it("replaces successive queues only within the same workspace", () => {
    queueFileOpens(SESSION_A, [{ path: "/first.ts" }]);
    queueFileOpens(SESSION_B, [{ path: "/other.ts" }]);
    queueFileOpens(SESSION_A, [{ path: "/second.ts" }]);

    expect(consumePendingFileOpens(SESSION_A)).toEqual([
      { path: "/second.ts" },
    ]);
    expect(consumePendingFileOpens(SESSION_B)).toEqual([{ path: "/other.ts" }]);
  });

  it("clears only pending requests owned by a disposed session", () => {
    queueFileOpens(SESSION_A, [{ path: "/a.ts" }]);
    queueFileOpens(SESSION_B, [{ path: "/b.ts" }]);
    queueFileOpens(GLOBAL, [{ path: "/global.ts" }]);

    clearPendingFileOpensForSession("session-a");

    expect(consumePendingFileOpens(SESSION_A)).toEqual([]);
    expect(consumePendingFileOpens(SESSION_B)).toEqual([{ path: "/b.ts" }]);
    expect(consumePendingFileOpens(GLOBAL)).toEqual([{ path: "/global.ts" }]);
  });

  it("queueing an empty list clears only that workspace", () => {
    queueFileOpens(SESSION_A, [{ path: "/a.ts" }]);
    queueFileOpens(SESSION_B, [{ path: "/b.ts" }]);

    queueFileOpens(SESSION_A, []);

    expect(consumePendingFileOpens(SESSION_A)).toEqual([]);
    expect(consumePendingFileOpens(SESSION_B)).toEqual([{ path: "/b.ts" }]);
  });

  it("handles a large workspace queue without data loss", () => {
    const files = Array.from({ length: 100 }, (_, index) => ({
      path: `/file-${index}.ts`,
      line: index + 1,
    }));

    queueFileOpens(SESSION_A, files);
    const result = consumePendingFileOpens(SESSION_A);

    expect(result).toHaveLength(100);
    expect(result[99]).toEqual({ path: "/file-99.ts", line: 100 });
  });
});
