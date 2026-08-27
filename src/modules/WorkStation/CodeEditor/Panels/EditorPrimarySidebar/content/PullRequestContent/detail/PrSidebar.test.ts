// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { GitHubPrReview } from "@src/api/tauri/github";

import { PrSidebar } from "./PrSidebar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === "string") return fallback;
      if (typeof fallback?.defaultValue !== "string") return key;
      return fallback.defaultValue;
    },
  }),
}));

function review(
  login: string,
  state: string,
  submittedAt: string
): GitHubPrReview {
  return {
    id: Math.abs(login.length * 1000 + submittedAt.length),
    user: { login, avatar_url: `https://a.example/${login}.png` },
    body: "",
    state,
    submitted_at: submittedAt,
    commit_id: null,
    html_url: "",
  };
}

const baseProps = {
  identity: {
    number: 7,
    title: "Sidebar operations",
    url: "https://github.com/org/repo/pull/7",
    status: "open",
    headBranch: "feature/sidebar",
    baseBranch: "develop",
  },
  checks: null,
  disabled: false,
  pending: false,
  reviewerCandidates: [],
  loadingReviewerCandidates: false,
  reviewerCandidatesError: null,
  onLoadReviewerCandidates: vi.fn().mockResolvedValue(undefined),
  onMerge: vi.fn().mockResolvedValue(undefined),
  onSetAutoMerge: vi.fn().mockResolvedValue(undefined),
  onDraftChange: vi.fn().mockResolvedValue(undefined),
  onStateChange: vi.fn().mockResolvedValue(undefined),
  onRequestedReviewersChange: vi.fn().mockResolvedValue(undefined),
  assigneeCandidates: [],
  onAssigneesChange: vi.fn().mockResolvedValue(undefined),
  labelCandidates: [],
  loadingLabelCandidates: false,
  labelCandidatesError: null,
  onLoadLabelCandidates: vi.fn().mockResolvedValue(undefined),
  onLabelsChange: vi.fn().mockResolvedValue(undefined),
};

describe("PrSidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("rolls reviewer rows up to their latest decisive state", () => {
    act(() => {
      root.render(
        createElement(PrSidebar, {
          ...baseProps,
          detail: {
            state: "open",
            requested_reviewers: [
              { login: "alice", avatar_url: "https://a.example/alice.png" },
            ],
            assignees: [
              { login: "bob", avatar_url: "https://a.example/bob.png" },
            ],
            labels: [{ name: "bug", color: "d73a4a" }],
          },
          reviews: [
            review("carol", "APPROVED", "2026-08-01T10:00:00Z"),
            review("dave", "CHANGES_REQUESTED", "2026-08-01T11:00:00Z"),
            // A later comment-only review must not clear the change request.
            review("dave", "COMMENTED", "2026-08-02T09:00:00Z"),
            // Alice reviewed earlier but was re-requested — awaiting wins.
            review("alice", "APPROVED", "2026-07-30T08:00:00Z"),
          ],
        })
      );
    });

    // The sidebar sits on the shared Workstation trail surface with the
    // trail section formatting, matching the Work Item properties rail.
    const surface = container.querySelector<HTMLElement>(
      "[data-testid='pr-sidebar']"
    );
    expect(surface?.className).toContain("rounded-xl");
    expect(surface?.className).toContain("border-border-1");
    // Exact trail-surface shadow, so it reads the same as the Work Item rail.
    expect(surface?.className).toContain("shadow-dropdown");
    // No panel title above the sections, and no collapse control — the rail is
    // permanent and opens straight into Reviewers.
    expect(surface?.textContent).not.toContain("Details");
    expect(
      surface?.querySelector("[data-testid='pr-sidebar-collapse']")
    ).toBeNull();
    // The reviewer trigger reuses the trail icon button, exactly like the
    // trail's own collapse control.
    const reviewerTrigger = surface?.querySelector(
      "[data-testid='pr-reviewer-action']"
    );
    expect(reviewerTrigger?.className).toContain("h-[26px]");
    expect(reviewerTrigger?.className).toContain("w-[26px]");
    expect(reviewerTrigger?.className).toContain("rounded-lg");
    const reviewers = container.querySelector(
      "[data-testid='pr-sidebar-reviewers']"
    );
    const reviewersLabel = reviewers?.querySelector("h3");
    expect(reviewersLabel?.className).toContain("uppercase");
    expect(reviewersLabel?.className).toContain("text-[11px]");
    const rows = Array.from(reviewers?.querySelectorAll("li") ?? []);
    const rowByLogin = new Map(
      rows.map((row) => [row.textContent?.trim(), row])
    );
    expect([...rowByLogin.keys()].sort()).toEqual(["alice", "carol", "dave"]);
    expect(
      rowByLogin.get("carol")?.querySelector(".lucide-check")
    ).not.toBeNull();
    expect(
      rowByLogin.get("dave")?.querySelector(".lucide-circle-x")
    ).not.toBeNull();
    expect(
      rowByLogin.get("alice")?.querySelector(".bg-warning-6")
    ).not.toBeNull();

    expect(
      reviewers?.querySelector("[data-testid='pr-reviewer-action']")
    ).not.toBeNull();
    // Assignees and labels are editable on an open PR, not just displayed.
    expect(
      container.querySelector(
        "[data-testid='pr-sidebar-assignees'] [data-testid='pr-assignee-action']"
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        "[data-testid='pr-sidebar-labels'] [data-testid='pr-label-action']"
      )
    ).not.toBeNull();

    const assignees = container.querySelector(
      "[data-testid='pr-sidebar-assignees']"
    );
    expect(assignees?.textContent).toContain("bob");

    const labels = container.querySelector("[data-testid='pr-sidebar-labels']");
    expect(labels?.textContent).toContain("bug");
    const dot = labels?.querySelector<HTMLElement>("span[style]");
    expect(dot?.style.backgroundColor).toBe("rgb(215, 58, 74)");

    expect(
      container.querySelector("[data-testid='pr-level-actions']")
    ).not.toBeNull();
  });

  it("keeps every picker available on a draft pull request", () => {
    act(() => {
      root.render(
        createElement(PrSidebar, {
          ...baseProps,
          identity: { ...baseProps.identity, status: "draft" },
          // A draft is still open on GitHub, which accepts all three edits.
          detail: { state: "open", draft: true },
          reviews: [],
        })
      );
    });

    expect(
      container.querySelector("[data-testid='pr-reviewer-action']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='pr-assignee-action']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='pr-label-action']")
    ).not.toBeNull();
  });

  it("hides the reviewer picker when the PR is not open and shows empty states", () => {
    act(() => {
      root.render(
        createElement(PrSidebar, {
          ...baseProps,
          identity: { ...baseProps.identity, status: "merged" },
          detail: { state: "closed", merged: true },
          reviews: [],
        })
      );
    });

    // Every picker disappears once the PR is no longer open.
    expect(
      container.querySelector("[data-testid='pr-reviewer-action']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='pr-assignee-action']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='pr-label-action']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='pr-sidebar-reviewers']")
        ?.textContent
    ).toContain("No reviews");
    expect(
      container.querySelector("[data-testid='pr-sidebar-assignees']")
        ?.textContent
    ).toContain("No one assigned");
    expect(
      container.querySelector("[data-testid='pr-sidebar-labels']")?.textContent
    ).toContain("None yet");
  });
});
