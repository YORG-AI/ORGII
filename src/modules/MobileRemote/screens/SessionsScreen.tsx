import React from "react";
import { useTranslation } from "react-i18next";

import { LIST_PANEL_SECTION_HEADER } from "@src/components/ListPanel/tokens";

import { useMobileRemote } from "../app";
import { MobileTopBar } from "../components/MobileTopBar";
import { SessionListItem } from "../components/SessionListItem";
import { DesktopPresenceLabel } from "../components/badges/DesktopPresenceLabel";
import { OfflineBanner } from "../components/banners/OfflineBanner";

export interface SessionsScreenProps {
  onSelectSession?: (sessionId: string) => void;
}

/** M-05 Sessions / Online (M-06 offline banner when presence offline). */
export function SessionsScreen({ onSelectSession }: SessionsScreenProps) {
  const { t } = useTranslation("mobileRemote");
  const { connection, sessions } = useMobileRemote();
  const offline = connection.presence === "offline";

  return (
    <>
      <MobileTopBar
        title={t("tabs.sessions")}
        leading={
          <DesktopPresenceLabel
            desktopName={connection.desktopName ?? "Desktop"}
            presence={connection.presence}
          />
        }
      />
      {offline ? (
        <div className="px-3 pt-3">
          <OfflineBanner desktopName={connection.desktopName} />
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <div className={`px-2 pb-1 ${LIST_PANEL_SECTION_HEADER.typography}`}>
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
