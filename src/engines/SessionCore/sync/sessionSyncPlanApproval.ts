import { getPendingPlanApproval } from "@src/api/tauri/agent";
import {
  type PlanApprovalStateMap,
  clearPendingPlanApproval,
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
      if (abortController.signal.aborted) return;
      // Keep the revision-aware merge for a live push racing this RPC, but
      // treat an authoritative null response as removal of stale local state.
      setPendingPlanApprovals((prev) =>
        snapshot
          ? rehydratePendingPlanApprovalIfNewer(prev, snapshot)
          : clearPendingPlanApproval(prev, sessionId)
      );
    } catch {
      // Non-critical: the Build button stays disabled until Rust broadcasts
      // agent:plan_ready_for_approval again.
    }
  };

  void rehydrate();
}
