// @vitest-environment jsdom
// The project test glob intentionally uses `.test.ts`; JSX is built with createElement.
import React, { act, createElement } from "react";
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

import GitHubIssueComposer from "../GitHubIssueComposer";
import type { GitHubIssueInteractionConfig } from "../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { login?: string }) =>
      key === "git.issues.composer.commentingAs"
        ? `Commenting as ${options?.login}`
        : key,
  }),
}));

vi.mock("@src/components/Avatar", () => ({
  default: ({ src }: { src?: string }) =>
    createElement("img", { src, alt: "viewer" }),
}));

vi.mock("@src/modules/shared/components/MarkdownTextareaEditor", () => ({
  default: ({
    value,
    onChange,
    editable,
    dataTestId,
    minHeight,
  }: {
    value: string;
    onChange?: (markdown: string) => void;
    editable?: boolean;
    dataTestId?: string;
    minHeight?: number;
  }) =>
    createElement("textarea", {
      value,
      readOnly: !editable,
      "data-testid": dataTestId,
      "data-min-height": minHeight,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        onChange?.(event.target.value),
    }),
}));

function interaction(
  overrides: Partial<GitHubIssueInteractionConfig> = {}
): GitHubIssueInteractionConfig {
  return {
    viewer: {
      login: "viewer",
      avatar_url: "https://example.com/viewer.png",
    },
    issueState: "open",
    duplicateCandidates: [],
    duplicateCandidatesLoaded: false,
    loadingDuplicateCandidates: false,
    duplicateCandidatesError: false,
    loading: false,
    canComment: true,
    canEditBody: true,
    canManageStatus: true,
    submittingComment: false,
    updatingBody: false,
    updatingStatus: false,
    error: null,
    onAddComment: vi.fn(async () => undefined),
    onUpdateBody: vi.fn(async () => undefined),
    onLoadDuplicateCandidates: vi.fn(async () => undefined),
    onStatusChange: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("GitHubIssueComposer", () => {
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

  it("shows the operating GitHub profile and submits the inline draft", async () => {
    const config = interaction();
    act(() => {
      root.render(createElement(GitHubIssueComposer, { interaction: config }));
    });

    expect(container.textContent).toContain("viewer");
    expect(container.textContent).not.toContain("@viewer");
    expect(container.textContent).not.toContain(
      "git.issues.composer.addComment"
    );
    expect(
      container.querySelector<HTMLImageElement>("img[alt='viewer']")?.src
    ).toBe("https://example.com/viewer.png");

    const editor = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='github-issue-comment-editor']"
    );
    expect(editor).not.toBeNull();
    expect(editor?.dataset.minHeight).toBe("100");
    const levelActions = container.querySelector(
      "[data-testid='github-issue-level-actions']"
    );
    const composer = container.querySelector(
      "[data-testid='github-issue-inline-composer']"
    );
    const input = container.querySelector(
      "[data-testid='github-issue-comment-input']"
    );
    expect(levelActions?.nextElementSibling).toBe(input);
    expect(composer?.className).toContain("gap-1.5");
    expect(input?.contains(levelActions as Node)).toBe(false);
    expect(levelActions?.className).not.toContain("border-");
    expect(
      input?.querySelector("[data-testid='github-issue-comment-submit']")
    ).not.toBeNull();
    expect(input?.className).toContain("px-1.5");
    expect(input?.className).toContain("!pt-1.5");
    expect(input?.className).toContain("pb-1.5");
    expect(
      input?.querySelector("[data-testid='github-issue-comment-submit']")
        ?.parentElement?.parentElement?.className
    ).toContain("px-1");
    expect(
      input?.querySelector("[data-testid='github-issue-comment-submit']")
        ?.parentElement?.className
    ).not.toContain("border-t");
    expect(
      levelActions?.querySelector(
        "[data-testid='github-issue-comment-status-action']"
      )
    ).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(editor, "Inline GitHub comment");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submit = container.querySelector<HTMLButtonElement>(
      "[data-testid='github-issue-comment-submit']"
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });

    expect(config.onAddComment).toHaveBeenCalledWith("Inline GitHub comment");
    expect(editor?.value).toBe("");
  });

  it("closes or reopens through the permission-aware status action", async () => {
    const config = interaction();
    act(() => {
      root.render(createElement(GitHubIssueComposer, { interaction: config }));
    });

    const editor = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='github-issue-comment-editor']"
    );
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(editor, "Closing note");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='github-issue-comment-status-action']"
        )
        ?.click();
      await Promise.resolve();
    });
    expect(config.onAddComment).toHaveBeenCalledWith("Closing note");
    expect(config.onStatusChange).toHaveBeenCalledWith("closed", {
      stateReason: "completed",
    });
  });

  it("defers duplicate issue loading until the second-level picker opens", async () => {
    const config = interaction();
    act(() => {
      root.render(createElement(GitHubIssueComposer, { interaction: config }));
    });

    expect(config.onLoadDuplicateCandidates).not.toHaveBeenCalled();
    await act(async () => {
      container
        .querySelectorAll<HTMLButtonElement>(".button-split-wrapper button")[1]
        ?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector("[data-testid='github-issue-close-menu']")
    ).not.toBeNull();
    expect(
      document
        .querySelector("[data-testid='github-issue-status-open']")
        ?.getAttribute("aria-disabled")
    ).toBe("true");
    expect(config.onLoadDuplicateCandidates).not.toHaveBeenCalled();

    await act(async () => {
      document
        .querySelector<HTMLElement>(
          "[data-testid='github-issue-close-duplicate']"
        )
        ?.click();
      await Promise.resolve();
    });
    expect(config.onLoadDuplicateCandidates).toHaveBeenCalledOnce();
    expect(
      document.querySelector("[data-testid='github-issue-duplicate-picker']")
    ).not.toBeNull();
  });

  it("uses an inline spinner while duplicate issues load", async () => {
    const config = interaction({ loadingDuplicateCandidates: true });
    act(() => {
      root.render(createElement(GitHubIssueComposer, { interaction: config }));
    });

    await act(async () => {
      container
        .querySelectorAll<HTMLButtonElement>(".button-split-wrapper button")[1]
        ?.click();
      await Promise.resolve();
    });
    act(() => {
      document
        .querySelector<HTMLElement>(
          "[data-testid='github-issue-close-duplicate']"
        )
        ?.click();
    });

    const loading = document.querySelector(
      "[data-testid='github-issue-duplicate-loading']"
    );
    expect(loading?.querySelector(".animate-spin")).not.toBeNull();
    expect(loading?.textContent).toContain("actions.loading");
    expect(config.onLoadDuplicateCandidates).not.toHaveBeenCalled();
  });

  it("closes as a duplicate with the selected canonical issue database ID", async () => {
    const canonicalIssue = {
      id: 100_987,
      number: 987,
      title: "Canonical issue",
      body: null,
      state: "open" as const,
      state_reason: null,
      html_url: "https://github.com/org2AI/ORG2/issues/987",
      created_at: "2026-08-05T01:00:00.000Z",
      updated_at: "2026-08-05T01:00:00.000Z",
      closed_at: null,
      user: {
        login: "author",
        avatar_url: "https://example.com/author.png",
      },
      labels: [],
      assignees: [],
      comments: 0,
      milestone: null,
    };
    const config = interaction({
      duplicateCandidates: [
        canonicalIssue,
        {
          ...canonicalIssue,
          id: 100_988,
          number: 988,
          title: "Different issue",
          html_url: "https://github.com/org2AI/ORG2/issues/988",
        },
      ],
      duplicateCandidatesLoaded: true,
    });
    act(() => {
      root.render(createElement(GitHubIssueComposer, { interaction: config }));
    });

    await act(async () => {
      container
        .querySelectorAll<HTMLButtonElement>(".button-split-wrapper button")[1]
        ?.click();
      await Promise.resolve();
    });
    act(() => {
      document
        .querySelector<HTMLElement>(
          "[data-testid='github-issue-close-duplicate']"
        )
        ?.click();
    });
    const search = document.querySelector<HTMLInputElement>(
      "[data-testid='github-issue-duplicate-picker'] input[type='search']"
    );
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(search, "987");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      document.querySelector(
        "[data-testid='github-issue-duplicate-candidate-988']"
      )
    ).toBeNull();
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          "[data-testid='github-issue-duplicate-candidate-987']"
        )
        ?.click();
      await Promise.resolve();
    });

    expect(config.onStatusChange).toHaveBeenCalledWith("closed", {
      stateReason: "duplicate",
      duplicateIssueId: 100_987,
    });
  });

  it("does not show the status action without GitHub permission", () => {
    act(() => {
      root.render(
        createElement(GitHubIssueComposer, {
          interaction: interaction({ canManageStatus: false }),
        })
      );
    });

    expect(
      container.querySelector(
        "[data-testid='github-issue-comment-status-action']"
      )
    ).toBeNull();
  });
});
