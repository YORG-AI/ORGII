/**
 * Types for useSessionLaunch hook
 */
import type { RefObject } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import type {
  AdvancedConfig,
  SessionCreatorLaunchMode,
} from "@src/features/SessionCreator/types";
import type {
  SessionLaunchOrgContext,
  SessionSource,
} from "@src/store/session/creatorStateAtom";

import type { SessionValidationResult } from "../useSessionValidation";

export interface SessionLaunchWorkItemContext extends Partial<SessionLaunchOrgContext> {
  workItemId?: string;
  projectSlug?: string;
  agentRole?: string;
  /**
   * orgtrack/v1 §5.2 product-mode axis for the launched session. Flows
   * whose whole purpose is PM mutation (Create Project with AI) must set
   * "project" explicitly — without a workItemId the backend resolver
   * defaults to build and the PM tools are policy-denied.
   */
  productMode?: string;
  /**
   * Agent definition override for the launched session. The AI
   * work-item creator needs an agent that actually registers
   * `manage_work_item` (builtin:os) — launching whatever agent the
   * composer happens to have selected (usually SDE) produces a session
   * that cannot fill the draft it was created for.
   */
  agentDefinitionId?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionLaunchSuccessInfo {
  sessionId: string;
  workItemContext?: SessionLaunchWorkItemContext;
}

export interface UseSessionLaunchOptions {
  /**
   * Repo/branch the new session will run against.
   * Authoritative for launch — does NOT reflect (or mutate) the global
   * toolbar's `selectedRepoIdAtom`. Built by useSessionCreator by seeding
   * from the global atom on first mount and updated only through the
   * SessionCreator's pill.
   */
  effectiveSource: SessionSource | null;
  editorContent: string;
  sessionName: string;
  advancedConfig: AdvancedConfig;
  isContentEmpty: boolean;
  validateSessionConfig: () => SessionValidationResult;
  composerInputRef: RefObject<ComposerInputRef | null>;
  onLaunchSuccess?: (info: SessionLaunchSuccessInfo) => void;
  launchMode?: SessionCreatorLaunchMode;
  workItemContext?: SessionLaunchWorkItemContext;
  resolveWorkItemContext?: () => Promise<SessionLaunchWorkItemContext | null>;
  /** Base64 data URLs from pasted images */
  imageDataUrls?: string[];
  /** Clear images after launch */
  clearImages?: () => void;
}

export interface UseSessionLaunchReturn {
  isLoading: boolean;
  handleLaunch: () => Promise<boolean>;
  /**
   * True when an "out of funds" wallet error was caught. The modal
   * component lives in `.market/` (archived for OSS); the render site
   * mounts nothing in OSS builds and shows a toast instead. The flag
   * seam is preserved so the commercial build only has to restore the
   * modal mount JSX + import, not the state plumbing.
   */
  showAddFundsModal: boolean;
  closeAddFundsModal: () => void;
  /**
   * True when an "out of ORGII/ORGII credits" error was caught. Same
   * OSS/commercial seam as showAddFundsModal — see that field's note.
   */
  showBuyCreditsModal: boolean;
  closeBuyCreditsModal: () => void;
}
