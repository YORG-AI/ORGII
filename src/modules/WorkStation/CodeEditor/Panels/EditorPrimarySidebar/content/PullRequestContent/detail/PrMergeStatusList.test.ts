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

import type { GitHubChecksSummary } from "@src/api/tauri/github";

import { PrMergeStatusList } from "./PrMergeStatusList";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === "string") return fallback;
      if (!fallback) return key;
      const count = fallback.count as number | undefined;
      const template =
        count === 1
          ? (fallback.defaultValue as string)
          : ((fallback.defaultValue_other ?? fallback.defaultValue) as string);
      if (typeof template !== "string") return key;
      return template.replace("{{count}}", String(count ?? ""));
    },
  }),
}));

const openExternalLink = vi.fn();
vi.mock("@src/util/platform/ipcRenderer", () => ({
  openExternalLink: (url: string) => openExternalLink(url),
}));

function checkRun(
  name: string,
  status: string,
  conclusion: string | null
): GitHubChecksSummary["check_runs"][number] {
  return {
    id: name.length * 17,
    name,
    status,
    conclusion,
    started_at: "2026-09-01T10:00:00Z",
    completed_at: conclusion ? "2026-09-01T10:05:00Z" : null,
    details_url: `https://github.com/org/repo/runs/${name}`,
    output_title: null,
    app_name: "GitHub Actions",
  } as GitHubChecksSummary["check_runs"][number];
}

const identity = {
  number: 1280,
  title: "replace pulsing skeletons with static ghost rows",
  url: "https://github.com/org/repo/pull/1280",
  status: "open",
  headBranch: "fix/loading-ghost-rows",
  baseBranch: "develop",
};

describe("PrMergeStatusList", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    openExternalLink.mockClear();
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

  function render(props: {
    checks: GitHubChecksSummary | null;
    detail: Record<string, unknown> | null;
  }): void {
    act(() => {
      root.render(
        createElement(PrMergeStatusList, {
          identity,
          reviews: [],
          ...props,
        })
      );
    });
  }

  it("states the merge verdict and the conditions behind it", () => {
    render({
      checks: {
        sha: "head",
        check_runs: [checkRun("build", "completed", "success")],
        statuses: [],
        state: "success",
      } as GitHubChecksSummary,
      detail: {
        state: "open",
        mergeable: true,
        mergeable_state: "clean",
        review_decision: "APPROVED",
      },
    });

    const headline = container.querySelector<HTMLElement>(
      "[data-testid='pr-merge-status-headline']"
    );
    expect(headline?.textContent).toBe("Able to merge");
    // Tone lives on the headline's icon, not the row text — the row itself
    // shares the same neutral text style as every other row in the list.
    const headlineIcon = headline?.querySelector("[data-icon='git-merge']");
    expect(headlineIcon?.getAttribute("class")).toContain("text-success-6");

    const status = container.querySelector<HTMLElement>(
      "[data-testid='pr-merge-status']"
    );
    expect(status?.textContent).toContain("All checks have passed");
    expect(status?.textContent).toContain("Changes approved");
    expect(status?.textContent).toContain("No conflicts with the base branch");
  });

  it("counts the failing checks and reads them out of the head commit", () => {
    render({
      checks: {
        sha: "head",
        check_runs: [
          checkRun("build", "completed", "success"),
          checkRun("lint", "completed", "failure"),
        ],
        statuses: [],
        state: "failure",
      } as GitHubChecksSummary,
      detail: { state: "open", mergeable: true, mergeable_state: "blocked" },
    });

    const trigger = container.querySelector<HTMLElement>(
      "[data-testid='pr-merge-status-checks']"
    );
    expect(trigger?.textContent).toBe("1 failing check");
    expect(
      container.querySelector("[data-testid='pr-merge-status-headline']")
        ?.textContent
    ).toBe("Merging is blocked");
  });

  it("opens a floating panel listing every check, worst group first", () => {
    render({
      checks: {
        sha: "head",
        check_runs: [
          checkRun("build", "completed", "success"),
          checkRun("lint", "completed", "failure"),
          checkRun("e2e", "in_progress", null),
        ],
        statuses: [],
        state: "failure",
      } as GitHubChecksSummary,
      detail: { state: "open", mergeable: true, mergeable_state: "blocked" },
    });

    expect(
      document.body.querySelector(
        "[data-testid='pr-merge-status-checks-panel']"
      )
    ).toBeNull();

    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid='pr-merge-status-checks']"
    );
    act(() => {
      trigger?.click();
    });

    const panel = document.body.querySelector<HTMLElement>(
      "[data-testid='pr-merge-status-checks-panel']"
    );
    expect(panel).not.toBeNull();
    // The panel is portalled to the document body, not nested in the rail.
    expect(container.contains(panel)).toBe(false);
    const text = panel?.textContent ?? "";
    expect(text).toContain("lint");
    expect(text).toContain("build");
    expect(text).toContain("e2e");
    expect(text.indexOf("Failed")).toBeLessThan(text.indexOf("Passed"));
  });
});
