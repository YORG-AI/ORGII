/**
 * FileHeaderShell
 *
 * Wraps the {@link FileHeader} body so it either renders inline (legacy
 * callers) or teleports into the global Workstation tab-header strip via
 * {@link usePublishWorkstationTabHeader} (My Station panes).
 *
 * The teleported variant intentionally drops the row chrome (40px height,
 * border, padding) since the workstation tab header already supplies it.
 */
import React from "react";

import { HEADER_CLASSES } from "@src/config/workstation/tokens";
import {
  type WorkstationTabHeaderHost,
  usePublishWorkstationTabHeader,
} from "@src/hooks/tabHost/useWorkstationTabHeader";

export interface FileHeaderShellProps {
  className?: string;
  publishToHost?: WorkstationTabHeaderHost;
  publishEnabled: boolean;
  children: React.ReactNode;
}

export const FileHeaderShell: React.FC<FileHeaderShellProps> = ({
  className,
  publishToHost,
  publishEnabled,
  children,
}) => {
  const teleport = !!publishToHost;
  const teleportedContent = teleport ? (
    <div
      className={`flex min-w-0 flex-1 items-center gap-1.5${
        className ? ` ${className}` : ""
      }`}
    >
      {children}
    </div>
  ) : null;

  usePublishWorkstationTabHeader({
    host: publishToHost ?? "code",
    content: teleportedContent,
    enabled: teleport && publishEnabled,
  });

  if (teleport) return null;
  return (
    <div
      className={`${HEADER_CLASSES.fileBar}${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
};
