// @vitest-environment jsdom
//
// The user-visible half of the PR-status fix: a row whose status was never
// resolved must not wear the green "open" badge. `statusKey` is injected
// asynchronously by `useSubmissionsData`, so "absent" covers the in-flight
// frame, a failed GitHub read, and rows with no repoFullName/prNumber to read.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getPrStatusVariant } from "@src/shared/pr/prStatus";

import {
  type PullRequestSubmission,
  SubmissionPullRequestsContent,
} from "../SubmissionsContent";

const NEUTRAL = getPrStatusVariant("unknown");
const OPEN = getPrStatusVariant("open");

function renderRow(
  overrides: Partial<PullRequestSubmission> = {}
): HTMLElement {
  const pullRequest: PullRequestSubmission = {
    key: "pullRequest:acme/repo#42",
    url: "https://github.com/acme/repo/pull/42",
    repoFullName: "acme/repo",
    prNumber: 42,
    prTitle: "Add submissions tab",
    origin: "mentioned",
    ...overrides,
  };
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    createElement(SubmissionPullRequestsContent, {
      pullRequests: [pullRequest],
      emptyLabel: "No pull requests",
    })
  );
  return container;
}

describe("SubmissionPullRequestsContent PR status badge", () => {
  it("renders a neutral badge, not an open one, when status is unresolved", () => {
    const html = renderRow().innerHTML;

    expect(html).toContain(NEUTRAL.badgeClass);
    expect(html).toContain(NEUTRAL.dotClass);
    // The regression: an unread status used to render as green "open".
    expect(html).not.toContain(OPEN.badgeClass);
    expect(html).not.toContain(OPEN.dotClass);
  });

  it("renders the injected status once it resolves", () => {
    const merged = getPrStatusVariant("merged");
    const html = renderRow({ statusKey: "merged" }).innerHTML;

    expect(html).toContain(merged.badgeClass);
    expect(html).not.toContain(NEUTRAL.badgeClass);
  });

  it("still renders a resolved open status as open", () => {
    const html = renderRow({ statusKey: "open" }).innerHTML;

    expect(html).toContain(OPEN.badgeClass);
    expect(html).not.toContain(NEUTRAL.badgeClass);
  });
});
