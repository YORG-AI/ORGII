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
   * defaults to build and `org2-pm` refuses mutations.
   */
  productMode?: string;
  /**
   * Agent definition override for the launched session. The AI
   * work-item creator launches builtin:os, which always carries
   * run_shell and therefore the injected `org2-pm` CLI used to fill
   * the linked draft.
   */
  agentDefinitionId?: string;
  /**
   * Exec-mode override for the launched session. PM mutation flows
   * pin "build": the work system is reached through `org2-pm` from
   * the shell, and the read-only exec modes (ask/plan/debug) deny
   * run_shell — inheriting the composer's mode would launch a filler
   * that cannot fill.
   */
  agentExecMode?: string;
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
