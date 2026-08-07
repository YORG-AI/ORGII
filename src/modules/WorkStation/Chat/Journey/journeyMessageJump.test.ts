import { describe, expect, it, vi } from "vitest";

import {
  listenForJourneyMessageJump,
  requestJourneyMessageJump,
} from "./journeyMessageJump";

describe("Journey exact message jump", () => {
  it("forwards the durable checkpoint message ID without a sequence fallback", () => {
    let received: string | null = null;
    let listener: ((event: Event) => void) | undefined;
    const addEventListener = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((_type, callback) => {
        listener = callback as (event: Event) => void;
      });
    const dispatchEvent = vi
      .spyOn(window, "dispatchEvent")
      .mockImplementation((event) => {
        listener?.(event);
        return true;
      });
    const stop = listenForJourneyMessageJump((messageId) => {
      received = messageId;
    });
    requestJourneyMessageJump("message-exact-42");
    stop();
    addEventListener.mockRestore();
    dispatchEvent.mockRestore();
    expect(received).toBe("message-exact-42");
  });
});
