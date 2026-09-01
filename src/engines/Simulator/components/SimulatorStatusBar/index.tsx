/**
 * SimulatorStatusBar Component
 *
 * Status bar showing current mode and time information:
 * - Follow mode: "Following session time count [Replay]"
 * - Free browsing mode: "Free browsing (time stamp) [Follow]"
 *
 * Similar to Zoom's status bar at the bottom of meetings
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import {
  currentEventIdAtom,
  effectiveSimulatorEventIdsAtom,
  navigateNextSimulatorEventAtom,
  navigatePrevSimulatorEventAtom,
  replayBarValueAtom,
  replayModeAtom,
  simulatorEventCountAtom,
} from "@src/engines/SessionCore";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cursor02Icon,
  HugeiconsIcon,
  PauseIcon,
  PlayIcon,
} from "@src/icons";
import {
  simulatorFollowAppLockAtom,
  simulatorSelectedAppAtom,
} from "@src/store/ui/simulatorAtom";

import { EventFilterDropdown } from "./EventFilterDropdown";
import { FollowModeDropdown } from "./FollowModeDropdown";
import { PlaybackSpeedInline } from "./PlaybackSpeedInline";
import { ReplayTimestampSegment } from "./ReplayTimestampSegment";
import {
  STATUS_BAR_ICON_BTN_20,
  STATUS_BAR_ICON_BTN_20_CIRCLE_NEUTRAL,
  STATUS_BAR_ICON_BTN_20_CIRCLE_PRIMARY,
  STATUS_BAR_TEXT_20,
} from "./tokens";

interface SimulatorStatusBarProps {
  /** Callback when toggling between follow/free browsing */
  onToggleMode?: () => void;
  /** Whether auto-play is active */
  isReplaying?: boolean;
  /** Toggle play/pause */
  onPlayPause?: () => void;
  /** Playback speed multiplier (free browse); right of next-event control */
  playbackSpeed?: number;
  onPlaybackSpeedChange?: (speed: number) => void;
}

export const SimulatorStatusBar: React.FC<SimulatorStatusBarProps> = memo(
  ({
    onToggleMode,
    isReplaying = false,
    onPlayPause,
    playbackSpeed,
    onPlaybackSpeedChange,
  }) => {
    const { t } = useTranslation("sessions");

    const [replayMode, setReplayMode] = useAtom(replayModeAtom);
    const effectiveSimulatorEventIds = useAtomValue(
      effectiveSimulatorEventIdsAtom
    );
    const eventCount = useAtomValue(simulatorEventCountAtom);
    const setCurrentEventId = useSetAtom(currentEventIdAtom);
    const setReplayBarValue = useSetAtom(replayBarValueAtom);
    const navigatePrev = useSetAtom(navigatePrevSimulatorEventAtom);
    const navigateNext = useSetAtom(navigateNextSimulatorEventAtom);
    const setSelectedApp = useSetAtom(simulatorSelectedAppAtom);
    const setFollowAppLock = useSetAtom(simulatorFollowAppLockAtom);

    const handleToggleToReplay = useCallback(() => {
      setReplayMode("replay");
      onToggleMode?.();
    }, [setReplayMode, onToggleMode]);

    const handleToggleToFollow = useCallback(() => {
      setReplayMode("follow");
      // Both `selectedApp` and `followAppLock` are free-browse-only
      // concepts ("I picked this app from the dock" / "while scrubbing
      // show only this app's events"). Entering follow means "agent
      // decides what to show", so any leftover from the previous replay
      // session would silently restrict the view while the pill claims
      // "Following Agent". Clear them on the way in.
      setSelectedApp(null);
      setFollowAppLock(null);

      const lastEventId = effectiveSimulatorEventIds.at(-1);
      if (lastEventId) {
        setCurrentEventId(lastEventId);
        setReplayBarValue(REPLAY_CONFIG.MAX_VALUE);
      }

      onToggleMode?.();
    }, [
      setReplayMode,
      setSelectedApp,
      setFollowAppLock,
      effectiveSimulatorEventIds,
      setCurrentEventId,
      setReplayBarValue,
      onToggleMode,
    ]);

    // In follow mode the entire pill is blue (single segment). In replay
    // mode the pill is a single chat-surface coloured strip — the previous
    // two-segment design (white controls + blue follow tail) read as two
    // pills crammed together, which the user explicitly asked us to drop.
    const pillBgClass =
      replayMode === "follow" ? "bg-primary-5" : SURFACE_TOKENS.surface;

    return (
      <div
        className={`relative isolate inline-flex h-8 transform-gpu items-center overflow-hidden rounded-full shadow-md ring-1 ring-border-2 ${pillBgClass}`}
      >
        <div className="inline-flex h-8 items-center gap-1.5 px-1.5">
          {replayMode === "replay" && <ReplayTimestampSegment />}
          {replayMode === "follow" ? (
            <>
              {/* Follow mode is "always-follow-the-Agent" — there is no
                target switching here. The per-app lock is a free-browse
                concept and lives in the replay branch below. Static
                text-only label; the `pl-1.5` keeps the text off the
                pill's left edge when the leading Keyboard cluster is
                hidden (chat visible). */}
              <span className="inline-flex h-5 shrink-0 items-center pl-1.5 text-[11px] leading-none font-medium text-white">
                {t("simulator.replay.followingAgent")}
              </span>
              <EventFilterDropdown variant="primary" iconOnly />
              <div className="ml-1 h-4 w-px shrink-0 bg-white/25" />
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
                  onClick={handleToggleToReplay}
                  className="flex h-5 w-5 transform-gpu items-center justify-center rounded-full text-white hover:bg-white/15 hover:text-white"
                >
                  <HugeiconsIcon
                    icon={Cursor02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </button>
              </Tooltip>
            </>
          ) : replayMode === "replay" ? (
            <>
              {/* Prev / Play / Next — then speed, then follow controls. */}
              <button
                data-testid="session-replay-previous"
                onClick={() => navigatePrev()}
                disabled={eventCount === 0}
                className={`ml-0.5 ${STATUS_BAR_ICON_BTN_20}`}
                title={t("simulator.replay.previousEvent")}
              >
                <HugeiconsIcon
                  icon={ArrowLeft01Icon}
                  size={14}
                  strokeWidth={1.5}
                />
              </button>
              <button
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
                data-testid="session-replay-next"
                onClick={() => navigateNext()}
                disabled={eventCount === 0}
                className={STATUS_BAR_ICON_BTN_20}
                title={t("simulator.replay.nextEvent")}
              >
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
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
              {/* Follow-target switch sits with the playback controls
                (Prev/Play/Next/Speed/Switch). The 1px divider then
                separates the "configure replay" cluster from the
                "commit: enter follow mode" action on the right. */}
              <EventFilterDropdown iconOnly />
              <FollowModeDropdown />
              <div className="ml-1 h-4 w-px shrink-0 bg-border-2" />
              <button
                type="button"
                onClick={handleToggleToFollow}
                title={t("simulator.replay.follow")}
                className={`${STATUS_BAR_TEXT_20} shrink-0 transform-gpu rounded-full px-2 font-medium text-text-2 ${SURFACE_TOKENS.hover} hover:text-primary-6`}
              >
                {t("simulator.replay.follow")}
              </button>
            </>
          ) : null}
        </div>
      </div>
    );
  }
);

SimulatorStatusBar.displayName = "SimulatorStatusBar";

export default SimulatorStatusBar;
