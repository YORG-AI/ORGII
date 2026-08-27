import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BranchPrSnapshot } from "@src/store/git";
import type { Session } from "@src/store/session";

import { buildSessionMenuItem } from "../menuItemBuilders";

const BASE_SESSION = {
  session_id: "s1",
  status: "completed",
  created_at: "2026-07-30T00:00:00Z",
  updated_at: "2026-07-30T00:00:00Z",
  name: "Session",
} satisfies Session;

function buildItem(
  session: Partial<Session>,
  visited = ["s1"],
  options: { showBranchTag?: boolean; pr?: BranchPrSnapshot } = {}
) {
  return buildSessionMenuItem({
    session: { ...BASE_SESSION, ...session },
    untitledSession: "Untitled",
    visitedSessions: new Set(visited),
    ...options,
  });
}

function markup(node: unknown): string {
  return renderToStaticMarkup(node as ReactElement);
}

describe("buildSessionMenuItem trailing accessories", () => {
  it("renders only the status dot when the session reports no branch", () => {
    const html = markup(buildItem({}).trailingElement);
    expect(html).toContain("rounded-full");
    expect(html).not.toContain("aria-label");
  });

  it.each([
    ["branch", { branch: "main" }],
    ["worktree branch", { worktreeBranch: "agent/feature-x" }],
  ])("does not render a %s tag", (_label, session) => {
    const html = markup(buildItem(session).trailingElement);
    expect(html).toContain("rounded-full");
    expect(html).not.toContain("aria-label");
  });

  it("does not render a PR tag when the preference is disabled", () => {
    const html = markup(
      buildItem({ branch: "main" }, ["s1"], {
        pr: {
          status: "open",
          number: 1,
          url: "https://github.com/o/r/pull/1",
          title: "Add thing",
        },
      }).trailingElement
    );

    expect(html).toContain("rounded-full");
    expect(html).not.toContain("Open PR");
  });

  it("does not leave a trailing branch tag on a working row", () => {
    const item = buildItem(
      { status: "running", worktreeBranch: "agent/feature-x" },
      []
    );
    expect(item.trailingElement).toBeUndefined();
    expect(markup(item.workingIndicator)).toContain('aria-label="Working"');
  });

  it("puts the enabled git indicator before the status dot", () => {
    const html = markup(
      buildItem({ branch: "main" }, ["s1"], {
        showBranchTag: true,
        pr: {
          status: "open",
          number: 1,
          url: "https://github.com/o/r/pull/1",
          title: "Add thing",
        },
      }).trailingElement
    );

    const gitIndex = html.indexOf('aria-label="Open PR #1: main"');
    const dotIndex = html.indexOf("rounded-full");
    expect(gitIndex).toBeGreaterThanOrEqual(0);
    expect(dotIndex).toBeGreaterThanOrEqual(0);
    expect(gitIndex).toBeLessThan(dotIndex);
  });

  it("shows no enabled marker for a branch with no pull request", () => {
    const html = markup(
      buildItem({ branch: "main" }, ["s1"], { showBranchTag: true })
        .trailingElement
    );
    expect(html).toContain("rounded-full");
    expect(html).not.toContain("aria-label");
  });

  it("shows no enabled marker once a worktree has merged or conflicted", () => {
    for (const mergeStatus of ["merged", "conflict"] as const) {
      const html = markup(
        buildItem({ worktreeBranch: "agent/feature-x", mergeStatus }, ["s1"], {
          showBranchTag: true,
        }).trailingElement
      );
      expect(html).not.toContain("aria-label");
    }
  });

  it("keeps the enabled git indicator on a working row", () => {
    const item = buildItem(
      { status: "running", worktreeBranch: "agent/feature-x" },
      [],
      { showBranchTag: true }
    );
    expect(markup(item.trailingElement)).toContain(
      'aria-label="Worktree branch: feature-x"'
    );
    expect(markup(item.workingIndicator)).toContain('aria-label="Working"');
  });
});

describe("buildSessionMenuItem enabled PR state", () => {
  function prMarkup(status: string): string {
    return markup(
      buildItem({ branch: "feature-x" }, ["s1"], {
        showBranchTag: true,
        pr: {
          status,
          number: 42,
          url: "https://github.com/o/r/pull/42",
          title: "Add thing",
        },
      }).trailingElement
    );
  }

  it.each([
    ["open", "Open PR #42: feature-x", "--color-success-6"],
    ["draft", "Draft PR #42: feature-x", "--color-text-3"],
    ["merged", "Merged PR #42: feature-x", "--color-purple-6"],
    ["closed", "Closed PR #42: feature-x", "--color-danger-6"],
  ])("renders %s with its own icon color", (status, label, color) => {
    const html = prMarkup(status);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(color);
  });

  it("shows no marker for an unrecognized state on a plain branch", () => {
    expect(prMarkup("pending_review")).not.toContain("aria-label");
  });

  it("still marks an in-flight worktree whose PR state is unrecognized", () => {
    const html = markup(
      buildItem({ worktreeBranch: "agent/feature-x" }, ["s1"], {
        showBranchTag: true,
        pr: {
          status: "pending_review",
          number: 5,
          url: "https://github.com/o/r/pull/5",
          title: "Add thing",
        },
      }).trailingElement
    );
    expect(html).toContain('aria-label="Worktree branch: feature-x"');
    expect(html).toContain("--color-success-6");
  });

  it("matches on the raw ref, so an agent worktree branch still labels short", () => {
    const html = markup(
      buildItem({ worktreeBranch: "agent/feature-x" }, ["s1"], {
        showBranchTag: true,
        pr: {
          status: "merged",
          number: 7,
          url: "https://github.com/o/r/pull/7",
          title: "Add thing",
        },
      }).trailingElement
    );
    expect(html).toContain('aria-label="Merged PR #7: feature-x"');
  });
});
