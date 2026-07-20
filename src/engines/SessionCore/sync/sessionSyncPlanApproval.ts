import { getPendingPlanApproval } from "@src/api/tauri/agent";
import {
  type PlanApprovalStateMap,
  clearPendingPlanApproval,
  upsertPendingPlanApproval,
} from "@src/store/session/planApprovalAtom";

export function rehydratePendingPlanApproval(
  sessionId: string,
  abortController: AbortController,
  setPendingPlanApprovals: (
    update: (prev: PlanApprovalStateMap) => PlanApprovalStateMap
  ) => void
): void {
  const rehydrate = async () => {
    try {
      const snapshot = await getPendingPlanApproval(sessionId);
      if (abortController.signal.aborted) return;
      setPendingPlanApprovals((prev) =>
        snapshot
          ? upsertPendingPlanApproval(prev, snapshot)
          : clearPendingPlanApproval(prev, sessionId)
      );
    } catch {
      // Non-critical: the Build button stays disabled until Rust broadcasts
      // agent:plan_ready_for_approval again.
    }
  };

  void rehydrate();
}
