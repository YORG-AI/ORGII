import { useAtom } from "jotai";
import { useCallback, useMemo } from "react";

import { collabSessionAccessSettingsAtom } from "@src/store/collaboration/collabOrgsAtom";
import { COLLAB_WORKSPACE_SCOPE } from "@src/store/collaboration/types";
import type {
  CollabMemberRecord,
  CollabSessionAccessMode,
  CollabSessionAccessSettings,
} from "@src/store/collaboration/types";
import type { Session } from "@src/store/session";

import { createDefaultAccessSettings, normalizeWorkspacePath } from "./utils";

interface UseAccessSettingsModelParams {
  orgId: string;
  currentMember: CollabMemberRecord | undefined;
  sessions: Session[];
}

export function useAccessSettingsModel({
  orgId,
  currentMember,
  sessions,
}: UseAccessSettingsModelParams) {
  const [accessSettingsList, setAccessSettingsList] = useAtom(
    collabSessionAccessSettingsAtom
  );

  const currentAccessSettings = useMemo(() => {
    if (!currentMember) return null;
    return (
      accessSettingsList.find(
        (settings) =>
          settings.orgId === orgId && settings.memberId === currentMember.id
      ) ??
      createDefaultAccessSettings(
        orgId,
        currentMember.id,
        COLLAB_WORKSPACE_SCOPE.SELECTED_WORKSPACES
      )
    );
  }, [accessSettingsList, currentMember, orgId]);

  const workspaceOptions = useMemo(() => {
    const paths = new Set<string>();
    for (const session of sessions) {
      const normalizedPath = normalizeWorkspacePath(session.repoPath);
      if (normalizedPath) paths.add(normalizedPath);
    }
    return Array.from(paths).sort((left, right) => left.localeCompare(right));
  }, [sessions]);

  const updateAccessSettings = useCallback(
    (
      updates: Partial<
        Pick<CollabSessionAccessSettings, "accessMode" | "workspacePaths">
      >
    ) => {
      if (!currentMember || !currentAccessSettings) return;
      const nextSettings: CollabSessionAccessSettings = {
        ...currentAccessSettings,
        ...updates,
        workspaceScope: COLLAB_WORKSPACE_SCOPE.SELECTED_WORKSPACES,
        updatedAt: new Date().toISOString(),
      };
      setAccessSettingsList((current) => {
        const existingIndex = current.findIndex(
          (settings) =>
            settings.orgId === nextSettings.orgId &&
            settings.memberId === nextSettings.memberId
        );
        if (existingIndex < 0) return [nextSettings, ...current];
        const next = [...current];
        next[existingIndex] = nextSettings;
        return next;
      });
    },
    [currentAccessSettings, currentMember, setAccessSettingsList]
  );

  const handleSelectAccessMode = useCallback(
    (accessMode: CollabSessionAccessMode) => {
      updateAccessSettings({ accessMode });
    },
    [updateAccessSettings]
  );

  const handleToggleWorkspace = useCallback(
    (workspacePath: string) => {
      if (!currentAccessSettings) return;
      const workspacePaths = currentAccessSettings.workspacePaths.includes(
        workspacePath
      )
        ? currentAccessSettings.workspacePaths.filter(
            (path) => path !== workspacePath
          )
        : [...currentAccessSettings.workspacePaths, workspacePath];
      updateAccessSettings({ workspacePaths });
    },
    [currentAccessSettings, updateAccessSettings]
  );

  return {
    currentAccessSettings,
    workspaceOptions,
    handleSelectAccessMode,
    handleToggleWorkspace,
  };
}
