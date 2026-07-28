import { describe, expect, it } from "vitest";

import { buildRustAgentSendMessageArgs } from "../rustAgentSendPayload";

describe("buildRustAgentSendMessageArgs", () => {
  it("preserves force-send as an explicit wire source", () => {
    expect(
      buildRustAgentSendMessageArgs({
        sessionId: "sdeagent-force-send",
        content: "follow up now",
        clientMessageId: "queued:sdeagent-force-send:q1",
        turnIntentId: "intent-force-send",
        turnIntentSource: "force_send",
      })
    ).toEqual({
      sessionId: "sdeagent-force-send",
      content: "follow up now",
      clientMessageId: "queued:sdeagent-force-send:q1",
      turnIntentId: "intent-force-send",
      turnIntentSource: "force_send",
    });
  });

  it("preserves an ordinary submit source", () => {
    expect(
      buildRustAgentSendMessageArgs({
        sessionId: "sdeagent-direct",
        content: "ordinary submit",
        turnIntentSource: "user_submit",
      })
    ).toEqual({
      sessionId: "sdeagent-direct",
      content: "ordinary submit",
      turnIntentSource: "user_submit",
    });
  });
});
