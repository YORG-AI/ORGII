import { getPendingPlanApproval } from "@src/api/tauri/agent";
import {
  type PlanApprovalStateMap,
  rehydratePendingPlanApprovalIfNewer,
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
      // Guard: abort signal may have fired while the RPC was in flight.
      if (abortController.signal.aborted || !snapshot) return;
      // Use the revision-aware merge to avoid clobbering a live
      // plan_ready_for_approval push that arrived before this RPC resolved.
      setPendingPlanApprovals((prev) =>
        rehydratePendingPlanApprovalIfNewer(prev, snapshot)
      );
    } catch {
      // Non-critical: the Build button stays disabled until Rust broadcasts
      // agent:plan_ready_for_approval again.
    }
  };

  void rehydrate();
}
