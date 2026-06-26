/**
 * Renderer for `canvas-preview` tabs.
 *
 * Reads the `canvasPreviewAtom` for the tab's sessionId and renders the
 * canvas payload in a full-height WorkStation view. Closing the card closes
 * the tab and restores the Canvas pill in PinnedActionsBar.
 */
import { useAtom } from "jotai";
import { ExternalLink, Layout } from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import A2UIRenderer from "@src/engines/ChatPanel/blocks/CanvasInlineCard/A2UIRenderer";
import { buildHtmlDocument } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/canvasBuilder";
import { EditorTabService } from "@src/services/workStation";
import { canvasPreviewAtom } from "@src/store/session/canvasPreviewAtom";
import { getCanvasPreviewTabId } from "@src/store/workstation/tabs/factories/canvasPreview";

import type { UnifiedTabContentProps } from "../types";

const CanvasPreviewTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { t } = useTranslation();
    const sessionId = String(tab.data.sessionId ?? "");
    const [entry, setEntry] = useAtom(canvasPreviewAtom);

    const payload =
      entry && entry.sessionId === sessionId ? entry.payload : null;

    const handleDismiss = useCallback(() => {
      setEntry(null);
      EditorTabService.closeTab(getCanvasPreviewTabId(sessionId));
    }, [sessionId, setEntry]);

    const srcDoc = useMemo(() => {
      if (!payload) return undefined;
      if (payload.mode === "html" && payload.content) {
        return buildHtmlDocument(payload.content);
      }
      return undefined;
    }, [payload]);

    const a2uiLines = useMemo(() => {
      if (!payload || payload.mode !== "a2ui" || !payload.content) return [];
      return payload.content.split("\n").filter(Boolean);
    }, [payload]);

    const handleOpenExternal = useCallback(() => {
      if (!payload) return;
      if (payload.mode === "url" && payload.url) {
        window.open(payload.url, "_blank", "noopener,noreferrer");
        return;
      }
      if (srcDoc) {
        const blob = new Blob([srcDoc], { type: "text/html" });
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, "_blank", "noopener,noreferrer");
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      }
    }, [payload, srcDoc]);

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
        {/* toolbar */}
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
            <button
              type="button"
              onClick={handleOpenExternal}
              className="rounded p-1 text-text-4 transition-colors hover:bg-fill-3 hover:text-text-2"
              title={t("previews.openInBrowser")}
            >
              <ExternalLink size={12} />
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              className="rounded p-1 text-sm text-text-4 transition-colors hover:bg-fill-3 hover:text-text-2"
              title={t("previews.closeCanvas")}
            >
              ✕
            </button>
          </div>
        </div>

        {/* content */}
        <div className="relative flex-1 overflow-auto">
          {payload.mode === "url" && payload.url ? (
            <iframe
              src={payload.url}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              title={payload.title ?? t("previews.canvas")}
            />
          ) : payload.mode === "a2ui" && a2uiLines.length > 0 ? (
            <A2UIRenderer lines={a2uiLines} className="h-full" />
          ) : srcDoc ? (
            <iframe
              srcDoc={srcDoc}
              className="h-full w-full border-0"
              sandbox="allow-scripts"
              title={payload.title ?? t("previews.canvas")}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <span className="text-xs text-text-4">
                {payload.streaming
                  ? t("previews.generatingCanvas")
                  : t("previews.noContent")}
              </span>
            </div>
          )}
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
