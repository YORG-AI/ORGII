// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SpotlightShell } from "../../../shell/SpotlightShell";
import type { SpotlightShellChromeProps } from "../../../shell/SpotlightShellChrome";
import { BranchPullRequestPicker } from "../BranchPullRequestPicker";
import { installVirtualListTestLayout } from "./virtualListTestLayout";

const mocks = vi.hoisted(() => ({
  getGitRemotes: vi.fn(),
  getGitCredentialForRemote: vi.fn(),
  listOpenPRsLocal: vi.fn(),
  preparePullRequestBranch: vi.fn(),
}));
vi.mock("@src/api/http/git/remotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/http/git/remotes")>()),
  ...mocks,
}));
vi.mock("@src/api/tauri/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/github")>()),
  ...mocks,
}));
vi.mock("@src/services/git/operations/preparePullRequestBranch", () => mocks);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// Keep the real shell footer portal, controls, rows, and virtualizer.
vi.mock("../../../shell/SpotlightShellChrome", () => ({
  SpotlightShellChrome: ({ children, footer }: SpotlightShellChromeProps) =>
    createElement(
      "div",
      null,
      createElement("div", { "data-test-panel": true }, children),
      createElement("div", { "data-test-hint-pill": true }, footer)
    ),
}));
vi.mock("@src/hooks/dropdown", async () => {
  const { useDropdownListNavigation } =
    await import("@src/hooks/dropdown/useDropdownListNavigation");
  return {
    useDropdownEngine: (options: {
      open: boolean;
      listNavigation: Parameters<typeof useDropdownListNavigation>[0];
    }) => ({
      isPositioned: options.open,
      panelRef: React.useRef(null),
      panelPosition: { top: 20, left: 20, width: 420 },
      keyboard: useDropdownListNavigation({
        ...options.listNavigation,
        isOpen: options.open,
      }),
    }),
  };
});

const storageKey = "orgii-spotlight-show-branch-info";
const checkStatuses = ["success", "failure", "pending", "none", "unavailable"];
let root: Root;
let container: HTMLDivElement;
let restoreLayout: () => void;
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.removeItem(storageKey);
  restoreLayout = installVirtualListTestLayout();
  mocks.getGitRemotes.mockResolvedValue({
    remotes: [{ name: "origin", url: "git@github.com:org/app.git" }],
  });
  mocks.getGitCredentialForRemote.mockResolvedValue(null);
  mocks.listOpenPRsLocal.mockResolvedValue(
    Array.from({ length: 50 }, (_, index) => ({
      number: index + 1,
      state: "open",
      title: `Change ${index + 1}`,
      head_branch: `feature/${index + 1}`,
      base_branch: "main",
      author_login: "alice",
      ci_status: checkStatuses[index % checkStatuses.length],
    }))
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreLayout();
  localStorage.removeItem(storageKey);
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

function toggle() {
  return document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input:not([type="checkbox"])'
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it.each(["spotlight", "dropdown"] as const)(
  "%s shares a default-off, persisted branch info preference without reloading PRs",
  async (presentation) => {
    const onSelect = vi.fn();
    const open = () =>
      act(async () => {
        const picker = createElement(BranchPullRequestPicker, {
          repoId: "repo",
          repoPath: "/repo",
          onSelect,
          onClose: vi.fn(),
          onBranchPrepared: vi.fn(),
          onTabChange: vi.fn(),
          presentation,
        });
        const shellProps = {
          isOpen: true,
          onClose: vi.fn(),
          children: picker,
        };
        root.render(
          createElement(
            Provider,
            { store: createStore() },
            presentation === "spotlight"
              ? createElement(SpotlightShell, shellProps)
              : picker
          )
        );
      });
    await open();
    expect(toggle().checked).toBe(false);
    expect(document.body.textContent).toContain("#1 · alice");
    expect(document.body.textContent).not.toContain("feature/");
    if (presentation === "spotlight") {
      expect(toggle().closest("[data-test-hint-pill]")).not.toBeNull();
      expect(toggle().closest("[data-test-panel]")).toBeNull();
    }
    // Hidden branch names remain searchable across loaded rows.
    await search("feature/50");
    expect(document.body.textContent).toContain("Change 50");
    expect(document.body.textContent).not.toContain("feature/50 → main");
    await act(async () => toggle().click());
    expect(document.body.textContent).toContain(
      "#50 · alice · feature/50 → main"
    );
    expect(localStorage.getItem(storageKey)).toBe("true");
    await act(async () => {
      document
        .querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
        );
    });
    await act(async () => {
      toggle().focus();
      toggle().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(mocks.preparePullRequestBranch).not.toHaveBeenCalled();
    await search("");
    const rows = document.querySelectorAll(
      '[data-spotlight-item-id^="pr:"], [data-testid^="branch-picker-pr-"]'
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(25);
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    await open();
    expect(toggle().checked).toBe(true);
    expect(document.body.textContent).toContain(
      "#1 · alice · feature/1 → main"
    );
    await act(async () => toggle().click());
    expect(document.body.textContent).not.toContain("feature/");
    expect(localStorage.getItem(storageKey)).toBe("false");
  }
);

it.each(["spotlight", "dropdown"] as const)(
  "%s renders check rollups at the right edge without fetching per row",
  async (presentation) => {
    await act(async () =>
      root.render(
        createElement(BranchPullRequestPicker, {
          repoId: "repo",
          repoPath: "/repo",
          onSelect: vi.fn(),
          onClose: vi.fn(),
          onBranchPrepared: vi.fn(),
          onTabChange: vi.fn(),
          presentation,
        })
      )
    );
    const labels = [
      "passedShort",
      "failedShort",
      "runningShort",
      "noneShort",
      "unavailableShort",
    ];
    const glyphs = ["check", "x", null, "minus", "ellipsis"];
    for (const [index, status] of checkStatuses.entries()) {
      const row = document.querySelector(
        presentation === "spotlight"
          ? `[data-spotlight-item-id="pr:${index + 1}"]`
          : `[data-testid="branch-picker-pr-${index + 1}"]`
      )!;
      expect(row).not.toBeNull();
      const indicator = row.querySelector(
        '[data-testid="branch-picker-checks"]'
      )!;
      expect(indicator).not.toBeNull();
      expect(indicator.getAttribute("role")).toBe("img");
      expect(
        indicator.classList.contains(`branch-picker-ci-status-${status}`)
      ).toBe(true);
      expect(indicator.getAttribute("aria-label")).toBe(
        `git.pr.checks.${labels[index]}`
      );
      expect(indicator.textContent).toBe("");
      if (glyphs[index]) {
        expect(indicator.querySelector("svg")?.getAttribute("data-icon")).toBe(
          glyphs[index]
        );
      } else {
        expect(indicator.querySelector(".bg-current")).not.toBeNull();
      }
      if (presentation === "dropdown") {
        expect(row.lastElementChild).toBe(indicator);
      } else {
        expect(
          indicator.parentElement?.previousElementSibling?.textContent
        ).toContain(`Change ${index + 1}`);
      }
    }
    await search("feature/50");
    expect(document.body.textContent).toContain("Change 50");
    expect(
      document.querySelectorAll('[data-testid="branch-picker-checks"]')
    ).toHaveLength(1);
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(1);
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledWith("org/app", 50, {
      page: 1,
      includeMetadata: true,
    });
  }
);
