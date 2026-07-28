/**
 * classifyBackendSessionStatus — queue dead-session gating tests.
 *
 * Regression coverage for the "queue flushed into a dead session" bug
 * (2026-06-11): six queued messages were naturally drained into a subagent
 * session 20 minutes after it terminated as `failed`; the backend accepted
 * them and no turn ever ran, silently swallowing the messages. The natural
 * drain must park ("dead") instead of dispatching; only explicit Send Now
 * may target a terminal session (which lazily re-initializes it).
 */
import { describe, expect, it } from "vitest";

import { classifyBackendSessionStatus } from "../backendDispatchVerdict";

describe("classifyBackendSessionStatus", () => {
  it("classifies executing statuses as busy", () => {
    for (const status of [
      "running",
      "installing",
      "waiting_for_user",
      "waiting_for_funds",
    ]) {
      expect(classifyBackendSessionStatus(status)).toBe("busy");
    }
  });

  it("classifies failure-class terminal statuses as dead", () => {
    for (const status of [
      "failed",
      "error",
      "timeout",
      "killed",
      "abandoned",
      "archived",
    ]) {
      expect(classifyBackendSessionStatus(status)).toBe("dead");
    }
  });

  it("keeps completed dispatchable — it is the normal drain trigger", () => {
    expect(classifyBackendSessionStatus("completed")).toBe("ready");
  });

  it("keeps cancelled dispatchable — Stop parking is handled by the hold atom", () => {
    expect(classifyBackendSessionStatus("cancelled")).toBe("ready");
  });

  it("treats idle and unknown statuses as ready", () => {
    expect(classifyBackendSessionStatus("idle")).toBe("ready");
    expect(classifyBackendSessionStatus("pending")).toBe("ready");
    expect(classifyBackendSessionStatus("some_future_status")).toBe("ready");
  });

  it("fails open on missing status", () => {
    expect(classifyBackendSessionStatus(undefined)).toBe("ready");
    expect(classifyBackendSessionStatus(null)).toBe("ready");
    expect(classifyBackendSessionStatus("")).toBe("ready");
  });
});
