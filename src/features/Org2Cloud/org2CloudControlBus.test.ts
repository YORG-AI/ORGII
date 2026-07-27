import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ORG_CONTROL_CHANGED_EVENT,
  broadcastOrgControlChangedToPeers,
  parseOrgControlChangeKind,
  parseOrgDbChangeKind,
  registerOrgControlBroadcaster,
} from "./org2CloudControlBus";

describe("org2 cloud control bus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces metadata and replay writes into one sessions nudge", () => {
    vi.useFakeTimers();
    const sender = vi.fn();
    const unregister = registerOrgControlBroadcaster("org-1", sender);

    broadcastOrgControlChangedToPeers("org-1", "sessions");
    broadcastOrgControlChangedToPeers("org-1", "sessions");
    vi.advanceTimersByTime(250);

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(ORG_CONTROL_CHANGED_EVENT, {
      kind: "sessions",
    });
    unregister();
  });

  it("cancels a pending nudge when the org channel closes", () => {
    vi.useFakeTimers();
    const sender = vi.fn();
    const unregister = registerOrgControlBroadcaster("org-1", sender);

    broadcastOrgControlChangedToPeers("org-1", "sessions");
    unregister();
    vi.runAllTimers();

    expect(sender).not.toHaveBeenCalled();
  });

  it("rejects unknown wire kinds", () => {
    expect(parseOrgControlChangeKind({ kind: "projects" })).toBeNull();
    expect(parseOrgControlChangeKind({ kind: "scopes" })).toBe("scopes");
  });

  it("parses server db-change kinds and rejects unknown ones", () => {
    expect(parseOrgDbChangeKind({ kind: "sessions" })).toBe("sessions");
    expect(parseOrgDbChangeKind({ kind: "comments" })).toBe("comments");
    expect(parseOrgDbChangeKind({ kind: "projects" })).toBe("projects");
    expect(parseOrgDbChangeKind({ kind: "workItems" })).toBe("workItems");
    expect(parseOrgDbChangeKind({ kind: "roster" })).toBe("roster");
    expect(parseOrgDbChangeKind({ kind: "policy" })).toBe("policy");
    expect(parseOrgDbChangeKind({ kind: "entitlement" })).toBeNull();
    expect(parseOrgDbChangeKind({})).toBeNull();
  });
});
