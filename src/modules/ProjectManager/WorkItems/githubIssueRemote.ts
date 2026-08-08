import { getGitRemotes } from "@src/api/http/git/remotes";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";

/** Resolve a GitHub remote from either a remote URL/repository name or a local checkout. */
export async function resolveGitHubIssueRemoteUrl(
  repoPath: string
): Promise<string | null> {
  if (
    /^[^/:@\s]+\/[^/\s]+$/.test(repoPath) ||
    parseGithubRepoFullName(repoPath)
  ) {
    return repoPath;
  }

  const remotes = await getGitRemotes({
    repo_id: "default",
    repo_path: repoPath,
  });
  const origin = remotes?.remotes?.find((remote) => remote.name === "origin");
  const fallback = remotes?.remotes?.[0];
  return (
    origin?.url ||
    origin?.fetch_url ||
    fallback?.url ||
    fallback?.fetch_url ||
    null
  );
}
