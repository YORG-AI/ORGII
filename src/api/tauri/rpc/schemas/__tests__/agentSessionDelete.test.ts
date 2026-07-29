import { describe, expect, it } from "vitest";

import { DeleteSessionReceiptSchema } from "../agentSession";

describe("DeleteSessionReceiptSchema", () => {
  it("parses every deleted Rust session ID", () => {
    expect(
      DeleteSessionReceiptSchema.parse({
        deletedSessionIds: ["worker", "root"],
      })
    ).toEqual({
      deletedSessionIds: ["worker", "root"],
    });
  });

  it("rejects the legacy void response", () => {
    expect(DeleteSessionReceiptSchema.safeParse(undefined).success).toBe(false);
  });
});
