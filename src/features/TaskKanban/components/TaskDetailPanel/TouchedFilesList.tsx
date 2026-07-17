/**
 * TouchedFilesList
 *
 * "Touched files" view of the Kanban session detail panel. Renders the flat
 * list of files a session touched — file name only, no diff/status detail.
 * Fed from `session.touchedFiles`, which the source cache populates for both
 * ORG2 (Rust-native) agent sessions and external sessions (CLI / Cursor /
 * imported history), so the same view works for every session type.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { getFileName } from "@src/util/file/pathUtils";

interface TouchedFilesListProps {
  files: readonly string[];
}

const TouchedFilesList: React.FC<TouchedFilesListProps> = ({ files }) => {
  const { t } = useTranslation("sessions");

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-text-3">
        {t("kanban.detailView.noTouchedFiles")}
      </div>
    );
  }

  return (
    <ul className="task-detail-panel__touched">
      {files.map((file, index) => {
        const name = getFileName(file);
        const dir =
          file.length > name.length
            ? file.slice(0, file.length - name.length)
            : "";
        return (
          <li
            key={`${file}-${index}`}
            title={file}
            className="flex items-baseline truncate rounded-md px-2 py-1.5 text-[13px] hover:bg-fill-1"
          >
            {dir && <span className="shrink-0 text-text-3">{dir}</span>}
            <span className="truncate text-text-1">{name}</span>
          </li>
        );
      })}
    </ul>
  );
};

export default TouchedFilesList;
