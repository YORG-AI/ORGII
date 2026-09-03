import { describe, expect, it } from "vitest";

import {
  SubmissionOutcomeUnknownError,
  shouldRestoreSubmissionAfterDispatchError,
} from "../submissionErrors";

describe("submission dispatch error restoration", () => {
  it("keeps a cleared composer when a durable Group outcome is unknown", () => {
    expect(
      shouldRestoreSubmissionAfterDispatchError(
        new SubmissionOutcomeUnknownError("response lost after commit")
      )
    ).toBe(false);
  });

  it("restores the submission for known zero-write failures", () => {
    expect(
      shouldRestoreSubmissionAfterDispatchError(
        new Error("group target limit exceeded")
      )
    ).toBe(true);
  });
});
