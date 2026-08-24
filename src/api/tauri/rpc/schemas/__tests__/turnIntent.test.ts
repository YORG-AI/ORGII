import { describe, expect, it } from "vitest";

import {
  TurnIntentStatusInputSchema,
  TurnIntentStatusReceiptSchema,
} from "../turnIntent";

describe("turn-intent RPC schemas", () => {
  it("accepts an origin lookup and backend-selected effective identity", () => {
    expect(
      TurnIntentStatusInputSchema.parse({
        sessionId: "sdeagent-1",
        turnIntentId: "intent-x",
      })
    ).toEqual({ sessionId: "sdeagent-1", turnIntentId: "intent-x" });
    expect(
      TurnIntentStatusReceiptSchema.parse({
        status: "queued",
        effectiveTurnIntentId: "wir-y",
      })
    ).toEqual({ status: "queued", effectiveTurnIntentId: "wir-y" });
  });

  it("fails closed for unknown status or empty identity", () => {
    expect(() =>
      TurnIntentStatusReceiptSchema.parse({
        status: "maybe-running",
        effectiveTurnIntentId: "wir-y",
      })
    ).toThrow();
    expect(() =>
      TurnIntentStatusInputSchema.parse({ sessionId: "", turnIntentId: "" })
    ).toThrow();
  });
});
