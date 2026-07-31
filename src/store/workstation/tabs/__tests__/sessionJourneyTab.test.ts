import { describe, expect, it } from "vitest";

import { createSessionJourneyTab } from "../factories/project";

describe("createSessionJourneyTab", () => {
  it("creates a session-journey tab keyed by session id", () => {
    const tab = createSessionJourneyTab({ sessionId: "session-42" });

    expect(tab.type).toBe("session-journey");
    expect(tab.id).toBe("session-journey:session-42");
    expect(tab.icon).toBe("GitFork");
    expect(tab.title).toBe("Session Journey");
    expect(tab.data).toMatchObject({ sessionId: "session-42" });
  });

  it("uses the session name in the title when provided", () => {
    const tab = createSessionJourneyTab({
      sessionId: "session-42",
      sessionName: "Fix sidebar overflow",
    });

    expect(tab.title).toBe("Fix sidebar overflow Journey");
  });

  it("is idempotent for the same session (keyed strategy)", () => {
    const a = createSessionJourneyTab({ sessionId: "session-42" });
    const b = createSessionJourneyTab({ sessionId: "session-42" });

    expect(a.id).toBe(b.id);
  });

  it("produces distinct ids for distinct sessions", () => {
    const a = createSessionJourneyTab({ sessionId: "session-1" });
    const b = createSessionJourneyTab({ sessionId: "session-2" });

    expect(a.id).not.toBe(b.id);
  });
});
