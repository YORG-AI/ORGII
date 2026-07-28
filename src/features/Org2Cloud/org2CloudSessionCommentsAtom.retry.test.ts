import { describe, expect, it } from "vitest";

import {
  SESSION_COMMENTS_ERROR_RETRY_MAX_MS,
  SESSION_COMMENTS_ERROR_RETRY_MS,
  decideSessionCommentsFetch,
  sessionCommentsErrorRetryDelayMs,
} from "./org2CloudSessionCommentsAtom.commentTransforms";
import type { CloudSessionCommentsEntry } from "./org2CloudSessionCommentsAtom.types";

function errorEntry(
  consecutiveFailures: number,
  fetchedAt: number
): CloudSessionCommentsEntry {
  return {
    comments: [],
    viewerOwnsSession: false,
    state: "error",
    consecutiveFailures,
    fetchedAt,
  };
}

describe("session comments error retry backoff", () => {
  it("doubles the delay per consecutive failure up to the cap", () => {
    expect(sessionCommentsErrorRetryDelayMs(1)).toBe(
      SESSION_COMMENTS_ERROR_RETRY_MS
    );
    expect(sessionCommentsErrorRetryDelayMs(2)).toBe(
      SESSION_COMMENTS_ERROR_RETRY_MS * 2
    );
    expect(sessionCommentsErrorRetryDelayMs(4)).toBe(
      SESSION_COMMENTS_ERROR_RETRY_MS * 8
    );
    expect(sessionCommentsErrorRetryDelayMs(20)).toBe(
      SESSION_COMMENTS_ERROR_RETRY_MAX_MS
    );
  });

  it("keeps a repeatedly failing entry unclaimable until its widened window", () => {
    const now = 1_000_000_000;
    const failures = 4;
    const entry = errorEntry(failures, now);
    const window = sessionCommentsErrorRetryDelayMs(failures);

    expect(decideSessionCommentsFetch(entry, false, now + window)).toBe("skip");
    expect(decideSessionCommentsFetch(entry, false, now + window + 1)).toBe(
      "claim"
    );
  });

  it("still claims a first-failure entry after the base window", () => {
    const now = 1_000_000_000;
    const entry = errorEntry(1, now);

    expect(
      decideSessionCommentsFetch(
        entry,
        false,
        now + SESSION_COMMENTS_ERROR_RETRY_MS + 1
      )
    ).toBe("claim");
  });
});
