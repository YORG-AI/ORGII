import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import type { ReplayMode } from "@src/engines/SessionCore/core/types";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cursor02Icon,
  HugeiconsIcon,
  PauseIcon,
  PlayIcon,
} from "@src/icons";

import { PlaybackSpeedInline } from "./PlaybackSpeedInline";
import { ReplayTimestampSegment } from "./ReplayTimestampSegment";
import {
  STATUS_BAR_ICON_BTN_20,
  STATUS_BAR_ICON_BTN_20_CIRCLE_NEUTRAL,
  STATUS_BAR_ICON_BTN_20_CIRCLE_PRIMARY,
  STATUS_BAR_TEXT_20,
} from "./tokens";

export interface SimulatorStatusBarViewProps {
  replayMode: ReplayMode;
  eventCount: number;
  isReplaying: boolean;
  playbackSpeed?: number;
  onPrevious: () => void;
  onPlayPause: () => void;
  onNext: () => void;
  onPlaybackSpeedChange?: (speed: number) => void;
  onEnterReplay: () => void;
  onFollow: () => void;
  /** Desktop-only replay filters. The Web adapter intentionally leaves these empty. */
  followOptions?: React.ReactNode;
  replayOptions?: React.ReactNode;
  /** Timestamp derives from the desktop SessionCore atoms and is omitted by Web. */
  showTimestamp?: boolean;
}

/**
 * Controlled visual contract for the Simulator replay pill. Desktop and Web
 * provide different state adapters, but share the exact transport UI.
 */
export const SimulatorStatusBarView: React.FC<SimulatorStatusBarViewProps> =
  memo(
    ({
      replayMode,
      eventCount,
      isReplaying,
      playbackSpeed,
      onPrevious,
      onPlayPause,
      onNext,
      onPlaybackSpeedChange,
      onEnterReplay,
      onFollow,
      followOptions,
      replayOptions,
      showTimestamp = false,
    }) => {
      const { t } = useTranslation("sessions");
      const pillBgClass =
        replayMode === "follow" ? "bg-primary-5" : SURFACE_TOKENS.surface;

      return (
        <div
          className={`relative isolate inline-flex h-8 transform-gpu items-center overflow-hidden rounded-full shadow-md ring-1 ring-border-2 ${pillBgClass}`}
          data-session-replay-status
        >
          <div className="inline-flex h-8 items-center gap-1.5 px-1.5">
            {replayMode === "replay" && showTimestamp ? (
              <ReplayTimestampSegment />
            ) : null}
            {replayMode === "follow" ? (
              <>
                <span className="inline-flex h-5 shrink-0 items-center pl-1.5 text-[11px] leading-none font-medium text-white">
                  {t("simulator.replay.followingAgent")}
                </span>
                {followOptions}
                {followOptions ? (
                  <div className="ml-1 h-4 w-px shrink-0 bg-white/25" />
                ) : null}
                <Tooltip
                  content={
                    <KeyboardShortcutTooltipContent
                      label={t("simulator.replay.freeBrowse")}
                    />
                  }
                  position="top"
                  mouseEnterDelay={200}
                  framedPanel
                >
                  <button
                    type="button"
                    data-testid="session-replay-enter-replay"
                    onClick={onEnterReplay}
                    className="flex h-5 w-5 transform-gpu items-center justify-center rounded-full text-white hover:bg-white/15 hover:text-white"
                    aria-label={t("simulator.replay.freeBrowse")}
                  >
                    <HugeiconsIcon
                      icon={Cursor02Icon}
                      data-icon="cursor-2"
                      size={12}
                      strokeWidth={1.75}
                    />
                  </button>
                </Tooltip>
              </>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="session-replay-previous"
                  onClick={onPrevious}
                  disabled={eventCount === 0}
                  className={`ml-0.5 ${STATUS_BAR_ICON_BTN_20}`}
                  title={t("simulator.replay.previousEvent")}
                  aria-label={t("simulator.replay.previousEvent")}
                >
                  <HugeiconsIcon
                    icon={ArrowLeft01Icon}
                    data-icon="arrow-left-1"
                    size={14}
                    strokeWidth={1.5}
                  />
                </button>
                <button
                  type="button"
                  data-testid="session-replay-play-pause"
                  onClick={onPlayPause}
                  disabled={eventCount === 0}
                  className={
                    isReplaying
                      ? STATUS_BAR_ICON_BTN_20_CIRCLE_NEUTRAL
                      : STATUS_BAR_ICON_BTN_20_CIRCLE_PRIMARY
                  }
                  title={
                    isReplaying
                      ? t("simulator.replay.pause")
                      : t("simulator.replay.play")
                  }
                  aria-label={
                    isReplaying
                      ? t("simulator.replay.pause")
                      : t("simulator.replay.play")
                  }
                >
                  <HugeiconsIcon
                    icon={isReplaying ? PauseIcon : PlayIcon}
                    data-icon={isReplaying ? "pause" : "play"}
                    size={12}
                    fill="currentColor"
                    strokeWidth={0}
                  />
                </button>
                <button
                  type="button"
                  data-testid="session-replay-next"
                  onClick={onNext}
                  disabled={eventCount === 0}
                  className={STATUS_BAR_ICON_BTN_20}
                  title={t("simulator.replay.nextEvent")}
                  aria-label={t("simulator.replay.nextEvent")}
                >
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    data-icon="arrow-right-1"
                    size={14}
                    strokeWidth={1.5}
                  />
                </button>
                {playbackSpeed != null && onPlaybackSpeedChange != null ? (
                  <PlaybackSpeedInline
                    value={playbackSpeed}
                    onChange={onPlaybackSpeedChange}
                    disabled={eventCount === 0}
                  />
                ) : null}
                {replayOptions}
                <div className="ml-1 h-4 w-px shrink-0 bg-border-2" />
                <button
                  type="button"
                  onClick={onFollow}
                  title={t("simulator.replay.follow")}
                  className={`${STATUS_BAR_TEXT_20} shrink-0 transform-gpu rounded-full px-2 font-medium text-text-2 ${SURFACE_TOKENS.hover} hover:text-primary-6`}
                >
                  {t("simulator.replay.follow")}
                </button>
              </>
            )}
          </div>
        </div>
      );
    }
  );

SimulatorStatusBarView.displayName = "SimulatorStatusBarView";
