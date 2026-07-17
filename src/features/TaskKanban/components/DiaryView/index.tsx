import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getGitCommits } from "@src/api/http/git";
import type { GitCommitInfo } from "@src/api/http/git/types";
import {
  type OrgtrackSessionEditArtifact,
  getOrgtrackSessionEditArtifacts,
} from "@src/api/tauri/lineage";
import type { KanbanTask } from "@src/features/KanbanBoard";
import { createLogger } from "@src/hooks/logger";
import type { Session } from "@src/store/session";
import { sessionMapAtom } from "@src/store/session/sessionAtom/atoms";

import { buildDiaryDaySummary } from "../../utils/diaryUtils";
import DiaryPanel from "../DiaryPanel";

const log = createLogger("DiaryView");

export interface DiaryViewProps {
  tasks: KanbanTask[];
  date: Date;
  onTaskClick?: (task: KanbanTask) => void;
}

function getDiarySessionIds(tasks: KanbanTask[]): string[] {
  return Array.from(
    new Set(
      tasks
        .map((task) => task.session_id)
        .filter((sessionId): sessionId is string => Boolean(sessionId))
    )
  );
}

function resolveRepoDisplayName(
  repoPath: string,
  sessionIds: string[],
  sessionMap: ReadonlyMap<string, Session>
): string {
  for (const sessionId of sessionIds) {
    const session = sessionMap.get(sessionId);
    if (!session) continue;

    const sessionRepoPath = session.worktreePath ?? session.repoPath;
    if (sessionRepoPath === repoPath && session.repo_name) {
      return session.repo_name;
    }
  }

  const normalizedPath = repoPath.replace(/\/$/, "");
  const pathSegments = normalizedPath.split(/[/\\]/);
  return pathSegments[pathSegments.length - 1] || repoPath;
}

function getCommitsRowTitle(
  repoPaths: string[],
  sessionIds: string[],
  sessionMap: ReadonlyMap<string, Session>,
  translate: TFunction<"sessions">
): string {
  if (repoPaths.length === 0) {
    return translate("kanban.diary.commits");
  }

  const repoNames = Array.from(
    new Set(
      repoPaths.map((repoPath) =>
        resolveRepoDisplayName(repoPath, sessionIds, sessionMap)
      )
    )
  );

  if (repoNames.length === 1) {
    return translate("kanban.diary.commitsTo", { repo: repoNames[0] });
  }

  return translate("kanban.diary.commitsToMultiple", {
    repos: repoNames.join(", "),
  });
}

function getDiaryRepoPaths(
  sessionIds: string[],
  sessionMap: ReadonlyMap<string, Session>
): string[] {
  return Array.from(
    new Set(
      sessionIds
        .map((sessionId) => {
          const session = sessionMap.get(sessionId);
          return session?.worktreePath ?? session?.repoPath;
        })
        .filter((repoPath): repoPath is string => Boolean(repoPath))
    )
  );
}

const DiaryView: React.FC<DiaryViewProps> = ({ tasks, date, onTaskClick }) => {
  const { t } = useTranslation("sessions");
  const sessionMap = useAtomValue(sessionMapAtom);
  const sessionIds = useMemo(() => getDiarySessionIds(tasks), [tasks]);
  const repoPaths = useMemo(
    () => getDiaryRepoPaths(sessionIds, sessionMap),
    [sessionIds, sessionMap]
  );
  const repoPathKey = useMemo(() => repoPaths.join("\u0000"), [repoPaths]);
  const commitsRowTitle = useMemo(
    () => getCommitsRowTitle(repoPaths, sessionIds, sessionMap, t),
    [repoPaths, sessionIds, sessionMap, t]
  );
  const [orgtrackArtifactsBySessionId, setOrgtrackArtifactsBySessionId] =
    useState<ReadonlyMap<string, OrgtrackSessionEditArtifact[]>>(
      () => new Map()
    );
  const sessionIdsKey = useMemo(() => sessionIds.join("\u0000"), [sessionIds]);
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadOrgtrackArtifacts(): Promise<void> {
      const currentSessionIds = sessionIdsKey
        .split("\u0000")
        .filter((sessionId): sessionId is string => Boolean(sessionId));
      if (currentSessionIds.length === 0) {
        setOrgtrackArtifactsBySessionId(new Map());
        return;
      }

      const entries = await Promise.all(
        currentSessionIds.map(async (sessionId) => {
          const artifacts = await getOrgtrackSessionEditArtifacts({
            sessionId,
          });
          return [sessionId, artifacts] as const;
        })
      );

      if (!cancelled) {
        setOrgtrackArtifactsBySessionId(new Map(entries));
      }
    }

    loadOrgtrackArtifacts().catch((error: unknown) => {
      log.warn("[DiaryView] failed to load orgtrack edit artifacts", error);
      if (!cancelled) setOrgtrackArtifactsBySessionId(new Map());
    });

    return () => {
      cancelled = true;
    };
  }, [sessionIdsKey]);

  useEffect(() => {
    let cancelled = false;

    async function loadCommits(): Promise<void> {
      const currentRepoPaths = repoPathKey
        .split("\u0000")
        .filter((repoPath): repoPath is string => Boolean(repoPath));
      if (currentRepoPaths.length === 0) {
        setCommits([]);
        return;
      }

      const entries = await Promise.all(
        currentRepoPaths.map(async (repoPath) => {
          const result = await getGitCommits({
            repo_id: repoPath,
            repo_path: repoPath,
            limit: 200,
          });
          return result?.commits ?? [];
        })
      );

      if (!cancelled) {
        const commitMap = new Map<string, GitCommitInfo>();
        for (const repoCommits of entries) {
          for (const commit of repoCommits) {
            commitMap.set(commit.sha, commit);
          }
        }
        setCommits(Array.from(commitMap.values()));
      }
    }

    loadCommits().catch((error: unknown) => {
      log.warn("[DiaryView] failed to load git commits", error);
      if (!cancelled) setCommits([]);
    });

    return () => {
      cancelled = true;
    };
  }, [repoPathKey]);

  const summary = useMemo(
    () =>
      buildDiaryDaySummary(
        tasks,
        date,
        new Date(),
        orgtrackArtifactsBySessionId,
        commits
      ),
    [tasks, date, orgtrackArtifactsBySessionId, commits]
  );

  return (
    <div className="h-full min-h-0 w-full overflow-hidden">
      <DiaryPanel
        summary={summary}
        commitsRowTitle={commitsRowTitle}
        onEventClick={(taskId) => {
          const task = tasks.find((candidate) => candidate.id === taskId);
          if (task) onTaskClick?.(task);
        }}
      />
    </div>
  );
};

export default DiaryView;
