import { describe, expect, it, vi } from "vitest";

import {
  focusJourneyMessage,
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
    const stop = listenForJourneyMessageJump((jump) => {
      received = jump.messageId;
    });
    requestJourneyMessageJump("session-exact", "message-exact-42");
    stop();
    addEventListener.mockRestore();
    dispatchEvent.mockRestore();
    expect(received).toBe("message-exact-42");
  });

  it("registers a listener that scrolls and highlights the exact rendered message", () => {
    const target = {
      dataset: { journeyMessageId: "checkpoint-message-42" } as DOMStringMap,
      scrollIntoView: vi.fn(),
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      querySelectorAll: () => [target],
    });
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    let listener: ((event: Event) => void) | undefined;
    const addEventListener = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((_type, callback) => {
        listener = callback as (event: Event) => void;
      });

    const stop = listenForJourneyMessageJump((jump) => {
      focusJourneyMessage(jump.messageId);
    });
    listener?.({
      detail: {
        sessionId: "session-exact",
        messageId: "checkpoint-message-42",
      },
    } as CustomEvent<{ sessionId: string; messageId: string }>);
    stop();

    expect(target.dataset.journeyHighlight).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth",
    });
    addEventListener.mockRestore();
    vi.unstubAllGlobals();
  });
});
