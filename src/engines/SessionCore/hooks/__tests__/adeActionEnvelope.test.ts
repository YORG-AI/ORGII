import { describe, expect, it } from "vitest";

import { parseAdeActionEnvelope } from "../adeActionEnvelope";

describe("parseAdeActionEnvelope", () => {
  it("returns null for non-ade frames", () => {
    expect(
      parseAdeActionEnvelope(JSON.stringify({ type: "agent:complete" }))
    ).toBeNull();
  });

  it("parses dispatch envelopes with invoking session id", () => {
    const detail = parseAdeActionEnvelope(
      JSON.stringify({
        type: "agent:ade_action",
        payload: {
          correlationId: "corr-1",
          action: "gui.execute",
          operation: "dispatch",
          invokingSessionId: "session-42",
          params: { foo: "bar" },
        },
      })
    );

    expect(detail?.correlationId).toBe("corr-1");
    expect(detail?.invokingSessionId).toBe("session-42");
  });
});
