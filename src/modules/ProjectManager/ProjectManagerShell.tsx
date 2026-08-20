/**
 * ProjectManagerShell Component
 *
 * Wraps ProjectManagerCore inside a SimulatorFrame for the project view mode.
 * Handles repo selection, status bar (settings opens from status bar), and layout.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useMemo } from "react";

import SimulatorFrame from "@src/engines/Simulator/components/SimulatorFrame";
import { useWorkStationTabs } from "@src/hooks/tabHost/useWorkStationTabs";
import {
  perAppStatusBarCallbacksAtom,
  workStationTitleBarHiddenAtom,
} from "@src/store/ui/workStationAtom";
import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { createProjectSettingsTab } from "@src/store/workstation/tabs";

import { WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS } from "../WorkStation/shared/tokens";
import ProjectManagerCore from "./ProjectManagerCore";

const getFolderName = (path: string): string => {
  if (!path) return "";
  const cleanPath = path.replace(/\/+$/, "");
  const segments = cleanPath.split("/").filter(Boolean);
  return segments[segments.length - 1] || "";
};

interface ProjectManagerShellProps {
  isActive?: boolean;
}

const ProjectManagerShell: React.FC<ProjectManagerShellProps> = memo(
  ({ isActive: _isActive = true }) => {
    const titleBarHidden = useAtomValue(workStationTitleBarHiddenAtom);

    const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
    const repoPath = activeWorkspaceRoot?.path ?? "";
    const repoName = useMemo(() => {
      if (activeWorkspaceRoot?.name) return activeWorkspaceRoot.name;
      return getFolderName(repoPath) || "Project Manager";
    }, [activeWorkspaceRoot?.name, repoPath]);

    const { openTab: openProjectTab } = useWorkStationTabs();

    const handleOpenSettings = useCallback(() => {
      openProjectTab(createProjectSettingsTab());
    }, [openProjectTab]);

    const setPerAppStatusBarCallbacks = useSetAtom(
      perAppStatusBarCallbacksAtom
    );
    useEffect(() => {
      setPerAppStatusBarCallbacks((prev) => ({
        ...prev,
        project: {
          ...prev.project,
          onOpenSettings: handleOpenSettings,
        },
      }));
      return () => {
        setPerAppStatusBarCallbacks((prev) => ({
          ...prev,
          project: {
            ...prev.project,
            onOpenSettings: undefined,
          },
        }));
      };
    }, [handleOpenSettings, setPerAppStatusBarCallbacks]);

    return (
      <SimulatorFrame
        title="Project Manager"
        radius={0}
        containerClassName="!bg-bg-2"
        showHeader={!titleBarHidden}
        headerBackgroundColor="var(--color-bg-1)"
        headerTextColor="var(--color-text-2)"
        showHeaderBorder={true}
        contentClassName="p-0 flex flex-col"
      >
        <div
          className={`flex min-h-0 flex-1 flex-col ${WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS}`}
        >
          <ProjectManagerCore repoPath={repoPath} repoName={repoName} />
        </div>
      </SimulatorFrame>
    );
  }
);

ProjectManagerShell.displayName = "ProjectManagerShell";

export default ProjectManagerShell;
