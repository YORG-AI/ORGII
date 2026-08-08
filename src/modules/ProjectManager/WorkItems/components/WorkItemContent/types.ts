import type { ReactNode } from "react";

import type {
  OrchestratorPhase,
  PrStatus,
  WorkItemHandoffTransition,
  WorkItemHistoryAction,
} from "@src/api/http/project";
import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
  GitHubIssueUser,
} from "@src/api/tauri/github";
import type { Person } from "@src/types/core/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import type { AgentRole } from "../../constants";
import type { WorkItemContentPresentation } from "./presentation";

export const SESSION_TAB_KEYS = ["session", "output", "history"] as const;
export type SessionTab = (typeof SESSION_TAB_KEYS)[number];

export interface WorkItemContentProps {
  workItem: WorkItemExtended;
  /**
   * `thread` presents the task as the primary view. Local Work Items retain
   * Discussion as a drill-in; GitHub issues use their floating comment composer.
   * The presentation omits the legacy lower tab strip and linked-session table.
   */
  presentation?: WorkItemContentPresentation;
  onUpdateWorkItem?: (updates: Partial<WorkItemExtended>) => void;
  onUpdateWorkItemImmediate?: (updates: Partial<WorkItemExtended>) => void;
  currentUser?: Person;
  teamMembers?: Person[];
  headerPath?: ReactNode;
  headerProperties?: ReactNode;
  /** Render the editable title inside the content surface. */
  titleVisible?: boolean;
  repoPath?: string | null;
  projectSlug?: string | null;
  shortId?: string | null;
  /**
   * Reuse activity already owned by the surrounding GitHub detail controller.
   * When omitted, project-backed Work Items resolve and load their own issue
   * timeline from `repoPath` + `shortId`.
   */
  githubIssueTimeline?: {
    items: GitHubIssueTimelineItem[];
    loading: boolean;
  };
  /** Inline GitHub-native body, comment, and status actions for thread surfaces. */
  githubIssueInteraction?: GitHubIssueInteractionConfig;
  onStartAgent?: (instructions?: string) => void;
  isStartingAgent?: boolean;
  onCancelAgent?: () => void;
  onRetry?: () => void;
  onAcceptAsIs?: () => void;
  onCreateFollowUp?: () => void;
  onOpenSession?: (sessionId: string, title?: string) => void;
  onOpenFileDiff?: (filePath: string) => void;
  onOpenFileAtLine?: (filePath: string, line?: number) => void;
  onReviewAllFiles?: (filePaths: string[]) => void;
  onRefreshWorkflow?: () => void;
  /**
   * Optional scope-aware handoff command. Embedded Team Inbox threads use
   * this for org-scoped Work Items that intentionally have no project slug.
   */
  onTransitionHandoff?: (
    transition: WorkItemHandoffTransition
  ) => Promise<WorkItemExtended>;
  activeAgentSessionId?: string | null;
  activeAgentRole?: AgentRole | null;
  isLockedByOther?: boolean;
  lockHolderName?: string | null;
  onCreatePr?: () => Promise<{ url?: string; error?: string }>;
}

export type GitHubIssueCloseReason = "completed" | "not_planned" | "duplicate";

export interface GitHubIssueStatusChangeOptions {
  stateReason?: GitHubIssueCloseReason;
  duplicateIssueId?: number;
}

export interface GitHubIssueInteractionConfig {
  viewer: GitHubIssueUser | null;
  issueState: GitHubIssue["state"];
  duplicateCandidates: GitHubIssue[];
  duplicateCandidatesLoaded: boolean;
  loadingDuplicateCandidates: boolean;
  duplicateCandidatesError: boolean;
  loading: boolean;
  canComment: boolean;
  canEditBody: boolean;
  canManageStatus: boolean;
  submittingComment: boolean;
  updatingBody: boolean;
  updatingStatus: boolean;
  error: "comment" | "status" | null;
  onAddComment: (body: string) => Promise<void>;
  onUpdateBody: (body: string) => Promise<void>;
  onLoadDuplicateCandidates: () => Promise<void>;
  onStatusChange: (
    state: GitHubIssue["state"],
    options?: GitHubIssueStatusChangeOptions
  ) => Promise<void>;
}

export interface OutputTabContentProps {
  workItem: WorkItemExtended;
  repoPath?: string | null;
  onOpenFileDiff?: (filePath: string) => void;
  onOpenFileAtLine?: (filePath: string, line?: number) => void;
  onReviewAllFiles?: (filePaths: string[]) => void;
  onOpenSession?: (sessionId: string, title?: string) => void;
  onRetry?: () => void;
  onAcceptAsIs?: () => void;
  onCreateFollowUp?: () => void;
  onCancel?: () => void;
  onCreatePr?: () => Promise<{ url?: string; error?: string }>;
}

export interface PrSectionProps {
  prUrl?: string;
  prStatus?: PrStatus;
  branch?: string;
  phase: OrchestratorPhase;
  autoCreatePr: boolean;
  onCreatePr?: () => Promise<{ url?: string; error?: string }>;
}

export type PrCreationState = "idle" | "creating" | "error";

export interface HistoryTabProps {
  timelineEntries: TimelineEntry[];
  currentUser: Person;
  isSubscribed: boolean;
  onToggleSubscribe: () => void;
  commentText: string;
  onCommentTextChange: (text: string) => void;
  mentionedUserIds?: string[];
  onMentionedUserIdsChange?: (memberIds: string[]) => void;
  teamMembers?: Person[];
  onCommentSubmit: () => void;
  isSubmittingComment: boolean;
  presentation?: WorkItemContentPresentation;
  canComment?: boolean;
  threadNavigation?: ReactNode;
}

export interface TimelineEntry {
  id: string;
  timestamp: string;
  type: WorkItemHistoryAction;
  actorId?: string;
  userName: string;
  userAvatar?: string;
  userColor?: string;
  descriptions: string[];
  changeFields?: string[];
  changeFieldKeys?: string[];
}
