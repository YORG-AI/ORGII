import type { TFunction } from "i18next";
import React from "react";

import { SectionContainer } from "@src/modules/shared/layouts/SectionLayout";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import type {
  CollabSessionAccessMode,
  CollabSessionAccessSettings,
} from "@src/store/collaboration/types";

const ACCESS_MODES = [
  COLLAB_SESSION_ACCESS_MODE.OFF,
  COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
  COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
] as const;

interface SettingsSectionProps {
  t: TFunction<"navigation">;
  currentAccessSettings: CollabSessionAccessSettings | null;
  workspaceOptions: string[];
  onSelectAccessMode: (accessMode: CollabSessionAccessMode) => void;
  onToggleWorkspace: (workspacePath: string) => void;
}

export function SettingsSection({
  t,
  currentAccessSettings,
  workspaceOptions,
  onSelectAccessMode,
  onToggleWorkspace,
}: SettingsSectionProps) {
  return (
    <SectionContainer color="chatPanelInfo" padding="default">
      <div className="flex flex-col gap-4">
        <div>
          <div className="text-[13px] font-semibold text-text-1">
            {t("collaboration.access.title")}
          </div>
          <div className="mt-1 text-[12px] text-text-3">
            {t("collaboration.access.description")}
          </div>
        </div>
        <div className="grid gap-2 @[720px]:grid-cols-3">
          {ACCESS_MODES.map((accessMode) => (
            <button
              key={accessMode}
              type="button"
              className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                currentAccessSettings?.accessMode === accessMode
                  ? "border-accent-6 bg-accent-2 text-text-1"
                  : "border-border-2 bg-bg-2 text-text-2 hover:bg-surface-hover"
              }`}
              onClick={() => onSelectAccessMode(accessMode)}
            >
              <div className="text-[12px] font-semibold">
                {t(`collaboration.access.modes.${accessMode}.title`)}
              </div>
              <div className="mt-1 text-[11px] text-text-3">
                {t(`collaboration.access.modes.${accessMode}.description`)}
              </div>
            </button>
          ))}
        </div>
        <div>
          <div className="text-[12px] font-semibold text-text-1">
            {t("collaboration.access.workspaces")}
          </div>
          <div className="mt-1 text-[12px] text-text-3">
            {t("collaboration.access.workspacesHint")}
          </div>
          <div className="mt-3 flex flex-col divide-y divide-border-2 rounded-xl border border-border-2 bg-bg-2">
            {workspaceOptions.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-text-3">
                {t("collaboration.access.noWorkspaces")}
              </div>
            ) : (
              workspaceOptions.map((workspacePath) => {
                const selected =
                  currentAccessSettings?.workspacePaths.includes(
                    workspacePath
                  ) ?? false;
                return (
                  <label
                    key={workspacePath}
                    className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[12px] text-text-2 hover:bg-surface-hover"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => onToggleWorkspace(workspacePath)}
                    />
                    <span className="min-w-0 truncate" title={workspacePath}>
                      {workspacePath}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
        <div className="text-warning-7 rounded-lg bg-warning-1 px-3 py-2 text-[12px]">
          {t("collaboration.access.fullReplayWarning")}
        </div>
      </div>
    </SectionContainer>
  );
}
