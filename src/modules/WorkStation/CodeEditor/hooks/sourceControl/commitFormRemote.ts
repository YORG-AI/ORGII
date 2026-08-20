import { getGitRemotes } from "@src/api/http/git/remotes";

export async function hasConfiguredGitRemote(params: {
  selectedRepoId: string | null;
  repoPath?: string;
}): Promise<boolean> {
  if (!params.selectedRepoId) return false;

  const remotesData = await getGitRemotes({
    repo_id: params.selectedRepoId,
    repo_path: params.repoPath,
  });

  return (remotesData?.remotes?.length ?? 0) > 0;
}
