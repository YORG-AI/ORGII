/**
 * Session Service
 *
 * Unified session operations shared by both AI (OS agent) and UI (human clicks).
 * All sessions are managed by the Rust backend via Tauri.
 */
export { SessionService } from "./SessionService";
export { PlanExecutionService } from "./PlanExecutionService";
export type { SessionSendMessageParams } from "./types";
