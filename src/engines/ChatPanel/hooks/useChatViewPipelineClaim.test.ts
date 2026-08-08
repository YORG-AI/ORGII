import { describe, expect, it } from "vitest";

import { shouldReleaseSecondaryPipeline } from "./useChatViewPipelineClaim";

describe("shouldReleaseSecondaryPipeline", () => {
  it("does not let stale secondary cleanup release the active primary session", () => {
    expect(
      shouldReleaseSecondaryPipeline({
        activePrimarySessionId: "session-A",
        currentPipelineSessionId: "session-A",
        secondarySessionId: "session-A",
      })
    ).toBe(false);
  });

  it("releases a secondary-owned pipeline when no primary tab owns it", () => {
    expect(
      shouldReleaseSecondaryPipeline({
        activePrimarySessionId: null,
        currentPipelineSessionId: "session-A",
        secondarySessionId: "session-A",
      })
    ).toBe(true);
  });

  it("does not release a pipeline that another session already claimed", () => {
    expect(
      shouldReleaseSecondaryPipeline({
        activePrimarySessionId: "session-B",
        currentPipelineSessionId: "session-B",
        secondarySessionId: "session-A",
      })
    ).toBe(false);
  });
});
