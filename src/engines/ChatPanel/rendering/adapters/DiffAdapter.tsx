/**
 * DiffAdapter — routes `create` / `overwrite` / `edit` / `apply_patch` /
 * `delete_file` to `DiffBlock` with a pre-translated title. The extracted
 * fileName is used for `{{name}}` interpolation; when the event is a patch
 * covering multiple files the block itself renders per-segment children.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { extractEditData } from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry";
import type {
  ExtractedEditData,
  UniversalEventProps,
} from "@src/engines/SessionCore/rendering/types/universalProps";
import { getFileName } from "@src/util/file/pathUtils";

import DiffBlock from "../../blocks/DiffBlock";

function firstSegmentFileName(editData: ExtractedEditData): string | undefined {
  return editData.applyPatchSegments
    ?.map(
      (segment) =>
        getFileName(segment.filePath) || getFileName(segment.fileName)
    )
    .find(Boolean);
}

export const DiffAdapter: React.FC<UniversalEventProps> = (props) => {
  const { t } = useTranslation("sessions");
  const action = (props.args?.action as string) || undefined;
  const editData = extractEditData(props);
  const fileName =
    firstSegmentFileName(editData) ||
    getFileName(editData.filePath) ||
    getFileName(editData.fileName) ||
    (typeof props.args?.file_path === "string"
      ? getFileName(props.args.file_path as string)
      : undefined);

  const hasName = Boolean(fileName);
  const namedLabels = useLifecycleLabels(
    props.eventType,
    action,
    hasName ? { name: fileName } : undefined
  );

  const labels = hasName
    ? namedLabels
    : {
        running: t("tools.editFileRunningNoName"),
        done: t("tools.editFileDoneNoName"),
        failed: t("tools.editFileFailedNoName"),
      };

  const state = statusToLifecycle(props.status);
  const toolName = props.functionName || props.eventType;
  return (
    <div data-tool-call-event-id={props.eventId} data-tool-call-name={toolName}>
      <DiffBlock {...props} title={labels[state]} />
    </div>
  );
};

DiffAdapter.displayName = "DiffAdapter";

export default DiffAdapter;
