/**
 * UrlPreviewContent Component
 *
 * Renders a native Tauri webview for URL preview in the editor area.
 * Used by agent to open URLs for preview/inspection.
 *
 * Uses the same useInlineWebview hook as the Browser module to create
 * native webviews that bypass X-Frame-Options restrictions.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import { useInlineWebview } from "@src/hooks/platform/useInlineWebview";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  HugeiconsIcon,
  Refresh04Icon,
  SquareArrowUpRightIcon,
} from "@src/icons";
import { isTauriDesktop } from "@src/util/platform/tauri";

interface UrlPreviewContentProps {
  url: string;
  title?: string;
}

// Generate label outside component to avoid impure function in render
let labelCounter = 0;
function getNextLabel(): string {
  return `url-preview-${++labelCounter}`;
}

const UrlPreviewContent: React.FC<UrlPreviewContentProps> = memo(
  ({ url, title }) => {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const isTauri = isTauriDesktop();

    // Generate a stable label for the webview (useState to avoid ref access in render)
    const [label] = React.useState(getNextLabel);

    const { reload, isWebviewCreated, updatePosition } = useInlineWebview({
      containerRef,
      url,
      isActive: true,
      isVisible: true,
      labelPrefix: label,
      useExactLabel: true,
      incognito: false,
      debug: false,
      pollInterval: 500,
      onNewWindow: (newUrl: string) => {
        // Open new windows in external browser
        window.open(newUrl, "_blank", "noopener,noreferrer");
      },
    });

    // Update position when mounted
    useEffect(() => {
      if (isWebviewCreated) {
        // Trigger position updates after mount for proper positioning
        const timers = [0, 50, 100, 200].map((delay) =>
          setTimeout(() => updatePosition(), delay)
        );
        return () => timers.forEach(clearTimeout);
      }
    }, [isWebviewCreated, updatePosition]);

    const handleReload = useCallback(() => {
      reload();
    }, [reload]);

    const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
      handleReload,
      !isWebviewCreated
    );

    const handleOpenExternal = useCallback(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    }, [url]);

    // Extract hostname for display
    const hostname = useMemo(() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    }, [url]);

    // Toolbar (URL bar) — published into the global Workstation tab-header
    // strip so the 40px row is shared with other tabs (file breadcrumb,
    // git commit info, etc.). The webview always claims the full content
    // area below; in non-Tauri dev a placeholder is rendered instead.
    const toolbarContent = useMemo(
      () => (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isTauri && (
            <Button
              variant="tertiary"
              size="small"
              onClick={handleRefreshClick}
              icon={
                <HugeiconsIcon
                  icon={Refresh04Icon}
                  data-icon="refresh-cw"
                  size={14}
                  className={spinClass}
                />
              }
              title={t("previews.reload")}
            />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-xs text-text-2">
              {title || hostname}
            </span>
            <span className="shrink-0 truncate text-xs text-text-3">{url}</span>
          </div>
          <Button
            variant="tertiary"
            size="small"
            onClick={handleOpenExternal}
            icon={
              <HugeiconsIcon
                icon={SquareArrowUpRightIcon}
                data-icon="square-arrow-out-up-right"
                size={14}
              />
            }
            title={t("previews.openInBrowser")}
          />
        </div>
      ),
      [
        isTauri,
        handleRefreshClick,
        spinClass,
        title,
        hostname,
        url,
        handleOpenExternal,
        t,
      ]
    );

    usePublishWorkstationTabHeader({ host: "code", content: toolbarContent });

    // Fallback for non-Tauri environment (development in browser)
    if (!isTauri) {
      return (
        <div className="flex h-full flex-col">
          <div className="flex flex-1 items-center justify-center">
            <Placeholder
              variant="empty"
              placement="detail-panel"
              title={t("previews.urlPreviewRequiresTauri")}
              subtitle={t("previews.openInExternalBrowser")}
              fillParentHeight
            />
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col">
        {/* Webview container - native webview overlays this */}
        <div ref={containerRef} className="relative flex-1 bg-white">
          {!isWebviewCreated && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-1">
              <Placeholder
                variant="loading"
                placement="detail-panel"
                fillParentHeight
              />
            </div>
          )}
        </div>
      </div>
    );
  }
);

UrlPreviewContent.displayName = "UrlPreviewContent";

export default UrlPreviewContent;
