import { fetchRustApi, gitRepoUrl } from "@src/api/http/git/client";
import { gitPush } from "@src/api/http/git/operations";
import { getGitRemotes } from "@src/api/http/git/remotes";
import { createPRLocal } from "@src/api/tauri/github";
import { createLogger } from "@src/hooks/logger";
import { announceBranchRemoteMutation } from "@src/util/git/branchRemoteMutation";
import { parseRepoFullNameFromRemote } from "@src/util/git/githubRemote";

const logger = createLogger("createPullRequest");

export function parseGithubRepoFullName(remoteUrl: string): string | null {
  return parseRepoFullNameFromRemote(remoteUrl);
}

export interface CreatePullRequestParams {
  repoPath: string;
  branch: string;
  title: string;
  repoId?: string;
  pushBeforeCreate?: boolean;
}

export interface CreatePullRequestResult {
  url?: string;
  error?: string;
}

export async function createPullRequest(
  params: CreatePullRequestParams
): Promise<CreatePullRequestResult> {
  const {
    repoPath,
    branch,
    title,
    repoId = "default",
    pushBeforeCreate = true,
  } = params;

  try {
    const remotesData = await getGitRemotes({
      repo_id: repoId,
      repo_path: repoPath,
    });
    const originRemote = remotesData?.remotes?.find(
      (remote) => remote.name === "origin"
    );
    if (!originRemote?.url) {
      return { error: "no_origin_remote" };
    }

    const repoFullName = parseGithubRepoFullName(originRemote.url);
    if (!repoFullName) {
      return { error: "cannot_parse_repo_name" };
    }

    if (pushBeforeCreate) {
      await gitPush({
        repo_id: repoId,
        repo_path: repoPath,
        remote: "origin",
        branch,
        set_upstream: true,
      });
    }

    let baseBranch = "main";
    try {
      const queryParams = new URLSearchParams({ path: repoPath });
      const branchResp = await fetchRustApi<{ name: string }>(
        `${gitRepoUrl(repoId)}/default-branch?${queryParams.toString()}`
      );
      if (branchResp.data?.name) {
        baseBranch = branchResp.data.name;
      }
    } catch {
      // Fallback to "main" when the API doesn't expose a default branch.
    }

    const prResponse = await createPRLocal(
      repoFullName,
      title,
      branch,
      baseBranch
    );

    announceBranchRemoteMutation({
      repoId,
      repoPath,
      branchName: branch,
      reason: "pull-request-created",
    });

    return { url: prResponse.url };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("GitHub re-authorization required")) {
      return { error: "not_authenticated" };
    }
    logger.error(`Failed to create PR: ${msg}`);
    return { error: msg };
  }
}
