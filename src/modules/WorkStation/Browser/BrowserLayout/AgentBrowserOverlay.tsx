/**
 * AgentBrowserOverlay
 *
 * Full-screen overlay shown when the AI agent is controlling Chrome.
 * Chrome runs hidden (off-screen via CDP) while the agent is in control,
 * and the overlay displays a live screencast stream. On "Take Over",
 * Chrome window is shown on-screen for direct user interaction.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  HugeiconsIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  SquareArrowUpRightIcon,
} from "@src/icons";

import type { AgentBrowserOverlayProps } from "./types";

function inferImageMime(base64: string): string {
  if (base64.startsWith("/9j/") || base64.startsWith("/9j"))
    return "image/jpeg";
  return "image/png";
}

export const AgentBrowserOverlay: React.FC<AgentBrowserOverlayProps> = memo(
  ({ screenshot, action, url, isPaused, onTakeover, onResume, onStop }) => {
    const { t } = useTranslation();

    const screenshotSrc = useMemo(() => {
      if (!screenshot) return null;
      const mime = inferImageMime(screenshot);
      return `data:${mime};base64,${screenshot}`;
    }, [screenshot]);

    return (
      <div className="absolute inset-0 z-30 flex flex-col bg-bg-1">
        {/* Floating toolbar */}
        <div className="flex items-center justify-between border-b border-border-2 bg-fill-2 px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <HugeiconsIcon
              icon={MonitorIcon}
              data-icon="monitor"
              size={14}
              className="text-primary-6"
            />
            <span className="text-text-1">{t("workstation.agentBrowser")}</span>
            {isPaused ? (
              <span className="rounded bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-600">
                <HugeiconsIcon
                  icon={SquareArrowUpRightIcon}
                  data-icon="square-arrow-out-up-right"
                  size={10}
                  className="mr-1 inline"
                />
                {t("workstation.userInControl")}
              </span>
            ) : (
              <span className="rounded bg-primary-6/10 px-2 py-0.5 text-xs text-primary-6">
                {t("workstation.agentControlling")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isPaused ? (
              <Button size="mini" variant="primary" onClick={() => onResume()}>
                <HugeiconsIcon icon={PlayIcon} data-icon="play" size={12} />
                {t("workstation.returnToAgent")}
              </Button>
            ) : (
              <Button
                size="mini"
                variant="primary"
                appearance="outline"
                onClick={onTakeover}
              >
                <HugeiconsIcon icon={PauseIcon} data-icon="pause" size={12} />
                {t("workstation.takeOver")}
              </Button>
            )}
            <Button size="mini" variant="tertiary" onClick={onStop}>
              {t("actions.stop")}
            </Button>
          </div>
        </div>

        {/* Action banner */}
        {action && !isPaused && action !== "screencast" && (
          <div className="flex items-center gap-2 bg-primary-6/5 px-3 py-1 text-xs text-primary-6">
            <span className="truncate">{action}</span>
          </div>
        )}

        {/* Screenshot stream */}
        <div className="flex flex-1 items-center justify-center overflow-hidden bg-workstation-bg">
          {screenshotSrc ? (
            <img
              src={screenshotSrc}
              alt={`Agent browser — ${url}`}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <div className="text-sm text-text-3">
              {isPaused
                ? t("workstation.chromeWindowOpen")
                : t("workstation.waitingForScreenshot")}
            </div>
          )}
        </div>

        {/* URL footer */}
        {url && (
          <div className="border-t border-border-1 bg-fill-1 px-3 py-1 text-xs text-text-3">
            {url}
          </div>
        )}
      </div>
    );
  }
);

AgentBrowserOverlay.displayName = "AgentBrowserOverlay";
