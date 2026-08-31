/**
 * Registering a sidebar workspace group's directory as a real workspace repo.
 *
 * Organize-by-workspace groups sessions by the cwd they ran in, so a group can
 * be headed by a directory that was never added as a workspace — every session
 * imported from an external CLI's history lands in one. Starting a session
 * from such a group needs the directory registered first: without a repo id
 * the launch carries a bare path, and every repo-keyed surface (branch
 * resolution, repo kind, the branch dropdown) has nothing to key on.
 *
 * Kind detection is not a convenience here. `server_import_repo` runs
 * `git init` (plus an initial commit) on a path that has no `.git`, which is
 * not something clicking "new session" may do to a directory the user only
 * ever ran an agent in — so a non-git directory is registered as a plain work
 * folder instead.
 */
import { repoApi } from "@src/api/tauri/repo";
import { REPO_KIND, type Repo } from "@src/store/repo";
import { matchRepoByPath } from "@src/store/repo/matchRepoByPath";

interface ImportedRepoRecord {
  repo_id: string;
  name: string;
  path: string;
  kind?: string;
}

function toStoreRepo(record: ImportedRepoRecord): Repo {
  return {
    id: record.repo_id,
    name: record.name,
    // The backend canonicalizes the path (symlinks, `/tmp` → `/private/tmp`),
    // so store what it persisted rather than what was clicked.
    path: record.path,
    fs_uri: record.path,
    kind: record.kind === "folder" ? REPO_KIND.FOLDER : REPO_KIND.GIT,
  };
}

/**
 * Import `workspacePath` as a workspace and return it in store shape.
 *
 * The backend list is consulted first because `reposAtom` is not authoritative
 * at every moment: it is empty until the startup load lands, and a `+` clicked
 * in that window would otherwise re-import a directory that is already
 * registered. That is not harmless — the import upserts `kind`, so a directory
 * deliberately registered as a work folder would be silently converted to a
 * git repo. A repo list that cannot be read rejects rather than guesses.
 *
 * Rejects, too, when the path is gone or unreadable: the backend validates the
 * directory before persisting anything, and a group can outlive the folder its
 * sessions ran in.
 */
export async function importWorkspaceRepo(
  workspacePath: string
): Promise<Repo> {
  const registeredRepos = await repoApi.getRepos();
  const alreadyRegistered = matchRepoByPath(
    (registeredRepos.data?.repos ?? []).map(toStoreRepo),
    workspacePath
  );
  if (alreadyRegistered) return alreadyRegistered;

  const isGitRepo = await repoApi.checkIsGitRepo(workspacePath);
  const response = isGitRepo
    ? await repoApi.importLocalRepo({ fs_path: workspacePath })
    : await repoApi.importWorkFolder({ fs_path: workspacePath });
  return toStoreRepo(response.data);
}
