import { useAtomValue } from "jotai";
import React, { memo } from "react";

import { sessionHydrationByIdAtom } from "@src/engines/SessionCore";
import type { Session } from "@src/store/session";
import { resolveSessionRowIconPresentation } from "@src/util/session/sessionSidebarRow";

interface SessionIdentityIconProps {
  session: Session | null | undefined;
  sessionId: string;
  isSelected?: boolean;
  className?: string;
}

export const SESSION_IDENTITY_ICON_SIZE = 14;

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
    const { Icon, isMonochromeBrandIcon } = resolveSessionRowIconPresentation(
      session ??
        (hydration?.iconId
          ? { session_id: sessionId, agentIconId: hydration.iconId }
          : sessionId)
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
