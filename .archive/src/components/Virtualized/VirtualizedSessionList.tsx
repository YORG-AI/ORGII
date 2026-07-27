/**
 * VirtualizedSessionList - High-performance virtualized list for sessions
 * Uses react-virtuoso for rendering only visible items
 */
import React, { memo, useCallback, useMemo } from "react";
import { Virtuoso } from "react-virtuoso";

export interface SessionListItem {
  id: string;
  name: string;
  repoName?: string;
  updatedAt: string;
  status?: string;
}

interface VirtualizedSessionListProps {
  sessions: SessionListItem[];
  onSessionClick: (session: SessionListItem) => void;
  height: number;
  itemHeight?: number;
  emptyMessage?: string;
  className?: string;
}

// Memoized row — only re-renders when its own session, className, or click
// handler identity change. When the parent's `sessions` array reference shifts
// but the individual item reference is stable, this row stays untouched.
interface SessionRowProps {
  session: SessionListItem;
  className: string;
  onClick: (session: SessionListItem) => void;
}

const SessionRow: React.FC<SessionRowProps> = memo(
  ({ session, className, onClick }) => {
    const formattedTime = useMemo(
      () => new Date(session.updatedAt).toLocaleString(),
      [session.updatedAt]
    );
    const handleClick = useCallback(() => {
      onClick(session);
    }, [onClick, session]);

    return (
      <div className={`session-list-item ${className}`} onClick={handleClick}>
        <div className="session-item-content">
          <div className="session-item-header">
            <span className="session-item-name">{session.name}</span>
            {session.status && (
              <span className={`session-item-status status-${session.status}`}>
                {session.status}
              </span>
            )}
          </div>
          {session.repoName && (
            <div className="session-item-project">{session.repoName}</div>
          )}
          <div className="session-item-time">{formattedTime}</div>
        </div>
      </div>
    );
  }
);
SessionRow.displayName = "SessionRow";

export const VirtualizedSessionList: React.FC<VirtualizedSessionListProps> = ({
  sessions,
  onSessionClick,
  height,
  itemHeight = 60,
  emptyMessage = "No sessions found",
  className = "",
}) => {
  // Use Virtuoso's `(index, session)` signature so we don't need to close over
  // the `sessions` array — this keeps itemContent stable across data updates.
  const itemContent = useCallback(
    (_index: number, session: SessionListItem) => (
      <SessionRow
        session={session}
        className={className}
        onClick={onSessionClick}
      />
    ),
    [className, onSessionClick]
  );

  const style = useMemo(() => ({ height }), [height]);

  if (sessions.length === 0) {
    return (
      <div className="session-list-empty" style={style}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <Virtuoso
      style={style}
      data={sessions}
      itemContent={itemContent}
      className={className}
      fixedItemHeight={itemHeight}
    />
  );
};

export default VirtualizedSessionList;
