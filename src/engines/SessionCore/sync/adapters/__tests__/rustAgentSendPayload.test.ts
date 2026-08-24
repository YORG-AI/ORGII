import { describe, expect, it } from "vitest";

import {
  buildRustAgentSendMessageArgs,
  parseRustAgentSendReceipt,
} from "../rustAgentSendPayload";

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

describe("parseRustAgentSendReceipt", () => {
  it.each([false, true])("preserves duplicate=%s", (duplicate) => {
    expect(
      parseRustAgentSendReceipt({
        content: JSON.stringify({
          queued: true,
          duplicate,
          turnIntentStatus: "queued",
          effectiveTurnIntentId: "intent-1",
        }),
        sessionId: "sdeagent-1",
        model: "test-model",
      })
    ).toEqual({
      duplicate,
      turnIntentStatus: "queued",
      effectiveTurnIntentId: "intent-1",
    });
  });

  it("preserves an exact durable status from a duplicate ack", () => {
    expect(
      parseRustAgentSendReceipt({
        content: JSON.stringify({
          queued: false,
          duplicate: true,
          turnIntentStatus: "completed",
          effectiveTurnIntentId: "wir_effective",
        }),
        sessionId: "sdeagent-1",
        model: "test-model",
      })
    ).toEqual({
      duplicate: true,
      turnIntentStatus: "completed",
      effectiveTurnIntentId: "wir_effective",
    });
  });

  it("preserves an explicit mid-turn steering receipt", () => {
    expect(
      parseRustAgentSendReceipt({
        content: JSON.stringify({
          duplicate: false,
          steered: true,
          turnIntentStatus: "queued",
          effectiveTurnIntentId: "intent-steered",
        }),
        sessionId: "sdeagent-1",
        model: "test-model",
      })
    ).toEqual({
      duplicate: false,
      steered: true,
      turnIntentStatus: "queued",
      effectiveTurnIntentId: "intent-steered",
    });
  });

  it.each(["not-json", JSON.stringify({ queued: true })])(
    "fails closed for malformed acknowledgement %s",
    (content) => {
      expect(() =>
        parseRustAgentSendReceipt({
          content,
          sessionId: "sdeagent-1",
          model: "test-model",
        })
      ).toThrow(/acknowledgement/);
    }
  );

  it("fails closed for a malformed durable status", () => {
    expect(() =>
      parseRustAgentSendReceipt({
        content: JSON.stringify({
          duplicate: true,
          turnIntentStatus: 42,
          effectiveTurnIntentId: "intent-1",
        }),
        sessionId: "sdeagent-1",
        model: "test-model",
      })
    ).toThrow(/turnIntentStatus/);
  });

  it.each([
    { duplicate: false, effectiveTurnIntentId: "intent-1" },
    { duplicate: false, turnIntentStatus: "queued" },
  ])("fails closed when a required receipt identity is missing", (payload) => {
    expect(() =>
      parseRustAgentSendReceipt({
        content: JSON.stringify(payload),
        sessionId: "sdeagent-1",
        model: "test-model",
      })
    ).toThrow(/turnIntentStatus|effectiveTurnIntentId/);
  });
});
