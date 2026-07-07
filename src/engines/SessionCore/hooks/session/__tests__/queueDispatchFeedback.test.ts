import { describe, expect, it } from "vitest";

import { releaseForceSendInterruptSlot } from "../queueDispatchFeedback";

describe("releaseForceSendInterruptSlot", () => {
  it("removes the message id so Send Now can retry", () => {
    const requested = new Set(["msg-1", "msg-2"]);
    releaseForceSendInterruptSlot("msg-1", requested);
    expect(requested.has("msg-1")).toBe(false);
    expect(requested.has("msg-2")).toBe(true);
  });

  it("no-ops when the id was not tracked", () => {
    const requested = new Set<string>();
    releaseForceSendInterruptSlot("missing", requested);
    expect(requested.size).toBe(0);
  });
});
