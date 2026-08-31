// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBranchPullRequests } from "../useBranchPullRequests";

const mocks = vi.hoisted(() => ({
  getGitRemotes: vi.fn(),
  getGitCredentialForRemote: vi.fn(),
  listOpenPRsLocal: vi.fn(),
}));
vi.mock("@src/api/http/git/remotes", () => mocks);
vi.mock("@src/api/tauri/github", () => mocks);

let root: Root;
let container: HTMLDivElement;
let value: ReturnType<typeof useBranchPullRequests>;
let visibility: DocumentVisibilityState;
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const pr = {
  number: 42,
  title: "Fix picker",
  head_branch: "feature",
  base_branch: "main",
  author_login: "author",
  ci_status: "success",
};
function Probe({ repoId = "repo" }: { repoId?: string }) {
  const result = useBranchPullRequests(repoId, `/repos/${repoId}`);
  useEffect(() => {
    value = result;
  }, [result]);
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  mocks.getGitRemotes.mockResolvedValue({
    remotes: [{ name: "origin", url: "git@github.com:org/app.git" }],
  });
  mocks.getGitCredentialForRemote.mockResolvedValue({
    connection_id: "account-a",
    source: "git",
    username: "alice",
  });
  mocks.listOpenPRsLocal.mockResolvedValue([pr]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

describe("useBranchPullRequests lifecycle", () => {
  it("only loads open PRs, bounds retained rows, and does not poll", async () => {
    mocks.listOpenPRsLocal.mockResolvedValue(
      Array.from({ length: 120 }, (_, index) => ({ ...pr, number: index + 1 }))
    );
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledWith("org/app", 50, {
      page: 1,
      includeMetadata: true,
    });
    expect(value.prs).toHaveLength(50);
    expect(value.loading).toBe(false);
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(1);
  });
  it("shares in-flight PR requests between consumers and releases on settle", async () => {
    const pending = deferred<unknown[]>();
    mocks.listOpenPRsLocal.mockReturnValueOnce(pending.promise);
    await act(async () =>
      root.render(
        createElement("div", null, createElement(Probe), createElement(Probe))
      )
    );
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve([pr]));
    expect(value.prs).toEqual([pr]);
    await act(async () => value.refresh());
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(2);
  });
  it("does not call GitHub for another hosting provider", async () => {
    mocks.getGitRemotes.mockResolvedValue({
      remotes: [{ name: "origin", url: "git@gitlab.com:org/app.git" }],
    });
    await act(async () => root.render(createElement(Probe)));
    expect(value.repoFullName).toBeNull();
    expect(value.error).toBeNull();
    expect(mocks.listOpenPRsLocal).not.toHaveBeenCalled();
  });
  it("uses a GitHub upstream when origin is not GitHub", async () => {
    mocks.getGitRemotes.mockResolvedValue({
      remotes: [
        { name: "origin", url: "git@gitlab.com:org/app.git" },
        { name: "upstream", url: "https://github.com/org/app.git" },
      ],
    });
    await act(async () => root.render(createElement(Probe)));
    expect(value.remote).toBe("upstream");
  });
  it("surfaces failures and allows a retry instead of showing a false empty list", async () => {
    mocks.listOpenPRsLocal.mockRejectedValueOnce(
      new Error("GitHub re-authorization required")
    );
    await act(async () => root.render(createElement(Probe)));
    expect(value.error).toBe("GitHub re-authorization required");
    await act(async () => value.refresh());
    expect(value.error).toBeNull();
    expect(value.prs).toEqual([pr]);
  });
  it("starts no requests while hidden and revalidates once on return", async () => {
    visibility = "hidden";
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.getGitRemotes).not.toHaveBeenCalled();
    visibility = "visible";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(1);
    expect(value.prs).toEqual([pr]);
    visibility = "hidden";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(value.prs).toEqual([]);
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(1);
  });
  it("rejects late data after a repo switch", async () => {
    const pending = deferred<unknown[]>();
    mocks.listOpenPRsLocal.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe)));
    mocks.getGitRemotes.mockResolvedValue({
      remotes: [{ name: "origin", url: "git@github.com:org/other.git" }],
    });
    mocks.listOpenPRsLocal.mockResolvedValue([{ ...pr, number: 99 }]);
    await act(async () =>
      root.render(createElement(Probe, { repoId: "other" }))
    );
    await act(async () => pending.resolve([pr]));
    expect(value.repoFullName).toBe("org/other");
    expect(value.prs.map((item) => item.number)).toEqual([99]);
  });
  it("discards responses from a previous identity and reloads", async () => {
    mocks.getGitCredentialForRemote
      .mockResolvedValueOnce({ connection_id: "old" })
      .mockResolvedValue({ connection_id: "new" });
    mocks.listOpenPRsLocal
      .mockResolvedValueOnce([pr])
      .mockResolvedValue([{ ...pr, number: 99 }]);
    await act(async () => root.render(createElement(Probe)));
    expect(value.prs.map((item) => item.number)).toEqual([99]);
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(2);
  });
  it("removes listeners and ignores completion after unmount", async () => {
    const pending = deferred<unknown[]>();
    mocks.listOpenPRsLocal.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => root.render(null));
    await act(async () => pending.resolve([pr]));
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(1);
    expect(value.prs).toEqual([]);
  });

  it("loads more only on demand, serializes repeated requests, and deduplicates shifted pages", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => ({
      ...pr,
      number: i + 1,
    }));
    const pending = deferred<unknown[]>();
    mocks.listOpenPRsLocal
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe)));
    expect(value.hasMore).toBe(true);
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(1);
    await act(async () => {
      void value.loadMore();
      void value.loadMore();
    });
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(2);
    expect(value.prs).toHaveLength(50);
    expect(value.loadingMore).toBe(true);
    await act(async () =>
      pending.resolve([
        { ...pr, number: 50 },
        { ...pr, number: 51 },
      ])
    );
    expect(value.prs).toHaveLength(51);
    expect(value.hasMore).toBe(false);
    expect(value.loadingMore).toBe(false);
    expect(mocks.listOpenPRsLocal).toHaveBeenLastCalledWith("org/app", 50, {
      page: 2,
      includeMetadata: true,
    });
  });

  it("caps retained data at 500 and stops requesting after 10 pages", async () => {
    mocks.listOpenPRsLocal.mockImplementation((_repo, _size, { page }) =>
      Promise.resolve(
        Array.from({ length: 50 }, (_, i) => ({
          ...pr,
          number: (page - 1) * 50 + i + 1,
        }))
      )
    );
    await act(async () => root.render(createElement(Probe)));
    for (let i = 0; i < 12; i++) await act(async () => value.loadMore());
    expect(value.prs).toHaveLength(500);
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(10);
    expect(value.hasMore).toBe(false);
    expect(value.limitReached).toBe(true);
  });

  it("bounds requests even when every page overlaps", async () => {
    mocks.listOpenPRsLocal.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({ ...pr, number: i + 1 }))
    );
    await act(async () => root.render(createElement(Probe)));
    for (let i = 0; i < 12; i++) await act(async () => value.loadMore());
    expect(value.prs).toHaveLength(50);
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(10);
    expect(value.limitReached).toBe(true);
  });

  it("preserves loaded rows after a page error and retries the same page explicitly", async () => {
    mocks.listOpenPRsLocal
      .mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, i) => ({ ...pr, number: i + 1 }))
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([{ ...pr, number: 51 }]);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => value.loadMore());
    expect(value.loadMoreError).toBe("offline");
    expect(value.error).toBeNull();
    expect(value.prs).toHaveLength(50);
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(2);
    await act(async () => value.loadMore());
    expect(value.prs).toHaveLength(51);
    expect(value.loadMoreError).toBeNull();
    expect(mocks.listOpenPRsLocal).toHaveBeenLastCalledWith("org/app", 50, {
      page: 2,
      includeMetadata: true,
    });
  });

  it("rejects an old page after refresh and detects identity changes between pages", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => ({
      ...pr,
      number: i + 1,
    }));
    const pending = deferred<unknown[]>();
    mocks.listOpenPRsLocal
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(firstPage);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      void value.loadMore();
    });
    await act(async () => value.refresh());
    await act(async () => pending.resolve([{ ...pr, number: 99 }]));
    expect(value.prs.map((item) => item.number)).not.toContain(99);
    mocks.getGitCredentialForRemote.mockResolvedValue({
      connection_id: "new-account",
    });
    mocks.listOpenPRsLocal.mockResolvedValue([{ ...pr, number: 101 }]);
    await act(async () => value.loadMore());
    expect(value.prs.map((item) => item.number)).toEqual([101]);
    expect(mocks.listOpenPRsLocal).toHaveBeenLastCalledWith("org/app", 50, {
      page: 1,
      includeMetadata: true,
    });
  });
});
