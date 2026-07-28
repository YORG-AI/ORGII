/**
 * useChatViewPlanPillState
 *
 * Derives the composer's "Plan" pill label (with a live auto-approve
 * countdown) from the session's pending plan approval, ticking once a
 * second only while a plan pill is actually visible.
 */
import { useEffect, useMemo, useState } from "react";

import type { PendingPlanApproval } from "@src/store/session/planApprovalAtom";

function formatPlanPillLabel(
  autoApproveAt: number | null | undefined,
  nowMs = Date.now()
): string {
  if (!autoApproveAt) return "Plan";
  const seconds = Math.max(0, Math.ceil((autoApproveAt - nowMs) / 1000));
  return `Plan · ${seconds}s`;
}

export function useChatViewPlanPillState({
  currentPlanApproval,
  shouldShowCurrentPlanSurface,
}: {
  currentPlanApproval: PendingPlanApproval | null;
  shouldShowCurrentPlanSurface: boolean;
}) {
  const hasPlan = Boolean(currentPlanApproval && shouldShowCurrentPlanSurface);
  const [planPillNowMs, setPlanPillNowMs] = useState(() => Date.now());
  const currentPlanAutoApproveAt = currentPlanApproval?.autoApproveAt ?? null;
  useEffect(() => {
    if (!hasPlan || !currentPlanAutoApproveAt) return;
    const timer = window.setInterval(() => setPlanPillNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [currentPlanAutoApproveAt, hasPlan]);
  const planPillLabel = useMemo(
    () =>
      formatPlanPillLabel(
        hasPlan ? currentPlanAutoApproveAt : null,
        planPillNowMs
      ),
    [currentPlanAutoApproveAt, hasPlan, planPillNowMs]
  );

  return { hasPlan, planPillLabel };
}
