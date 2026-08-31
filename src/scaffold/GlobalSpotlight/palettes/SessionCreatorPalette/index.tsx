/**
 * SessionCreatorPalette
 *
 * Embeds SessionCreatorChatPanel directly inside the Spotlight shell,
 * letting the user configure and launch a new session without leaving
 * the palette (no navigation to Agent Station).
 */
import React, { useCallback, useMemo } from "react";

import type { SessionLaunchSuccessInfo } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import { SessionCreatorChatPanel } from "@src/features/SessionCreator/variants";
import { Add01Icon } from "@src/icons";
import type { BasePaletteProps } from "@src/scaffold/GlobalSpotlight/shared";

import { SpotlightPillBar } from "../../components";
import { SpotlightShell } from "../../shell";
import type { PathSegment } from "../../types";

export interface SessionCreatorPaletteProps extends BasePaletteProps {
  asBody?: boolean;
}

export function SessionCreatorPalette({
  isOpen,
  onClose,
  onGoBackToParent,
  asBody: _asBody,
}: SessionCreatorPaletteProps) {
  const handleBack = onGoBackToParent ?? onClose;

  const handleSessionStart = useCallback(
    (_info: SessionLaunchSuccessInfo) => {
      onClose();
    },
    [onClose]
  );

  const path = useMemo<PathSegment[]>(
    () => [
      {
        type: "action",
        id: "new-session",
        label: "New Session",
        icon: Add01Icon,
        color: "primary",
      },
    ],
    []
  );

  const body = (
    <div className="flex min-h-0 flex-col">
      <SpotlightPillBar path={path} onRemoveSegment={handleBack} />
      <SessionCreatorChatPanel
        hidePresenceButton
        onSessionStart={handleSessionStart}
        innerClassName="!pb-4"
      />
    </div>
  );

  return (
    <SpotlightShell
      isOpen={isOpen}
      onClose={onClose}
      hasActiveAction
      hideFooter
    >
      {body}
    </SpotlightShell>
  );
}
