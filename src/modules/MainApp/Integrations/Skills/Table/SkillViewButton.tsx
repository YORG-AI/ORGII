import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Dropdown from "@src/components/Dropdown";
import Menu from "@src/components/Menu";
import SplitButton from "@src/components/SplitButton";
import { createLogger } from "@src/hooks/logger";
import { SKILL_SOURCE } from "@src/types/extensions";
import { getFileManagerRevealLabelKey } from "@src/util/platform/fileManagerLabels";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

import type { SkillTableRow } from "./SkillTableParts";

const logger = createLogger("SkillViewButton");

interface SkillViewButtonProps<TSkill extends SkillTableRow> {
  skill: TSkill;
  size?: "small" | "default";
  variant?: "primary" | "secondary" | "tertiary";
}

function sanitizeSkillFileSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-") || "skill";
}

async function materializeEmbeddedSkill(skillName: string): Promise<string> {
  const content = await invoke<string>("skills_read", {
    workspacePath: null,
    name: skillName,
  });
  const baseDir = await appCacheDir();
  const skillDir = await join(
    baseDir,
    "embedded-skills-preview",
    sanitizeSkillFileSegment(skillName)
  );
  await mkdir(skillDir, { recursive: true });
  const filePath = await join(skillDir, "SKILL.md");
  await writeTextFile(filePath, content);
  return filePath;
}

function SkillViewButton<TSkill extends SkillTableRow>({
  skill,
  size = "small",
  variant = "secondary",
}: SkillViewButtonProps<TSkill>) {
  const { t } = useTranslation("integrations");
  const [dropdownVisible, setDropdownVisible] = useState(false);
  const [opening, setOpening] = useState(false);
  const isEmbeddedBuiltin = skill.source === SKILL_SOURCE.EMBEDDED_BUILTIN;
  const canOpen = Boolean(skill.path) || isEmbeddedBuiltin;

  const handleOpen = useCallback(async () => {
    if (!canOpen) return;
    setOpening(true);
    try {
      const path = isEmbeddedBuiltin
        ? await materializeEmbeddedSkill(skill.name)
        : skill.path;
      if (path) {
        openFileInWorkStation(path, { defaultPreviewMode: true });
      }
      setDropdownVisible(false);
    } catch (err) {
      logger.error("Failed to open skill:", err);
    } finally {
      setOpening(false);
    }
  }, [canOpen, isEmbeddedBuiltin, skill.name, skill.path]);

  const handleReveal = useCallback(() => {
    if (!skill.path || isEmbeddedBuiltin) return;
    void invoke("show_in_folder", { path: skill.path });
    setDropdownVisible(false);
  }, [isEmbeddedBuiltin, skill.path]);

  return (
    <SplitButton
      variant={variant}
      size={size}
      disabled={!canOpen || opening}
      loading={opening}
      onClick={() => void handleOpen()}
      menu={
        <Dropdown
          droplist={
            <Menu>
              <Menu.Item
                key="open-to-right"
                disabled={!canOpen || opening}
                onClick={() => void handleOpen()}
              >
                {t("common:actions.openToRight")}
              </Menu.Item>
              <Menu.Item
                key="reveal-in-file-manager"
                disabled={isEmbeddedBuiltin || !skill.path}
                onClick={handleReveal}
              >
                {t(getFileManagerRevealLabelKey())}
              </Menu.Item>
            </Menu>
          }
          trigger="click"
          position="bottom-end"
          popupVisible={dropdownVisible}
          onVisibleChange={setDropdownVisible}
          getPopupContainer={() => document.body}
          avoidViewportOverflow
          className="z-9999"
          style={{ zIndex: 9999 }}
        >
          <div />
        </Dropdown>
      }
      onMenuButtonClick={(event) => {
        event.stopPropagation();
        if (canOpen) {
          setDropdownVisible((visible) => !visible);
        }
      }}
      menuOpen={dropdownVisible}
      menuButtonLabel={t("common:actions.view")}
      widthMode="hug"
    >
      {t("common:actions.view")}
    </SplitButton>
  );
}

export default SkillViewButton;
