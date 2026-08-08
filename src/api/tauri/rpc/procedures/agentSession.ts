import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

export const agentSession = {
  listSessions: defineProcedure("agent_session_list")
    .output(z.array(z.string()))
    .build(),
  getSessionInfo: defineProcedure("agent_session_info")
    .input(schemas.agentSession.SessionIdInput)
    .output(schemas.agentSession.SessionInfoSchema.nullable())
    .build(),
  manualCompact: defineProcedure("agent_session_manual_compact")
    .input(schemas.agentSession.ManualCompactInput)
    .output(schemas.agentSession.ManualCompactResultSchema)
    .build(),
  housekeeperContextCompactionStatus: defineProcedure(
    "housekeeper_context_compaction_status"
  )
    .input(schemas.agentSession.SessionIdInput)
    .output(schemas.agentSession.HousekeeperContextCompactionStateSchema)
    .build(),
  setHousekeeperContextCompactionEnabled: defineProcedure(
    "housekeeper_context_compaction_set_enabled"
  )
    .input(schemas.agentSession.HousekeeperContextCompactionEnabledInput)
    .output(schemas.agentSession.HousekeeperContextCompactionStateSchema)
    .build(),
  compactHousekeeperContextNow: defineProcedure(
    "housekeeper_context_compact_now"
  )
    .input(schemas.agentSession.SessionIdInput)
    .output(schemas.agentSession.HousekeeperContextCompactionStateSchema)
    .build(),
  cancelSession: defineProcedure("agent_session_cancel")
    .input(schemas.agentSession.CancelSessionInput)
    .output(z.boolean())
    .build(),
  removeSession: defineProcedure("agent_session_remove")
    .input(schemas.agentSession.SessionIdInput)
    .build(),
  isAgentRunning: defineProcedure("agent_is_running")
    .output(z.boolean())
    .build(),
  loadMessages: defineProcedure("agent_load_messages")
    .input(schemas.agentSession.SessionIdInput)
    .output(z.array(schemas.agentSession.SessionMessageSchema))
    .build(),
  getSession: defineProcedure("agent_get_session")
    .input(schemas.agentSession.SessionIdInput)
    .output(schemas.agentSession.SessionMetaSchema.nullable())
    .build(),
  listAllSessions: defineProcedure("agent_list_all_sessions")
    .output(z.array(schemas.agentSession.SessionMetaSchema))
    .build(),
  deleteSession: defineProcedure("agent_delete_session")
    .input(schemas.agentSession.SessionIdInput)
    .output(schemas.agentSession.DeleteSessionReceiptSchema)
    .build(),
  clearMessages: defineProcedure("agent_clear_messages")
    .input(schemas.agentSession.SessionIdInput)
    .output(z.number())
    .build(),
  truncateAfterMessage: defineProcedure("agent_truncate_after_message")
    .input(schemas.agentSession.TruncateAfterMessageInput)
    .output(z.number())
    .build(),
  checkSnapshotChanges: defineProcedure("agent_check_snapshot_changes")
    .input(schemas.agentSession.CheckSnapshotChangesInput)
    .output(z.boolean())
    .build(),
  updateSessionStatus: defineProcedure("agent_update_session_status")
    .input(schemas.agentSession.UpdateSessionStatusInput)
    .output(z.boolean())
    .build(),
  saveSession: defineProcedure("agent_save_session")
    .input(schemas.agentSession.SaveSessionInput)
    .build(),
  linkSessionToWorkItem: defineProcedure("agent_link_session_to_work_item")
    .input(schemas.agentSession.LinkSessionToWorkItemInput)
    .output(schemas.agentSession.SessionMetaSchema)
    .build(),
  trackSessionAsProject: defineProcedure("agent_track_session_as_project")
    .input(schemas.agentSession.SessionIdInput)
    .output(schemas.agentSession.TrackSessionAsProjectResult)
    .build(),
  respondQuestion: defineProcedure("agent_question_response")
    .input(schemas.agentSession.QuestionResponseInput)
    .build(),
  rejectQuestion: defineProcedure("agent_question_reject")
    .input(schemas.agentSession.SessionRequestIdInput)
    .build(),
  // ── Secret capture (out-of-band; plaintext never reaches LLM) ──
  // Backs the `SecretCaptureModal` ↔ `SecretBroker` round-trip.
  submitSecret: defineProcedure("agent_secret_capture_submit")
    .input(schemas.agentSession.SecretCaptureSubmitInput)
    .build(),
  cancelSecret: defineProcedure("agent_secret_capture_cancel")
    .input(schemas.agentSession.SessionRequestIdInput)
    .build(),
  discardSecret: defineProcedure("agent_secret_capture_discard")
    .input(schemas.agentSession.SecretCaptureDiscardInput)
    .output(z.boolean())
    .build(),
  respondPermission: defineProcedure("agent_permission_response")
    .input(schemas.agentSession.PermissionResponseInput)
    .build(),
  getPendingQuestions: defineProcedure("agent_get_pending_questions")
    .input(schemas.agentSession.SessionIdInput)
    .output(schemas.agentSession.PendingQuestionsOutput)
    .build(),
  respondModeSwitch: defineProcedure("agent_mode_switch_response")
    .input(schemas.agentSession.ModeSwitchResponseInput)
    .build(),
  getPendingPlanApproval: defineProcedure("agent_get_pending_plan_approval")
    .input(schemas.agentSession.SessionIdInput)
    .output(schemas.agentSession.PendingPlanApprovalSchema)
    .build(),
  respondPlanApproval: defineProcedure("agent_plan_approval_response")
    .input(schemas.agentSession.PlanApprovalResponseInput)
    .build(),
  getSessionFiles: defineProcedure("agent_get_session_files")
    .input(schemas.agentSession.SessionIdInput)
    .output(schemas.agentSession.SessionFilesSchema)
    .build(),
  getSessionWorkspacePath: defineProcedure("agent_get_session_workspace_path")
    .input(schemas.agentSession.SessionIdInput)
    .output(z.string().nullable())
    .build(),
  getSnapshots: defineProcedure("agent_get_snapshots")
    .input(schemas.agentSession.SessionIdInput)
    .output(z.array(schemas.agentSession.SnapshotRecordSchema))
    .build(),
  revertToSnapshot: defineProcedure("agent_revert")
    .input(schemas.agentSession.RevertInput)
    .output(schemas.agentSession.RevertResultSchema)
    .build(),
  restoreSnapshot: defineProcedure("agent_restore_snapshot")
    .input(schemas.agentSession.RestoreSnapshotInput)
    .output(schemas.agentSession.RevertResultSchema)
    .build(),
  revertFileReview: defineProcedure("agent_revert_file_review")
    .input(schemas.agentSession.RevertFileReviewInput)
    .output(z.boolean())
    .build(),
  revertFile: defineProcedure("agent_revert_file")
    .input(schemas.agentSession.RevertFileInput)
    .output(z.boolean())
    .build(),
  getTodos: defineProcedure("agent_get_todos")
    .input(schemas.agentSession.SessionIdInput)
    .output(z.array(schemas.agentSession.TodoItemSchema))
    .build(),
  resolveReview: defineProcedure("agent_resolve_review")
    .input(schemas.agentSession.SessionIdInput)
    .output(z.number())
    .build(),
  saveFileResolution: defineProcedure("agent_save_file_resolution")
    .input(schemas.agentSession.FileResolutionInput)
    .build(),
  getFileResolutions: defineProcedure("agent_get_file_resolutions")
    .input(schemas.agentSession.SessionIdInput)
    .output(z.array(schemas.agentSession.FileResolutionSchema))
    .build(),
  getAgentStatus: defineProcedure("agent_get_status")
    .output(schemas.agentSession.AgentStatusInfoSchema)
    .build(),
  sessionLaunch: defineProcedure("session_launch")
    .input(schemas.agentSession.SessionLaunchInput)
    .output(schemas.agentSession.SessionLaunchResultSchema)
    .build(),
  wingmanStart: defineProcedure("wingman_start")
    .input(schemas.agentSession.WingmanStartInput)
    .build(),
  wingmanStop: defineProcedure("wingman_stop")
    .input(schemas.agentSession.SessionIdInput)
    .build(),
  wingmanCloseWindows: defineProcedure("wingman_close_windows").build(),
  wingmanShowDesktopControlTest: defineProcedure(
    "wingman_show_desktop_control_test"
  )
    .input(schemas.agentSession.WingmanDesktopControlTestInput)
    .build(),
  wingmanListMonitors: defineProcedure("wingman_list_monitors")
    .output(z.array(schemas.agentSession.WingmanMonitorSchema))
    .build(),
  sendAdeActionResult: defineProcedure("agent_ade_action_result")
    .input(schemas.agentSession.AdeActionResultInput)
    .build(),
} as const;
