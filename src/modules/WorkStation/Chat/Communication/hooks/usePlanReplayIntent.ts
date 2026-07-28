import { useCallback, useState } from "react";

import {
  type PlanIntentOverride,
  computeEffectivePlanPreview,
  computeEffectivePlanView,
} from "../planPreviewView";
import type { MessageViewMode } from "../types";

interface UsePlanReplayIntentOptions {
  baseViewMode: MessageViewMode;
  currentPlanId: string | null;
  setBaseViewMode: (viewMode: MessageViewMode) => void;
}

interface UsePlanReplayIntentReturn {
  effectiveViewMode: MessageViewMode;
  effectivePreviewMode: boolean;
  handleViewModeChange: (viewMode: MessageViewMode) => void;
  handlePreviewModeChange: (previewMode: boolean) => void;
}

/**
 * Keeps the user's replay choices scoped to the pending plan that produced
 * them. A different plan id naturally ignores stale intent without an effect.
 */
export function usePlanReplayIntent({
  baseViewMode,
  currentPlanId,
  setBaseViewMode,
}: UsePlanReplayIntentOptions): UsePlanReplayIntentReturn {
  const [override, setOverride] = useState<PlanIntentOverride | null>(null);

  const recordIntent = useCallback(
    (patch: { view?: MessageViewMode; preview?: boolean }) => {
      if (!currentPlanId) return;
      setOverride((current) =>
        current?.planId === currentPlanId
          ? { ...current, ...patch }
          : { planId: currentPlanId, ...patch }
      );
    },
    [currentPlanId]
  );

  const handleViewModeChange = useCallback(
    (viewMode: MessageViewMode) => {
      setBaseViewMode(viewMode);
      recordIntent({ view: viewMode });
    },
    [recordIntent, setBaseViewMode]
  );

  const handlePreviewModeChange = useCallback(
    (previewMode: boolean) => {
      recordIntent({ preview: previewMode });
    },
    [recordIntent]
  );

  return {
    effectiveViewMode: computeEffectivePlanView({
      baseView: baseViewMode,
      currentPlanId,
      override,
    }),
    effectivePreviewMode: computeEffectivePlanPreview({
      currentPlanId,
      override,
    }),
    handleViewModeChange,
    handlePreviewModeChange,
  };
}
