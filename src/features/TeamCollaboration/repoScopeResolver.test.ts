import { beforeEach, describe, expect, it, vi } from "vitest";

import { getGitRemotes } from "@src/api/http/git/remotes";
import { resolveGitHubRepoNetworkIdentityLocal } from "@src/api/tauri/github";

import {
  clearShareableScopeKeyCache,
  peekMatchingOrgRepoScope,
  peekShareableScopeKey,
  resolveLocalCheckoutForScopeKey,
  resolveMatchingOrgRepoScope,
  resolveShareableScopeKey,
  resolveShareableScopeKeys,
  subscribeShareableScopeKeys,
} from "./repoScopeResolver";

vi.mock("@src/api/http/git/remotes", () => ({
  getGitRemotes: vi.fn(),
}));
vi.mock("@src/api/tauri/github", () => ({
  resolveGitHubRepoNetworkIdentityLocal: vi.fn(),
}));

const remotesMock = vi.mocked(getGitRemotes);
const networkIdentityMock = vi.mocked(resolveGitHubRepoNetworkIdentityLocal);

beforeEach(() => {
  networkIdentityMock.mockRejectedValue(new Error("not configured"));
  clearShareableScopeKeyCache();
});

function remoteEntry(name: string, url: string) {
  return { name, url, fetch_url: url, push_url: url };
}

describe("resolveShareableScopeKey (git-remote-only sharing, design §8.3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearShareableScopeKeyCache();
  });

  it("resolves a local path to the normalized origin remote key", async () => {
    remotesMock.mockResolvedValue({
      remotes: [
        remoteEntry("upstream", "git@github.com:upstream/alpha.git"),
        remoteEntry("origin", "git@github.com:acme/alpha.git"),
      ],
    });
    // origin wins over other remotes: fork ≠ upstream — the checkout's own
    // remote is its identity.
    await expect(resolveShareableScopeKey("/repo/alpha")).resolves.toBe(
      "github.com/acme/alpha"
    );
    expect(remotesMock).toHaveBeenCalledWith({
      repo_id: "/repo/alpha",
      repo_path: "/repo/alpha",
    });
  });

  it("returns null for a repo with NO remote — the not-shareable signal", async () => {
    remotesMock.mockResolvedValue({ remotes: [] });
    await expect(resolveShareableScopeKey("/repo/local-only")).resolves.toBe(
      null
    );
    // A confirmed no-remote result IS cached (peek sees it synchronously).
    expect(peekShareableScopeKey("/repo/local-only")).toBe(null);
    expect(remotesMock).toHaveBeenCalledTimes(1);
    await resolveShareableScopeKey("/repo/local-only");
    expect(remotesMock).toHaveBeenCalledTimes(1);
  });

  it("passes remote-style inputs through, normalized, without any IPC", async () => {
    await expect(
      resolveShareableScopeKey("git@github.com:acme/alpha.git")
    ).resolves.toBe("github.com/acme/alpha");
    expect(peekShareableScopeKey("https://github.com/acme/alpha")).toBe(
      "github.com/acme/alpha"
    );
    expect(remotesMock).not.toHaveBeenCalled();
  });

  it("does NOT cache a transport failure — the next call retries and heals", async () => {
    // getGitRemotes swallows transport errors and reports undefined; a repo
    // must never be permanently marked unshareable by a hiccup (e.g. the
    // git server still booting at app start).
    remotesMock.mockResolvedValueOnce(undefined);
    await expect(resolveShareableScopeKey("/repo/alpha")).resolves.toBe(null);
    expect(peekShareableScopeKey("/repo/alpha")).toBeUndefined();

    remotesMock.mockResolvedValue({
      remotes: [remoteEntry("origin", "git@github.com:acme/alpha.git")],
    });
    await expect(resolveShareableScopeKey("/repo/alpha")).resolves.toBe(
      "github.com/acme/alpha"
    );
    expect(peekShareableScopeKey("/repo/alpha")).toBe("github.com/acme/alpha");
  });

  it("dedupes concurrent lookups for one path and notifies subscribers once", async () => {
    let resolveRemotes!: (value: {
      remotes: ReturnType<typeof remoteEntry>[];
    }) => void;
    remotesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRemotes = resolve;
        })
    );
    const notifications: Array<[string, string[] | null]> = [];
    const unsubscribe = subscribeShareableScopeKeys((path, keys) =>
      notifications.push([path, keys])
    );

    const first = resolveShareableScopeKey("/repo/alpha");
    const second = resolveShareableScopeKey("/repo/alpha");
    expect(peekShareableScopeKey("/repo/alpha")).toBeUndefined();
    // Flush the deferred lookup body — exactly ONE IPC call fires for the
    // two concurrent callers.
    await Promise.resolve();
    await Promise.resolve();
    expect(remotesMock).toHaveBeenCalledTimes(1);

    resolveRemotes({
      remotes: [remoteEntry("origin", "git@github.com:acme/alpha.git")],
    });
    await expect(first).resolves.toBe("github.com/acme/alpha");
    await expect(second).resolves.toBe("github.com/acme/alpha");
    expect(notifications).toEqual([["/repo/alpha", ["github.com/acme/alpha"]]]);
    unsubscribe();
  });

  it("uses the first remote when no origin exists (same remote = same source)", async () => {
    remotesMock.mockResolvedValue({
      remotes: [remoteEntry("fork", "https://github.com/me/alpha.git")],
    });
    await expect(resolveShareableScopeKey("/repo/alpha")).resolves.toBe(
      "github.com/me/alpha"
    );
  });

  it("returns ALL remote keys origin-first, deduped (fork + upstream)", async () => {
    remotesMock.mockResolvedValue({
      remotes: [
        remoteEntry("upstream", "https://github.com/team/alpha.git"),
        remoteEntry("origin", "git@github.com:me/alpha.git"),
        // Same URL as upstream in another form — must dedupe.
        remoteEntry("mirror", "git@github.com:team/alpha.git"),
      ],
    });
    await expect(resolveShareableScopeKeys("/repo/alpha")).resolves.toEqual([
      "github.com/me/alpha",
      "github.com/team/alpha",
    ]);
    // Single-key view stays the primary (origin) identity.
    expect(peekShareableScopeKey("/repo/alpha")).toBe("github.com/me/alpha");
  });
});

describe("resolveLocalCheckoutForScopeKey (fork relay: scope key → local path)", () => {
  // Injected resolver keeps these tests IPC-free and deterministic.
  const resolverFor =
    (byPath: Record<string, string[] | null>) =>
    async (path: string): Promise<string[] | null> =>
      byPath[path] ?? null;

  it("returns the first candidate whose remote resolves to the scope key", async () => {
    const resolve = resolverFor({
      "/repo/other": ["github.com/acme/other"],
      "/repo/alpha": ["github.com/acme/alpha"],
      "/repo/alpha-clone": ["github.com/acme/alpha"],
    });
    await expect(
      resolveLocalCheckoutForScopeKey(
        // Any remote FORM must match — both sides normalize.
        "git@github.com:acme/alpha.git",
        ["/repo/other", "/repo/alpha", "/repo/alpha-clone"],
        resolve
      )
    ).resolves.toBe("/repo/alpha");
  });

  it("matches through a NON-primary remote (fork checkout, upstream key)", async () => {
    // The teammate pushed the TEAM repo's key; our checkout's primary
    // identity is a personal fork but its upstream still identifies it.
    const resolve = resolverFor({
      "/repo/fork": ["github.com/me/alpha", "github.com/team/alpha"],
    });
    await expect(
      resolveLocalCheckoutForScopeKey(
        "github.com/team/alpha",
        ["/repo/fork"],
        resolve
      )
    ).resolves.toBe("/repo/fork");
  });

  it("matches differently named GitHub forks through their common source", async () => {
    networkIdentityMock.mockImplementation(async (fullName) => ({
      full_name: fullName,
      source_full_name: "yorgai/ORG2",
    }));
    const resolve = resolverFor({
      "C:\\Repos\\ORGII": ["github.com/yorgai/org2"],
    });

    await expect(
      resolveLocalCheckoutForScopeKey(
        "github.com/vantanode/org2",
        ["C:\\Repos\\ORGII"],
        resolve
      )
    ).resolves.toBe("C:\\Repos\\ORGII");
    expect(networkIdentityMock).toHaveBeenCalledWith("yorgai/org2");
    expect(networkIdentityMock).toHaveBeenCalledWith("vantanode/org2");
  });

  it("returns null when no local checkout matches (fork opens without a workspace)", async () => {
    await expect(
      resolveLocalCheckoutForScopeKey(
        "github.com/acme/alpha",
        ["/repo/other"],
        resolverFor({ "/repo/other": ["github.com/acme/other"] })
      )
    ).resolves.toBeNull();
  });

  it("returns null for a missing/empty/local-path scope key (nothing to match by)", async () => {
    const resolve = resolverFor({});
    await expect(
      resolveLocalCheckoutForScopeKey(undefined, ["/repo/a"], resolve)
    ).resolves.toBeNull();
    await expect(
      resolveLocalCheckoutForScopeKey(null, ["/repo/a"], resolve)
    ).resolves.toBeNull();
    // A local PATH is not a shareable identity — never treated as a key.
    await expect(
      resolveLocalCheckoutForScopeKey(
        "/owner/machine/repo",
        ["/repo/a"],
        resolve
      )
    ).resolves.toBeNull();
  });

  it("skips non-local-path candidates and dedupes repeats (one probe per path)", async () => {
    const probed: string[] = [];
    const resolve = async (path: string): Promise<string[] | null> => {
      probed.push(path);
      return path === "/repo/alpha" ? ["github.com/acme/alpha"] : null;
    };
    await expect(
      resolveLocalCheckoutForScopeKey(
        "github.com/acme/alpha",
        ["github.com/acme/alpha", "", "/repo/x", "/repo/x", "/repo/alpha"],
        resolve
      )
    ).resolves.toBe("/repo/alpha");
    expect(probed).toEqual(["/repo/x", "/repo/alpha"]);
  });

  it("a throwing candidate never hides a later match", async () => {
    const resolve = async (path: string): Promise<string[] | null> => {
      if (path === "/repo/broken") throw new Error("transport down");
      return path === "/repo/alpha" ? ["github.com/acme/alpha"] : null;
    };
    await expect(
      resolveLocalCheckoutForScopeKey(
        "github.com/acme/alpha",
        ["/repo/broken", "/repo/alpha"],
        resolve
      )
    ).resolves.toBe("/repo/alpha");
  });
});

describe("GitHub fork-network org scope matching", () => {
  it("returns the original wire scope after canonical upstreams match", async () => {
    networkIdentityMock.mockImplementation(async (fullName) => ({
      full_name: fullName,
      source_full_name: "yorgai/ORG2",
    }));

    await expect(
      resolveMatchingOrgRepoScope(
        ["github.com/yorgai/org2"],
        ["github.com/vantanode/org2"]
      )
    ).resolves.toBe("github.com/vantanode/org2");
    expect(
      peekMatchingOrgRepoScope(
        ["github.com/yorgai/org2"],
        ["github.com/vantanode/org2"]
      )
    ).toBe("github.com/vantanode/org2");
  });

  it("does not merge repositories from different fork networks", async () => {
    networkIdentityMock.mockImplementation(async (fullName) => ({
      full_name: fullName,
      source_full_name: fullName,
    }));
    await expect(
      resolveMatchingOrgRepoScope(
        ["github.com/acme/one"],
        ["github.com/acme/two"]
      )
    ).resolves.toBeNull();
  });
});
