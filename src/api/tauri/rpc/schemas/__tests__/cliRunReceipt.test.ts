import { describe, expect, it } from "vitest";

import { CliRunReceiptSchema } from "../cli";

describe("CliRunReceiptSchema", () => {
  it("preserves the origin and effective turn identities", () => {
    expect(
      CliRunReceiptSchema.parse({
        sessionId: "cliagent-1",
        turnIntentId: "intent-x",
        effectiveTurnIntentId: "wir-y",
        status: "queued",
        duplicate: true,
      })
    ).toEqual({
      sessionId: "cliagent-1",
      turnIntentId: "intent-x",
      effectiveTurnIntentId: "wir-y",
      status: "queued",
      duplicate: true,
    });
  });

  it("rejects an unrecognized lifecycle status", () => {
    expect(() =>
      CliRunReceiptSchema.parse({
        sessionId: "cliagent-1",
        turnIntentId: "intent-x",
        effectiveTurnIntentId: "intent-x",
        status: "maybe-running",
        duplicate: false,
      })
    ).toThrow();
  });
});
