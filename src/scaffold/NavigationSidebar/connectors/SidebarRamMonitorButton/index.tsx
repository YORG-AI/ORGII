import { Gauge } from "lucide-react";
import React, { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { formatRuntimeBytes } from "@src/hooks/perf";

import HoverAnimatedIcon, {
  triggerIconAnimation,
} from "../../components/HoverAnimatedIcon";
import { MemoryBreakdownSection } from "./MemoryBreakdownSection";
import { MemoryStatRow } from "./MemoryStatRow";
import { CHILD_PROCESS_CATEGORY } from "./constants";
import { SUCCESS_FPS_THRESHOLD, SUCCESS_RAM_THRESHOLD_MB } from "./constants";
import { formatMegabytes, getAppMemoryTotal } from "./formatters";
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
  const { snapshot, runtimeRows, fpsSample, fpsValue, isSamplingFps } =
    useRamMonitorMetrics(isOpen);

  const handleToggleAttributionHints = useCallback(() => {
    setShowAttributionHints((previousValue) => !previousValue);
  }, []);

  const appMemoryMb = getAppMemoryTotal(snapshot);
  const backendRssMb = snapshot.memoryBreakdown?.backend_rss_mb ?? appMemoryMb;
  const fileCacheMb = snapshot.memoryBreakdown?.file_cache_mb ?? 0;
  const terminalPtyBufferBytes = snapshot.ptyMemory.reduce(
    (sum, ptyInfo) => sum + ptyInfo.buffer_bytes,
    0
  );
  const totalTerminalBufferBytes =
    snapshot.terminalBufferBytes + terminalPtyBufferBytes;
  const tauriWebViewRendererMemoryMb = snapshot.childProcesses
    .filter(
      (childProcess) => childProcess.category === CHILD_PROCESS_CATEGORY.WEBVIEW
    )
    .reduce((sum, childProcess) => sum + childProcess.memory_mb, 0);
  const tauriGpuMemoryMb = snapshot.childProcesses
    .filter(
      (childProcess) => childProcess.category === CHILD_PROCESS_CATEGORY.GPU
    )
    .reduce((sum, childProcess) => sum + childProcess.memory_mb, 0);
  const tauriNetworkMemoryMb = snapshot.childProcesses
    .filter(
      (childProcess) => childProcess.category === CHILD_PROCESS_CATEGORY.NETWORK
    )
    .reduce((sum, childProcess) => sum + childProcess.memory_mb, 0);
  const webkitProcessMemoryMb =
    tauriWebViewRendererMemoryMb + tauriGpuMemoryMb + tauriNetworkMemoryMb;
  const totalAppRamMb = appMemoryMb + webkitProcessMemoryMb;
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
      label: "Backend process",
      value: formatMegabytes(backendRssMb),
      bytes: backendRssMb * 1024 * 1024,
    },
    {
      key: "backendFileCache",
      label: "File cache",
      value: formatMegabytes(fileCacheMb),
      bytes: fileCacheMb * 1024 * 1024,
      indentLevel: 1,
    },
    {
      key: "webkitGroup",
      label: "WebKit / WebView helpers",
      value: formatMegabytes(webkitProcessMemoryMb),
      bytes: webkitProcessMemoryMb * 1024 * 1024,
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
                label="Total app RAM"
                value={formatMegabytes(totalAppRamMb)}
                emphasized
                tone={
                  totalAppRamMb > 0 && totalAppRamMb < SUCCESS_RAM_THRESHOLD_MB
                    ? "success"
                    : undefined
                }
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

              <div className="my-2 border-t border-border-2" />
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

              {snapshot.errorMessage && (
                <div className="text-danger-7 rounded-md border border-danger-3 bg-danger-1 px-2 py-1.5 text-[11px] leading-snug">
                  {tCommon("status.error")} · {snapshot.errorMessage}
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
            icon={Gauge}
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
