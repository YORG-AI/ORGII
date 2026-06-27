/**
 * ModeSwitchInputCard
 *
 * Renders the mode-switch suggestion card above the InputArea (same slot as
 * AskQuestionCard). Reads the latest unresolved `suggest_mode_switch` event
 * from the session event store and shows Skip / Switch buttons.
 *
 * The chat history event (ModeSwitchEvent) renders the resolved state
 * (switched / skipped / pending header). This card only handles the
 * actionable state.
 */
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";

import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import { stripMcpPrefix } from "@src/engines/SessionCore/core/interactiveTools";
import { createLogger } from "@src/hooks/logger";

import { ModeSwitchCardBody } from "./ModeSwitchCardBody";
import { isResolved, skipMode, switchMode } from "./useModeSwitchActions";

const log = createLogger("ModeSwitchInputCard");

// ============================================
// Hook
// ============================================

interface PendingModeSwitch {
  eventId: string;
  targetMode: string;
  reason: string;
  createdAt?: string;
}

function useModeSwitchPending(): PendingModeSwitch | null {
  const events = useAtomValue(eventsAtom);

  for (let idx = events.length - 1; idx >= 0; idx--) {
    const event = events[idx];
    if (stripMcpPrefix(event.functionName ?? "") !== "suggest_mode_switch")
      continue;
    if (event.activityStatus === "processed") continue;
    const eventId = event.id ?? "";
    if (isResolved(eventId)) continue;

    return {
      eventId,
      targetMode:
        (event.args.target_mode as string | undefined) ??
        (event.args.targetModeId as string | undefined) ??
        "plan",
      reason:
        (event.args.reason as string | undefined) ??
        (event.args.explanation as string | undefined) ??
        "",
      createdAt: event.createdAt,
    };
  }
  return null;
}

// ============================================
// Component
// ============================================

interface ModeSwitchInputCardProps {
  collapsed?: boolean;
  onCollapse?: () => void;
  onHasDataChange?: (hasData: boolean) => void;
}

export function ModeSwitchInputCard({
  collapsed,
  onCollapse,
  onHasDataChange,
}: ModeSwitchInputCardProps = {}) {
  const pending = useModeSwitchPending();

  const [dismissed, setDismissed] = useState<string | null>(null);

  const handleSwitch = useCallback(() => {
    if (!pending) return;
    setDismissed(pending.eventId);
    switchMode(pending.eventId, pending.targetMode).catch((err: unknown) => {
      log.error("[ModeSwitchInputCard] Failed to switch mode:", err);
    });
  }, [pending]);

  const handleSkip = useCallback(() => {
    if (!pending) return;
    setDismissed(pending.eventId);
    skipMode(pending.eventId).catch((err: unknown) => {
      log.error("[ModeSwitchInputCard] Failed to skip mode switch:", err);
    });
  }, [pending]);

  const isActive = !!pending && dismissed !== pending.eventId;

  useEffect(() => {
    onHasDataChange?.(isActive);
  }, [isActive, onHasDataChange]);

  if (!isActive) return null;

  return (
    <div
      data-tool-call-event-id={pending.eventId}
      data-tool-call-name="suggest_mode_switch"
    >
      <ModeSwitchCardBody
        key={pending.eventId}
        targetMode={pending.targetMode}
        reason={pending.reason}
        createdAt={pending.createdAt}
        onSwitch={handleSwitch}
        onSkip={handleSkip}
        collapsed={collapsed}
        onCollapse={onCollapse}
      />
    </div>
  );
}

ModeSwitchInputCard.displayName = "ModeSwitchInputCard";
