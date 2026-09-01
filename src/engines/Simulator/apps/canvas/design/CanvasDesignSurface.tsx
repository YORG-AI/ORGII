import { useSetAtom } from "jotai";
import React, { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import BasePill from "@src/components/ComposerInput/BasePill";
import IconButton from "@src/components/IconButton";
import { PILL_SIZE } from "@src/config/pillTokens";
import InputArea from "@src/engines/ChatPanel/InputArea";
import CanvasPreviewSurface from "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasPreviewSurface";
import type { SubmitOverrideInput } from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { useWorkspaceChat } from "@src/engines/ChatPanel/hooks/useWorkspaceChat";
import { goLiveAtom } from "@src/engines/SessionCore/core/atoms";
import {
  buildDomComponentJsonFromElementInfo,
  buildDomComponentUserMessage,
} from "@src/features/DomSelection/domComponentPayload";
import type { DomSelectionRect } from "@src/features/DomSelection/types";
import { Cancel01Icon, Cursor02Icon, HugeiconsIcon } from "@src/icons";

import type { CanvasDesignSelection } from "./canvasDomCapture";
import { useCanvasDesignInspector } from "./useCanvasDesignInspector";

interface CanvasPayload {
  mode: "html" | "react" | "a2ui" | "url";
  content?: string;
  url?: string;
  title?: string;
  streaming?: boolean;
}

interface CanvasDesignSurfaceProps {
  payload: CanvasPayload;
  reloadKey: number;
  title: string;
  eventId: string;
  sessionId: string;
  designEnabled: boolean;
}

interface CanvasDesignPromptProps {
  selection: CanvasDesignSelection;
  rootRect: DomSelectionRect;
  payload: CanvasPayload;
  eventId: string;
  sessionId: string;
  title: string;
  onSubmitted: () => void;
  onDismiss: () => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

type CanvasDesignPromptPlacement = "below" | "docked";

interface CanvasDesignPromptLayout {
  placement: CanvasDesignPromptPlacement;
  style: React.CSSProperties;
}

// The revision composer runs with agent interceptors off, so slash items that
// mutate session state (for example /canvas creation) must not be offered
// here. Mirrors the restriction HumanSessionView applies to its work-log
// composer.
const CANVAS_DESIGN_SLASH_ITEM_CATEGORIES = ["skill"] as const;

const PROMPT_GAP = 12;
const PROMPT_MAX_WIDTH = 640;
const PROMPT_ESTIMATED_HEIGHT = 52;
// FloatingReplayContainer occupies the bottom of every active Simulator app.
// Keep the Canvas composer above that shared chrome instead of placing both
// controls on the same bottom edge.
const PROMPT_DOCK_BOTTOM_INSET = 72;
const VIEWPORT_MARGIN = 8;

interface CanvasSelectionPillProps {
  selection: CanvasDesignSelection;
  onDismiss: () => void;
  dismissLabel: string;
}

const CanvasSelectionPill: React.FC<CanvasSelectionPillProps> = ({
  selection,
  onDismiss,
  dismissLabel,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onDismiss();
    },
    [onDismiss]
  );

  return (
    <BasePill
      variant="editor"
      iconNode={
        isHovered ? (
          <HugeiconsIcon
            icon={Cancel01Icon}
            data-icon="x"
            size={PILL_SIZE.iconSize}
            strokeWidth={2}
            aria-hidden
          />
        ) : (
          <HugeiconsIcon
            icon={Cursor02Icon}
            data-icon="mouse-pointer-2"
            size={PILL_SIZE.iconSize}
            strokeWidth={1.75}
            aria-hidden
          />
        )
      }
      className="max-w-40 cursor-pointer"
      title={selection.tooltipLabel}
      aria-label={dismissLabel}
      role="button"
      tabIndex={0}
      onClick={onDismiss}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onKeyDown={handleKeyDown}
      data-canvas-design-selection-pill
    >
      <span className="min-w-0 truncate">
        {/^(h[1-6])$/i.test(selection.elementInfo.tagName)
          ? selection.elementInfo.tagName.toUpperCase()
          : selection.label}
      </span>
    </BasePill>
  );
};

export function computeCanvasDesignPromptLayout(
  selection: CanvasDesignSelection,
  rootRect: DomSelectionRect,
  viewportSize: { width: number; height: number }
): CanvasDesignPromptLayout {
  const visibleLeft = Math.max(rootRect.x, VIEWPORT_MARGIN);
  const visibleTop = Math.max(rootRect.y, VIEWPORT_MARGIN);
  const visibleRight = Math.min(
    rootRect.x + rootRect.width,
    viewportSize.width - VIEWPORT_MARGIN
  );
  const visibleBottom = Math.min(
    rootRect.y + rootRect.height,
    viewportSize.height - VIEWPORT_MARGIN
  );
  const visibleWidth = Math.max(1, visibleRight - visibleLeft);
  const width = Math.max(
    1,
    Math.min(PROMPT_MAX_WIDTH, visibleWidth - PROMPT_GAP * 2)
  );
  const selectionTop = rootRect.y + selection.rect.y;
  const selectionBottom = selectionTop + selection.rect.height;
  const availableBelow =
    visibleBottom - PROMPT_DOCK_BOTTOM_INSET - selectionBottom - PROMPT_GAP;
  const coversMostOfCanvas =
    rootRect.height > 0 && selection.rect.height >= rootRect.height * 0.55;
  const docked = coversMostOfCanvas || availableBelow < PROMPT_ESTIMATED_HEIGHT;
  const placement: CanvasDesignPromptPlacement = docked ? "docked" : "below";
  const availableDockHeight = Math.max(
    PROMPT_GAP,
    visibleBottom - visibleTop - PROMPT_ESTIMATED_HEIGHT - PROMPT_GAP
  );
  const dockBottomInset = Math.min(
    PROMPT_DOCK_BOTTOM_INSET,
    availableDockHeight
  );
  const left = visibleLeft + (visibleWidth - width) / 2;

  return {
    placement,
    style:
      placement === "below"
        ? {
            position: "fixed",
            top: Math.max(
              visibleTop + PROMPT_GAP,
              selectionBottom + PROMPT_GAP
            ),
            left,
            width,
          }
        : {
            position: "fixed",
            bottom: viewportSize.height - visibleBottom + dockBottomInset,
            left,
            width,
          },
  };
}

const CanvasDesignPrompt: React.FC<CanvasDesignPromptProps> = ({
  selection,
  rootRect,
  payload,
  eventId,
  sessionId,
  title,
  onSubmitted,
  onDismiss,
}) => {
  const { t } = useTranslation("sessions");
  const { handleSessChatSubmit } = useWorkspaceChat({ sessionId });
  const goLive = useSetAtom(goLiveAtom);
  const promptLayout = computeCanvasDesignPromptLayout(selection, rootRect, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const handleSubmitOverride = useCallback(
    async ({ displayText }: SubmitOverrideInput): Promise<boolean> => {
      const instruction = displayText.trim();
      const canvasSelection = {
        schemaVersion: 1 as const,
        origin: "canvas-design" as const,
        canvas: {
          sessionId,
          eventId,
          mode: payload.mode,
          title,
        },
        selection: {
          kind: selection.kind,
          label: selection.label,
          rect: selection.rect,
          targets: selection.targets,
        },
        previewHtml: selection.previewHtml,
      };
      const built = buildDomComponentJsonFromElementInfo(
        selection.elementInfo,
        `canvas://${encodeURIComponent(sessionId)}/${encodeURIComponent(eventId)}`,
        { displayLabel: selection.label, canvasSelection }
      );
      const message = buildDomComponentUserMessage(
        built,
        instruction,
        eventId,
        {
          currentCanvas: {
            mode: payload.mode,
            content: payload.content,
            url: payload.url,
            title: payload.title ?? title,
            streaming: payload.streaming,
          },
        }
      );

      await handleSessChatSubmit(
        undefined,
        message.displayContent,
        message.agentContent
      );
      // A design revision acts on the live Canvas. If the replay cursor was
      // parked on an earlier event (e.g. via jump-from-chat), the up-to-cursor
      // simulator window would exclude the incoming revision and the Canvas
      // would appear stale until reopened — snap back to follow mode so the
      // revision streams and materializes in view.
      goLive();
      onSubmitted();
      return true;
    },
    [
      eventId,
      goLive,
      handleSessChatSubmit,
      onSubmitted,
      payload.content,
      payload.mode,
      payload.title,
      payload.url,
      payload.streaming,
      selection,
      sessionId,
      title,
    ]
  );

  return createPortal(
    <div
      data-canvas-design-ui
      data-canvas-design-prompt
      data-placement={promptLayout.placement}
      className="pointer-events-auto z-10000 drop-shadow-2xl"
      style={promptLayout.style}
      role="dialog"
      aria-label={t("canvasApp.designPromptLabel", "Describe a Canvas change")}
    >
      <InputArea
        key={`${selection.kind}:${selection.elementInfo.xpath}`}
        placeholder={t(
          "canvasApp.designPromptPlaceholder",
          "Describe what to change…"
        )}
        sessionId={sessionId}
        sessionScope="none"
        onSubmitOverride={handleSubmitOverride}
        omitChatHeader
        surfaceBg
        autoFocus
        acceptDraggedPills={false}
        allowFileAttachments={false}
        enableAgentInterceptors={false}
        disableStopWhenEmpty
        bottomAnchored={promptLayout.placement === "docked"}
        presentation="contextual"
        slashItemCategories={CANVAS_DESIGN_SLASH_ITEM_CATEGORIES}
        topRowPills={
          <CanvasSelectionPill
            selection={selection}
            onDismiss={onDismiss}
            dismissLabel={t(
              "canvasApp.clearDesignSelection",
              "Clear Canvas selection"
            )}
          />
        }
      />
    </div>,
    document.body
  );
};

const CanvasDesignSurface: React.FC<CanvasDesignSurfaceProps> = ({
  payload,
  reloadKey,
  title,
  eventId,
  sessionId,
  designEnabled,
}) => {
  const { t } = useTranslation("sessions");
  const rootRef = useRef<HTMLDivElement>(null);
  const inspector = useCanvasDesignInspector(rootRef, designEnabled);
  const visibleSelection = inspector.selected ?? inspector.hovered;

  return (
    <div
      ref={rootRef}
      className={`relative h-full min-h-0 w-full overflow-hidden ${
        designEnabled ? "cursor-crosshair select-none" : ""
      }`}
      data-testid="canvas-design-surface"
      data-design-enabled={designEnabled ? "true" : "false"}
    >
      <CanvasPreviewSurface
        payload={payload}
        variant="simulator"
        title={title}
        reloadKey={reloadKey}
        emptyFallback={
          <div className="flex h-full items-center justify-center">
            <span className="text-xs text-text-4">
              {payload.streaming
                ? t("canvasCard.waiting", "Waiting for content…")
                : t("canvasCard.empty", "No content")}
            </span>
          </div>
        }
      />

      {designEnabled && (
        <div
          data-canvas-design-ui
          className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
          aria-hidden={!inspector.selected}
        >
          {visibleSelection && (
            <>
              <div
                className="absolute border-2 border-primary-6 bg-primary-6/10"
                style={{
                  left: visibleSelection.rect.x,
                  top: visibleSelection.rect.y,
                  width: visibleSelection.rect.width,
                  height: visibleSelection.rect.height,
                }}
              />
              {!inspector.selected && (
                <div
                  data-canvas-design-hover-label
                  className="absolute max-w-80 truncate rounded bg-primary-6 px-2 py-1 text-xs font-medium text-white shadow-lg"
                  style={{
                    left: clamp(
                      visibleSelection.rect.x,
                      4,
                      inspector.rootSize.width - 160
                    ),
                    top:
                      visibleSelection.rect.y >= 32
                        ? visibleSelection.rect.y - 30
                        : visibleSelection.rect.y +
                          visibleSelection.rect.height +
                          4,
                  }}
                >
                  {visibleSelection.tooltipLabel}
                  <span className="ml-2 font-normal opacity-80">
                    {t(
                      "canvasApp.designHoverHint",
                      "Click to select, drag to draw"
                    )}
                  </span>
                </div>
              )}
              {inspector.selected && (
                <IconButton
                  data-canvas-design-close
                  className="pointer-events-auto absolute rounded-full bg-text-1 text-bg-1 shadow-lg hover:bg-text-2"
                  style={{
                    left: clamp(
                      visibleSelection.rect.x +
                        visibleSelection.rect.width -
                        14,
                      4,
                      inspector.rootSize.width - 32
                    ),
                    top:
                      visibleSelection.rect.y >= 36
                        ? visibleSelection.rect.y - 34
                        : visibleSelection.rect.y + 4,
                  }}
                  aria-label={t(
                    "canvasApp.clearDesignSelection",
                    "Clear Canvas selection"
                  )}
                  onClick={inspector.clearSelection}
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    data-icon="x"
                    size={15}
                    aria-hidden
                  />
                </IconButton>
              )}
            </>
          )}
          {inspector.marquee && (
            <div
              className="absolute border-2 border-dashed border-primary-6 bg-primary-6/10"
              style={{
                left: inspector.marquee.x,
                top: inspector.marquee.y,
                width: inspector.marquee.width,
                height: inspector.marquee.height,
              }}
            />
          )}
        </div>
      )}
      {designEnabled && inspector.selected && inspector.promptOpen && (
        <CanvasDesignPrompt
          key={`${inspector.selected.kind}:${inspector.selected.elementInfo.xpath}`}
          selection={inspector.selected}
          rootRect={inspector.rootRect}
          payload={payload}
          eventId={eventId}
          sessionId={sessionId}
          title={title}
          onSubmitted={inspector.closePrompt}
          onDismiss={inspector.clearSelection}
        />
      )}
    </div>
  );
};

CanvasDesignSurface.displayName = "CanvasDesignSurface";

export default CanvasDesignSurface;
