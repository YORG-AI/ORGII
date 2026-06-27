/**
 * SessionService - Singleton Session Operations Service
 *
 * Provides session capabilities shared by both AI (OS agent) and UI (human clicks).
 * This is the single source of truth for session operations — both the ActionSystem
 * Zod actions and the UI components call through this service.
 *
 * All sessions are managed by the Rust backend via Tauri:
 * - rust_agent sessions: agentApi (unified)
 * - cli_agent sessions: Tauri commands (cli_agent_*)
 *
 * Usage:
 *   import { SessionService } from "@src/engines/SessionCore/services/SessionService";
 *   await SessionService.sendMessage({ sessionId, content: "fix the bug" });
 */
import {
  CANCEL_REASON,
  getSession as agentGetSession,
  getPendingQuestions,
  respondQuestion,
  sessionLaunch,
} from "@src/api/tauri/agent";
import { ROUTES } from "@src/config/routes";
import { getAdapterForSession } from "@src/engines/SessionCore/sync";
import { createLogger } from "@src/hooks/logger";
import { collectAdeContext } from "@src/services/context/collectors";
import {
  type Session,
  type SessionStatus,
  activeSessionIdAtom,
  loadSessions,
  markSessionActive,
  sessionsAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { invokeTauri } from "@src/util/platform/tauri/init";
import {
  isAgentSession,
  isCliSession,
  isCursorIdeSession,
  isExternalHistorySession,
} from "@src/util/session/sessionDispatch";

import type {
  SessionAnswerQuestionParams,
  SessionCancelParams,
  SessionCreateParams,
  SessionGetStatusParams,
  SessionInfo,
  SessionInterruptParams,
  SessionListParams,
  SessionMergeParams,
  SessionMergeResult,
  SessionOpenParams,
  SessionPauseResumeParams,
  SessionResumeCliParams,
  SessionSendMessageParams,
  SessionStatusInfo,
} from "./types";

const logger = createLogger("SessionService");

// Tracks in-flight merge requests by session ID to prevent concurrent
// duplicate calls from separate UI surfaces (e.g. diff window + kanban panel).
const _mergingSessionIds = new Set<string>();

// ============================================
// Helpers
// ============================================

function throwServiceError(context: string, error: unknown): never {
  const msg = error instanceof Error ? error.message : String(error);
  logger.error(`${context}: ${msg}`);
  throw new Error(`${context}: ${msg}`);
}

/**
 * Throw a clear error for operations that simply don't apply to a
 * Cursor IDE session — there's no ORGII-side process to resume, no
 * `Question` surface to answer, etc. Send / cancel are routed through
 * the adapter (Cursor IDE has working `sendMessage` and a no-op
 * `stopSession`) and never reach this guard.
 */
function assertSupportsManagedOperation(
  sessionId: string,
  operation: string
): void {
  if (isCursorIdeSession(sessionId)) {
    throw new Error(
      `Operation "${operation}" is not supported for Cursor IDE sessions (${sessionId}).`
    );
  }
  if (isExternalHistorySession(sessionId)) {
    throw new Error(
      `Operation "${operation}" is not supported for imported external history sessions (${sessionId}).`
    );
  }
}

function categoryForSession(sessionId: string): SessionInfo["category"] {
  if (isCliSession(sessionId)) return "cli_agent";
  if (isCursorIdeSession(sessionId)) return "cursor_ide";
  if (isExternalHistorySession(sessionId)) return "external_history";
  return "rust_agent";
}

function mapSessionToInfo(session: Session): SessionInfo {
  return {
    sessionId: session.session_id,
    name: session.name || session.user_input || "Unnamed",
    status: session.status,
    category: categoryForSession(session.session_id),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    repoName: session.repo_name,
    branch: session.branch,
    pendingQuestionsCount:
      session.pending_questions_count ?? session.pending_questions?.length ?? 0,
    userInput: session.user_input,
  };
}

// ============================================
// SessionService - Singleton API
// ============================================

export const SessionService = {
  // ==========================================
  // Create
  // ==========================================

  /**
   * Create a new agent session and start it via the unified session_launch command.
   *
   * Supports three dispatch paths determined by params:
   *   1. CLI agent   — params.cliAgentType is set → category: "cli_agent"
   *   2. Hosted key  — params.keySource === "hosted_key" → category: "rust_agent" + tier/listingModel
   *   3. Own key     — default → category: "rust_agent" + model/accountId
   */
  async create(params: SessionCreateParams): Promise<{ sessionId: string }> {
    // For brand-new sessions the chosen repo IS the toolbar repo (the
    // creator picks from the same atom), so prefer the explicit param
    // when supplied and skip the gate when not — at create time there's
    // no persisted row to compare against yet.
    const expectedRepoPath = params.projectRepoPath || params.repoPath || null;
    const adeContext = collectAdeContext({ expectedRepoPath });

    const isCli = Boolean(params.cliAgentType);
    const category = isCli ? "cli_agent" : "rust_agent";

    const launchParams = {
      category,
      content: params.task,
      workspacePath: params.projectRepoPath || params.repoPath || undefined,
      accountId: params.accountId || undefined,
      name: params.name || params.task.slice(0, 60),
      mode: params.mode || undefined,
      agentDefinitionId: params.agentDefinitionId || undefined,
      workItemId: params.workItemId || undefined,
      agentRole: params.agentRole || undefined,
      worktreePath: params.repoPath || undefined,
      keySource: params.keySource || undefined,
      parentSessionId: params.parentSessionId || undefined,
      ideContext: adeContext,
      ...(params.projectSlug ? { projectSlug: params.projectSlug } : {}),
      ...(isCli
        ? { platform: params.cliAgentType }
        : params.keySource === "hosted_key"
          ? {
              tier: params.tier || undefined,
              model: params.listingModel || undefined,
            }
          : { model: params.model || undefined }),
    };

    try {
      const result = await sessionLaunch(
        launchParams as Parameters<typeof sessionLaunch>[0]
      );
      logger.info(
        `Created and started ${category} session: ${result.sessionId}`
      );
      return { sessionId: result.sessionId };
    } catch (error) {
      throwServiceError("Failed to create session", error);
    }
  },

  // ==========================================
  // List / Status
  // ==========================================

  /**
   * List sessions with optional filters.
   */
  async list(params?: SessionListParams): Promise<SessionInfo[]> {
    try {
      await loadSessions({
        forceRefresh: true,
        status: params?.status as SessionStatus | undefined,
        repoPath: params?.repoId,
        limit: params?.limit,
      });

      const store = getInstrumentedStore();
      let result = store.get(sessionsAtom);

      if (params?.status) {
        result = result.filter((session) => session.status === params.status);
      }
      if (params?.repoId) {
        result = result.filter((session) => session.repoPath === params.repoId);
      }
      if (params?.limit) {
        result = result.slice(0, params.limit);
      }

      return result.map(mapSessionToInfo);
    } catch (error) {
      throwServiceError("Failed to list sessions", error);
    }
  },

  /**
   * Get detailed status of a specific session.
   */
  async getStatus(params: SessionGetStatusParams): Promise<SessionStatusInfo> {
    const { sessionId } = params;

    try {
      if (isAgentSession(sessionId)) {
        const session = await agentGetSession(sessionId);
        const pendingResult = await getPendingQuestions(sessionId);
        const pendingQuestionsRaw = pendingResult.pendingQuestions ?? [];

        const pendingQuestions = pendingQuestionsRaw.map((pq) => ({
          questionId: pq.id,
          questionText: pq.question,
        }));

        const sessionStatus = session?.status ?? "completed";
        const hasQuestions = pendingQuestions.length > 0;

        return {
          sessionId,
          status: hasQuestions ? "waiting_for_user" : sessionStatus,
          waitingFor: hasQuestions ? "question_answer" : null,
          pendingQuestions,
          pendingQuestionsCount: pendingQuestions.length,
        };
      }

      const session = await invokeTauri<{
        sessionId: string;
        status: string;
      } | null>("cli_agent_status", { sessionId });

      if (!session) {
        throw new Error(`CLI session not found: ${sessionId}`);
      }

      return {
        sessionId,
        status: session.status,
        waitingFor: null,
        pendingQuestions: [],
        pendingQuestionsCount: 0,
      };
    } catch (error) {
      throwServiceError(`Failed to get status for ${sessionId}`, error);
    }
  },

  // ==========================================
  // Messaging
  // ==========================================

  /**
   * Send a text message to a running session.
   *
   * The previous switch on `isAgentSession` / `isCliSession` lived
   * here; it now lives inside each adapter's `sendMessage`. This
   * keeps adding new IDEs (Trae, Windsurf, ...) to a single new file
   * under `sync/adapters/` instead of patching the service.
   */
  async sendMessage(params: SessionSendMessageParams): Promise<void> {
    const {
      sessionId,
      content,
      displayText,
      model,
      accountId,
      mode,
      imageDataUrls,
      isResume,
      clientMessageId,
      turnIntentId,
    } = params;
    // Gate ADE context on the session row's persisted repo so a session
    // on repo A doesn't ship repo B's editor / git / LSP state when the
    // toolbar happens to point elsewhere. Legacy rows with no
    // `repoPath` fall through to the unconstrained path.
    const sessionRow = getInstrumentedStore().get(sessionByIdAtom(sessionId));
    const adeContext = collectAdeContext({
      expectedRepoPath: sessionRow?.repoPath ?? null,
    });
    const adapter = getAdapterForSession(sessionId);
    if (!adapter) {
      throwServiceError(
        `Failed to send message to ${sessionId}`,
        new Error(`No adapter registered for session ${sessionId}`)
      );
    }

    try {
      await adapter.sendMessage({
        sessionId,
        content,
        displayText,
        model: model || undefined,
        accountId: accountId || undefined,
        mode: mode || undefined,
        imageDataUrls,
        isResume,
        clientMessageId,
        turnIntentId,
        adeContext,
        sessionRepoPath: sessionRow?.repoPath ?? null,
      });
      // Float the row to the top of "today" in the sidebar without
      // waiting for the next session list refresh. The backend will
      // emit its own fresh `updated_at` on the next `loadSessions`,
      // which simply overwrites this local stamp — no drift.
      markSessionActive(sessionId);
      logger.info(`Sent message to ${adapter.category} session: ${sessionId}`);
    } catch (error) {
      throwServiceError(`Failed to send message to ${sessionId}`, error);
    }
  },

  // ==========================================
  // Questions
  // ==========================================

  /**
   * Answer a pending question from the agent.
   *
   * Cursor IDE has no ORGII-side question surface, so the call is
   * rejected up-front rather than reaching the Tauri command.
   */
  async answerQuestion(params: SessionAnswerQuestionParams): Promise<void> {
    const { sessionId, questionId, answer } = params;
    assertSupportsManagedOperation(sessionId, "answerQuestion");

    try {
      await respondQuestion(sessionId, questionId, [[answer]]);
      logger.info(`Answered question ${questionId} for session: ${sessionId}`);
    } catch (error) {
      throwServiceError(`Failed to answer question for ${sessionId}`, error);
    }
  },

  // ==========================================
  // Resume / Cancel / Interrupt
  // ==========================================

  /** Interrupt the currently running turn for any session type. */
  async interrupt(params: SessionInterruptParams): Promise<void> {
    const { sessionId, reason, onError } = params;
    const adapter = getAdapterForSession(sessionId);
    if (!adapter) {
      throwServiceError(
        `Failed to interrupt ${sessionId}`,
        new Error(`No adapter registered for session ${sessionId}`)
      );
    }

    try {
      await adapter.stopSession(sessionId, reason);
      logger.info(`Interrupted ${adapter.category} session: ${sessionId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (onError) {
        onError(msg);
      } else {
        throwServiceError(`Failed to interrupt ${sessionId}`, error);
      }
    }
  },

  /**
   * Resume a paused CLI session.
   *
   * Only CLI sessions support resume; agent sessions get a clearer
   * error and Cursor IDE is rejected up-front because there's no
   * ORGII-side process to resume.
   */
  async resumeCli(params: SessionResumeCliParams): Promise<void> {
    const { sessionId, onError } = params;
    assertSupportsManagedOperation(sessionId, "resumeCli");

    if (isAgentSession(sessionId)) {
      const err =
        "Agent sessions cannot be resumed. Send a new message instead.";
      if (onError) {
        onError(err);
        return;
      }
      throwServiceError(`Failed to resume ${sessionId}`, new Error(err));
    }

    try {
      await invokeTauri("cli_agent_resume", { sessionId });
      logger.info(`Resumed CLI session: ${sessionId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (onError) {
        onError(msg);
      } else {
        throwServiceError(`Failed to resume ${sessionId}`, error);
      }
    }
  },

  /**
   * Resume a paused session.
   *
   * @deprecated Use `resumeCli` for CLI sessions. This method is retained
   * for ActionSystem backward-compatibility.
   */
  async resume(params: SessionPauseResumeParams): Promise<void> {
    const { sessionId } = params;
    assertSupportsManagedOperation(sessionId, "resume");

    try {
      if (isAgentSession(sessionId)) {
        throw new Error(
          "Agent sessions cannot be resumed. Send a new message instead."
        );
      }

      await invokeTauri("cli_agent_resume", { sessionId });
      logger.info(`Resumed CLI session: ${sessionId}`);
    } catch (error) {
      throwServiceError(`Failed to resume ${sessionId}`, error);
    }
  },

  /**
   * Cancel/stop a session entirely.
   *
   * Routes through the adapter so each session type cleans up the
   * way it knows how. Cursor IDE's adapter no-ops here (the user
   * cancels Cursor turns inside the probe window).
   */
  async cancel(params: SessionCancelParams): Promise<void> {
    const { sessionId } = params;
    const adapter = getAdapterForSession(sessionId);
    if (!adapter) {
      throwServiceError(
        `Failed to cancel ${sessionId}`,
        new Error(`No adapter registered for session ${sessionId}`)
      );
    }

    try {
      await adapter.stopSession(sessionId, CANCEL_REASON.USER_STOP);
      logger.info(`Cancelled ${adapter.category} session: ${sessionId}`);
    } catch (error) {
      throwServiceError(`Failed to cancel ${sessionId}`, error);
    }
  },

  // ==========================================
  // Navigation (GUI)
  // ==========================================

  /**
   * Navigate to a session's workspace view.
   * Sets the active session ID atom and fires a navigation event to WorkStation.
   */
  async open(params: SessionOpenParams): Promise<void> {
    const { sessionId } = params;
    const store = getInstrumentedStore();
    store.set(workstationActiveSessionIdAtom, sessionId);
    store.set(activeSessionIdAtom, sessionId);
    window.dispatchEvent(
      new CustomEvent("action-system-navigate", {
        detail: { path: ROUTES.workStation.base.path },
      })
    );
    logger.info(`Opened session: ${sessionId}`);
  },

  // ==========================================
  // Worktree Operations
  // ==========================================

  /**
   * Merge a session's worktree branch back into the base branch.
   */
  async merge(params: SessionMergeParams): Promise<SessionMergeResult> {
    const { sessionId, strategy } = params;

    if (isAgentSession(sessionId)) {
      throw new Error(
        "Merge is not supported for Agent sessions (no worktree)"
      );
    }

    if (_mergingSessionIds.has(sessionId)) {
      throw new Error(`Merge already in progress for session ${sessionId}`);
    }

    _mergingSessionIds.add(sessionId);
    try {
      const result = await invokeTauri<SessionMergeResult>("cli_agent_merge", {
        sessionId,
        strategy: strategy ?? "auto",
      });
      logger.info(
        `Merge result for session ${sessionId}: merged=${result.merged}`
      );
      return result;
    } catch (error) {
      throwServiceError(`Failed to merge session ${sessionId}`, error);
    } finally {
      _mergingSessionIds.delete(sessionId);
    }
  },

  /**
   * Get diff between a session's worktree branch and its base branch.
   * Only works for sessions with worktree isolation.
   */
  async worktreeDiff(sessionId: string): Promise<string> {
    try {
      return await invokeTauri<string>("cli_agent_worktree_diff", {
        sessionId,
      });
    } catch (error) {
      throwServiceError(`Failed to get worktree diff for ${sessionId}`, error);
    }
  },

  /**
   * Get a unified diff patch for all files modified during a session.
   *
   * Uses the per-session file-history snapshots (pre-edit bytes vs. current
   * on-disk content). Works for every SDE Agent session regardless of whether
   * worktree isolation was used. Returns an empty string when no file-history
   * snapshots exist.
   */
  async sessionDiff(sessionId: string): Promise<string> {
    try {
      return await invokeTauri<string>("cache_get_session_diff", {
        sessionId,
      });
    } catch (error) {
      throwServiceError(`Failed to get session diff for ${sessionId}`, error);
    }
  },

  /**
   * Discard a session's worktree (remove worktree and delete branch).
   */
  async worktreeDiscard(sessionId: string): Promise<boolean> {
    try {
      const result = await invokeTauri<boolean>("cli_agent_worktree_discard", {
        sessionId,
      });
      logger.info(`Discarded worktree for session ${sessionId}`);
      return result;
    } catch (error) {
      throwServiceError(`Failed to discard worktree for ${sessionId}`, error);
    }
  },
};
