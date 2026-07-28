import { describe, expect, it } from "vitest";

import {
  isSessionEngineActiveStatus,
  isSessionRuntimeExecuting,
} from "../sessionRuntimeExecuting";

describe("session runtime status helpers", () => {
  it("treats installing as active and worker-attached", () => {
    expect(isSessionEngineActiveStatus("installing")).toBe(true);
    expect(isSessionRuntimeExecuting("installing")).toBe(true);
  });

  it("keeps interactive waits active without treating them as worker execution", () => {
    for (const status of ["waiting_for_user", "waiting_for_funds"]) {
      expect(isSessionEngineActiveStatus(status)).toBe(true);
      expect(isSessionRuntimeExecuting(status)).toBe(false);
    }
  });

  it("rejects terminal, idle, and missing statuses", () => {
    for (const status of ["idle", "completed", "failed", undefined, null]) {
      expect(isSessionEngineActiveStatus(status)).toBe(false);
      expect(isSessionRuntimeExecuting(status)).toBe(false);
    }
  });
});
