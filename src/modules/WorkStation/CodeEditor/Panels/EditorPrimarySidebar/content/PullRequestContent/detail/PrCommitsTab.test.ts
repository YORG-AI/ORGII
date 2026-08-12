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
import { copyText } from "@src/util/data/clipboard";

import { PrCommitsTab } from "./PrCommitsTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallbackOrOptions?: string | Record<string, unknown>
    ): string => {
      if (typeof fallbackOrOptions === "string") return fallbackOrOptions;
      const fallback =
        typeof fallbackOrOptions?.defaultValue === "string"
          ? fallbackOrOptions.defaultValue
          : key;
      return fallback.replace(/{{(\w+)}}/g, (_, token: string) =>
        String(fallbackOrOptions?.[token] ?? "")
      );
    },
    i18n: { resolvedLanguage: "en" },
  }),
}));

vi.mock("@src/util/data/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock(
  "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitCommitDetailContent",
  () => ({
    default: ({ commitSha }: { commitSha: string }) =>
      createElement("div", { "data-testid": "commit-detail" }, commitSha),
  })
);

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const SHA = "5272d6c012345678901234567890123456789012";

const commits: Record<string, unknown>[] = [
  {
    sha: SHA,
    author: {
      login: "Neonforge98",
      avatar_url: "https://avatars.example/neonforge98.png",
    },
    commit: {
      message:
        "fix(key-vault): bound Codex autodetect lifecycle\n\nRelease retained listeners when the scan finishes.",
      author: {
        name: "Neon Forge",
        email: "neon@example.com",
        date: "2026-08-06T12:00:00Z",
      },
      committer: {
        name: "Neon Forge",
        email: "neon@example.com",
        date: "2026-08-06T12:00:00Z",
      },
      verification: { verified: true },
    },
  },
];

const checks = {
  sha: SHA,
  state: "success",
  check_runs: [
    {
      id: 1,
      name: "lint",
      status: "completed",
      conclusion: "success",
      details_url: null,
      started_at: null,
      completed_at: null,
      output_title: null,
      app_name: null,
    },
    {
      id: 2,
      name: "test",
      status: "completed",
      conclusion: "success",
      details_url: null,
      started_at: null,
      completed_at: null,
      output_title: null,
      app_name: null,
    },
  ],
  statuses: [],
} satisfies GitHubChecksSummary;

describe("PrCommitsTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T13:00:00Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllMocks();
    vi.useRealTimers();
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderCommits(): void {
    act(() => {
      root.render(
        createElement(PrCommitsTab, {
          commits,
          checks,
          prNumber: 613,
          repoPath: "/repo",
          repoId: "repo-id",
          loading: false,
        })
      );
    });
  }

  it("renders GitHub-style commit blocks with author, status, and message details", () => {
    renderCommits();

    expect(container.textContent).toContain("Commits on Aug 6, 2026");
    expect(container.textContent).toContain(
      "fix(key-vault): bound Codex autodetect lifecycle"
    );
    expect(container.textContent).toContain(
      "Release retained listeners when the scan finishes."
    );
    expect(container.textContent).toContain("Neonforge98");
    expect(container.textContent).toContain("1 hour ago");
    expect(container.textContent).toContain("2 / 2");
    expect(container.textContent).toContain("Verified");
    expect(container.textContent).toContain("5272d6c");

    const card = container.querySelector("article");
    expect(card?.className).toContain("rounded-xl");
    expect(card?.className).toContain("bg-primary-container");
  });

  it("copies the full SHA and opens commit details inline", async () => {
    renderCommits();

    const copyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy commit SHA"]'
    );
    await act(async () => copyButton?.click());
    expect(copyText).toHaveBeenCalledWith(SHA);

    const detailButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="View commit details"]'
    );
    act(() => detailButton?.click());
    expect(
      container.querySelector('[data-testid="commit-detail"]')?.textContent
    ).toBe(SHA);
  });

  it("restores a controlled commit selection after remount", () => {
    act(() => {
      root.render(
        createElement(PrCommitsTab, {
          commits,
          checks,
          selectedCommitSha: SHA,
          onSelectedCommitShaChange: vi.fn(),
          prNumber: 613,
          repoPath: "/repo",
          repoId: "repo-id",
          loading: false,
        })
      );
    });

    expect(
      container.querySelector('[data-testid="commit-detail"]')?.textContent
    ).toBe(SHA);
    expect(container.textContent).toContain("All commits");
  });
});
