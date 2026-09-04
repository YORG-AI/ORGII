import React from "react";

import StatusDot from "@src/components/StatusDot";

import type { DesktopPresence } from "../../connection/types";

export interface DesktopPresenceLabelProps {
  desktopName: string;
  presence: DesktopPresence;
}

function resolveDotColor(presence: DesktopPresence): string {
  switch (presence) {
    case "online":
      return "bg-success-6";
    case "offline":
      return "bg-text-4";
    default:
      return "bg-warning-6";
  }
}

export function DesktopPresenceLabel({
  desktopName,
  presence,
}: DesktopPresenceLabelProps) {
  const pulse = presence === "unknown";
  return (
    <StatusDot
      color={resolveDotColor(presence)}
      label={desktopName}
      size="inline"
      pulse={pulse}
    />
  );
}

DesktopPresenceLabel.displayName = "DesktopPresenceLabel";
