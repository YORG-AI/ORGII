import React, { memo, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { resolveAgentIcon } from "@src/config/agentIcons";
import {
  resolveAgentChildParentSessionId,
  resolveSessionHeaderBreadcrumbDisplay,
} from "@src/engines/ChatPanel/components/SessionHeaderBreadcrumb/sessionHeaderBreadcrumbDisplay";
import BreadcrumbFileHeader, {
  type BreadcrumbFileHeaderDisplaySegment,
} from "@src/modules/shared/components/FileHeader/BreadcrumbFileHeader";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

import type { WebSessionListItem } from "./useWebSessionRoster";
import { webSessionPath } from "./webSessionLocation";

interface WebSessionHeaderBreadcrumbProps {
  session: WebSessionListItem;
  fallbackName: string;
  rosterSessions: readonly WebSessionListItem[];
}

const WebSessionHeaderBreadcrumb: React.FC<WebSessionHeaderBreadcrumbProps> =
  memo(({ session, fallbackName, rosterSessions }) => {
    const navigate = useNavigate();
    const display = useMemo(
      () =>
        resolveSessionDisplayMetadata({
          kind: "remote",
          session,
        }),
      [session]
    );
    const sessionIconElement = useMemo(
      () =>
        React.createElement(resolveAgentIcon(display.agentIconId), {
          size: 14,
          className: "shrink-0 text-text-3",
          "aria-hidden": true,
        }),
      [display.agentIconId]
    );
    const parentSessionId = session.forkedFrom?.sourceSessionId ?? null;
    const parentSession = useMemo(
      () =>
        parentSessionId
          ? (rosterSessions.find(
              (candidate) => candidate.sourceSessionId === parentSessionId
            ) ?? null)
          : null,
      [parentSessionId, rosterSessions]
    );
    const breadcrumb = useMemo(
      () =>
        resolveSessionHeaderBreadcrumbDisplay({
          sessionId: session.sourceSessionId,
          sessionName: session.title,
          fallbackName,
          parentSessionId,
          parentSessionName:
            parentSession?.title ?? session.forkedFrom?.ownerDisplayName,
        }),
      [
        fallbackName,
        parentSession?.title,
        session.forkedFrom?.ownerDisplayName,
        session.sourceSessionId,
        session.title,
        parentSessionId,
      ]
    );

    const displaySegments = useMemo<
      BreadcrumbFileHeaderDisplaySegment[]
    >(() => {
      const sessionNameSegment: BreadcrumbFileHeaderDisplaySegment = {
        label: breadcrumb.displayName,
        title: breadcrumb.fullDisplayName,
      };
      const resolvedParentId = resolveAgentChildParentSessionId(
        session.sourceSessionId,
        parentSessionId
      );
      if (!breadcrumb.isAgentChildSession || !resolvedParentId) {
        return [sessionNameSegment];
      }
      return [
        ...(breadcrumb.parentDisplayName
          ? [
              {
                label: breadcrumb.parentDisplayName,
                title: breadcrumb.parentFullDisplayName,
                icon: sessionIconElement,
                onClick: parentSession
                  ? () => navigate(webSessionPath(parentSession))
                  : undefined,
              },
            ]
          : []),
        sessionNameSegment,
      ];
    }, [
      sessionIconElement,
      breadcrumb,
      navigate,
      parentSession,
      parentSessionId,
      session.sourceSessionId,
    ]);

    return (
      <BreadcrumbFileHeader
        filePath={breadcrumb.fullDisplayName}
        displaySegments={displaySegments}
        lastSegmentIcon={sessionIconElement}
        disableNavigation
      />
    );
  });

WebSessionHeaderBreadcrumb.displayName = "WebSessionHeaderBreadcrumb";

export default WebSessionHeaderBreadcrumb;
