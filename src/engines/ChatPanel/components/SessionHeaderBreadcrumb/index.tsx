import { useAtomValue } from "jotai";
import React, { memo, useMemo } from "react";

import BreadcrumbFileHeader, {
  type BreadcrumbFileHeaderDisplaySegment,
} from "@src/modules/shared/components/FileHeader/BreadcrumbFileHeader";
import { type Session, sessionByIdAtom } from "@src/store/session";

import SessionIdentityIcon from "../SessionIdentityIcon";
import {
  resolveAgentChildParentSessionId,
  resolveSessionHeaderBreadcrumbDisplay,
} from "./sessionHeaderBreadcrumbDisplay";

export interface SessionHeaderParentTarget {
  sessionId: string;
  sessionName?: string;
  repoPath?: string;
}

interface SessionHeaderBreadcrumbProps {
  session: Session | null | undefined;
  sessionId: string;
  fallbackName: string;
  onParentSessionClick?: (target: SessionHeaderParentTarget) => void;
}

/** Shared My Station-style breadcrumb for session published headers. */
const SessionHeaderBreadcrumb: React.FC<SessionHeaderBreadcrumbProps> = memo(
  ({ session, sessionId, fallbackName, onParentSessionClick }) => {
    const parentSessionId = resolveAgentChildParentSessionId(
      sessionId,
      session?.parentSessionId
    );
    const parentSession = useAtomValue(sessionByIdAtom(parentSessionId ?? ""));
    const display = useMemo(
      () =>
        resolveSessionHeaderBreadcrumbDisplay({
          sessionId,
          sessionName: session?.name,
          fallbackName,
          parentSessionId: session?.parentSessionId,
          orgMemberId: session?.orgMemberId,
          background: session?.background,
          parentSessionName: parentSession?.name,
        }),
      [
        fallbackName,
        parentSession?.name,
        session?.background,
        session?.name,
        session?.orgMemberId,
        session?.parentSessionId,
        sessionId,
      ]
    );
    const displaySegments = useMemo<
      BreadcrumbFileHeaderDisplaySegment[]
    >(() => {
      if (!display.isAgentChildSession) {
        return [{ label: display.displayName }];
      }

      return [
        ...(parentSessionId && display.parentDisplayName
          ? [
              {
                label: display.parentDisplayName,
                title: display.parentFullDisplayName,
                icon: (
                  <SessionIdentityIcon
                    session={parentSession}
                    sessionId={parentSessionId}
                  />
                ),
                onClick: onParentSessionClick
                  ? () =>
                      onParentSessionClick({
                        sessionId: parentSessionId,
                        sessionName: parentSession?.name,
                        repoPath: parentSession?.repoPath,
                      })
                  : undefined,
              },
            ]
          : []),
        { label: display.displayName },
      ];
    }, [display, onParentSessionClick, parentSession, parentSessionId]);

    return (
      <BreadcrumbFileHeader
        filePath={display.fullDisplayName}
        displaySegments={displaySegments}
        lastSegmentIcon={
          <SessionIdentityIcon session={session} sessionId={sessionId} />
        }
        disableNavigation
      />
    );
  }
);

SessionHeaderBreadcrumb.displayName = "SessionHeaderBreadcrumb";

export {
  SESSION_HEADER_CHILD_NAME_MAX_CHARACTERS,
  SESSION_HEADER_NAME_MAX_CHARACTERS,
  SESSION_HEADER_PARENT_NAME_MAX_CHARACTERS,
  resolveAgentChildParentSessionId,
  resolveSessionHeaderBreadcrumbDisplay,
} from "./sessionHeaderBreadcrumbDisplay";
export default SessionHeaderBreadcrumb;
