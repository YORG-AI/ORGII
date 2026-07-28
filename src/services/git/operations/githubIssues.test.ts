import { describe, expect, it } from "vitest";

import type { GitHubIssueComment } from "@src/api/tauri/github";

import { issueCommentToTimelineItem } from "./githubIssues";

describe("issueCommentToTimelineItem", () => {
  it("appends newly-created comments in the same shape as fetched timeline items", () => {
    const comment: GitHubIssueComment = {
      id: 5034449241,
      body: "Please work on this",
      user: {
        login: "Harry19081",
        avatar_url: "https://example.com/avatar.png",
      },
      created_at: "2026-07-21T13:09:14Z",
      updated_at: "2026-07-21T13:09:14Z",
      html_url:
        "https://github.com/org2ai/ORG2/issues/459#issuecomment-5034449241",
    };

    expect(issueCommentToTimelineItem(comment)).toEqual({
      id: comment.id,
      event: "commented",
      created_at: comment.created_at,
      actor: comment.user,
      body: comment.body,
      html_url: comment.html_url,
      assignee: null,
      label: null,
      milestone: null,
      rename: null,
      source: null,
      commit_id: null,
      lock_reason: null,
    });
  });
});
