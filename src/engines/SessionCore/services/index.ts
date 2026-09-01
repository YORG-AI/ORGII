/**
 * Session Service
 *
 * Unified session operations shared by both AI (OS agent) and UI (human clicks).
 * All sessions are managed by the Rust backend via Tauri.
 */
export { SessionService } from "./SessionService";
export { PlanExecutionService } from "./PlanExecutionService";
export type {
  SessionAnswerQuestionParams,
  SessionCancelParams,
  SessionCreateParams,
  SessionGetStatusParams,
  SessionInfo,
  SessionListParams,
  SessionMergeParams,
  SessionMergeResult,
  SessionOpenParams,
  SessionPauseResumeParams,
  SessionSendMessageParams,
  SessionStatusInfo,
} from "./types";
