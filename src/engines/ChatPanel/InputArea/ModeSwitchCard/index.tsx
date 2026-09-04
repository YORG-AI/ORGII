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
import { selectAtom } from "jotai/utils";
import { useCallback, useEffect, useState } from "react";

import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import { createLogger } from "@src/hooks/logger";

import { ModeSwitchCardBody } from "./ModeSwitchCardBody";
import {
  extractPendingModeSwitch,
  pendingModeSwitchEqual,
} from "./pendingModeSwitch";
import { isResolved, skipMode, switchMode } from "./useModeSwitchActions";

const log = createLogger("ModeSwitchInputCard");

const pendingModeSwitchAtom = selectAtom(
  eventsAtom,
  extractPendingModeSwitch,
  pendingModeSwitchEqual
);

function useModeSwitchPending() {
  const pending = useAtomValue(pendingModeSwitchAtom);
  if (pending && isResolved(pending.eventId)) return null;
  return pending;
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
