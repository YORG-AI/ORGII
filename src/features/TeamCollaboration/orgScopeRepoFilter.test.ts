import { describe, expect, it, vi } from "vitest";

import {
  getRepoScopeKeysForOrgFilter,
  repoEligibleForOrgScopedPicker,
  repoMatchesOrgScopes,
  workspaceMatchesRepoFilter,
} from "./orgScopeRepoFilter";

const SCOPES = ["github.com/org2ai/org2"];

describe("getRepoScopeKeysForOrgFilter", () => {
  it("prefers fs_uri over repo_url and returns the peeked keys", () => {
    const peek = vi.fn(() => [
      "github.com/vantanode/org2",
      "github.com/org2ai/org2",
    ]);
    expect(
      getRepoScopeKeysForOrgFilter(
        {
          fs_uri: "/Users/me/org2-fork",
          repo_url: "https://github.com/acme/elsewhere.git",
        },
        peek
      )
    ).toEqual(["github.com/vantanode/org2", "github.com/org2ai/org2"]);
    expect(peek).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledWith("/Users/me/org2-fork");
  });

  it("strips a file:// scheme before peeking", () => {
    const peek = vi.fn(() => ["github.com/org2ai/org2"]);
    getRepoScopeKeysForOrgFilter({ fs_uri: "file:///Users/me/org2" }, peek);
    expect(peek).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledWith("/Users/me/org2");
  });

  it("falls back to a normalized repo_url key without peeking", () => {
    const peek = vi.fn(() => undefined);
    expect(
      getRepoScopeKeysForOrgFilter(
        { repo_url: "https://github.com/org2ai/ORG2.git" },
        peek
      )
    ).toEqual(["github.com/org2ai/org2"]);
    expect(peek).not.toHaveBeenCalled();
  });

  it("returns null for a repo with no fs_uri and no usable repo_url", () => {
    expect(getRepoScopeKeysForOrgFilter({}, () => undefined)).toBeNull();
    expect(
      getRepoScopeKeysForOrgFilter({ repo_url: "   " }, () => undefined)
    ).toBeNull();
  });
});

describe("repoMatchesOrgScopes (strict)", () => {
  it("matches a repo whose remote url is in scope", () => {
    expect(
      repoMatchesOrgScopes(
        { repo_url: "https://github.com/org2ai/ORG2.git" },
        SCOPES
      )
    ).toBe(true);
  });

  it("matches a fork checkout through ANY remote key (upstream)", () => {
    expect(
      repoMatchesOrgScopes({ fs_uri: "/Users/me/org2-fork" }, SCOPES, () => [
        "github.com/vantanode/org2",
        "github.com/org2ai/org2",
      ])
    ).toBe(true);
  });

  it("consults fs_uri and ignores repo_url when both are set", () => {
    expect(
      repoMatchesOrgScopes(
        {
          fs_uri: "/Users/me/elsewhere",
          repo_url: "https://github.com/org2ai/ORG2.git",
        },
        SCOPES,
        () => ["github.com/acme/elsewhere"]
      )
    ).toBe(false);
  });

  it("rejects out-of-scope, unresolved, and remote-less repos", () => {
    expect(
      repoMatchesOrgScopes(
        { repo_url: "https://github.com/acme/elsewhere.git" },
        SCOPES
      )
    ).toBe(false);
    const prime = vi.fn();
    expect(
      repoMatchesOrgScopes(
        { fs_uri: "/Users/me/org2" },
        SCOPES,
        () => undefined,
        prime
      )
    ).toBe(false);
    expect(prime).toHaveBeenCalledWith("/Users/me/org2");
    expect(repoMatchesOrgScopes({ fs_uri: "/x" }, SCOPES, () => null)).toBe(
      false
    );
    expect(repoMatchesOrgScopes({ fs_uri: "/x" }, SCOPES, () => [])).toBe(
      false
    );
  });

  it("primes an unresolved file:// checkout with the stripped path", () => {
    const peek = vi.fn(() => undefined);
    const prime = vi.fn();
    expect(
      repoMatchesOrgScopes(
        { fs_uri: "file:///Users/me/org2" },
        SCOPES,
        peek,
        prime
      )
    ).toBe(false);
    expect(peek).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledWith("/Users/me/org2");
    expect(prime).toHaveBeenCalledTimes(1);
    expect(prime).toHaveBeenCalledWith("/Users/me/org2");
  });

  it("rejects without peeking or priming when scopes are missing or empty", () => {
    const peek = vi.fn(() => ["github.com/org2ai/org2"]);
    const prime = vi.fn();
    expect(
      repoMatchesOrgScopes({ fs_uri: "/Users/me/org2" }, undefined, peek, prime)
    ).toBe(false);
    expect(
      repoMatchesOrgScopes({ fs_uri: "/Users/me/org2" }, [], peek, prime)
    ).toBe(false);
    expect(peek).not.toHaveBeenCalled();
    expect(prime).not.toHaveBeenCalled();
  });
});

describe("repoEligibleForOrgScopedPicker (optimistic)", () => {
  it("keeps a still-resolving checkout visible and primes it", () => {
    const prime = vi.fn();
    expect(
      repoEligibleForOrgScopedPicker(
        { fs_uri: "/Users/me/org2" },
        SCOPES,
        () => undefined,
        prime
      )
    ).toBe(true);
    expect(prime).toHaveBeenCalledWith("/Users/me/org2");
  });

  it("hides a resolved out-of-scope or remote-less checkout", () => {
    expect(
      repoEligibleForOrgScopedPicker(
        { fs_uri: "/Users/me/other" },
        SCOPES,
        () => ["github.com/acme/elsewhere"]
      )
    ).toBe(false);
    expect(
      repoEligibleForOrgScopedPicker({ fs_uri: "/x" }, SCOPES, () => null)
    ).toBe(false);
    expect(
      repoEligibleForOrgScopedPicker({ fs_uri: "/x" }, SCOPES, () => [])
    ).toBe(false);
  });

  it("matches through any remote key like the strict variant", () => {
    expect(
      repoEligibleForOrgScopedPicker(
        { fs_uri: "/Users/me/org2-fork" },
        SCOPES,
        () => ["github.com/vantanode/org2", "github.com/org2ai/org2"]
      )
    ).toBe(true);
  });

  it("rejects without peeking or priming when scopes are missing or empty", () => {
    const peek = vi.fn(() => undefined);
    const prime = vi.fn();
    expect(
      repoEligibleForOrgScopedPicker(
        { repo_url: "https://github.com/org2ai/ORG2" },
        [],
        peek,
        prime
      )
    ).toBe(false);
    expect(
      repoEligibleForOrgScopedPicker(
        { fs_uri: "/Users/me/org2" },
        undefined,
        peek,
        prime
      )
    ).toBe(false);
    expect(peek).not.toHaveBeenCalled();
    expect(prime).not.toHaveBeenCalled();
  });
});

describe("workspaceMatchesRepoFilter", () => {
  const inScope = (repo: { fs_uri?: string | null }) =>
    repo.fs_uri === "/Users/me/org2";

  it("matches when ANY member folder satisfies the predicate", () => {
    expect(
      workspaceMatchesRepoFilter(["/Users/me/other", "/Users/me/org2"], inScope)
    ).toBe(true);
  });

  it("rejects when no member folder matches", () => {
    expect(
      workspaceMatchesRepoFilter(["/Users/me/other", "/Users/me/x"], inScope)
    ).toBe(false);
  });

  it("tolerates null and undefined folder entries", () => {
    expect(
      workspaceMatchesRepoFilter([null, undefined, "/Users/me/org2"], inScope)
    ).toBe(true);
    expect(workspaceMatchesRepoFilter([null, undefined], inScope)).toBe(false);
  });

  it("rejects an empty workspace without invoking the predicate", () => {
    const predicate = vi.fn(() => true);
    expect(workspaceMatchesRepoFilter([], predicate)).toBe(false);
    expect(predicate).not.toHaveBeenCalled();
  });
});
