import { describe, expect, it } from "vitest";

import { namespaceCopyEventId } from "@src/features/TeamCollaboration/copyEventId";

import { resolveUserMessageSide } from "./userMessageSide";

describe("resolveUserMessageSide", () => {
  const sessionId = "agentsession-local";

  it("keeps messages authored by the local session on the right", () => {
    expect(
      resolveUserMessageSide({ sessionId, id: "user-message-local" })
    ).toBe("right");
  });

  it("puts imported shared-conversation messages on the left", () => {
    expect(
      resolveUserMessageSide({
        sessionId,
        id: namespaceCopyEventId(sessionId, "user-message-remote"),
      })
    ).toBe("left");
  });

  it("keeps a local continuation right of inherited messages in a fork", () => {
    const inherited = {
      sessionId,
      id: namespaceCopyEventId(sessionId, "user-message-inherited"),
    };
    const continuation = { sessionId, id: "user-message-continuation" };

    expect(resolveUserMessageSide(inherited)).toBe("left");
    expect(resolveUserMessageSide(continuation)).toBe("right");
  });
});
