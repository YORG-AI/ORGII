import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import type { ScanProgress } from "@src/store/workstation/codeEditor/diagnostics/workspaceScanAtom";

import { SECTION_LABEL, TOOL_ICON_FILE } from "./config";

interface ScanProgressSectionProps {
  scanProgress: ScanProgress | null;
}

const ScanProgressSection: React.FC<ScanProgressSectionProps> = memo(
  ({ scanProgress }) => {
    const { t } = useTranslation();
    const tools = scanProgress?.tools ?? [];

    if (tools.length === 0) {
      return (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-fill-1 px-4 py-3">
          <Loader2
            size={SPINNER_TOKENS.default}
            className="shrink-0 animate-spin text-primary-6"
          />
          <span className="text-xs text-text-3">
            {t("status.diagnosticsInitializing")}
          </span>
        </div>
      );
    }

    return (
      <div className="mt-4 rounded-lg bg-fill-1 px-4 py-3">
        <div className={SECTION_LABEL}>{t("status.scanProgress")}</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {tools.map((tool) => (
            <div key={tool.name} className="flex items-center gap-1.5">
              {tool.status === "running" && (
                <Loader2
                  size={12}
                  className="shrink-0 animate-spin text-primary-6"
                />
              )}
              {tool.status === "done" && (
                <CheckCircle2 size={13} className="shrink-0 text-success-6" />
              )}
              {tool.status === "failed" && (
                <XCircle size={13} className="shrink-0 text-danger-6" />
              )}

              <FileTypeIcon
                fileName={TOOL_ICON_FILE[tool.name] ?? "file.txt"}
                size="small"
                className="shrink-0"
              />

              <span className="text-[12px] text-text-2">{tool.name}</span>

              {(tool.filesScanned ?? 0) > 0 && (
                <span className="text-[11px] text-text-4">
                  {tool.filesScanned} {t("labels.files")}
                </span>
              )}
              {tool.diagnosticCount !== undefined &&
                tool.diagnosticCount > 0 && (
                  <span className="text-[11px] font-medium text-warning-6">
                    ({tool.diagnosticCount})
                  </span>
                )}
            </div>
          ))}
        </div>
      </div>
    );
  }
);
ScanProgressSection.displayName = "ScanProgressSection";

export default ScanProgressSection;
