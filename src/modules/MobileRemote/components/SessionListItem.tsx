import React from "react";

import {
  SESSION_ROW_PRESENTATION,
  SessionRowLeadingIcon,
} from "@src/components/SessionRowPresentation";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

export interface SessionListItemProps {
  sessionId: string;
  name: string;
  status: "running" | "idle";
  onSelect?: () => void;
}

export function SessionListItem({
  sessionId,
  name,
  status,
  onSelect,
}: SessionListItemProps) {
  const statusTone = status === "running" ? "working" : "default";

  return (
    <button
      type="button"
      data-testid="mobile-remote-session-row"
      className={`${SESSION_ROW_PRESENTATION.row} w-full cursor-pointer border-0 bg-transparent px-2 text-left text-text-1 outline-none select-none hover:bg-sidebar-selected focus-visible:bg-sidebar-selected focus-visible:ring-2 focus-visible:ring-primary-6/30 active:bg-sidebar-selected`}
      onClick={onSelect}
    >
      <span className={SESSION_ROW_PRESENTATION.content}>
        <SessionRowLeadingIcon
          icon={resolveSessionRowIcon(sessionId)}
          iconLabel={`session-${sessionId}`}
          statusTone={statusTone}
          statusLabel={status === "running" ? "Working" : undefined}
        />
        <span className={SESSION_ROW_PRESENTATION.text}>
          <span
            className={`${SESSION_ROW_PRESENTATION.title} block text-text-1`}
          >
            {name}
          </span>
        </span>
      </span>
    </button>
  );
}

SessionListItem.displayName = "SessionListItem";
