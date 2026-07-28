import type { ReactNode } from "react";

import type {
  OrchestratorPhase,
  PrStatus,
  WorkItemHistoryAction,
} from "@src/api/http/project";
import type { Person } from "@src/types/core/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import type { AgentRole } from "../../constants";
import type { WorkItemContentPresentation } from "./presentation";

export const SESSION_TAB_KEYS = ["session", "output", "history"] as const;
export type SessionTab = (typeof SESSION_TAB_KEYS)[number];

export interface WorkItemContentProps {
  workItem: WorkItemExtended;
  /**
   * `thread` presents the task as the primary view and Discussion as a drill-in.
   * It omits the legacy lower tab strip and linked-session table.
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
  activeAgentSessionId?: string | null;
  activeAgentRole?: AgentRole | null;
  isLockedByOther?: boolean;
  lockHolderName?: string | null;
  onCreatePr?: () => Promise<{ url?: string; error?: string }>;
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
