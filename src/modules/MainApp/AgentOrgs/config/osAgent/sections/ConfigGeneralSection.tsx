/**
 * OS Agent Config — General Content
 *
 * Workspace path display only. Runtime limits (max iterations, exec
 * timeout) are surfaced uniformly across all agent kinds via
 * `<AgentRuntimeLimitsSection />` so this file is OS-specific
 * presentation only.
 *
 * NOTE: workspace-only is exposed via the General security section
 * (`workspaceOnly` on `AgentPolicy`). For the OS Agent the working_dir is
 * `~/.orgii/personal/workspace` (see `ResolvedAgent::resolve` →
 * `personal_workspace()` fallback), so enabling workspace-only would
 * lock the agent inside its own personal scratch dir and block it from
 * touching the user's repos. The toggle is meaningful for SDE/Custom
 * agents whose working_dir tracks the active session repo. There is
 * deliberately no parallel `restrictToWorkspace` field — it was retired
 * because it duplicated `policy.workspaceOnly` and the two could drift.
 *
 * NOTE: Embedding/memory-search settings (provider, model, mode) live in
 * Settings → Code Search / Indexing. Per-agent memory knobs (long-term
 * memory toggle, extract memories, auto-dream) live on each agent's
 * Memory & Evolution tab.
 */
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import Button from "@src/components/Button";
import { FolderOpenIcon, HugeiconsIcon } from "@src/icons";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_PATH_TEXT_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import AgentRuntimeLimitsSection from "../../shared/AgentRuntimeLimitsSection";

interface ConfigGeneralSectionProps {
  config: Record<string, unknown>;
  update: (path: string, value: unknown) => void;
  /** Optional sub-section title above the first container */
  title?: string;
}

const ConfigGeneralSection: React.FC<ConfigGeneralSectionProps> = ({
  config,
  update,
  title,
}) => {
  const { t } = useTranslation("settings");

  const [workspace, setWorkspace] = useState("~/.orgii/personal/workspace");
  useEffect(() => {
    let cancelled = false;
    rpc.agentOrgs.memory.personalWorkspace().then((path) => {
      if (!cancelled) setWorkspace(path);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRevealWorkspace = useCallback(async () => {
    let expandedPath = workspace;
    if (expandedPath.startsWith("~")) {
      const home = await homeDir();
      expandedPath = expandedPath.replace("~", home.replace(/\/$/, ""));
    }
    try {
      await invoke("show_in_folder", { path: expandedPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to reveal workspace: ${message}`);
    }
  }, [workspace]);

  return (
    <>
      <SectionContainer title={title}>
        <SectionRow
          label={t("osAgent.workspace")}
          description={t("osAgent.workspaceDesc")}
        >
          <div className={SECTION_ACTION_GAP_CLASSES}>
            <span className={SECTION_PATH_TEXT_CLASSES}>{workspace}</span>
            <Button
              icon={
                <HugeiconsIcon
                  icon={FolderOpenIcon}
                  data-icon="folder-open"
                  size={14}
                />
              }
              iconOnly
              onClick={handleRevealWorkspace}
              title={t("storage.reveal")}
            />
          </div>
        </SectionRow>
      </SectionContainer>

      <AgentRuntimeLimitsSection
        config={config}
        update={update}
        defaultExecTimeoutSeconds={60}
      />
    </>
  );
};

export default ConfigGeneralSection;
