/**
 * Renderer for `canvas-preview` tabs.
 *
 * Reads session-scoped canvas state through the canonical hook and renders
 * the payload in a full-height WorkStation view. Closing the card closes the
 * tab and clears the matching Canvas entry.
 */
import { ExternalLink, Layout, X } from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import IconButton from "@src/components/IconButton";
import CanvasPreviewSurface from "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasPreviewSurface";
import {
  buildHtmlDocument,
  buildReactDocument,
} from "@src/engines/ChatPanel/blocks/CanvasInlineCard/canvasBuilder";
import { useCanvasForTurn } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/useCanvasForTurn";
import { EditorTabService } from "@src/services/workStation/EditorTabService";
import { getCanvasPreviewTabId } from "@src/store/workstation/tabs/factories/canvasPreview";

import type { UnifiedTabContentProps } from "../types";

function buildExternalSrcDoc(
  mode: string,
  content: string | undefined
): string | undefined {
  if (mode === "html" && content) return buildHtmlDocument(content);
  if (mode === "react" && content) return buildReactDocument(content);
  return undefined;
}

const CanvasPreviewTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { t } = useTranslation();
    const sessionId = String(tab.data.sessionId ?? "");
    const { snapshot, clearCanvas } = useCanvasForTurn(sessionId);
    const payload = snapshot.latestPayload;

    const handleDismiss = useCallback(() => {
      clearCanvas();
      EditorTabService.closeTab(getCanvasPreviewTabId(sessionId));
    }, [clearCanvas, sessionId]);

    const handleOpenExternal = useCallback(() => {
      if (!payload) return;
      if (payload.mode === "url" && payload.url) {
        window.open(payload.url, "_blank", "noopener,noreferrer");
        return;
      }
      const srcDoc = buildExternalSrcDoc(payload.mode, payload.content);
      if (srcDoc) {
        const blob = new Blob([srcDoc], { type: "text/html" });
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, "_blank", "noopener,noreferrer");
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      }
    }, [payload]);

    if (!payload) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-text-4">
          <Layout size={32} strokeWidth={1} />
          <span className="text-sm">{t("previews.noCanvasAvailable")}</span>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between border-b border-border-1 bg-fill-2 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <Layout size={13} className="shrink-0 text-primary-6" />
            <span className="truncate text-xs font-medium text-text-2">
              {payload.title ?? t("previews.canvas")}
            </span>
            {payload.mode === "url" && payload.url && (
              <span className="max-w-[200px] truncate text-xs text-text-4">
                {payload.url}
              </span>
            )}
            {payload.streaming && (
              <span
                aria-hidden
                className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary-6"
              />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              onClick={handleOpenExternal}
              title={t("previews.openInBrowser")}
              aria-label={t("previews.openInBrowser")}
              size="sm"
            >
              <ExternalLink size={12} />
            </IconButton>
            <IconButton
              onClick={handleDismiss}
              title={t("previews.closeCanvas")}
              aria-label={t("previews.closeCanvas")}
              size="sm"
            >
              <X size={12} />
            </IconButton>
          </div>
        </div>

        <div className="relative flex-1 overflow-auto">
          <CanvasPreviewSurface
            payload={payload}
            variant="tab"
            title={payload.title ?? t("previews.canvas")}
            emptyFallback={
              <div className="flex h-full items-center justify-center">
                <span className="text-xs text-text-4">
                  {payload.streaming
                    ? t("previews.generatingCanvas")
                    : t("previews.noContent")}
                </span>
              </div>
            }
          />
          {payload.streaming && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary-6/40"
              aria-hidden
            />
          )}
        </div>
      </div>
    );
  }
);

CanvasPreviewTabRenderer.displayName = "CanvasPreviewTabRenderer";

export default CanvasPreviewTabRenderer;
