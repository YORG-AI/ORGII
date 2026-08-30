import React, { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  describeAppMemoryMeasurement,
  formatRuntimeBytes,
  getAppMemoryRoleLabelKey,
  getAppMemoryTotals,
} from "@src/hooks/perf";
import { GaugeIcon } from "@src/icons";

import HoverAnimatedIcon, {
  triggerIconAnimation,
} from "../../components/HoverAnimatedIcon";
import { MemoryBreakdownSection } from "./MemoryBreakdownSection";
import { MemoryStatRow } from "./MemoryStatRow";
import { SUCCESS_FPS_THRESHOLD, SUCCESS_RAM_THRESHOLD_MB } from "./constants";
import { formatMegabytes } from "./formatters";
import type { MemoryBreakdownRow, SidebarRamMonitorPanelProps } from "./types";
import { useRamMonitorMetrics } from "./useRamMonitorMetrics";

export const SidebarRamMonitorPanel: React.FC<SidebarRamMonitorPanelProps> = ({
  isOpen,
  panelRef,
  panelPosition,
}) => {
  const { t: tSettings } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation();
  const [showAttributionHints, setShowAttributionHints] = useState(false);
  const {
    snapshot,
    appMemoryState,
    runtimeRows,
    fpsSample,
    fpsValue,
    isSamplingFps,
  } = useRamMonitorMetrics(isOpen);

  const handleToggleAttributionHints = useCallback(() => {
    setShowAttributionHints((previousValue) => !previousValue);
  }, []);

  const appMemorySnapshot = appMemoryState.snapshot;
  const {
    totalBytes: totalAppMemoryBytes,
    backendBytes: backendEffectiveBytes,
    webviewHelperBytes: webviewEffectiveBytes,
    residentPrivateBytes,
    swappedBytes,
    hasBreakdown,
  } = getAppMemoryTotals(appMemorySnapshot);
  const totalAppRamMb = totalAppMemoryBytes / (1024 * 1024);
  const translateSettings = (key: string) => tSettings(key);
  const measurementLabel = describeAppMemoryMeasurement(
    appMemorySnapshot,
    translateSettings
  );
  const withPeak = (label: string, peakBytes: number | null): string =>
    peakBytes
      ? `${label} · ${tSettings("monitor.peakSuffix", {
          value: formatRuntimeBytes(peakBytes),
        })}`
      : label;
  const backendProcess = appMemorySnapshot?.processes.find(
    (process) => process.role === "backend"
  );
  const helperProcessRows: MemoryBreakdownRow[] = (
    appMemorySnapshot?.processes ?? []
  )
    .filter((process) => process.role !== "backend")
    .map((process) => ({
      key: `helper-${process.process_instance_id}`,
      label: withPeak(
        tSettings(getAppMemoryRoleLabelKey(process.role)),
        process.peak_effective_memory_bytes
      ),
      value: formatRuntimeBytes(process.effective_memory_bytes),
      bytes: process.effective_memory_bytes,
      indentLevel: 1,
      alwaysVisible: true,
    }));
  const fileCacheMb = snapshot.memoryBreakdown?.file_cache_mb ?? 0;
  const terminalPtyBufferBytes = snapshot.ptyMemory.reduce(
    (sum, ptyInfo) => sum + ptyInfo.buffer_bytes,
    0
  );
  const totalTerminalBufferBytes =
    snapshot.terminalBufferBytes + terminalPtyBufferBytes;
  const webViewDiagnostics = snapshot.webViewDiagnostics;
  const webViewEstimateBytes =
    (webViewDiagnostics?.decodedImageBytes ?? 0) +
    (webViewDiagnostics?.dataUrlBytes ?? 0) +
    (webViewDiagnostics?.canvasBytes ?? 0) +
    (webViewDiagnostics?.videoFrameBytes ?? 0);
  const runtimeEstimateBytes =
    totalTerminalBufferBytes +
    runtimeRows.reduce((sum, row) => sum + row.bytes, 0);
  const attributionHintBytes = webViewEstimateBytes + runtimeEstimateBytes;
  const ramBreakdownRows: MemoryBreakdownRow[] = [
    {
      key: "backendGroup",
      label: withPeak(
        tSettings("monitor.appBackend"),
        backendProcess?.peak_effective_memory_bytes ?? null
      ),
      value: formatRuntimeBytes(backendEffectiveBytes),
      bytes: backendEffectiveBytes,
      alwaysVisible: true,
    },
    {
      key: "backendFileCache",
      label: tSettings("monitor.breakdownFileCache"),
      value: formatMegabytes(fileCacheMb),
      bytes: fileCacheMb * 1024 * 1024,
      indentLevel: 1,
    },
    {
      key: "webkitGroup",
      label: tSettings("monitor.appWebviewHelpers"),
      value: formatRuntimeBytes(webviewEffectiveBytes),
      bytes: webviewEffectiveBytes,
      alwaysVisible: true,
    },
    ...helperProcessRows,
    {
      key: "rssMappedTotal",
      label: tSettings("monitor.rssMappedDiagnostic"),
      value: formatRuntimeBytes(appMemorySnapshot?.rss_mapped_total_bytes ?? 0),
      bytes: appMemorySnapshot?.rss_mapped_total_bytes ?? 0,
    },
    {
      key: "attributionHintsGroup",
      label: tSettings("monitor.attributionHintsGroup"),
      value: formatRuntimeBytes(attributionHintBytes),
      bytes: attributionHintBytes,
    },
    {
      key: "webViewEstimatesGroup",
      label: tSettings("monitor.webViewEstimatesGroup"),
      value: formatRuntimeBytes(webViewEstimateBytes),
      bytes: webViewEstimateBytes,
    },
    {
      key: "webViewDecodedImages",
      label: tSettings("monitor.webViewDecodedImages", {
        count: webViewDiagnostics?.imageCount ?? 0,
      }),
      value: formatRuntimeBytes(webViewDiagnostics?.decodedImageBytes ?? 0),
      bytes: webViewDiagnostics?.decodedImageBytes ?? 0,
      indentLevel: 1,
    },
    {
      key: "webViewDataUrlImages",
      label: tSettings("monitor.webViewDataUrlImages", {
        count: webViewDiagnostics?.dataUrlImageCount ?? 0,
      }),
      value: formatRuntimeBytes(webViewDiagnostics?.dataUrlBytes ?? 0),
      bytes: webViewDiagnostics?.dataUrlBytes ?? 0,
      indentLevel: 1,
    },
    {
      key: "webViewCanvasSurfaces",
      label: tSettings("monitor.webViewCanvasSurfaces", {
        count: webViewDiagnostics?.canvasCount ?? 0,
      }),
      value: formatRuntimeBytes(webViewDiagnostics?.canvasBytes ?? 0),
      bytes: webViewDiagnostics?.canvasBytes ?? 0,
      indentLevel: 1,
    },
    {
      key: "webViewVideoFrames",
      label: tSettings("monitor.webViewVideoFrames", {
        count: webViewDiagnostics?.videoCount ?? 0,
      }),
      value: formatRuntimeBytes(webViewDiagnostics?.videoFrameBytes ?? 0),
      bytes: webViewDiagnostics?.videoFrameBytes ?? 0,
      indentLevel: 1,
    },
    {
      key: "runtimeEstimatesGroup",
      label: tSettings("monitor.runtimeEstimatesGroup"),
      value: formatRuntimeBytes(runtimeEstimateBytes),
      bytes: runtimeEstimateBytes,
    },
    ...runtimeRows.map((row) => ({ ...row, indentLevel: 1 })),
    {
      key: "terminalBuffers",
      label: tSettings("monitor.terminalBuffers"),
      value: formatRuntimeBytes(totalTerminalBufferBytes),
      bytes: totalTerminalBufferBytes,
      indentLevel: 1,
    },
  ];
  const visibleRamBreakdownRows = ramBreakdownRows.filter(
    (row) => row.bytes > 0
  );
  const attributionToggleAriaLabel = showAttributionHints
    ? tCommon("showLess")
    : tCommon("showMore");

  return (
    <>
      {isOpen &&
        createPortal(
          <div
            ref={panelRef as React.RefObject<HTMLDivElement>}
            className={`${DROPDOWN_CLASSES.panelAnimated} fixed max-h-[600px] w-[340px] overflow-hidden rounded-xl`}
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left: panelPosition.left,
            }}
          >
            <div className="max-h-[600px] space-y-2 overflow-y-auto px-3 pt-3 scrollbar-hide">
              <MemoryStatRow
                label={t("layoutSettings.ramFps")}
                value={fpsValue}
                emphasized
                tone={
                  isSamplingFps
                    ? "muted"
                    : fpsSample.fps !== null &&
                        fpsSample.fps > SUCCESS_FPS_THRESHOLD
                      ? "success"
                      : undefined
                }
              />
              <MemoryStatRow
                label={tSettings("monitor.appMemory")}
                value={formatMegabytes(totalAppRamMb)}
                emphasized
                tone={
                  totalAppRamMb > 0 && totalAppRamMb < SUCCESS_RAM_THRESHOLD_MB
                    ? "success"
                    : undefined
                }
              />
              {hasBreakdown && (
                <>
                  <MemoryStatRow
                    label={tSettings("monitor.residentPrivate")}
                    value={formatRuntimeBytes(residentPrivateBytes)}
                    indentLevel={1}
                  />
                  <MemoryStatRow
                    label={tSettings("monitor.swappedMemory")}
                    value={formatRuntimeBytes(swappedBytes)}
                    indentLevel={1}
                  />
                </>
              )}
              <MemoryStatRow
                label={tSettings("monitor.measurement")}
                value={measurementLabel}
              />
              <MemoryStatRow
                label={tSettings("monitor.webViewDomNodes")}
                value={String(webViewDiagnostics?.domNodes ?? 0)}
              />
              <MemoryStatRow
                label={tSettings("monitor.webViewCompositedCandidates", {
                  sampled: webViewDiagnostics?.compositedSampleCount ?? 0,
                })}
                value={String(
                  webViewDiagnostics?.compositedCandidateCount ?? 0
                )}
              />

              <div
                className={`${DROPDOWN_CLASSES.menuGroupSeparator} !my-0.5`}
              />
              <MemoryStatRow
                label={tSettings("monitor.memoryBreakdown")}
                value={null}
                emphasized
              />
              <MemoryBreakdownSection
                rows={visibleRamBreakdownRows}
                showAttributionHints={showAttributionHints}
                toggleAriaLabel={attributionToggleAriaLabel}
                onToggleAttributionHints={handleToggleAttributionHints}
              />

              {(snapshot.errorMessage || appMemoryState.errorMessage) && (
                <div className="text-danger-7 rounded-md border border-danger-3 bg-danger-1 px-2 py-1.5 text-[11px] leading-snug">
                  {tCommon("status.error")} ·{" "}
                  {snapshot.errorMessage || appMemoryState.errorMessage}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

export const SidebarRamMonitorButton: React.FC = React.memo(() => {
  const { t: tSettings } = useTranslation("settings");
  const { isOpen, isPositioned, toggle, triggerRef, panelRef, panelPosition } =
    useDropdownEngine<HTMLDivElement>({
      placement: "top",
      align: "right",
      gap: DROPDOWN_PANEL.triggerGap,
    });
  const buttonActiveClassName = isOpen ? "text-text-1" : "text-text-2";
  const triggerTitle = tSettings("monitor.performanceMonitor");

  return (
    <>
      <div ref={triggerRef} title={triggerTitle}>
        <button
          type="button"
          className={`flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] border-none p-0 transition-colors duration-150 ${
            isOpen
              ? "bg-sidebar-selected"
              : "bg-transparent hover:bg-sidebar-selected"
          }`}
          onClick={toggle}
          onMouseEnter={(event) => triggerIconAnimation(event.currentTarget)}
        >
          <HoverAnimatedIcon
            icon={GaugeIcon}
            iconName="gauge"
            size={16}
            strokeWidth={2}
            className={buttonActiveClassName}
          />
        </button>
      </div>
      {isPositioned && (
        <SidebarRamMonitorPanel
          isOpen={isOpen}
          panelRef={panelRef}
          panelPosition={panelPosition}
        />
      )}
    </>
  );
});

SidebarRamMonitorButton.displayName = "SidebarRamMonitorButton";
