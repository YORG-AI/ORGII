/**
 * Remote Operations — push, pull, fetch, publish, sync
 */
import { gitApi } from "@src/api/http/git";
import { getGitHubGitCredentialForRemote } from "@src/api/tauri/github";
import { showGitErrorAndHandle } from "@src/hooks/git/useGitErrorDialog";
import { createLogger } from "@src/hooks/logger";
import {
  type GitPullStrategy,
  gitPullStrategyAtom,
} from "@src/store/ui/editorSettingsAtom";
import {
  type GitAuthenticationDialogResult,
  showGitAuthenticationDialog,
} from "@src/util/dialogs/gitAuthenticationDialog";

import { TerminalService } from "../../terminal";
import type { GitOperationResult } from "./types";
import {
  getOutputIntegration,
  getRepoContext,
  getStore,
  parseGitError,
} from "./types";

const logger = createLogger("GitRemoteOps");

// ============================================
// Core Operations
// ============================================

/**
 * Push to remote
 * Uses streaming output if available, falls back to terminal
 */
export async function push(
  params: {
    force?: boolean;
    setUpstream?: boolean;
    remote?: string;
    branch?: string;
    showErrorDialog?: boolean;
  } = {}
): Promise<GitOperationResult> {
  const integration = getOutputIntegration();

  if (integration) {
    const result = await integration.pushWithOutput({
      remote: params.remote,
      branch: params.branch,
      force: params.force,
      set_upstream: params.setUpstream,
      showErrorDialog: params.showErrorDialog,
    });
    if (!result.success && result.errorType === "authentication_failed") {
      return (await retryPushWithAuth(params)) ?? result;
    }
    return result;
  }

  const repo = getRepoContext();
  if (repo) {
    try {
      await gitApi.gitPush({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        remote: params.remote,
        branch: params.branch,
        force: params.force,
        set_upstream: params.setUpstream,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      const result: GitOperationResult = {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
      if (result.errorType === "authentication_failed") {
        return (await retryPushWithAuth(params)) ?? result;
      }
      return result;
    }
  }

  // Fall back to terminal command
  const cmd = params.force ? "git push --force" : "git push";
  try {
    await TerminalService.execute(cmd);
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

/**
 * Read the user's preferred pull strategy from settings
 */
function getUserPullStrategy(): GitPullStrategy {
  const strategy = getStore().get(gitPullStrategyAtom);
  return strategy ?? "merge";
}

/**
 * Build the terminal pull command with strategy flags.
 * Always pass explicit flag so Git knows how to reconcile when branches diverge.
 */
function buildPullCommand(strategy: GitPullStrategy): string {
  switch (strategy) {
    case "rebase":
      return "git pull --rebase";
    case "ff-only":
      return "git pull --ff-only";
    default:
      return "git pull --no-rebase";
  }
}

async function getRemoteUrl(remoteName?: string): Promise<string | undefined> {
  const repo = getRepoContext();
  if (!repo) return undefined;

  const remotesData = await gitApi.getGitRemotes({
    repo_id: repo.repoId,
    repo_path: repo.repoPath,
  });
  const targetRemoteName = remoteName ?? "origin";
  const remote = remotesData?.remotes.find(
    (candidateRemote) => candidateRemote.name === targetRemoteName
  );
  return remote?.push_url ?? remote?.fetch_url ?? remote?.url;
}

async function readStoredGitCredential(
  remoteName?: string
): Promise<GitAuthenticationDialogResult | null> {
  const repo = getRepoContext();
  if (!repo) return null;

  const remoteUrl = await getRemoteUrl(remoteName);
  if (!remoteUrl) return null;

  const credential = await gitApi.fillGitCredentials({
    repo_id: repo.repoId,
    repo_path: repo.repoPath,
    remoteUrl,
  });

  if (!credential?.found || !credential.username || !credential.password) {
    return null;
  }

  return {
    username: credential.username,
    token: credential.password,
    shouldStore: false,
  };
}

async function readGitHubConnectionCredential(
  remoteName?: string
): Promise<GitAuthenticationDialogResult | null> {
  const remoteUrl = await getRemoteUrl(remoteName);
  if (!remoteUrl) return null;

  try {
    const credential = await getGitHubGitCredentialForRemote(remoteUrl);
    if (!credential) return null;
    return {
      username: credential.username,
      token: credential.token,
      shouldStore: false,
    };
  } catch (error) {
    logger.warn("GitHub credential lookup failed:", error);
    return null;
  }
}

async function requestGitAuthToken(
  operation: "push" | "pull" | "fetch" | "sync",
  remote?: string
): Promise<GitAuthenticationDialogResult | null> {
  const repo = getRepoContext();
  const remoteUrl = await getRemoteUrl(remote);
  return showGitAuthenticationDialog({
    operation,
    repoPath: repo?.repoPath,
    remote: remoteUrl ?? remote,
    onLoadStoredCredential: () => readStoredGitCredential(remote),
  });
}

async function attemptPushWithAuth(
  params: {
    force?: boolean;
    setUpstream?: boolean;
    remote?: string;
    branch?: string;
  },
  auth: GitAuthenticationDialogResult
): Promise<GitOperationResult> {
  const repo = getRepoContext();
  if (!repo) return { success: false, errorType: "unknown" };

  try {
    await gitApi.gitPush({
      repo_id: repo.repoId,
      repo_path: repo.repoPath,
      remote: params.remote,
      branch: params.branch,
      force: params.force,
      set_upstream: params.setUpstream,
      authUsername: auth.username,
      authToken: auth.token,
      storeAuth: auth.shouldStore,
    });
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

async function retryPushWithAuth(params: {
  force?: boolean;
  setUpstream?: boolean;
  remote?: string;
  branch?: string;
}): Promise<GitOperationResult | null> {
  const githubAuth = await readGitHubConnectionCredential(params.remote);
  if (githubAuth) {
    const githubResult = await attemptPushWithAuth(params, githubAuth);
    if (
      githubResult.success ||
      githubResult.errorType !== "authentication_failed"
    ) {
      return githubResult;
    }
  }

  const auth = await requestGitAuthToken("push", params.remote);
  if (!auth) return null;

  return attemptPushWithAuth(params, auth);
}

async function attemptPullWithAuth(
  params: {
    remote?: string;
    branch?: string;
    strategy: GitPullStrategy;
  },
  auth: GitAuthenticationDialogResult
): Promise<GitOperationResult> {
  const repo = getRepoContext();
  if (!repo) return { success: false, errorType: "unknown" };

  try {
    await gitApi.gitPull({
      repo_id: repo.repoId,
      repo_path: repo.repoPath,
      remote: params.remote,
      branch: params.branch,
      strategy: params.strategy,
      authUsername: auth.username,
      authToken: auth.token,
      storeAuth: auth.shouldStore,
    });
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

async function retryPullWithAuth(params: {
  remote?: string;
  branch?: string;
  strategy: GitPullStrategy;
}): Promise<GitOperationResult | null> {
  const githubAuth = await readGitHubConnectionCredential(params.remote);
  if (githubAuth) {
    const githubResult = await attemptPullWithAuth(params, githubAuth);
    if (
      githubResult.success ||
      githubResult.errorType !== "authentication_failed"
    ) {
      return githubResult;
    }
  }

  const auth = await requestGitAuthToken("pull", params.remote);
  if (!auth) return null;

  return attemptPullWithAuth(params, auth);
}

async function attemptFetchWithAuth(
  params: {
    remote?: string;
    prune?: boolean;
  },
  auth: GitAuthenticationDialogResult
): Promise<GitOperationResult> {
  const repo = getRepoContext();
  if (!repo) return { success: false, errorType: "unknown" };

  try {
    await gitApi.gitFetch({
      repo_id: repo.repoId,
      repo_path: repo.repoPath,
      remote: params.remote,
      prune: params.prune,
      authUsername: auth.username,
      authToken: auth.token,
      storeAuth: auth.shouldStore,
    });
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

async function retryFetchWithAuth(params: {
  remote?: string;
  prune?: boolean;
}): Promise<GitOperationResult | null> {
  const githubAuth = await readGitHubConnectionCredential(params.remote);
  if (githubAuth) {
    const githubResult = await attemptFetchWithAuth(params, githubAuth);
    if (
      githubResult.success ||
      githubResult.errorType !== "authentication_failed"
    ) {
      return githubResult;
    }
  }

  const auth = await requestGitAuthToken("fetch", params.remote);
  if (!auth) return null;

  return attemptFetchWithAuth(params, auth);
}

/**
 * Pull from remote
 * Uses streaming output if available, falls back to terminal.
 * Respects the user's pull strategy setting (merge/rebase/ff-only).
 */
export async function pull(
  params: {
    remote?: string;
    branch?: string;
    strategy?: GitPullStrategy;
    showErrorDialog?: boolean;
  } = {}
): Promise<GitOperationResult> {
  const strategy = params.strategy ?? getUserPullStrategy();
  const integration = getOutputIntegration();

  if (integration) {
    const result = await integration.pullWithOutput({ ...params, strategy });
    if (!result.success && result.errorType === "authentication_failed") {
      return (await retryPullWithAuth({ ...params, strategy })) ?? result;
    }
    return result;
  }

  const repo = getRepoContext();
  if (repo) {
    try {
      await gitApi.gitPull({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        remote: params.remote,
        branch: params.branch,
        strategy,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      const result: GitOperationResult = {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
      if (result.errorType === "authentication_failed") {
        return (await retryPullWithAuth({ ...params, strategy })) ?? result;
      }
      return result;
    }
  }

  try {
    await TerminalService.execute(buildPullCommand(strategy));
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

/**
 * Fetch from remote
 * Uses streaming output if available, falls back to terminal
 */
export async function fetch(
  params: {
    remote?: string;
    prune?: boolean;
    showErrorDialog?: boolean;
  } = {}
): Promise<GitOperationResult> {
  const integration = getOutputIntegration();

  if (integration) {
    const result = await integration.fetchWithOutput(params);
    if (!result.success && result.errorType === "authentication_failed") {
      return (await retryFetchWithAuth(params)) ?? result;
    }
    return result;
  }

  const repo = getRepoContext();
  if (repo) {
    try {
      await gitApi.gitFetch({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        remote: params.remote,
        prune: params.prune,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      const result: GitOperationResult = {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
      if (result.errorType === "authentication_failed") {
        return (await retryFetchWithAuth(params)) ?? result;
      }
      return result;
    }
  }

  try {
    await TerminalService.execute("git fetch");
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

/**
 * Publish branch (push with --set-upstream)
 */
export async function publish(): Promise<GitOperationResult> {
  return push({ setUpstream: true });
}

/**
 * Sync (fetch → pull → push)
 *
 * Fetches first so local tracking refs are up-to-date before pull+push.
 * Without the preflight fetch, `git status` may report 0 behind while
 * the remote actually has new commits, causing a push rejection.
 */
export async function sync(
  params: { showErrorDialog?: boolean } = {}
): Promise<GitOperationResult> {
  const fetchResult = await fetch({
    showErrorDialog: params.showErrorDialog,
  });
  if (!fetchResult.success) {
    return fetchResult;
  }
  const pullResult = await pull({
    showErrorDialog: params.showErrorDialog,
  });
  if (!pullResult.success) {
    return pullResult;
  }
  return push({
    showErrorDialog: params.showErrorDialog,
  });
}

// ============================================
// Operations with Error Dialog
// ============================================

/**
 * Defer native dialog display to the next event-loop tick.
 * Calling the Tauri dialog API synchronously from a WebKit event callback
 * (e.g. SSE end, fetch settlement) can trigger a main-thread rendering
 * mutex self-deadlock on macOS.
 */
function deferErrorDialog(
  options: Parameters<typeof showGitErrorAndHandle>[0]
) {
  setTimeout(() => {
    showGitErrorAndHandle(options);
  }, 0);
}

/**
 * Push to remote with error dialog on failure
 */
export async function pushWithDialog(
  params: { force?: boolean; setUpstream?: boolean } = {}
): Promise<GitOperationResult> {
  const integration = getOutputIntegration();
  const repoContext = getRepoContext();
  const result = await push(params);

  if (!integration && !result.success && result.errorType !== "none") {
    deferErrorDialog({
      operation: "push",
      repoId: repoContext?.repoId,
      repoPath: repoContext?.repoPath,
      errorType: result.errorType,
      errorMessage: result.message || "Push failed",
    });
  }
  return result;
}

/**
 * Pull from remote with error dialog on failure
 */
export async function pullWithDialog(
  params: { remote?: string; branch?: string; strategy?: GitPullStrategy } = {}
): Promise<GitOperationResult> {
  const integration = getOutputIntegration();
  const repoContext = getRepoContext();
  const result = await pull(params);

  if (!integration && !result.success && result.errorType !== "none") {
    deferErrorDialog({
      operation: "pull",
      repoId: repoContext?.repoId,
      repoPath: repoContext?.repoPath,
      errorType: result.errorType,
      errorMessage: result.message || "Pull failed",
    });
  }
  return result;
}

/**
 * Fetch from remote with error dialog on failure
 */
export async function fetchWithDialog(
  params: { remote?: string; prune?: boolean } = {}
): Promise<GitOperationResult> {
  const integration = getOutputIntegration();
  const repoContext = getRepoContext();
  const result = await fetch(params);

  if (!integration && !result.success && result.errorType !== "none") {
    deferErrorDialog({
      operation: "fetch",
      repoId: repoContext?.repoId,
      repoPath: repoContext?.repoPath,
      errorType: result.errorType,
      errorMessage: result.message || "Fetch failed",
    });
  }
  return result;
}

/**
 * Sync (pull + push) with error dialog on failure
 */
export async function syncWithDialog(): Promise<GitOperationResult> {
  const integration = getOutputIntegration();
  const repoContext = getRepoContext();
  const result = await sync();

  if (!integration && !result.success && result.errorType !== "none") {
    deferErrorDialog({
      operation: "sync",
      repoId: repoContext?.repoId,
      repoPath: repoContext?.repoPath,
      errorType: result.errorType,
      errorMessage: result.message || "Sync failed",
    });
  }
  return result;
}
