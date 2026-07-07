import { describe, expect, it } from "vitest";

import {
  isSessionEngineActiveStatus,
  isSessionRuntimeExecuting,
} from "../sessionRuntimeExecuting";

describe("isSessionRuntimeExecuting", () => {
  it("returns true only for running and installing", () => {
    expect(isSessionRuntimeExecuting("running")).toBe(true);
    expect(isSessionRuntimeExecuting("installing")).toBe(true);
  });

  it("returns false for idle, terminal, and interactive-wait statuses", () => {
    expect(isSessionRuntimeExecuting("idle")).toBe(false);
    expect(isSessionRuntimeExecuting("failed")).toBe(false);
    expect(isSessionRuntimeExecuting("waiting_for_user")).toBe(false);
    expect(isSessionRuntimeExecuting("waiting_for_funds")).toBe(false);
    expect(isSessionRuntimeExecuting(undefined)).toBe(false);
    expect(isSessionRuntimeExecuting(null)).toBe(false);
  });
});

describe("isSessionEngineActiveStatus", () => {
  it("returns true for open-turn statuses", () => {
    for (const status of [
      "running",
      "installing",
      "waiting_for_user",
      "waiting_for_funds",
    ]) {
      expect(isSessionEngineActiveStatus(status)).toBe(true);
    }
  });

  it("returns false for idle, terminal, and missing statuses", () => {
    expect(isSessionEngineActiveStatus("idle")).toBe(false);
    expect(isSessionEngineActiveStatus("failed")).toBe(false);
    expect(isSessionEngineActiveStatus("completed")).toBe(false);
    expect(isSessionEngineActiveStatus(undefined)).toBe(false);
    expect(isSessionEngineActiveStatus(null)).toBe(false);
  });
});
