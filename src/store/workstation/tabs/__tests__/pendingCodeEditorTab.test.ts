import { afterEach, describe, expect, it } from "vitest";

import {
  clearPendingCodeEditorTabForSession,
  consumePendingCodeEditorTab,
  queuePendingCodeEditorTab,
} from "../pendingCodeEditorTab";

const GLOBAL = { kind: "global" } as const;
const SESSION_A = { kind: "session", sessionId: "session-a" } as const;
const SESSION_B = { kind: "session", sessionId: "session-b" } as const;

afterEach(() => {
  consumePendingCodeEditorTab(GLOBAL);
  consumePendingCodeEditorTab(SESSION_A);
  consumePendingCodeEditorTab(SESSION_B);
});

describe("workspace-scoped pending Code Editor tab", () => {
  it("isolates delayed focus requests by workspace", () => {
    queuePendingCodeEditorTab(SESSION_A, "source-control:A");
    queuePendingCodeEditorTab(SESSION_B, "source-control:B");

    expect(consumePendingCodeEditorTab(SESSION_A)).toBe("source-control:A");
    expect(consumePendingCodeEditorTab(SESSION_B)).toBe("source-control:B");
  });

  it("consumes only once", () => {
    queuePendingCodeEditorTab(GLOBAL, "explorer");
    expect(consumePendingCodeEditorTab(GLOBAL)).toBe("explorer");
    expect(consumePendingCodeEditorTab(GLOBAL)).toBeNull();
  });

  it("clears only the disposed session", () => {
    queuePendingCodeEditorTab(SESSION_A, "A");
    queuePendingCodeEditorTab(SESSION_B, "B");

    clearPendingCodeEditorTabForSession("session-a");

    expect(consumePendingCodeEditorTab(SESSION_A)).toBeNull();
    expect(consumePendingCodeEditorTab(SESSION_B)).toBe("B");
  });
});
