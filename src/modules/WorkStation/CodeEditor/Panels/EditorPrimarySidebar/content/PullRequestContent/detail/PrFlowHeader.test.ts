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

import type { PrFile } from "@src/api/tauri/github";

import { PrFlowHeader } from "./PrFlowHeader";

const clipboard = vi.hoisted(() => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === "string") return fallback;
      if (typeof fallback?.defaultValue !== "string") return key;
      const count = Number(fallback.count ?? 0);
      const template =
        count === 1 || typeof fallback.defaultValue_other !== "string"
          ? fallback.defaultValue
          : fallback.defaultValue_other;
      return template.replace("{{count}}", String(count));
    },
  }),
}));

vi.mock("@src/util/data/clipboard", () => ({
  copyText: clipboard.copyText,
}));

vi.mock("@src/components/Message", () => ({
  default: toast,
}));

describe("PrFlowHeader", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    clipboard.copyText.mockClear();
    toast.success.mockClear();
    toast.error.mockClear();
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

  const openIdentity = {
    number: 7,
    title: "Refine the flow header",
    url: "https://github.com/org/repo/pull/7",
    status: "open",
    headBranch: "feature/flow-header",
    baseBranch: "develop",
  };

  it("renders the GitHub-flow sentence for an open PR with singular commits", () => {
    act(() => {
      root.render(
        createElement(PrFlowHeader, {
          identity: openIdentity,
          detail: {
            commits: 1,
            additions: 12,
            deletions: 3,
            user: { login: "author", avatar_url: "https://a.example/a.png" },
          },
          baseBranch: "develop",
          commitCount: 0,
          files: [],
        })
      );
    });

    const title = container.querySelector("[data-testid='pr-flow-title']");
    expect(title?.textContent).toContain("Refine the flow header");
    expect(title?.textContent).toContain("#7");
    const status = container.querySelector("[data-testid='pr-flow-status']");
    expect(status?.textContent).toContain("open");
    expect(status?.firstElementChild?.className).toContain("bg-success-1");
    const subline = container.querySelector("[data-testid='pr-flow-subline']");
    expect(subline?.textContent).toContain("author");
    expect(subline?.textContent).toContain("wants to merge 1 commit into");
    expect(subline?.textContent).not.toContain("commits into");
    expect(subline?.textContent).toContain("develop");
    expect(subline?.textContent).toContain("from");
    expect(subline?.textContent).toContain("feature/flow-header");
    expect(subline?.textContent).toContain("+12");
    expect(subline?.textContent).toContain("-3");
  });

  it("credits the merger on merged PRs and falls back to file diff stats", () => {
    act(() => {
      root.render(
        createElement(PrFlowHeader, {
          identity: { ...openIdentity, status: "merged" },
          detail: {
            user: { login: "author", avatar_url: "" },
            merged_by: { login: "merger", avatar_url: "" },
          },
          baseBranch: "develop",
          commitCount: 4,
          files: [
            { filename: "a.ts", additions: 5, deletions: 2 },
            { filename: "b.ts", additions: 1, deletions: 0 },
          ] as unknown as PrFile[],
        })
      );
    });

    const subline = container.querySelector("[data-testid='pr-flow-subline']");
    expect(subline?.textContent).toContain("merger");
    expect(subline?.textContent).toContain("merged 4 commits into");
    expect(subline?.textContent).not.toContain("wants to merge");
    expect(subline?.textContent).toContain("+6");
    expect(subline?.textContent).toContain("-2");
  });

  it("copies the head branch name from the flow subline", async () => {
    act(() => {
      root.render(
        createElement(PrFlowHeader, {
          identity: openIdentity,
          detail: null,
          baseBranch: "develop",
          commitCount: 2,
          files: [],
        })
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='pr-flow-copy-branch']")
        ?.click();
      await Promise.resolve();
    });

    expect(clipboard.copyText).toHaveBeenCalledWith("feature/flow-header");
    expect(toast.success).toHaveBeenCalledWith("Branch name copied");
  });
});
