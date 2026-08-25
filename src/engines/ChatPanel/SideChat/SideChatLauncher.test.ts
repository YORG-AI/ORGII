import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SideChatLauncher, dispatchSideChatMessage } from ".";

const dispatchTurnSpy = vi.hoisted(() => vi.fn());

vi.mock("@src/engines/SessionCore/services/TurnDispatchService", () => ({
  dispatchTurn: dispatchTurnSpy,
}));

beforeEach(() => {
  dispatchTurnSpy.mockReset().mockResolvedValue(undefined);
});

describe("SideChatLauncher", () => {
  it("renders an accessible floating dialog trigger", () => {
    const markup = renderToStaticMarkup(
      createElement(SideChatLauncher, {
        label: "Side Chat",
        onOpen: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="side-chat-floating-button"');
    expect(markup).toContain('aria-label="Side Chat"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("bottom-4");
    expect(markup).toContain("right-4");
  });
});

describe("dispatchSideChatMessage", () => {
  it("routes an ordinary submit through canonical dispatch", async () => {
    await expect(
      dispatchSideChatMessage("sdeagent-side", {
        displayText: "visible [skill:/review]",
        agentContent: "expanded prompt",
        imageDataUrls: ["data:image/png;base64,abc"],
      })
    ).resolves.toBe(true);

    expect(dispatchTurnSpy).toHaveBeenCalledWith({
      sessionId: "sdeagent-side",
      content: "expanded prompt",
      displayText: "visible [skill:/review]",
      imageDataUrls: ["data:image/png;base64,abc"],
      turnIntentSource: "user_submit",
      directUserIntent: true,
    });
  });

  it("does not reserve an empty submit", async () => {
    await expect(
      dispatchSideChatMessage("sdeagent-side", { displayText: "   " })
    ).resolves.toBe(false);
    expect(dispatchTurnSpy).not.toHaveBeenCalled();
  });

  it("returns false when canonical transport rejects", async () => {
    dispatchTurnSpy.mockRejectedValueOnce(new Error("offline"));

    await expect(
      dispatchSideChatMessage("sdeagent-side", { displayText: "hello" })
    ).resolves.toBe(false);
    expect(dispatchTurnSpy).toHaveBeenCalledTimes(1);
  });
});
