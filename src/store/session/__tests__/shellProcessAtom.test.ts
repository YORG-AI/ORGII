import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import { findStaleShellProcesses } from "@src/hooks/terminal/useProcessReconciliation";

import {
  shellProcessMapAtom,
  updateShellProcessAtom,
} from "../shellProcessAtom";

describe("shellProcessAtom", () => {
  it("ignores lifecycle updates for a reused PID from another tool call", () => {
    const store = createStore();
    store.set(updateShellProcessAtom, {
      type: "start",
      sessionId: "session-1",
      pid: 1001,
      callId: "call-new",
      command: "sleep 180",
    });

    store.set(updateShellProcessAtom, {
      type: "exit",
      sessionId: "session-1",
      pid: 1001,
      callId: "call-old",
      killed: false,
    });

    expect(
      store.get(shellProcessMapAtom).get("session-1")?.get(1001)?.status
    ).toBe("running");
  });

  it("marks frontend-only running processes as exited during reconciliation", () => {
    const store = createStore();

    store.set(updateShellProcessAtom, {
      type: "start",
      sessionId: "session-live",
      pid: 1001,
      callId: "call-live",
      command: "sleep 180",
    });
    store.set(updateShellProcessAtom, {
      type: "start",
      sessionId: "session-stale",
      pid: 1002,
      callId: "call-stale",
      command: "sleep 180",
    });
    store.set(updateShellProcessAtom, {
      type: "background",
      sessionId: "session-stale",
      pid: 1002,
      callId: "call-stale",
    });

    const staleProcesses = findStaleShellProcesses(
      store.get(shellProcessMapAtom),
      [
        {
          session_id: "session-live",
          call_id: "call-live",
          pid: 1001,
          command: "sleep 180",
        },
      ]
    );

    expect(staleProcesses).toEqual([
      { sessionId: "session-stale", pid: 1002, callId: "call-stale" },
    ]);

    for (const process of staleProcesses) {
      store.set(updateShellProcessAtom, {
        type: "exit",
        sessionId: process.sessionId,
        pid: process.pid,
        callId: process.callId,
        killed: false,
      });
    }

    const processMap = store.get(shellProcessMapAtom);
    expect(processMap.get("session-live")?.get(1001)?.status).toBe("running");
    expect(processMap.get("session-stale")?.get(1002)?.status).toBe("exited");
  });

  it("does not confuse identities whose colon-joined forms would collide", () => {
    const store = createStore();
    store.set(updateShellProcessAtom, {
      type: "start",
      sessionId: "session:a",
      pid: 1001,
      callId: "call",
      command: "sleep 180",
    });

    expect(
      findStaleShellProcesses(store.get(shellProcessMapAtom), [
        {
          session_id: "session",
          call_id: "a:call",
          pid: 1001,
          command: "sleep 180",
        },
      ])
    ).toEqual([{ sessionId: "session:a", pid: 1001, callId: "call" }]);
  });
});
