/**
 * Canvas App
 *
 * Renders agent-generated dynamic UI in a sandboxed iframe (html/url modes)
 * or as native React components (a2ui mode).
 *
 * Listens for canvas events from the backend via WebSocket:
 * - canvas:present     — Show HTML content or URL
 * - canvas:hide        — Hide the canvas
 * - canvas:navigate    — Navigate to a URL
 * - canvas:eval        — Execute JavaScript via the active preview surface
 * - canvas:a2ui_push   — Push A2UI JSONL content (accumulated incrementally)
 * - canvas:a2ui_reset  — Reset A2UI state
 */
import {
  Layout,
  Maximize2,
  Minimize2,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import IconButton from "@src/components/IconButton";
import { Placeholder } from "@src/components/Placeholder";
import CanvasPreviewSurface, {
  type CanvasPreviewSurfaceHandle,
} from "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasPreviewSurface";
import type { CanvasInlineMode } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";
import type { SimulatorAppProps } from "@src/engines/Simulator/apps/core/types";
import {
  NoTabsPlaceholder,
  WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS,
  useSimulatorAwaitingAgentCaption,
  useSimulatorPlaceholderActions,
} from "@src/modules/WorkStation/shared";

// ============================================
// Types
// ============================================

interface CanvasState {
  visible: boolean;
  mode: CanvasInlineMode | "empty";
  url: string | null;
  content: string | null;
  width: number | null;
  height: number | null;
}

const INITIAL_STATE: CanvasState = {
  visible: false,
  mode: "empty",
  url: null,
  content: null,
  width: null,
  height: null,
};

// ============================================
// Component
// ============================================

function CanvasApp(props: SimulatorAppProps) {
  const [state, setState] = useState<CanvasState>(INITIAL_STATE);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const surfaceRef = useRef<CanvasPreviewSurfaceHandle>(null);
  const { t } = useTranslation("sessions");
  const { t: tCommon } = useTranslation("common");
  const simulatorPlaceholderActions = useSimulatorPlaceholderActions(
    props.mode ?? "simulation"
  );
  const simulatorAwaitingAgentCaption = useSimulatorAwaitingAgentCaption();

  useEffect(() => {
    let cancelled = false;

    function handleCanvasEvent(
      event: CustomEvent<{ type: string; data: Record<string, unknown> }>
    ) {
      if (cancelled) return;

      const { type, data } = event.detail;

      switch (type) {
        case "canvas:present":
          setState((prev) => ({
            ...prev,
            visible: true,
            mode: data.html ? "html" : data.url ? "url" : prev.mode,
            url: (data.url as string) || prev.url,
            content: (data.html as string) || prev.content,
            width: (data.width as number) || prev.width,
            height: (data.height as number) || prev.height,
          }));
          break;

        case "canvas:hide":
          setState((prev) => ({ ...prev, visible: false }));
          break;

        case "canvas:navigate":
          setState((prev) => ({
            ...prev,
            visible: true,
            mode: "url",
            url: (data.url as string) || prev.url,
          }));
          break;

        case "canvas:eval":
          if (data.javascript) {
            surfaceRef.current?.evalScript(data.javascript as string);
          }
          break;

        case "canvas:a2ui_push":
          if (data.jsonl) {
            setState((prev) => ({
              ...prev,
              visible: true,
              mode: "a2ui",
              content: [prev.content, data.jsonl as string]
                .filter(Boolean)
                .join("\n"),
            }));
          }
          break;

        case "canvas:a2ui_reset":
          setState((prev) => ({
            ...prev,
            content: prev.mode === "a2ui" ? null : prev.content,
            mode: prev.mode === "a2ui" ? "empty" : prev.mode,
          }));
          break;
      }
    }

    window.addEventListener(
      "canvas-event" as keyof WindowEventMap,
      handleCanvasEvent as EventListener
    );

    return () => {
      cancelled = true;
      window.removeEventListener(
        "canvas-event" as keyof WindowEventMap,
        handleCanvasEvent as EventListener
      );
    };
  }, []);

  const handleClose = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  if (!state.visible && state.mode === "empty") {
    return (
      <NoTabsPlaceholder
        icon="canvas"
        caption={simulatorAwaitingAgentCaption}
        actions={simulatorPlaceholderActions}
      />
    );
  }

  const payload =
    state.mode === "empty"
      ? null
      : {
          mode: state.mode,
          content: state.content ?? undefined,
          url: state.url ?? undefined,
          title: t("simulator.replay.canvas.iframeTitle"),
        };

  return (
    <div
      className={`flex h-full flex-col ${
        isFullscreen ? "fixed inset-0 z-50 bg-bg-1" : ""
      }`}
    >
      <div className="flex items-center justify-between border-b border-border-2 bg-workstation-bg px-3 py-1.5">
        <div className="flex items-center gap-2 text-sm text-text-2">
          <Layout className="h-4 w-4" />
          <span>{t("simulator.replay.canvas.toolbarTitle")}</span>
          {state.mode === "url" && state.url && (
            <span className="max-w-[200px] truncate text-xs text-text-3">
              {state.url}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {state.mode === "url" && state.url && (
            <IconButton
              onClick={() => window.open(state.url!, "_blank")}
              title={t("simulator.replay.canvas.tooltipOpenInBrowser")}
              aria-label={t("simulator.replay.canvas.tooltipOpenInBrowser")}
              size="sm"
            >
              <SquareArrowOutUpRight className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <IconButton
            onClick={handleToggleFullscreen}
            title={
              isFullscreen
                ? t("simulator.replay.canvas.tooltipExitFullscreen")
                : t("simulator.replay.canvas.tooltipFullscreen")
            }
            aria-label={
              isFullscreen
                ? t("simulator.replay.canvas.tooltipExitFullscreen")
                : t("simulator.replay.canvas.tooltipFullscreen")
            }
            size="sm"
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </IconButton>
          <IconButton
            onClick={handleClose}
            title={t("simulator.replay.canvas.tooltipCloseCanvas")}
            aria-label={t("simulator.replay.canvas.tooltipCloseCanvas")}
            size="sm"
          >
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {payload ? (
          <CanvasPreviewSurface
            ref={surfaceRef}
            payload={payload}
            variant="tab"
            title={payload.title}
            emptyFallback={
              <Placeholder
                variant="empty"
                placement="detail-panel"
                fillParentHeight
                className={WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS}
                title={tCommon("placeholders.canvasHidden")}
              />
            }
          />
        ) : (
          <Placeholder
            variant="empty"
            placement="detail-panel"
            fillParentHeight
            className={WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS}
            title={tCommon("placeholders.canvasHidden")}
          />
        )}
      </div>
    </div>
  );
}

export default CanvasApp;
