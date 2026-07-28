import { useAtomValue } from "jotai";

import {
  type PendingPlanApproval,
  pendingPlanApprovalForSessionAtomFamily,
} from "@src/store/session/planApprovalAtom";

export function usePendingPlanApproval(
  sessionId: string | null | undefined
): PendingPlanApproval | null {
  return useAtomValue(pendingPlanApprovalForSessionAtomFamily(sessionId ?? ""));
}
