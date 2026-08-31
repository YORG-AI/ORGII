import React from "react";

import { useMobileRemote } from "../app";
import { SessionListItem } from "../components/SessionListItem";
import { DesktopPresenceLabel } from "../components/badges/DesktopPresenceLabel";
import { OfflineBanner } from "../components/banners/OfflineBanner";

export interface SessionsScreenProps {
  onSelectSession?: (sessionId: string) => void;
}

/** M-05 Sessions / Online (M-06 offline banner when presence offline). */
export function SessionsScreen({ onSelectSession }: SessionsScreenProps) {
  const { connection, sessions } = useMobileRemote();
  const offline = connection.presence === "offline";

  return (
    <>
      <header className="flex h-12 shrink-0 items-center border-b border-border-2 px-3">
        <DesktopPresenceLabel
          desktopName={connection.desktopName ?? "Desktop"}
          presence={connection.presence}
        />
      </header>
      {offline ? (
        <div className="px-3 pt-3">
          <OfflineBanner desktopName={connection.desktopName} />
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-3">
          Live
        </div>
        <div className="flex flex-col gap-1">
          {sessions.map((session) => (
            <SessionListItem
              key={session.id}
              sessionId={session.id}
              name={session.name}
              status={session.status === "offline" ? "idle" : session.status}
              onSelect={() => onSelectSession?.(session.id)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

SessionsScreen.displayName = "SessionsScreen";
