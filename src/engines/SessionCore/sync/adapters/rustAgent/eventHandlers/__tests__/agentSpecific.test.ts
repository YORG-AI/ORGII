import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentWSEvent } from "../../../shared/types";
import { handleAdeAction } from "../agentSpecific";

class StubCustomEvent {
  constructor(
    public readonly type: string,
    public readonly init: { detail: unknown }
  ) {}
}

describe("handleAdeAction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the trusted invoking session id on the session-channel path", () => {
    const dispatched: StubCustomEvent[] = [];
    vi.stubGlobal("CustomEvent", StubCustomEvent);
    vi.stubGlobal("window", {
      dispatchEvent: (event: StubCustomEvent) => {
        dispatched.push(event);
        return true;
      },
    });

    handleAdeAction({
      type: "agent:ade_action",
      correlationId: "corr-1",
      action: "session.replyComment",
      params: { commentId: "comment-1", body: "done" },
      sessionId: "",
      invokingSessionId: "local-session-42",
    } as AgentWSEvent);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe("agent-ade-action");
    expect(dispatched[0].init.detail).toMatchObject({
      correlationId: "corr-1",
      action: "session.replyComment",
      invokingSessionId: "local-session-42",
    });
  });
});
