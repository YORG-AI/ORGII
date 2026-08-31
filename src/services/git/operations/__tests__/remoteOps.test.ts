// @vitest-environment jsdom
/**
 * Unit tests for the git remote operations (push / pull / fetch / publish /
 * sync) and their error-dialog variants.
 *
 * These operate on the user's real repository, so the assertions target the
 * request actually constructed — the exact payload handed to the Rust git
 * API — plus the value returned. In
 * particular, every destructive flag (`force`, `set_upstream`, `prune`) is
 * asserted to be absent unless the caller explicitly asked for it.
 *
 * Only the true I/O edges are mocked: the git HTTP API, the Tauri credential
 * lookup, the two native dialogs, and the terminal. `./types` is left real, so
 * `parseGitError`'s stderr-to-domain-error translation is genuinely exercised
 * through each operation's return value.
 *
 * `remoteOps` reads a module-level repo-context singleton that has no reset
 * path, so each test loads the module graph fresh via `loadRemoteOps`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitPullStrategy } from "@src/store/ui/editorSettingsAtom";
import type { UseGitOutputIntegrationReturn } from "@src/types/workstation/gitOutputIntegration";

import type { GitOperationResult } from "../types";

const gitPush = vi.fn();
const gitPull = vi.fn();
const gitFetch = vi.fn();
const getGitRemotes = vi.fn();
const fillGitCredentials = vi.fn();
const getGitHubGitCredentialForRemote = vi.fn();
const showGitAuthenticationDialog = vi.fn();
const showGitErrorAndHandle = vi.fn();
const execute = vi.fn();

vi.mock("@src/api/http/git", () => ({
  gitApi: {
    gitPush: (...args: unknown[]) => gitPush(...args),
    gitPull: (...args: unknown[]) => gitPull(...args),
    gitFetch: (...args: unknown[]) => gitFetch(...args),
    getGitRemotes: (...args: unknown[]) => getGitRemotes(...args),
    fillGitCredentials: (...args: unknown[]) => fillGitCredentials(...args),
  },
}));
vi.mock("@src/api/tauri/github", () => ({
  getGitHubGitCredentialForRemote: (...args: unknown[]) =>
    getGitHubGitCredentialForRemote(...args),
}));
vi.mock("@src/util/dialogs/gitAuthenticationDialog", () => ({
  showGitAuthenticationDialog: (...args: unknown[]) =>
    showGitAuthenticationDialog(...args),
}));
vi.mock("@src/hooks/git/useGitErrorDialog", () => ({
  showGitErrorAndHandle: (...args: unknown[]) => showGitErrorAndHandle(...args),
}));
vi.mock("@src/services/terminal", () => ({
  TerminalService: { execute: (...args: unknown[]) => execute(...args) },
}));

const REPO = { repoId: "repo-1", repoPath: "/tmp/repo" } as const;

const ORIGIN_URL = "https://github.com/acme/repo.git";
const UPSTREAM_URL = "https://github.com/upstream/repo.git";

function remotes(
  list: Array<{
    name: string;
    url?: string;
    fetch_url?: string;
    push_url?: string;
  }>
) {
  return { remotes: list };
}

function makeIntegration(
  overrides: Partial<UseGitOutputIntegrationReturn>
): UseGitOutputIntegrationReturn {
  return overrides as unknown as UseGitOutputIntegrationReturn;
}

/**
 * Load `remoteOps` against a fresh module graph, then seed the repo context,
 * the output integration, and the pull-strategy setting on the fresh store.
 */
async function loadRemoteOps(
  options: {
    repo?: { repoId: string; repoPath: string } | null;
    integration?: Partial<UseGitOutputIntegrationReturn> | null;
    /** `null` removes the setting entirely, exposing the code's own fallback. */
    pullStrategy?: GitPullStrategy | null;
  } = {}
) {
  vi.resetModules();

  const [remoteOps, types, storeModule, outputModule, settingsModule] =
    await Promise.all([
      import("../remoteOps"),
      import("../types"),
      import("@src/util/core/state/instrumentedStore"),
      import("@src/store/workstation/codeEditor/outputIntegration"),
      import("@src/store/settings/settingsAtom"),
    ]);

  const store = storeModule.createInstrumentedStore();

  if (options.integration) {
    store.set(
      outputModule.gitOutputIntegrationAtom,
      makeIntegration(options.integration)
    );
  }
  if (options.pullStrategy !== undefined) {
    const settings = { ...store.get(settingsModule.settingsAtom) };
    if (options.pullStrategy === null) {
      delete (settings as Record<string, unknown>)["git.pullStrategy"];
    } else {
      settings["git.pullStrategy"] = options.pullStrategy;
    }
    store.set(settingsModule.settingsAtom, settings);
  }
  if (options.repo) {
    types.setRepoContext(options.repo.repoId, options.repo.repoPath);
  }

  return remoteOps;
}

/** Let `deferErrorDialog`'s setTimeout(0) run. */
const flushMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

function structuredError(message: string, errorType: string): Error {
  return Object.assign(new Error(message), { errorType });
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue(undefined);
  gitPush.mockResolvedValue({ success: true });
  gitPull.mockResolvedValue({ success: true });
  gitFetch.mockResolvedValue({ success: true });
  getGitRemotes.mockResolvedValue(remotes([]));
  getGitHubGitCredentialForRemote.mockResolvedValue(null);
  showGitAuthenticationDialog.mockResolvedValue(null);
  fillGitCredentials.mockResolvedValue(null);
});

// ============================================
// No repository context
// ============================================

describe("no repository context — loud failure, nothing executed", () => {
  // These operations used to fall back to typing the git command into the
  // user's visible terminal (whatever cwd it was in) and reported success
  // the moment Enter was delivered. Without a repo context there is nowhere
  // trustworthy to run git, so the operation must fail loudly instead.
  const NO_REPO_FAILURE = {
    success: false,
    errorType: "unknown",
    message: expect.stringContaining("No repository is selected"),
  };

  it("fails a push and never touches the terminal", async () => {
    const remoteOps = await loadRemoteOps();

    await expect(remoteOps.push({ force: true })).resolves.toEqual(
      NO_REPO_FAILURE
    );
    expect(execute).not.toHaveBeenCalled();
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("fails a publish instead of silently dropping --set-upstream", async () => {
    const remoteOps = await loadRemoteOps();

    await expect(remoteOps.publish()).resolves.toEqual(NO_REPO_FAILURE);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails a pull for every strategy", async () => {
    const remoteOps = await loadRemoteOps();

    for (const strategy of ["merge", "rebase", "ff-only"] as const) {
      await expect(remoteOps.pull({ strategy })).resolves.toEqual(
        NO_REPO_FAILURE
      );
    }
    expect(execute).not.toHaveBeenCalled();
    expect(gitPull).not.toHaveBeenCalled();
  });

  it("fails a fetch", async () => {
    const remoteOps = await loadRemoteOps();

    await expect(remoteOps.fetch({ prune: true })).resolves.toEqual(
      NO_REPO_FAILURE
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails a sync at its first step", async () => {
    const remoteOps = await loadRemoteOps();

    await expect(remoteOps.sync()).resolves.toEqual(NO_REPO_FAILURE);
    expect(execute).not.toHaveBeenCalled();
    expect(gitPull).not.toHaveBeenCalled();
    expect(gitPush).not.toHaveBeenCalled();
  });
});

// ============================================
// Pull strategy resolution
// ============================================

describe("pull strategy resolution — the strategy sent to the git API", () => {
  async function pulledStrategy(
    options: Parameters<typeof loadRemoteOps>[0] = {},
    callArg?: { strategy?: GitPullStrategy }
  ) {
    const remoteOps = await loadRemoteOps({ repo: REPO, ...options });
    await remoteOps.pull(callArg);
    return gitPull.mock.calls[0][0].strategy;
  }

  it("uses the shipped default strategy (rebase) when the caller passes none", async () => {
    expect(await pulledStrategy()).toBe("rebase");
  });

  it("falls back to the registry default when the setting is absent", async () => {
    // Regression: this used to fall back to a literal "merge", so an
    // unhydrated settings atom pulled with a different strategy at startup
    // than the shipped default ("rebase").
    expect(await pulledStrategy({ pullStrategy: null })).toBe("rebase");
  });

  it("reads the user's configured pull strategy when the caller passes none", async () => {
    expect(await pulledStrategy({ pullStrategy: "merge" })).toBe("merge");
  });

  it("lets an explicit strategy override the configured one", async () => {
    expect(
      await pulledStrategy({ pullStrategy: "rebase" }, { strategy: "ff-only" })
    ).toBe("ff-only");
  });
});

// ============================================
// Rust API path — exact payloads
// ============================================

describe("rust api path — the payload built for each operation", () => {
  it("sends no destructive flags for a plain push", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });

    await expect(remoteOps.push()).resolves.toEqual({
      success: true,
      errorType: "none",
    });

    expect(gitPush).toHaveBeenCalledTimes(1);
    const payload = gitPush.mock.calls[0][0];
    expect(payload).toEqual({ repo_id: "repo-1", repo_path: "/tmp/repo" });
    expect(payload.force).toBeUndefined();
    expect(payload.set_upstream).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards every push option under its wire name", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });

    await remoteOps.push({
      remote: "upstream",
      branch: "feature",
      force: true,
      setUpstream: true,
    });

    expect(gitPush.mock.calls[0][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: "upstream",
      branch: "feature",
      force: true,
      set_upstream: true,
    });
  });

  it("publishes with set_upstream and without force", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });

    await expect(remoteOps.publish()).resolves.toEqual({
      success: true,
      errorType: "none",
    });

    const payload = gitPush.mock.calls[0][0];
    expect(payload.set_upstream).toBe(true);
    expect(payload.force).toBeUndefined();
  });

  it("does not leak showErrorDialog into the wire payload", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });

    await remoteOps.push({ showErrorDialog: true });

    expect(gitPush.mock.calls[0][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
    });
  });

  it("sends the resolved pull strategy", async () => {
    const remoteOps = await loadRemoteOps({
      repo: REPO,
      pullStrategy: "ff-only",
    });

    await remoteOps.pull({ remote: "origin", branch: "main" });

    expect(gitPull.mock.calls[0][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: "origin",
      branch: "main",
      strategy: "ff-only",
    });
  });

  it("sends prune only when requested", async () => {
    const withPrune = await loadRemoteOps({ repo: REPO });
    await withPrune.fetch({ remote: "origin", prune: true });
    expect(gitFetch.mock.calls[0][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: "origin",
      prune: true,
    });

    gitFetch.mockClear();
    const withoutPrune = await loadRemoteOps({ repo: REPO });
    await withoutPrune.fetch();
    const payload = gitFetch.mock.calls[0][0];
    expect(payload).toEqual({ repo_id: "repo-1", repo_path: "/tmp/repo" });
    expect(payload.prune).toBeUndefined();
  });
});

// ============================================
// Error translation
// ============================================

describe("error translation from git stderr", () => {
  async function pushError(error: unknown): Promise<GitOperationResult> {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitPush.mockRejectedValueOnce(error);
    return remoteOps.push();
  }

  it("classifies a non-fast-forward rejection from the structured error type", async () => {
    const result = await pushError(
      structuredError("Updates were rejected", "non_fast_forward")
    );

    expect(result).toEqual({
      success: false,
      errorType: "non_fast_forward",
      message: "Updates were rejected",
    });
  });

  it("classifies a protected-branch rejection from the structured error type", async () => {
    const result = await pushError(
      structuredError("protected branch hook declined", "protected_branch")
    );

    expect(result.errorType).toBe("protected_branch");
  });

  it("classifies a network failure from the stderr text", async () => {
    const result = await pushError(
      new Error("fatal: unable to access: Connection timed out")
    );

    expect(result).toEqual({
      success: false,
      errorType: "network_error",
      message: "fatal: unable to access: Connection timed out",
    });
  });

  it("classifies unknown stderr as unknown and preserves the message verbatim", async () => {
    const result = await pushError(new Error("fatal: the remote end hung up"));

    expect(result).toEqual({
      success: false,
      errorType: "unknown",
      message: "fatal: the remote end hung up",
    });
  });

  it("stringifies a non-Error rejection rather than dropping it", async () => {
    const result = await pushError("git exited with code 128");

    expect(result).toEqual({
      success: false,
      errorType: "unknown",
      message: "git exited with code 128",
    });
  });

  it("classifies a dirty working tree on pull as uncommitted changes", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitPull.mockRejectedValueOnce(
      new Error(
        "error: Your local changes to the following files would be overwritten by merge"
      )
    );

    await expect(remoteOps.pull({ strategy: "merge" })).resolves.toMatchObject({
      success: false,
      errorType: "uncommitted_changes",
    });
  });

  it("classifies a conflicted pull as merge conflicts", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitPull.mockRejectedValueOnce(
      new Error("CONFLICT (content): Merge conflict in src/app.ts")
    );

    await expect(remoteOps.pull({ strategy: "merge" })).resolves.toMatchObject({
      success: false,
      errorType: "merge_conflicts",
    });
  });

  it("translates a fetch failure through the same classifier", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitFetch.mockRejectedValueOnce(new Error("fatal: not a git repository"));

    await expect(remoteOps.fetch()).resolves.toEqual({
      success: false,
      errorType: "unknown",
      message: "fatal: not a git repository",
    });
  });
});

// ============================================
// Credential handling
// ============================================

describe("credential resolution", () => {
  beforeEach(() => {
    gitPush.mockRejectedValue(new Error("Authentication failed"));
  });

  it("retries with the GitHub connection credential, without prompting", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "upstream", url: UPSTREAM_URL, push_url: UPSTREAM_URL }])
    );
    getGitHubGitCredentialForRemote.mockResolvedValue({
      username: "x-access-token",
      token: "gho_secret",
    });
    gitPush.mockReset();
    gitPush
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockResolvedValueOnce({ success: true });

    await expect(
      remoteOps.push({ remote: "upstream", branch: "feature" })
    ).resolves.toEqual({ success: true, errorType: "none" });

    expect(gitPush).toHaveBeenCalledTimes(2);
    // The retry must carry the original flags, not a sanitised copy — and not
    // an embellished one either, so this is an exact payload match against a
    // non-default remote with no destructive flag set.
    expect(gitPush.mock.calls[1][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: "upstream",
      branch: "feature",
      force: undefined,
      set_upstream: undefined,
      authUsername: "x-access-token",
      authToken: "gho_secret",
      storeAuth: false,
    });
    expect(showGitAuthenticationDialog).not.toHaveBeenCalled();
  });

  it("adds no destructive flag and no remote of its own on the credential retry", async () => {
    // A plain `push` / `fetch` that hits an auth failure must be retried as the
    // same plain request. Obtaining a credential is not a licence to add
    // --force or --prune, nor to redirect the request at the default remote —
    // that would silently turn a routine push into a force-push-with-token.
    const pushOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "upstream", push_url: UPSTREAM_URL }])
    );
    getGitHubGitCredentialForRemote.mockResolvedValue({
      username: "x-access-token",
      token: "gho_secret",
    });
    gitPush
      .mockReset()
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockResolvedValueOnce({ success: true });

    await pushOps.push({ remote: "upstream", branch: "feature" });

    expect(gitPush.mock.calls[1][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: "upstream",
      branch: "feature",
      force: undefined,
      set_upstream: undefined,
      authUsername: "x-access-token",
      authToken: "gho_secret",
      storeAuth: false,
    });

    const fetchOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "upstream", fetch_url: UPSTREAM_URL }])
    );
    gitFetch
      .mockReset()
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockResolvedValueOnce({ success: true });

    await fetchOps.fetch({ remote: "upstream" });

    expect(gitFetch.mock.calls[1][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: "upstream",
      prune: undefined,
      authUsername: "x-access-token",
      authToken: "gho_secret",
      storeAuth: false,
    });
  });

  it("prefers push_url, then fetch_url, then url when resolving the remote", async () => {
    for (const [remote, expected] of [
      [{ name: "origin", url: "u", fetch_url: "f", push_url: "p" }, "p"],
      [{ name: "origin", url: "u", fetch_url: "f" }, "f"],
      [{ name: "origin", url: "u" }, "u"],
    ] as const) {
      getGitHubGitCredentialForRemote.mockClear();
      const remoteOps = await loadRemoteOps({ repo: REPO });
      getGitRemotes.mockResolvedValue(remotes([remote]));

      await remoteOps.push();

      expect(getGitHubGitCredentialForRemote).toHaveBeenCalledWith(expected);
    }
  });

  it("defaults to the origin remote and honours an explicit one", async () => {
    const list = remotes([
      { name: "origin", push_url: ORIGIN_URL },
      { name: "upstream", push_url: UPSTREAM_URL },
    ]);

    const defaulted = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(list);
    await defaulted.push();
    expect(getGitHubGitCredentialForRemote).toHaveBeenCalledWith(ORIGIN_URL);

    getGitHubGitCredentialForRemote.mockClear();
    const explicit = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(list);
    await explicit.push({ remote: "upstream" });
    expect(getGitHubGitCredentialForRemote).toHaveBeenCalledWith(UPSTREAM_URL);
  });

  it("skips the credential lookup when the named remote does not exist", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(remotes([{ name: "origin" }]));

    await remoteOps.push({ remote: "fork" });

    expect(getGitHubGitCredentialForRemote).not.toHaveBeenCalled();
    // The dialog falls back to the bare remote name it was given.
    expect(showGitAuthenticationDialog).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "push", remote: "fork" })
    );

    // …and the stored-credential lookup is skipped too, rather than being
    // asked for credentials against an unresolvable remote.
    const { onLoadStoredCredential } =
      showGitAuthenticationDialog.mock.calls[0][0];
    await expect(onLoadStoredCredential()).resolves.toBeNull();
    expect(fillGitCredentials).not.toHaveBeenCalled();
  });

  it("falls through to the prompt when the GitHub credential lookup throws", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", url: ORIGIN_URL }])
    );
    getGitHubGitCredentialForRemote.mockRejectedValue(new Error("ipc down"));

    await remoteOps.push();

    expect(showGitAuthenticationDialog).toHaveBeenCalledTimes(1);
  });

  it("prompts with the resolved remote URL and repo path", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );

    await remoteOps.push();

    expect(showGitAuthenticationDialog).toHaveBeenCalledWith({
      operation: "push",
      repoPath: "/tmp/repo",
      remote: ORIGIN_URL,
      onLoadStoredCredential: expect.any(Function),
    });
  });

  it("retries with prompted credentials and honours the store-me choice", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );
    showGitAuthenticationDialog.mockResolvedValue({
      username: "harry",
      token: "pat_secret",
      shouldStore: true,
    });
    gitPush.mockReset();
    gitPush
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockResolvedValueOnce({ success: true });

    await expect(remoteOps.push({ setUpstream: true })).resolves.toEqual({
      success: true,
      errorType: "none",
    });

    expect(gitPush.mock.calls[1][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: undefined,
      branch: undefined,
      force: undefined,
      set_upstream: true,
      authUsername: "harry",
      authToken: "pat_secret",
      storeAuth: true,
    });
  });

  it("returns the original failure when the prompt is cancelled, and leaks no token", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );
    gitPush.mockReset();
    gitPush.mockRejectedValue(
      new Error(
        "fatal: Authentication failed for 'https://github.com/acme/repo.git/'"
      )
    );
    showGitAuthenticationDialog.mockResolvedValue(null);

    const result = await remoteOps.push();

    expect(result).toEqual({
      success: false,
      errorType: "authentication_failed",
      message:
        "fatal: Authentication failed for 'https://github.com/acme/repo.git/'",
    });
    expect(gitPush).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("gho_");
  });

  it("stops retrying when the GitHub credential fails for a non-auth reason", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );
    getGitHubGitCredentialForRemote.mockResolvedValue({
      username: "x-access-token",
      token: "gho_secret",
    });
    gitPush.mockReset();
    gitPush
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockRejectedValueOnce(
        structuredError("Updates were rejected", "non_fast_forward")
      );

    await expect(remoteOps.push()).resolves.toMatchObject({
      errorType: "non_fast_forward",
    });
    // A non-fast-forward is not fixed by better credentials, so no prompt.
    expect(showGitAuthenticationDialog).not.toHaveBeenCalled();
  });

  it("fails loudly rather than retrying blind when no repo context exists", async () => {
    // No repo context: the operation must not reach the API, the credential
    // retry, or the auth dialog — there is nothing meaningful to retry.
    const remoteOps = await loadRemoteOps();

    await expect(remoteOps.push()).resolves.toMatchObject({
      errorType: "unknown",
      message: expect.stringContaining("No repository is selected"),
    });
    expect(gitPush).not.toHaveBeenCalled();
    expect(showGitAuthenticationDialog).not.toHaveBeenCalled();
  });

  it("resolves a stored credential through the dialog callback", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );
    fillGitCredentials.mockResolvedValue({
      found: true,
      username: "harry",
      password: "stored_secret",
    });

    await remoteOps.push();

    const options = showGitAuthenticationDialog.mock.calls[0][0];
    await expect(options.onLoadStoredCredential()).resolves.toEqual({
      username: "harry",
      token: "stored_secret",
      shouldStore: false,
    });
    expect(fillGitCredentials).toHaveBeenCalledWith({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remoteUrl: ORIGIN_URL,
    });
  });

  it("returns no stored credential when the helper reports a miss or a partial record", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );

    await remoteOps.push();
    const { onLoadStoredCredential } =
      showGitAuthenticationDialog.mock.calls[0][0];

    fillGitCredentials.mockResolvedValue({ found: false });
    await expect(onLoadStoredCredential()).resolves.toBeNull();

    fillGitCredentials.mockResolvedValue({ found: true, username: "harry" });
    await expect(onLoadStoredCredential()).resolves.toBeNull();

    fillGitCredentials.mockResolvedValue(null);
    await expect(onLoadStoredCredential()).resolves.toBeNull();
  });

  it("retries pull and fetch through the same credential path", async () => {
    const pullOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );
    getGitHubGitCredentialForRemote.mockResolvedValue({
      username: "x-access-token",
      token: "gho_secret",
    });
    gitPull
      .mockReset()
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockResolvedValueOnce({ success: true });

    await expect(pullOps.pull({ strategy: "rebase" })).resolves.toEqual({
      success: true,
      errorType: "none",
    });
    expect(gitPull.mock.calls[1][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: undefined,
      branch: undefined,
      strategy: "rebase",
      authUsername: "x-access-token",
      authToken: "gho_secret",
      storeAuth: false,
    });

    const fetchOps = await loadRemoteOps({ repo: REPO });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );
    gitFetch
      .mockReset()
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockResolvedValueOnce({ success: true });

    await expect(fetchOps.fetch({ prune: true })).resolves.toEqual({
      success: true,
      errorType: "none",
    });
    expect(gitFetch.mock.calls[1][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: undefined,
      prune: true,
      authUsername: "x-access-token",
      authToken: "gho_secret",
      storeAuth: false,
    });
  });
});

describe("credential retry for pull and fetch", () => {
  beforeEach(() => {
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );
    getGitHubGitCredentialForRemote.mockResolvedValue({
      username: "x-access-token",
      token: "gho_secret",
    });
  });

  it("escalates from the GitHub credential to the prompt, then reports the final pull failure", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    showGitAuthenticationDialog.mockResolvedValue({
      username: "harry",
      token: "pat_secret",
      shouldStore: false,
    });
    gitPull
      .mockReset()
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockRejectedValueOnce(new Error("fatal: the remote end hung up"));

    await expect(remoteOps.pull({ strategy: "merge" })).resolves.toEqual({
      success: false,
      errorType: "unknown",
      message: "fatal: the remote end hung up",
    });

    expect(gitPull).toHaveBeenCalledTimes(3);
    expect(gitPull.mock.calls[2][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: undefined,
      branch: undefined,
      strategy: "merge",
      authUsername: "harry",
      authToken: "pat_secret",
      storeAuth: false,
    });
  });

  it("keeps the original pull failure when the prompt is cancelled", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitPull.mockReset().mockRejectedValue(new Error("Authentication failed"));

    await expect(remoteOps.pull({ strategy: "merge" })).resolves.toMatchObject({
      errorType: "authentication_failed",
      message: "Authentication failed",
    });
  });

  it("stops retrying the pull when the GitHub credential fails for a non-auth reason", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitPull
      .mockReset()
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockRejectedValueOnce(
        new Error("CONFLICT (content): Merge conflict in src/app.ts")
      );

    await expect(remoteOps.pull({ strategy: "merge" })).resolves.toMatchObject({
      errorType: "merge_conflicts",
    });
    expect(showGitAuthenticationDialog).not.toHaveBeenCalled();
  });

  it("escalates from the GitHub credential to the prompt, then reports the final fetch failure", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    showGitAuthenticationDialog.mockResolvedValue({
      username: "harry",
      token: "pat_secret",
      shouldStore: false,
    });
    gitFetch
      .mockReset()
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockRejectedValueOnce(new Error("fatal: the remote end hung up"));

    await expect(remoteOps.fetch({ prune: true })).resolves.toEqual({
      success: false,
      errorType: "unknown",
      message: "fatal: the remote end hung up",
    });
    expect(gitFetch.mock.calls[2][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: undefined,
      prune: true,
      authUsername: "harry",
      authToken: "pat_secret",
      storeAuth: false,
    });
  });

  it("keeps the original fetch failure when the prompt is cancelled", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitFetch.mockReset().mockRejectedValue(new Error("Authentication failed"));

    await expect(remoteOps.fetch()).resolves.toMatchObject({
      errorType: "authentication_failed",
    });
  });

  it("stops retrying the fetch when the GitHub credential fails for a non-auth reason", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitFetch
      .mockReset()
      .mockRejectedValueOnce(new Error("Authentication failed"))
      .mockRejectedValueOnce(
        structuredError("network unreachable", "network_error")
      );

    await expect(remoteOps.fetch()).resolves.toMatchObject({
      errorType: "network_error",
    });
    expect(showGitAuthenticationDialog).not.toHaveBeenCalled();
  });
});

// ============================================
// Output integration path
// ============================================

describe("output integration path", () => {
  it("streams the push and forwards every flag under its wire name", async () => {
    const pushWithOutput = vi
      .fn()
      .mockResolvedValue({ success: true, errorType: "none" });
    const remoteOps = await loadRemoteOps({
      repo: REPO,
      integration: { pushWithOutput },
    });

    await expect(
      remoteOps.push({
        remote: "origin",
        branch: "feature",
        force: true,
        setUpstream: true,
        showErrorDialog: true,
      })
    ).resolves.toEqual({ success: true, errorType: "none" });

    expect(pushWithOutput).toHaveBeenCalledWith({
      remote: "origin",
      branch: "feature",
      force: true,
      set_upstream: true,
      showErrorDialog: true,
    });
    expect(gitPush).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("streams a plain push with no destructive flag set", async () => {
    const pushWithOutput = vi
      .fn()
      .mockResolvedValue({ success: true, errorType: "none" });
    const remoteOps = await loadRemoteOps({
      repo: REPO,
      integration: { pushWithOutput },
    });

    await remoteOps.push();

    const payload = pushWithOutput.mock.calls[0][0];
    expect(payload.force).toBeUndefined();
    expect(payload.set_upstream).toBeUndefined();
  });

  it("passes a streamed non-auth failure straight back to the caller", async () => {
    const pushWithOutput = vi.fn().mockResolvedValue({
      success: false,
      errorType: "non_fast_forward",
      message: "rejected",
    });
    const remoteOps = await loadRemoteOps({
      repo: REPO,
      integration: { pushWithOutput },
    });

    await expect(remoteOps.push()).resolves.toEqual({
      success: false,
      errorType: "non_fast_forward",
      message: "rejected",
    });
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("runs the credential retry when the streamed push fails on auth", async () => {
    const pushWithOutput = vi.fn().mockResolvedValue({
      success: false,
      errorType: "authentication_failed",
      message: "denied",
    });
    const remoteOps = await loadRemoteOps({
      repo: REPO,
      integration: { pushWithOutput },
    });
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );
    getGitHubGitCredentialForRemote.mockResolvedValue({
      username: "x-access-token",
      token: "gho_secret",
    });

    await expect(remoteOps.push({ force: true })).resolves.toEqual({
      success: true,
      errorType: "none",
    });
    // The retry leaves the streaming channel and goes direct to the API,
    // carrying the caller's force flag and nothing beyond it.
    expect(gitPush.mock.calls[0][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: undefined,
      branch: undefined,
      force: true,
      set_upstream: undefined,
      authUsername: "x-access-token",
      authToken: "gho_secret",
      storeAuth: false,
    });
  });

  it("keeps the streamed failure when the retry is declined", async () => {
    const pushWithOutput = vi.fn().mockResolvedValue({
      success: false,
      errorType: "authentication_failed",
      message: "denied",
    });
    const remoteOps = await loadRemoteOps({
      repo: REPO,
      integration: { pushWithOutput },
    });

    await expect(remoteOps.push()).resolves.toEqual({
      success: false,
      errorType: "authentication_failed",
      message: "denied",
    });
  });

  it("streams the pull with the resolved strategy", async () => {
    const pullWithOutput = vi
      .fn()
      .mockResolvedValue({ success: true, errorType: "none" });
    const remoteOps = await loadRemoteOps({
      repo: REPO,
      integration: { pullWithOutput },
      pullStrategy: "rebase",
    });

    await remoteOps.pull({ remote: "origin" });

    expect(pullWithOutput).toHaveBeenCalledWith({
      remote: "origin",
      strategy: "rebase",
    });
  });

  it("runs the credential retry when a streamed pull or fetch fails on auth", async () => {
    getGitRemotes.mockResolvedValue(
      remotes([{ name: "origin", push_url: ORIGIN_URL }])
    );
    getGitHubGitCredentialForRemote.mockResolvedValue({
      username: "x-access-token",
      token: "gho_secret",
    });

    const pullWithOutput = vi.fn().mockResolvedValue({
      success: false,
      errorType: "authentication_failed",
      message: "denied",
    });
    const pullOps = await loadRemoteOps({
      repo: REPO,
      integration: { pullWithOutput },
    });
    await expect(pullOps.pull({ strategy: "ff-only" })).resolves.toEqual({
      success: true,
      errorType: "none",
    });
    expect(gitPull.mock.calls[0][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: undefined,
      branch: undefined,
      strategy: "ff-only",
      authUsername: "x-access-token",
      authToken: "gho_secret",
      storeAuth: false,
    });

    const fetchWithOutput = vi.fn().mockResolvedValue({
      success: false,
      errorType: "authentication_failed",
      message: "denied",
    });
    const fetchOps = await loadRemoteOps({
      repo: REPO,
      integration: { fetchWithOutput },
    });
    await expect(fetchOps.fetch({ prune: true })).resolves.toEqual({
      success: true,
      errorType: "none",
    });
    expect(gitFetch.mock.calls[0][0]).toEqual({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      remote: undefined,
      prune: true,
      authUsername: "x-access-token",
      authToken: "gho_secret",
      storeAuth: false,
    });
  });

  it("gives up with unknown when a streamed auth retry has no repo context to retry against", async () => {
    // The streaming path does not require a repo context, but the retry does.
    // The user can be prompted for credentials and still get nothing back.
    const pushWithOutput = vi.fn().mockResolvedValue({
      success: false,
      errorType: "authentication_failed",
      message: "denied",
    });
    const remoteOps = await loadRemoteOps({
      integration: { pushWithOutput },
    });
    showGitAuthenticationDialog.mockResolvedValue({
      username: "harry",
      token: "pat_secret",
      shouldStore: false,
    });

    await expect(remoteOps.push({ remote: "origin" })).resolves.toEqual({
      success: false,
      errorType: "unknown",
    });

    expect(getGitRemotes).not.toHaveBeenCalled();
    expect(getGitHubGitCredentialForRemote).not.toHaveBeenCalled();
    expect(showGitAuthenticationDialog).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: undefined, remote: "origin" })
    );
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("gives up with unknown for a streamed pull or fetch that has no repo context", async () => {
    showGitAuthenticationDialog.mockResolvedValue({
      username: "harry",
      token: "pat_secret",
      shouldStore: false,
    });
    const authFailure = {
      success: false,
      errorType: "authentication_failed",
      message: "denied",
    };

    const pullOps = await loadRemoteOps({
      integration: { pullWithOutput: vi.fn().mockResolvedValue(authFailure) },
    });
    await expect(pullOps.pull({ strategy: "merge" })).resolves.toEqual({
      success: false,
      errorType: "unknown",
    });

    const fetchOps = await loadRemoteOps({
      integration: { fetchWithOutput: vi.fn().mockResolvedValue(authFailure) },
    });
    await expect(fetchOps.fetch()).resolves.toEqual({
      success: false,
      errorType: "unknown",
    });

    expect(gitPull).not.toHaveBeenCalled();
    expect(gitFetch).not.toHaveBeenCalled();
  });

  it("keeps the streamed pull or fetch failure when the retry is declined", async () => {
    const authFailure = {
      success: false,
      errorType: "authentication_failed",
      message: "denied",
    };

    const pullOps = await loadRemoteOps({
      repo: REPO,
      integration: { pullWithOutput: vi.fn().mockResolvedValue(authFailure) },
    });
    await expect(pullOps.pull({ strategy: "merge" })).resolves.toEqual(
      authFailure
    );

    const fetchOps = await loadRemoteOps({
      repo: REPO,
      integration: { fetchWithOutput: vi.fn().mockResolvedValue(authFailure) },
    });
    await expect(fetchOps.fetch()).resolves.toEqual(authFailure);
  });

  it("resolves no stored credential without a repo context", async () => {
    const pushWithOutput = vi.fn().mockResolvedValue({
      success: false,
      errorType: "authentication_failed",
      message: "denied",
    });
    const remoteOps = await loadRemoteOps({
      integration: { pushWithOutput },
    });

    await remoteOps.push();

    const { onLoadStoredCredential } =
      showGitAuthenticationDialog.mock.calls[0][0];
    await expect(onLoadStoredCredential()).resolves.toBeNull();
    expect(fillGitCredentials).not.toHaveBeenCalled();
  });

  it("streams the fetch with its parameters unchanged", async () => {
    const fetchWithOutput = vi
      .fn()
      .mockResolvedValue({ success: true, errorType: "none" });
    const remoteOps = await loadRemoteOps({
      repo: REPO,
      integration: { fetchWithOutput },
    });

    await remoteOps.fetch({ remote: "origin", prune: true });

    expect(fetchWithOutput).toHaveBeenCalledWith({
      remote: "origin",
      prune: true,
    });
  });
});

// ============================================
// sync
// ============================================

describe("sync", () => {
  it("fetches, then pulls, then pushes, in that order", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });

    await expect(remoteOps.sync()).resolves.toEqual({
      success: true,
      errorType: "none",
    });

    expect(gitFetch).toHaveBeenCalledTimes(1);
    expect(gitPull).toHaveBeenCalledTimes(1);
    expect(gitPush).toHaveBeenCalledTimes(1);
    expect(gitFetch.mock.invocationCallOrder[0]).toBeLessThan(
      gitPull.mock.invocationCallOrder[0]
    );
    expect(gitPull.mock.invocationCallOrder[0]).toBeLessThan(
      gitPush.mock.invocationCallOrder[0]
    );
  });

  it("never pushes when the preflight fetch fails", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitFetch.mockRejectedValueOnce(
      new Error("fatal: could not read from remote")
    );

    await expect(remoteOps.sync()).resolves.toMatchObject({ success: false });

    expect(gitPull).not.toHaveBeenCalled();
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("never pushes when the pull fails", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitPull.mockRejectedValueOnce(
      new Error("CONFLICT (content): Merge conflict in src/app.ts")
    );

    await expect(remoteOps.sync()).resolves.toMatchObject({
      success: false,
      errorType: "merge_conflicts",
    });

    expect(gitFetch).toHaveBeenCalledTimes(1);
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("never pushes with force", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });

    await remoteOps.sync();

    expect(gitPush.mock.calls[0][0].force).toBeUndefined();
  });
});

// ============================================
// Dialog variants
// ============================================

describe("operations with an error dialog", () => {
  it("shows the dialog with the failing operation's context", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitPush.mockRejectedValueOnce(new Error("fatal: the remote end hung up"));

    const result = await remoteOps.pushWithDialog({ force: true });
    await flushMacrotask();

    expect(result).toMatchObject({ success: false, errorType: "unknown" });
    expect(showGitErrorAndHandle).toHaveBeenCalledWith({
      operation: "push",
      repoId: "repo-1",
      repoPath: "/tmp/repo",
      errorType: "unknown",
      errorMessage: "fatal: the remote end hung up",
    });
  });

  it("does not show the dialog when the operation succeeds", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });

    await remoteOps.pushWithDialog();
    await flushMacrotask();

    expect(showGitErrorAndHandle).not.toHaveBeenCalled();
  });

  it("leaves error reporting to the output panel when streaming is available", async () => {
    const pushWithOutput = vi.fn().mockResolvedValue({
      success: false,
      errorType: "non_fast_forward",
      message: "rejected",
    });
    const remoteOps = await loadRemoteOps({
      repo: REPO,
      integration: { pushWithOutput },
    });

    await remoteOps.pushWithDialog();
    await flushMacrotask();

    expect(showGitErrorAndHandle).not.toHaveBeenCalled();
  });

  it("substitutes a per-operation fallback message when git said nothing", async () => {
    const cases: Array<[string, string]> = [
      ["fetch", "Fetch failed"],
      ["push", "Push failed"],
      ["pull", "Pull failed"],
      ["sync", "Sync failed"],
    ];

    for (const [operation, expected] of cases) {
      showGitErrorAndHandle.mockClear();
      const remoteOps = await loadRemoteOps({ repo: REPO });
      // `sync` fails at its preflight fetch, so a silent fetch covers both.
      gitFetch.mockRejectedValueOnce(new Error(""));
      gitPush.mockRejectedValueOnce(new Error(""));
      gitPull.mockRejectedValueOnce(new Error(""));

      if (operation === "fetch") await remoteOps.fetchWithDialog();
      if (operation === "push") await remoteOps.pushWithDialog();
      if (operation === "pull") await remoteOps.pullWithDialog();
      if (operation === "sync") await remoteOps.syncWithDialog();
      await flushMacrotask();

      expect(showGitErrorAndHandle).toHaveBeenCalledWith(
        expect.objectContaining({ operation, errorMessage: expected })
      );
    }
  });

  it("labels the pull and sync dialogs with their own operation", async () => {
    const pullOps = await loadRemoteOps({ repo: REPO });
    gitPull.mockRejectedValueOnce(new Error("fatal: refusing to merge"));
    await pullOps.pullWithDialog({ strategy: "merge" });
    await flushMacrotask();
    expect(showGitErrorAndHandle).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "pull" })
    );

    showGitErrorAndHandle.mockClear();
    const syncOps = await loadRemoteOps({ repo: REPO });
    gitFetch.mockRejectedValueOnce(
      new Error("fatal: could not read from remote")
    );
    await syncOps.syncWithDialog();
    await flushMacrotask();
    expect(showGitErrorAndHandle).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "sync" })
    );
  });

  it("defers the dialog past the current task rather than opening it inline", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });
    gitPush.mockRejectedValueOnce(new Error("fatal: the remote end hung up"));

    await remoteOps.pushWithDialog();

    // Opening a native dialog synchronously from a settled fetch can deadlock
    // the macOS main thread, so it must not have fired yet.
    expect(showGitErrorAndHandle).not.toHaveBeenCalled();
    await flushMacrotask();
    expect(showGitErrorAndHandle).toHaveBeenCalledTimes(1);
  });

  it("forwards the force flag through the dialog wrapper", async () => {
    const remoteOps = await loadRemoteOps({ repo: REPO });

    await remoteOps.pushWithDialog({ force: true, setUpstream: true });

    expect(gitPush.mock.calls[0][0]).toMatchObject({
      force: true,
      set_upstream: true,
    });
  });
});
