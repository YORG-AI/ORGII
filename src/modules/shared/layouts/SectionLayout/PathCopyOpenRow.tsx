/**
 * PathCopyOpenRow
 *
 * Standardised "path + Copy + FolderOpen" row used across Settings.
 * Renders a SectionRow with a truncated path text and two icon buttons.
 *
 * Usage:
 *   <PathCopyOpenRow
 *     label={t("storage.dataDirectory")}
 *     description={t("storage.dataDirectoryDesc")}
 *     path={diskUsage?.root_path ?? "…"}
 *     onCopy={() => copyText(path)}
 *     onOpen={() => invoke("open_folder", { path })}
 *     disabled={!diskUsage?.root_path}
 *   />
 */
import React, { memo } from "react";

import Button from "@src/components/Button";
import { Copy01Icon, FolderOpenIcon, HugeiconsIcon } from "@src/icons";

import SectionRow from "./Row";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_PATH_TEXT_CLASSES,
} from "./tokens";

export interface PathCopyOpenRowProps {
  label: string;
  description?: string;
  path: string;
  onCopy: () => void;
  onOpen: () => void;
  /** Disables both buttons (e.g. while path is loading) */
  disabled?: boolean;
  copyTitle?: string;
  openTitle?: string;
}

const PathCopyOpenRow: React.FC<PathCopyOpenRowProps> = memo(
  ({
    label,
    description,
    path,
    onCopy,
    onOpen,
    disabled,
    copyTitle,
    openTitle,
  }) => {
    return (
      <SectionRow label={label} description={description}>
        <div className={SECTION_ACTION_GAP_CLASSES}>
          <span className={SECTION_PATH_TEXT_CLASSES}>{path}</span>
          <Button
            onClick={onCopy}
            icon={
              <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={14} />
            }
            iconOnly
            title={copyTitle}
            disabled={disabled}
          />
          <Button
            onClick={onOpen}
            icon={
              <HugeiconsIcon
                icon={FolderOpenIcon}
                data-icon="folder-open"
                size={14}
              />
            }
            iconOnly
            title={openTitle}
            disabled={disabled}
          />
        </div>
      </SectionRow>
    );
  }
);

PathCopyOpenRow.displayName = "PathCopyOpenRow";

export default PathCopyOpenRow;
