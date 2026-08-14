import { useAtomValue } from "jotai";
import React, { memo } from "react";

import { sessionHydrationByIdAtom } from "@src/engines/SessionCore";
import { useCloudSessionPendingPlayEntry } from "@src/features/Org2Cloud/useCloudSessionDownloadSurface";
import type { Session } from "@src/store/session";
import { resolveSessionRowIconPresentation } from "@src/util/session/sessionSidebarRow";

interface SessionIdentityIconProps {
  session: Session | null | undefined;
  sessionId: string;
  isSelected?: boolean;
  className?: string;
}

export const SESSION_IDENTITY_ICON_SIZE = 14;

export function resolveSessionIdentityIconSource(
  session: Session | null | undefined,
  sessionId: string,
  pendingIconId: string | null | undefined,
  hydrationIconId: string | null | undefined
): Session | { session_id: string; agentIconId: string } | string {
  if (pendingIconId) {
    return { session_id: sessionId, agentIconId: pendingIconId };
  }
  if (session) return session;
  if (hydrationIconId) {
    return { session_id: sessionId, agentIconId: hydrationIconId };
  }
  return sessionId;
}

export function resolveSessionIdentityIconColorClass(
  isSelected: boolean,
  isMonochromeBrandIcon: boolean
): string {
  if (!isSelected || !isMonochromeBrandIcon) return "text-text-2";
  return "text-text-1";
}

/** The canonical session icon treatment used by Chat Panel session tabs. */
const SessionIdentityIcon: React.FC<SessionIdentityIconProps> = memo(
  ({ session, sessionId, isSelected = true, className = "" }) => {
    const hydration = useAtomValue(sessionHydrationByIdAtom(sessionId));
    const pendingPlay = useCloudSessionPendingPlayEntry(sessionId);
    const { Icon, isMonochromeBrandIcon } = resolveSessionRowIconPresentation(
      resolveSessionIdentityIconSource(
        session,
        sessionId,
        pendingPlay?.iconId,
        hydration?.iconId
      )
    );
    const colorClass = resolveSessionIdentityIconColorClass(
      isSelected,
      isMonochromeBrandIcon
    );

    return (
      <span
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${colorClass} ${className}`.trim()}
        aria-hidden
      >
        {React.createElement(Icon, {
          size: SESSION_IDENTITY_ICON_SIZE,
          strokeWidth: 2,
          className: "shrink-0",
        })}
      </span>
    );
  }
);

SessionIdentityIcon.displayName = "SessionIdentityIcon";

export default SessionIdentityIcon;
