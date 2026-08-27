import { useAtomValue } from "jotai";
import React, { memo } from "react";

import Org2SessionIcon from "@src/assets/modelIcons/org2-session.svg";
import { sessionByIdAtom } from "@src/store/session";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

interface FileSessionHistoryIconProps {
  sessionId: string;
  isOrg2Session?: boolean;
}

export const FileSessionHistoryIcon = memo(
  ({ sessionId, isOrg2Session = false }: FileSessionHistoryIconProps) => {
    const session = useAtomValue(sessionByIdAtom(sessionId));

    if (isOrg2Session) {
      return <Org2SessionIcon className="size-3.5" aria-hidden="true" />;
    }

    return React.createElement(resolveSessionRowIcon(session ?? sessionId), {
      size: 14,
      className: "text-text-1",
    });
  }
);

FileSessionHistoryIcon.displayName = "FileSessionHistoryIcon";
