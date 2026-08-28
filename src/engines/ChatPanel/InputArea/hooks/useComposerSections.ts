/**
 * useComposerSections
 *
 * Manages expand/collapse state for all ComposerStack sections:
 *
 * Primary cards (question, permission, modeswitch) — always-visible when
 * active; collapse to a primary-6 pill at the front of the pill row.
 *
 * Secondary sections (queue, processes, files) — pill-only; one card open
 * at a time.
 *
 * Shared between ChatView and PlaygroundChatPanel.
 */
import React, { useCallback, useMemo, useState } from "react";

import {
  ArrowLeftRightIcon,
  ClipboardListIcon,
  ComputerTerminal01Icon,
  DiffIcon,
  GitCommitHorizontalIcon,
  HelpCircleIcon,
  HugeiconsIcon,
  MessageCircleMoreIcon,
  NotificationBubbleIcon,
} from "@src/icons";

import type { InlineSection } from "../components/CollapsedInlineRow";
import {
  type ComposerActiveSection,
  resolveComposerSectionForSessionSwitch,
} from "./composerSectionState";

export interface FileChangeStats {
  count: number;
  additions: number;
  deletions: number;
}

export interface GitArtifactStats {
  commitCount: number;
  pullRequestCount: number;
}

export interface UseComposerSectionsOptions {
  sessionId?: string | null;
  queueCount: number;
  enqueueCount?: number;
  /** Whether the AskQuestionCard currently has pending data (controls pill visibility). */
  hasQuestion?: boolean;
  /** Whether the PermissionCard currently has pending data. */
  hasPermission?: boolean;
  /** Whether the ModeSwitchCard currently has pending data. */
  hasModeSwitch?: boolean;
  /** Whether the CreatePlanCard currently has a pending plan to review. */
  hasPlan?: boolean;
  /** Label shown on the collapsed plan pill. */
  planPillLabel?: string;
  /** Commit / pull request counts supplied by Rust Orgtrack for the current session. */
  gitArtifactStats?: GitArtifactStats;
  /** Opens the dedicated file-diff surface when the files/submissions pill is clicked. */
  onFilesExpand: () => void;
  /**
   * When provided, the files / git-artifacts pills open this dropdown menu
   * instead of invoking `onFilesExpand` directly. Surfaces without a menu
   * (e.g. the DevTools playground) keep the plain expand behavior.
   */
  filesMenu?: React.ReactNode;
  includeFileSections?: boolean;
}

const NOOP = () => {};

export function createFileInlineSection({
  fileChangeStats,
  onFilesExpand,
  filesMenu,
}: {
  fileChangeStats: FileChangeStats;
  onFilesExpand: () => void;
  filesMenu?: React.ReactNode;
}): InlineSection | null {
  if (fileChangeStats.count <= 0) return null;

  const diffStatNodes: React.ReactNode[] = [];
  if (fileChangeStats.additions > 0) {
    diffStatNodes.push(
      React.createElement(
        "span",
        { key: "additions", className: "font-normal text-green-500" },
        `+${fileChangeStats.additions}`
      )
    );
  }
  if (fileChangeStats.deletions > 0) {
    diffStatNodes.push(
      React.createElement(
        "span",
        { key: "deletions", className: "font-normal text-red-500" },
        `-${fileChangeStats.deletions}`
      )
    );
  }

  return {
    key: "files",
    icon: React.createElement(HugeiconsIcon, { icon: DiffIcon, size: 13 }),
    count: fileChangeStats.count,
    content: React.createElement(
      "span",
      { className: "inline-flex items-center gap-2" },
      React.createElement("span", null, fileChangeStats.count),
      diffStatNodes.length > 0
        ? React.createElement("span", {
            className:
              "inline-block h-0.5 w-0.5 shrink-0 rounded-full bg-text-4",
            "aria-hidden": true,
          })
        : null,
      ...diffStatNodes
    ),
    active: false,
    onExpand: filesMenu ? NOOP : onFilesExpand,
    droplist: filesMenu,
    testId: "composer-section-files",
  };
}

export function useComposerSections({
  sessionId,
  queueCount,
  enqueueCount = 0,
  hasQuestion = false,
  hasPermission = false,
  hasModeSwitch = false,
  hasPlan = false,
  planPillLabel = "Plan",
  gitArtifactStats = { commitCount: 0, pullRequestCount: 0 },
  onFilesExpand,
  filesMenu,
  includeFileSections = true,
}: UseComposerSectionsOptions) {
  // Primary card collapsed states
  const [questionCollapsed, setQuestionCollapsed] = useState(false);
  const [permissionCollapsed, setPermissionCollapsed] = useState(false);
  const [modeSwitchCollapsed, setModeSwitchCollapsed] = useState(false);
  const [planCollapsed, setPlanCollapsed] = useState(false);

  // Secondary section — only one card open at a time. Persist this per
  // session so queued messages stay discoverable when users switch away and
  // return after the turn has completed.
  const [activeSection, setActiveSection] =
    useState<ComposerActiveSection>(null);
  const [activeSectionBySession, setActiveSectionBySession] = useState(
    () => new Map<string, ComposerActiveSection>()
  );

  // Counts reported by child components
  const [processVisibleCount, setProcessVisibleCount] = useState(0);
  const [fileChangeStats, setFileChangeStatsState] = useState<FileChangeStats>({
    count: 0,
    additions: 0,
    deletions: 0,
  });
  const setFileChangeStats = useCallback((next: FileChangeStats) => {
    setFileChangeStatsState((current) =>
      current.count === next.count &&
      current.additions === next.additions &&
      current.deletions === next.deletions
        ? current
        : next
    );
  }, []);

  const [prevSessionId, setPrevSessionId] = useState(sessionId);
  if (sessionId !== prevSessionId) {
    const { activeSection: nextActiveSection, storedSectionForPrevious } =
      resolveComposerSectionForSessionSwitch({
        previousSessionId: prevSessionId,
        nextSessionId: sessionId,
        currentActiveSection: activeSection,
        queueCount,
        previouslyStoredSection: sessionId
          ? activeSectionBySession.get(sessionId)
          : undefined,
      });
    if (prevSessionId && storedSectionForPrevious !== undefined) {
      setActiveSectionBySession((current) => {
        const next = new Map(current);
        next.set(prevSessionId, storedSectionForPrevious);
        return next;
      });
    }
    setPrevSessionId(sessionId);
    setActiveSection(nextActiveSection);
    setProcessVisibleCount(0);
    setFileChangeStats({ count: 0, additions: 0, deletions: 0 });
  }

  // Auto-expand queue when messages arrive. Prefer the monotonic enqueue
  // counter when it is available, but also react to count growth so the queue
  // stays visible if the counter update and queue filter land in different
  // render passes or a session switch restores a non-empty queue.
  const [prevEnqueueCount, setPrevEnqueueCount] = useState(enqueueCount);
  const [prevQueueCount, setPrevQueueCount] = useState(queueCount);
  const [queueAutoOpenedForCount, setQueueAutoOpenedForCount] = useState(
    queueCount > 0 ? queueCount : 0
  );
  if (prevEnqueueCount !== enqueueCount || prevQueueCount !== queueCount) {
    const hasNewQueueWork =
      queueCount > 0 &&
      (enqueueCount > prevEnqueueCount || queueCount > prevQueueCount);
    setPrevEnqueueCount(enqueueCount);
    setPrevQueueCount(queueCount);
    setQueueAutoOpenedForCount(hasNewQueueWork ? queueCount : 0);
    if (hasNewQueueWork) {
      setActiveSection("queue");
    }
  } else if (queueCount === 0 && queueAutoOpenedForCount !== 0) {
    setQueueAutoOpenedForCount(0);
  } else if (
    queueCount > 0 &&
    activeSection !== "queue" &&
    queueAutoOpenedForCount < queueCount
  ) {
    setQueueAutoOpenedForCount(queueCount);
    setActiveSection("queue");
  }

  // Restore collapsed → expanded when the card's data resets (new question, new permission, etc.)
  const [prevHasQuestion, setPrevHasQuestion] = useState(hasQuestion);
  if (hasQuestion !== prevHasQuestion) {
    setPrevHasQuestion(hasQuestion);
    if (hasQuestion) setQuestionCollapsed(false);
  }
  const [prevHasPermission, setPrevHasPermission] = useState(hasPermission);
  if (hasPermission !== prevHasPermission) {
    setPrevHasPermission(hasPermission);
    if (hasPermission) setPermissionCollapsed(false);
  }
  const [prevHasModeSwitch, setPrevHasModeSwitch] = useState(hasModeSwitch);
  if (hasModeSwitch !== prevHasModeSwitch) {
    setPrevHasModeSwitch(hasModeSwitch);
    if (hasModeSwitch) setModeSwitchCollapsed(false);
  }
  const [prevHasPlan, setPrevHasPlan] = useState(hasPlan);
  if (hasPlan !== prevHasPlan) {
    setPrevHasPlan(hasPlan);
    if (hasPlan) setPlanCollapsed(false);
  }

  const collapseQuestion = useCallback(() => setQuestionCollapsed(true), []);
  const expandQuestion = useCallback(() => setQuestionCollapsed(false), []);
  const collapsePermission = useCallback(
    () => setPermissionCollapsed(true),
    []
  );
  const expandPermission = useCallback(() => setPermissionCollapsed(false), []);
  const collapseModeSwitch = useCallback(
    () => setModeSwitchCollapsed(true),
    []
  );
  const expandModeSwitch = useCallback(() => setModeSwitchCollapsed(false), []);
  const collapsePlan = useCallback(() => setPlanCollapsed(true), []);
  const expandPlan = useCallback(() => setPlanCollapsed(false), []);

  const toggleQueue = useCallback(
    () => setActiveSection((prev) => (prev === "queue" ? null : "queue")),
    []
  );
  const toggleProcess = useCallback(
    () => setActiveSection((prev) => (prev === "process" ? null : "process")),
    []
  );
  const queueExpanded = activeSection === "queue";
  const processExpanded = activeSection === "process";

  const hasQueue = queueCount > 0;
  const hasProcess = processVisibleCount > 0;
  const hasFiles = includeFileSections && fileChangeStats.count > 0;
  const gitArtifactCount =
    gitArtifactStats.commitCount + gitArtifactStats.pullRequestCount;
  const hasGitArtifacts = gitArtifactCount > 0;

  const hasAny =
    hasQueue ||
    hasProcess ||
    hasFiles ||
    hasGitArtifacts ||
    (hasQuestion && questionCollapsed) ||
    (hasPermission && permissionCollapsed) ||
    (hasModeSwitch && modeSwitchCollapsed) ||
    (hasPlan && planCollapsed);

  const inlineSections = useMemo<InlineSection[]>(() => {
    const sections: InlineSection[] = [];

    // Primary pills — leading, primary-6 variant, icon + text label
    if (hasQuestion && questionCollapsed) {
      sections.push({
        key: "question",
        icon: React.createElement(HugeiconsIcon, {
          icon: HelpCircleIcon,
          size: 13,
        }),
        count: 0,
        label: "Question",
        active: false,
        variant: "primary",
        onExpand: expandQuestion,
      });
    }
    if (hasPermission && permissionCollapsed) {
      sections.push({
        key: "permission",
        icon: React.createElement(HugeiconsIcon, {
          icon: NotificationBubbleIcon,
          size: 13,
        }),
        count: 0,
        label: "Permission",
        active: false,
        variant: "primary",
        onExpand: expandPermission,
      });
    }
    if (hasModeSwitch && modeSwitchCollapsed) {
      sections.push({
        key: "modeswitch",
        icon: React.createElement(HugeiconsIcon, {
          icon: ArrowLeftRightIcon,
          size: 13,
        }),
        count: 0,
        label: "Mode Switch",
        active: false,
        variant: "primary",
        onExpand: expandModeSwitch,
      });
    }
    if (hasPlan && planCollapsed) {
      sections.push({
        key: "plan",
        icon: React.createElement(HugeiconsIcon, {
          icon: ClipboardListIcon,
          size: 13,
        }),
        count: 0,
        label: planPillLabel,
        active: false,
        variant: "primary",
        onExpand: expandPlan,
        testId: "composer-section-plan",
      });
    }

    // Secondary pills
    if (hasQueue) {
      sections.push({
        key: "queue",
        icon: React.createElement(HugeiconsIcon, {
          icon: MessageCircleMoreIcon,
          size: 13,
        }),
        count: queueCount,
        active: queueExpanded,
        onExpand: toggleQueue,
        testId: "composer-section-queue",
      });
    }
    if (hasProcess) {
      sections.push({
        key: "process",
        icon: React.createElement(HugeiconsIcon, {
          icon: ComputerTerminal01Icon,
          size: 13,
        }),
        count: processVisibleCount,
        active: processExpanded,
        onExpand: toggleProcess,
        testId: "composer-section-process",
      });
    }
    if (includeFileSections) {
      const fileSection = createFileInlineSection({
        fileChangeStats,
        onFilesExpand,
        filesMenu,
      });
      if (fileSection) {
        sections.push(fileSection);
      }
    }
    if (hasGitArtifacts) {
      sections.push({
        key: "git-artifacts",
        icon: React.createElement(HugeiconsIcon, {
          icon: GitCommitHorizontalIcon,
          size: 13,
        }),
        count: gitArtifactCount,
        active: false,
        onExpand: filesMenu ? NOOP : onFilesExpand,
        droplist: filesMenu,
        testId: "composer-section-git-artifacts",
      });
    }

    return sections;
  }, [
    hasQuestion,
    questionCollapsed,
    hasPermission,
    permissionCollapsed,
    hasModeSwitch,
    modeSwitchCollapsed,
    hasPlan,
    planPillLabel,
    planCollapsed,
    expandQuestion,
    expandPermission,
    expandModeSwitch,
    expandPlan,
    hasQueue,
    hasProcess,
    hasGitArtifacts,
    queueCount,
    processVisibleCount,
    fileChangeStats,
    gitArtifactCount,
    queueExpanded,
    processExpanded,
    toggleQueue,
    toggleProcess,
    onFilesExpand,
    filesMenu,
    includeFileSections,
  ]);

  return {
    // Primary card collapse state
    questionCollapsed,
    permissionCollapsed,
    modeSwitchCollapsed,
    planCollapsed,
    collapseQuestion,
    collapsePermission,
    collapseModeSwitch,
    collapsePlan,
    // Secondary section state
    queueExpanded,
    processExpanded,
    toggleQueue,
    toggleProcess,
    hasAny,
    inlineSections,
    setProcessVisibleCount,
    setFileChangeStats,
  };
}
