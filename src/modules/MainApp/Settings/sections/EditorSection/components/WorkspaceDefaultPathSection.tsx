import { open } from "@tauri-apps/plugin-dialog";
import { useAtom } from "jotai";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import { WORKSPACE_DEFAULT_REPO_LOCATION } from "@src/config/workspaceDefaultRepoPaths";
import type { WorkspaceDefaultRepoLocation } from "@src/config/workspaceDefaultRepoPaths";
import { createLogger } from "@src/hooks/logger";
import { FolderOpenIcon, HugeiconsIcon } from "@src/icons";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_PATH_TEXT_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  workspaceCustomDefaultRepoPathAtom,
  workspaceDefaultRepoLocationAtom,
} from "@src/store/config/configAtom";
import { resolveDefaultRepoParentPath } from "@src/util/workspace/defaultRepoPath";

const logger = createLogger("WorkspaceDefaultPathSettings");

const WorkspaceDefaultPathSection: React.FC = () => {
  const { t } = useTranslation("settings");
  const [defaultRepoLocation, setDefaultRepoLocation] = useAtom(
    workspaceDefaultRepoLocationAtom
  );
  const [customDefaultRepoPath, setCustomDefaultRepoPath] = useAtom(
    workspaceCustomDefaultRepoPathAtom
  );
  const [resolvedPath, setResolvedPath] = useState("");

  useEffect(() => {
    let cancelled = false;

    resolveDefaultRepoParentPath({
      location: defaultRepoLocation,
      customPath: customDefaultRepoPath,
    })
      .then((path) => {
        if (!cancelled) setResolvedPath(path);
      })
      .catch(() => {
        if (!cancelled) setResolvedPath("");
      });

    return () => {
      cancelled = true;
    };
  }, [customDefaultRepoPath, defaultRepoLocation]);

  const handleLocationChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const nextLocation = String(value) as WorkspaceDefaultRepoLocation;
      setDefaultRepoLocation(nextLocation);
    },
    [setDefaultRepoLocation]
  );

  const handleChooseCustomPath = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("editor.defaultRepoFolderChooseCustom"),
      });

      if (selected && typeof selected === "string") {
        setCustomDefaultRepoPath(selected);
      }
    } catch (error) {
      logger.error("Failed to choose default repo folder:", error);
      Message.error(t("editor.defaultRepoFolderChooseError"));
    }
  }, [setCustomDefaultRepoPath, t]);

  return (
    <SectionContainer title={t("editor.workspaceDefaults")}>
      <SectionRow
        label={t("editor.defaultRepoFolder")}
        description={t("editor.defaultRepoFolderDesc")}
      >
        <Select
          value={defaultRepoLocation}
          onChange={handleLocationChange}
          options={[
            {
              label: t("editor.defaultRepoFolderDocumentsGithub"),
              value: WORKSPACE_DEFAULT_REPO_LOCATION.DOCUMENTS_GITHUB,
            },
            {
              label: t("editor.defaultRepoFolderDocumentsOrgii"),
              value: WORKSPACE_DEFAULT_REPO_LOCATION.DOCUMENTS_ORGII,
            },
            {
              label: t("editor.defaultRepoFolderDocuments"),
              value: WORKSPACE_DEFAULT_REPO_LOCATION.DOCUMENTS,
            },
            {
              label: t("editor.defaultRepoFolderCustom"),
              value: WORKSPACE_DEFAULT_REPO_LOCATION.CUSTOM,
            },
          ]}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      {defaultRepoLocation === WORKSPACE_DEFAULT_REPO_LOCATION.CUSTOM && (
        <SectionRow label={t("editor.customDefaultRepoFolder")} indent>
          <div
            className={SECTION_ACTION_GAP_CLASSES}
            style={SECTION_CONTROL_STYLE}
          >
            <Input
              value={customDefaultRepoPath}
              onChange={setCustomDefaultRepoPath}
              placeholder="~/Code"
              className="min-w-0 flex-1"
            />
            <Button
              variant="secondary"
              size="default"
              iconOnly
              icon={
                <HugeiconsIcon
                  icon={FolderOpenIcon}
                  data-icon="folder-open"
                  size={16}
                />
              }
              title={t("editor.defaultRepoFolderChoose")}
              aria-label={t("editor.defaultRepoFolderChoose")}
              onClick={handleChooseCustomPath}
            />
          </div>
        </SectionRow>
      )}
      <SectionRow label={t("editor.defaultRepoFolderResolvedPath")} indent>
        <span className={SECTION_PATH_TEXT_CLASSES} title={resolvedPath}>
          {resolvedPath || "—"}
        </span>
      </SectionRow>
    </SectionContainer>
  );
};

export default WorkspaceDefaultPathSection;
