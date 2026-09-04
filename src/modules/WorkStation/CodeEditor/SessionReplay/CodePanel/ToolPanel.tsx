import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getToolIcon } from "@src/engines/ChatPanel/blocks/ToolCallBlock/config";
import { extractResultText } from "@src/engines/ChatPanel/blocks/ToolCallBlock/helpers";
import {
  inferStatusFromResult,
  mapStatus,
} from "@src/engines/SessionCore/rendering/props/propsNormalizer";
import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry";
import { useTerminalSurfaceStyle } from "@src/hooks/terminal/useTerminalSurfaceStyle";
import { HugeiconsIcon, Wrench01Icon } from "@src/icons";
import { FileHeader } from "@src/modules/shared/components/FileHeader";
import { getToolDisplayLabelFromRegistry } from "@src/util/ui/rendering/registryToolLabel";

import type { ToolOperationEntry } from "../types";

interface ToolPanelProps {
  operation: ToolOperationEntry;
  publishEnabled: boolean;
}

interface ToolPaneProps {
  label: string;
  content: string;
  emptyLabel: string;
  borderTop?: boolean;
}

function formatJson(record: Record<string, unknown>): string {
  return Object.keys(record).length > 0 ? JSON.stringify(record, null, 2) : "";
}

const ToolPane: React.FC<ToolPaneProps> = memo(
  ({ label, content, emptyLabel, borderTop = false }) => {
    const { foreground, mutedForeground, typography } =
      useTerminalSurfaceStyle();

    return (
      <section
        className={`flex min-h-0 flex-1 flex-col ${
          borderTop ? "border-t border-border-2" : ""
        }`}
      >
        <div className="flex h-9 shrink-0 items-center px-3 text-[11px] font-bold text-text-2 uppercase">
          {label}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-[100px]">
          {content ? (
            <pre
              className="m-0 wrap-break-word whitespace-pre-wrap"
              style={{ ...typography, color: foreground }}
            >
              {content}
            </pre>
          ) : (
            <div
              className="flex h-full items-center justify-center"
              style={{ ...typography, color: mutedForeground }}
            >
              {emptyLabel}
            </div>
          )}
        </div>
      </section>
    );
  }
);

ToolPane.displayName = "ToolPane";

export const ToolPanel: React.FC<ToolPanelProps> = memo(
  ({ operation, publishEnabled }) => {
    const { t } = useTranslation("sessions");
    const event = operation.event;
    const args = useMemo(() => event.args ?? {}, [event.args]);
    const result = useMemo(() => event.result ?? {}, [event.result]);
    const action = typeof args.action === "string" ? args.action : undefined;
    const labels = useLifecycleLabels(event.functionName, action);
    const status = mapStatus(
      event.displayStatus || inferStatusFromResult(result)
    );
    const state = statusToLifecycle(status);
    const titleText =
      labels[state] ||
      getToolDisplayLabelFromRegistry(event.functionName, action);
    const argsSummary = operation.displayName;

    const inputText = useMemo(() => {
      const displayArgs = Object.fromEntries(
        Object.entries(args).filter(([key]) => key !== "streamOutput")
      );
      return formatJson(displayArgs);
    }, [args]);

    const outputText = useMemo(() => {
      const streamOutput =
        typeof args.streamOutput === "string" ? args.streamOutput : "";
      if (event.displayStatus === "running" && streamOutput)
        return streamOutput;
      const resultText = extractResultText(result);
      return resultText ?? formatJson(result);
    }, [args, event.displayStatus, result]);

    const headerIcon = useMemo(() => {
      const toolIcon = getToolIcon(event.functionName, { action });
      return (
        toolIcon || (
          <HugeiconsIcon
            icon={Wrench01Icon}
            data-icon="wrench"
            size={14}
            className="shrink-0 text-text-2"
          />
        )
      );
    }, [event.functionName, action]);

    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        <FileHeader
          filePath={event.functionName}
          disableNavigation
          useFileTypeIcon={false}
          headerIcon={headerIcon}
          publishToHost="simulator"
          publishEnabled={publishEnabled}
          titleSlot={
            <>
              <span className="shrink-0 text-[12px] font-medium whitespace-nowrap text-text-1">
                {titleText}
              </span>
              {argsSummary && argsSummary !== titleText && (
                <span
                  className="min-w-0 truncate text-[12px] text-text-2"
                  title={argsSummary}
                >
                  {argsSummary}
                </span>
              )}
            </>
          }
        />
        <div className="code-viewer-scroll-container min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col">
            <ToolPane
              label={t("tools.inputSection")}
              content={inputText}
              emptyLabel={t("common:status.empty")}
            />
            <ToolPane
              label={t("tools.outputSection")}
              content={outputText}
              emptyLabel={t("common:status.pending")}
              borderTop
            />
          </div>
        </div>
      </div>
    );
  }
);

ToolPanel.displayName = "ToolPanel";
