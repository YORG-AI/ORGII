import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  XCircle,
} from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import {
  type SourceStatusMessage,
  useDiagnosticHealth,
} from "@src/modules/WorkStation/CodeEditor/hooks/diagnostics/useDiagnosticHealth";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { triggerLspRetry } from "@src/store/workstation/codeEditor/diagnostics";

function getStatusIcon(status: SourceStatusMessage["status"]) {
  switch (status) {
    case "active":
      return <CheckCircle2 size={14} className="text-success-6" />;
    case "initializing":
      return (
        <Loader2
          size={SPINNER_TOKENS.default}
          className="animate-spin text-text-3"
        />
      );
    case "failed":
      return <XCircle size={14} className="text-danger-6" />;
    case "unavailable":
      return <XCircle size={14} className="text-text-3" />;
    default:
      return <Info size={14} className="text-text-3" />;
  }
}

interface HealthStatusDisplayProps {
  className?: string;
}

export const HealthStatusDisplay: React.FC<HealthStatusDisplayProps> = memo(
  ({ className = "" }) => {
    const { t } = useTranslation();
    const { hasActiveSource, allInitializing, hasFailed, statusMessages } =
      useDiagnosticHealth();

    if (statusMessages.length === 0) {
      return (
        <div
          className={`flex h-full w-full flex-col overflow-hidden bg-workstation-bg ${className}`}
        >
          <Placeholder
            variant="empty"
            title={t("common:status.noProblems")}
            subtitle={t("common:status.scanWorkspaceHint")}
          />
        </div>
      );
    }

    if (allInitializing) {
      return (
        <div
          className={`flex h-full w-full flex-col overflow-hidden bg-workstation-bg ${className}`}
        >
          <Placeholder
            variant="loading"
            title={t("common:status.diagnosticsInitializing")}
          />
        </div>
      );
    }

    if (hasActiveSource && !hasFailed) {
      return (
        <div
          className={`flex h-full w-full flex-col overflow-hidden bg-workstation-bg ${className}`}
        >
          <Placeholder
            variant="empty"
            placement="detail-panel"
            title={t("common:status.noProblems")}
            fillParentHeight
          />
        </div>
      );
    }

    return (
      <div
        className={`flex h-full w-full flex-col overflow-hidden bg-workstation-bg ${className}`}
      >
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text-2">
            <AlertTriangle size={14} className="text-warning-6" />
            <span>{t("common:status.diagnosticSourceIssues")}</span>
          </div>
          <div className="flex flex-col gap-2">
            {statusMessages.map((sourceMsg) => {
              const isLsp = sourceMsg.source.endsWith(" LSP");
              const showRetry = isLsp && sourceMsg.status === "failed";
              return (
                <div
                  key={sourceMsg.source}
                  className="flex items-start gap-2 rounded-md bg-fill-1 p-2 px-3"
                >
                  {getStatusIcon(sourceMsg.status)}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-xs leading-[1.4] text-text-1">
                      {sourceMsg.message}
                    </span>
                    {sourceMsg.installHint && (
                      <code className="cursor-text select-all break-all rounded bg-fill-2 px-2 py-1 text-[11px] text-text-3">
                        {sourceMsg.installHint}
                      </code>
                    )}
                  </div>
                  {showRetry && (
                    <Button
                      variant="tertiary"
                      size="mini"
                      onClick={() => triggerLspRetry()}
                    >
                      {t("common:actions.retry")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }
);

HealthStatusDisplay.displayName = "HealthStatusDisplay";
