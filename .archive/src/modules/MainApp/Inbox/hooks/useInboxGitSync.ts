/**
 * useInboxGitSync Hook
 *
 * Syncs git data into the inbox:
 * 1. Upserts git operation history (WebSocket events) to DB
 * 2. Fetches recent commits on HEAD change and persists to DB
 * 3. Derives ephemeral live git status messages (conflicts, sync, uncommitted)
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";

import { getGitCommits } from "@src/api/http/git/commits";
import { gitOperationHistoryAtom } from "@src/store/git/gitOperationAtom";
import { currentGitStatusAtom } from "@src/store/git/gitStatusAtom";
import {
  selectedRepoAtom,
  selectedRepoIdAtom,
  selectedRepoPathAtom,
} from "@src/store/repo";
import { upsertInboxMessageAtom } from "@src/store/ui/inboxAtom";

import type { InboxMessage } from "../types";
import {
  MAX_RECENT_COMMITS,
  gitCommitToInboxMessage,
  gitOperationToInboxMessage,
} from "./converters";

interface UseInboxGitSyncOptions {
  dbLoaded: boolean;
}

export function useInboxGitSync({ dbLoaded }: UseInboxGitSyncOptions) {
  const gitOperationHistory = useAtomValue(gitOperationHistoryAtom);
  const gitStatus = useAtomValue(currentGitStatusAtom);
  const selectedRepoId = useAtomValue(selectedRepoIdAtom);
  const selectedRepo = useAtomValue(selectedRepoAtom);
  const selectedRepoPath = useAtomValue(selectedRepoPathAtom);
  const upsertMessage = useSetAtom(upsertInboxMessageAtom);

  // Track read status for ephemeral live messages
  const [liveReadIds, setLiveReadIds] = useState<Set<string>>(new Set());

  // ============================================
  // 1. Upsert git operation history to DB
  // ============================================

  const syncedOpIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!dbLoaded) return;
    for (const operation of gitOperationHistory) {
      if (syncedOpIdsRef.current.has(operation.id)) continue;
      syncedOpIdsRef.current.add(operation.id);
      const msg = gitOperationToInboxMessage(operation);
      upsertMessage(msg);
    }
    // Cap ref size
    if (syncedOpIdsRef.current.size > 200) {
      const entries = [...syncedOpIdsRef.current];
      syncedOpIdsRef.current = new Set(entries.slice(-100));
    }
  }, [gitOperationHistory, dbLoaded, upsertMessage]);

  // ============================================
  // 2. Fetch recent commits on HEAD change
  // ============================================

  const lastTipRef = useRef<string | null>(null);

  useEffect(() => {
    const tip = gitStatus?.current_tip;
    if (!tip || !selectedRepoId || !dbLoaded) return;
    if (tip === lastTipRef.current) return;
    lastTipRef.current = tip;

    let cancelled = false;

    const fetchAndPersistCommits = async () => {
      try {
        const result = await getGitCommits({
          repo_id: selectedRepoId,
          repo_path: selectedRepoPath || undefined,
          limit: MAX_RECENT_COMMITS,
        });
        if (cancelled || !result?.commits) return;

        const repoName = selectedRepo?.name ?? selectedRepoId;
        for (const commit of result.commits) {
          if (cancelled) return;
          const msg = gitCommitToInboxMessage(commit, repoName);
          await upsertMessage(msg);
        }
      } catch {
        // Silently ignore — git log may fail if repo is mid-operation
      }
    };

    fetchAndPersistCommits();

    return () => {
      cancelled = true;
    };
  }, [
    gitStatus?.current_tip,
    selectedRepoId,
    selectedRepoPath,
    selectedRepo?.name,
    dbLoaded,
    upsertMessage,
  ]);

  // ============================================
  // 3. Ephemeral live git status messages
  // ============================================

  const liveGitMessages = useMemo(() => {
    const live: InboxMessage[] = [];
    if (!gitStatus) return live;

    const uncommitted = gitStatus.working_directory?.files?.length ?? 0;
    const behind = gitStatus.branch_ahead_behind?.behind ?? 0;
    const ahead = gitStatus.branch_ahead_behind?.ahead ?? 0;
    const hasConflicts = gitStatus.do_conflicted_files_exist;

    if (hasConflicts) {
      live.push({
        id: "git-live-conflict",
        title: "Merge Conflicts Detected",
        preview: "Resolve conflicts before continuing",
        content: `Your repo has merge conflicts that need to be resolved.\n\nBranch: ${gitStatus.current_branch}`,
        category: "git",
        priority: "urgent",
        status: "unread",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sender: { name: "Git" },
        metadata: { branch: gitStatus.current_branch },
      });
    }

    if (behind > 0 || ahead > 0) {
      const parts: string[] = [];
      if (behind > 0) {
        parts.push(`${behind} commit${behind > 1 ? "s" : ""} behind`);
      }
      if (ahead > 0) {
        parts.push(`${ahead} commit${ahead > 1 ? "s" : ""} ahead`);
      }
      const summary = parts.join(", ");
      live.push({
        id: "git-live-sync",
        title: "Git Sync Needed",
        preview: `${gitStatus.current_branch} is ${summary}`,
        content: `Branch "${gitStatus.current_branch}" is ${summary}. Sync with upstream to stay up to date.`,
        category: "git",
        priority: "medium",
        status: "unread",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sender: { name: "Git" },
        metadata: { branch: gitStatus.current_branch },
      });
    }

    if (uncommitted > 0) {
      live.push({
        id: "git-live-uncommitted",
        title: `${uncommitted} Uncommitted Change${uncommitted > 1 ? "s" : ""}`,
        preview: `${uncommitted} file${uncommitted > 1 ? "s" : ""} modified on ${gitStatus.current_branch}`,
        content: `You have ${uncommitted} uncommitted file${uncommitted > 1 ? "s" : ""} on branch "${gitStatus.current_branch}". Commit or stash your changes.`,
        category: "git",
        priority: "low",
        status: "unread",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sender: { name: "Git" },
        metadata: { branch: gitStatus.current_branch },
      });
    }

    return live.map((msg) =>
      liveReadIds.has(msg.id) ? { ...msg, status: "read" as const } : msg
    );
  }, [gitStatus, liveReadIds]);

  /** Mark a live message as read (ephemeral, not persisted) */
  const markLiveAsRead = (id: string) => {
    if (id.startsWith("git-live-")) {
      setLiveReadIds((prev) => new Set(prev).add(id));
    }
  };

  return { liveGitMessages, markLiveAsRead };
}
