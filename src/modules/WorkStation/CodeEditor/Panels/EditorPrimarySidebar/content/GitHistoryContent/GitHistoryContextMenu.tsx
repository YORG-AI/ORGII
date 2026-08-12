import i18next from "i18next";
import { useEffect, useRef } from "react";

import { type GitCommitInfo, getGitRemotes } from "@src/api/http/git";
import { createLogger } from "@src/hooks/logger";
import { copyText } from "@src/util/data/clipboard";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";
import { openExternalLink } from "@src/util/platform/ipcRenderer";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

const log = createLogger("GitHistoryContextMenu");

type DispatchFn = (
  actionType: string,
  payload: Record<string, unknown>,
  source: "user" | "ai" | "system"
) => Promise<unknown>;

interface ActionResult {
  success: boolean;
  message?: string;
}

export interface GitHistoryContextMenuProps {
  commit: GitCommitInfo;
  repoId: string;
  repoPath: string;
  isHeadCommit: boolean;
  dispatch: DispatchFn;
  onOpenInNewTab: (commit: GitCommitInfo) => void;
  onActionComplete: () => void;
  onClose: () => void;
}

function normalizeRemoteToWebUrl(remoteUrl: string): string | null {
  const sanitizedUrl = remoteUrl.trim();
  if (!sanitizedUrl) return null;

  if (sanitizedUrl.startsWith("git@")) {
    const sshMatch = /^git@([^:]+):(.+)$/.exec(sanitizedUrl);
    if (!sshMatch) return null;
    const host = sshMatch[1];
    const path = sshMatch[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  if (sanitizedUrl.startsWith("ssh://git@")) {
    const sshUrlMatch = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(sanitizedUrl);
    if (!sshUrlMatch) return null;
    const host = sshUrlMatch[1];
    const path = sshUrlMatch[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  if (
    sanitizedUrl.startsWith("https://") ||
    sanitizedUrl.startsWith("http://")
  ) {
    return sanitizedUrl.replace(/\.git$/, "");
  }

  return null;
}

function getGitHubCommitUrl(
  remotes: Array<{
    name: string;
    url: string;
    fetch_url: string;
    push_url: string;
  }>,
  commitSha: string
): string | null {
  const prioritizedRemotes = [...remotes].sort((leftRemote, rightRemote) => {
    if (leftRemote.name === "origin") return -1;
    if (rightRemote.name === "origin") return 1;
    return 0;
  });

  for (const remote of prioritizedRemotes) {
    const candidateUrls = [remote.url, remote.fetch_url, remote.push_url];
    for (const candidateUrl of candidateUrls) {
      const baseUrl = normalizeRemoteToWebUrl(candidateUrl);
      if (!baseUrl) continue;
      if (!baseUrl.toLowerCase().includes("github")) continue;
      return `${baseUrl}/commit/${commitSha}`;
    }
  }

  return null;
}

async function confirmAction(msg: string, title: string): Promise<boolean> {
  return confirmDestructiveAction({ title, message: msg });
}

function showResult(result: ActionResult, successLabel: string): void {
  if (result.success) {
    showGitActionDialogSafely(result.message ?? successLabel, "info");
  } else {
    showGitActionDialogSafely(result.message ?? "Operation failed", "error");
  }
}

export default function GitHistoryContextMenu(
  props: GitHistoryContextMenuProps
) {
  const { onClose } = props;
  const hasShownMenu = useRef(false);

  useEffect(() => {
    if (hasShownMenu.current) return;
    hasShownMenu.current = true;

    const {
      commit,
      repoId,
      repoPath,
      isHeadCommit,
      dispatch,
      onActionComplete,
    } = props;

    async function showNativeMenu() {
      try {
        await popupNativeMenu({
          source: "git-history",
          buildItems: () => {
            const t = i18next.t.bind(i18next);
            const items: NativeMenuItemOptions[] = [
              {
                text: "Amend Commit...",
                enabled: isHeadCommit,
                action: async () => {
                  if (!isHeadCommit) return;
                  const confirmed = await confirmAction(
                    "Amend the latest commit using currently staged changes?",
                    "Confirm Amend Commit"
                  );
                  if (!confirmed) return;
                  const result = (await dispatch(
                    "git.amend",
                    {},
                    "user"
                  )) as ActionResult;
                  showResult(result, "Commit amended");
                  onActionComplete();
                },
              },
              {
                text: "Reset to Commit (Soft)",
                action: async () => {
                  const confirmed = await confirmAction(
                    `Soft reset HEAD to ${commit.short_sha}?`,
                    "Confirm Soft Reset"
                  );
                  if (!confirmed) return;
                  const result = (await dispatch(
                    "git.reset",
                    { ref: commit.sha, mode: "soft" },
                    "user"
                  )) as ActionResult;
                  showResult(result, "Soft reset complete");
                  onActionComplete();
                },
              },
              {
                text: "Reset to Commit (Mixed)",
                action: async () => {
                  const confirmed = await confirmAction(
                    `Mixed reset HEAD to ${commit.short_sha}?`,
                    "Confirm Mixed Reset"
                  );
                  if (!confirmed) return;
                  const result = (await dispatch(
                    "git.reset",
                    { ref: commit.sha, mode: "mixed" },
                    "user"
                  )) as ActionResult;
                  showResult(result, "Mixed reset complete");
                  onActionComplete();
                },
              },
              {
                text: "Reset to Commit (Hard)",
                action: async () => {
                  const confirmed = await confirmAction(
                    `Hard reset HEAD to ${commit.short_sha}? This discards uncommitted changes.`,
                    "Confirm Hard Reset"
                  );
                  if (!confirmed) return;
                  const result = (await dispatch(
                    "git.reset",
                    { ref: commit.sha, mode: "hard" },
                    "user"
                  )) as ActionResult;
                  showResult(result, "Hard reset complete");
                  onActionComplete();
                },
              },
              {
                text: "Checkout Commit",
                action: async () => {
                  const confirmed = await confirmAction(
                    `Checkout ${commit.short_sha}? This enters detached HEAD state.`,
                    "Confirm Checkout Commit"
                  );
                  if (!confirmed) return;
                  const result = (await dispatch(
                    "git.checkout",
                    { branch: commit.sha, create: false },
                    "user"
                  )) as ActionResult;
                  showResult(result, `Checked out ${commit.short_sha}`);
                  onActionComplete();
                },
              },
              {
                text: t("common:actions.openInNewTab"),
                action: () => {
                  props.onOpenInNewTab(commit);
                },
              },
              {
                text: "Reorder Commit",
                enabled: false,
              },
              { item: "Separator" },
              {
                text: "Revert Changes in Commit",
                action: async () => {
                  const confirmed = await confirmAction(
                    `Revert changes introduced by ${commit.short_sha}?`,
                    "Confirm Revert Commit"
                  );
                  if (!confirmed) return;
                  const result = (await dispatch(
                    "git.revertCommit",
                    { commitSha: commit.sha, noCommit: false },
                    "user"
                  )) as ActionResult;
                  showResult(result, "Revert complete");
                  onActionComplete();
                },
              },
              {
                text: "Create Branch from Commit",
                action: async () => {
                  const defaultName = `branch-${commit.short_sha}`;
                  const input = window.prompt(
                    "Enter new branch name:",
                    defaultName
                  );
                  const branchName = input?.trim();
                  if (!branchName) return;
                  const result = (await dispatch(
                    "git.createBranchFromCommit",
                    {
                      branchName,
                      commitSha: commit.sha,
                      checkout: true,
                    },
                    "user"
                  )) as ActionResult;
                  showResult(result, `Created branch ${branchName}`);
                  onActionComplete();
                },
              },
              {
                text: "Cherry-pick Commit",
                action: async () => {
                  const confirmed = await confirmAction(
                    `Cherry-pick ${commit.short_sha} onto current branch?`,
                    "Confirm Cherry-pick"
                  );
                  if (!confirmed) return;
                  const result = (await dispatch(
                    "git.cherryPickCommit",
                    { commitSha: commit.sha, noCommit: false },
                    "user"
                  )) as ActionResult;
                  showResult(result, "Cherry-pick complete");
                  onActionComplete();
                },
              },
              { item: "Separator" },
              {
                text: t("common:git.commit.copySha"),
                action: async () => {
                  await copyText(commit.sha);
                  showGitActionDialogSafely(
                    t("common:git.commit.shaCopied"),
                    "info"
                  );
                },
              },
              {
                text: t("common:actions.viewOnGitHub"),
                action: async () => {
                  const remotes = await getGitRemotes({
                    repo_id: repoId,
                    repo_path: repoPath,
                  });
                  const commitUrl = getGitHubCommitUrl(
                    remotes?.remotes ?? [],
                    commit.sha
                  );
                  if (!commitUrl) {
                    showGitActionDialogSafely(
                      "No GitHub remote found for this repo",
                      "warning"
                    );
                    return;
                  }
                  await openExternalLink(commitUrl);
                },
              },
            ];
            return items;
          },
        });
      } catch (error) {
        log.error("[GitHistoryContextMenu] Failed to show menu:", error);
      } finally {
        onClose();
      }
    }

    void showNativeMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
