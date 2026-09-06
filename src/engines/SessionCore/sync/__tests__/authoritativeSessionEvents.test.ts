import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { loadAuthoritativeSessionEvents } from "../authoritativeSessionEvents";

const mocks = vi.hoisted(() => ({
  loadAgentHistory: vi.fn(),
  loadExternalPreview: vi.fn(),
  loadExternalAuthoritativeHistory: vi.fn(),
  loadCliHistory: vi.fn(),
  loadPersistedEvents: vi.fn(),
  getAdapterForSession: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getPersistedEvents: mocks.loadPersistedEvents,
  },
}));

vi.mock("../adapters/cli/cliHistory", () => ({
  loadCliHistory: mocks.loadCliHistory,
}));

vi.mock("../types", () => ({
  getAdapterForSession: mocks.getAdapterForSession,
}));

const EVENT = { id: "event-1" } as SessionEvent;

describe("loadAuthoritativeSessionEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdapterForSession.mockReturnValue({
      category: "agent",
      loadHistory: mocks.loadAgentHistory,
    });
  });

  it("reads a native Agent through its persisted native-message adapter", async () => {
    mocks.loadAgentHistory.mockResolvedValue([EVENT]);

    await expect(
      loadAuthoritativeSessionEvents("agentsession-native")
    ).resolves.toEqual({ events: [EVENT], source: "agent_history" });
    expect(mocks.loadAgentHistory).toHaveBeenCalledOnce();
    expect(mocks.loadCliHistory).not.toHaveBeenCalled();
  });

  it("reads a managed CLI through its provider transcript adapter", async () => {
    mocks.loadCliHistory.mockResolvedValue([EVENT]);

    await expect(
      loadAuthoritativeSessionEvents("cliagent-native")
    ).resolves.toEqual({ events: [EVENT], source: "cli_history" });
    expect(mocks.loadCliHistory).toHaveBeenCalledOnce();
    expect(mocks.getAdapterForSession).not.toHaveBeenCalled();
  });

  it("reads imported provider history through its external-history adapter", async () => {
    mocks.loadExternalAuthoritativeHistory.mockResolvedValue([EVENT]);
    mocks.getAdapterForSession.mockReturnValue({
      category: "external_history",
      loadHistory: mocks.loadExternalPreview,
      loadAuthoritativeHistory: mocks.loadExternalAuthoritativeHistory,
    });

    await expect(
      loadAuthoritativeSessionEvents("claudecodeapp-native")
    ).resolves.toEqual({ events: [EVENT], source: "external_history" });
    expect(mocks.loadExternalAuthoritativeHistory).toHaveBeenCalledOnce();
    expect(mocks.loadExternalPreview).not.toHaveBeenCalled();
    expect(mocks.loadCliHistory).not.toHaveBeenCalled();
  });

  it("reads a teammate Cloud import from its complete persisted replay", async () => {
    mocks.loadPersistedEvents.mockResolvedValue([EVENT]);

    await expect(
      loadAuthoritativeSessionEvents("imported-session-cloud")
    ).resolves.toEqual({
      events: [EVENT],
      source: "collaboration_replay",
    });
    expect(mocks.loadPersistedEvents).toHaveBeenCalledWith(
      "imported-session-cloud"
    );
    expect(mocks.getAdapterForSession).not.toHaveBeenCalled();
  });

  it("fails closed rather than treating an imported UI preview as complete", async () => {
    mocks.getAdapterForSession.mockReturnValue({
      category: "external_history",
      loadHistory: mocks.loadExternalPreview,
    });

    await expect(
      loadAuthoritativeSessionEvents("claudecodeapp-preview-only")
    ).rejects.toThrow("No authoritative full-history reader");
    expect(mocks.loadExternalPreview).not.toHaveBeenCalled();
  });

  it("fails closed without an authoritative native reader", async () => {
    mocks.getAdapterForSession.mockReturnValue(undefined);

    await expect(
      loadAuthoritativeSessionEvents("agentsession-native")
    ).rejects.toThrow("No authoritative native history reader");
  });

  it("fails closed for an adapter outside the authoritative categories", async () => {
    mocks.getAdapterForSession.mockReturnValue({
      category: "unsupported",
      loadHistory: mocks.loadAgentHistory,
    });

    await expect(
      loadAuthoritativeSessionEvents("imported-unsupported")
    ).rejects.toThrow("No authoritative native history reader");
    expect(mocks.loadAgentHistory).not.toHaveBeenCalled();
  });
});
