import { useAtomValue } from "jotai";
import React, { memo, useMemo } from "react";

import { WorkstationHeaderSectionSeparator } from "@src/modules/WorkStation/shared/WorkstationHeaderSectionSeparator";
import BreadcrumbFileHeader, {
  type BreadcrumbFileHeaderDisplaySegment,
} from "@src/modules/shared/components/FileHeader/BreadcrumbFileHeader";
import { type Session, sessionByIdAtom } from "@src/store/session";

import SessionIdentityIcon from "../SessionIdentityIcon";
import {
  resolveAgentChildParentSessionId,
  resolveSessionHeaderBreadcrumbDisplay,
} from "./sessionHeaderBreadcrumbDisplay";

const EXTERNAL_OWNER_NAME_MAX_CHARACTERS = 10;

function truncateExternalOwnerName(name: string): string {
  const characters = Array.from(name);
  return characters.length > EXTERNAL_OWNER_NAME_MAX_CHARACTERS
    ? `${characters.slice(0, EXTERNAL_OWNER_NAME_MAX_CHARACTERS).join("")}...`
    : name;
}

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
    const externalOwnerName = session?.importedFrom?.ownerDisplayName?.trim();
    const externalOwnerDisplayName = externalOwnerName
      ? truncateExternalOwnerName(externalOwnerName)
      : undefined;
    const displaySegments = useMemo<
      BreadcrumbFileHeaderDisplaySegment[]
    >(() => {
      const sessionNameSegment: BreadcrumbFileHeaderDisplaySegment = {
        label: display.displayName,
        ...(externalOwnerName && externalOwnerDisplayName
          ? {
              content: (
                <span className="inline-flex min-w-0 items-center gap-2">
                  <span>{display.displayName}</span>
                  <WorkstationHeaderSectionSeparator />
                  <span className="inline-block max-w-40 truncate align-middle font-normal text-text-2">
                    {externalOwnerDisplayName}
                  </span>
                </span>
              ),
              title: `${display.fullDisplayName} | ${externalOwnerName}`,
            }
          : {}),
      };

      if (!display.isAgentChildSession) {
        return [sessionNameSegment];
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
        sessionNameSegment,
      ];
    }, [
      display,
      externalOwnerDisplayName,
      externalOwnerName,
      onParentSessionClick,
      parentSession,
      parentSessionId,
    ]);

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
