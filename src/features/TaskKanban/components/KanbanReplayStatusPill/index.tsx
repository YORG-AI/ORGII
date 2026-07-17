/**
 * KanbanReplayStatusPill
 *
 * Visual twin of `SimulatorStatusBar`'s pill — same h-8 rounded-full
 * chrome, same 20×20 icon buttons, same `pl-1.5` follow-mode label,
 * same speed dropdown styling. Only the data source differs (kanban
 * replay atoms instead of simulator session atoms) and the timestamp
 * format: kanban events span multiple days so we keep the
 * `today / yesterday + HH:mm:ss` label here; the simulator pill
 * collapses to a fixed-width `HH:mm:ss` because a session is always
 * single-day.
 *
 * Items omitted vs the simulator pill (no kanban analogue):
 *   - inline-chat-input toggle
 *   - FollowModeDropdown (per-app follow lock)
 *
 * If/when a third caller needs this pill, lift the slots into a shared
 * `ReplayPillChrome` component (the structural overlap with
 * `SimulatorStatusBar` is now ~90%).
 *
 * Autoplay timer matches `FloatingReplayContainer`'s implementation: a
 * `setInterval` whose period is `AUTOPLAY_BASE_INTERVAL_MS / speed`
 * stepping the cursor through `kanbanReplayEventsAtom` until the last
 * event is reached.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronLeft,
  ChevronRight,
  MousePointer2,
  Pause,
  Play,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import Tooltip from "@src/components/Tooltip";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { REPLAY_SPEED_OPTIONS } from "@src/config/workspace/replayConfig";
import { useDropdownEngine } from "@src/hooks/dropdown/useDropdownEngine";
import {
  currentKanbanReplayEventIndexAtom,
  kanbanReplayBoundsAtom,
  kanbanReplayCursorAtom,
  kanbanReplayEventCountAtom,
  kanbanReplayModeAtom,
  kanbanReplayPlayingAtom,
  kanbanReplaySpeedAtom,
  navigateNextKanbanEventAtom,
  navigatePrevKanbanEventAtom,
  setKanbanCursorTimestampAtom,
} from "@src/store/ui/kanbanReplayAtom";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

// ── Tailwind constants — kept byte-identical with `SimulatorStatusBar`
// so a design tweak on either side transfers via grep-and-replace. ──

const STATUS_BAR_TEXT_20 =
  "inline-flex h-5 shrink-0 items-center text-xs leading-none";

const STATUS_BAR_ICON_BTN_20 = `flex h-5 w-5 transform-gpu items-center justify-center rounded-full text-text-2 ${SURFACE_TOKENS.hover} hover:text-primary-6 disabled:cursor-not-allowed disabled:opacity-40`;

const STATUS_BAR_ICON_BTN_20_CIRCLE_NEUTRAL =
  "flex h-5 w-5 transform-gpu items-center justify-center rounded-full bg-fill-3 text-text-1 hover:bg-fill-4 hover:text-primary-6 disabled:cursor-not-allowed disabled:opacity-40";

const STATUS_BAR_ICON_BTN_20_CIRCLE_PRIMARY =
  "flex h-5 w-5 transform-gpu items-center justify-center rounded-full bg-primary-6 text-white hover:bg-primary-5 disabled:cursor-not-allowed disabled:opacity-40";

const AUTOPLAY_BASE_INTERVAL_MS = 2000;

// ── Speed dropdown — direct copy of simulator's `PlaybackSpeedInline` ──

interface PlaybackSpeedInlineProps {
  value: number;
  onChange: (speed: number) => void;
  disabled: boolean;
}

const PlaybackSpeedInline: React.FC<PlaybackSpeedInlineProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const {
    isOpen,
    isPositioned,
    triggerRef,
    panelRef,
    panelPosition,
    toggle,
    close,
  } = useDropdownEngine<HTMLButtonElement>({
    placement: "top",
    align: "right",
    disabled,
    gap: DROPDOWN_PANEL.triggerGapTight,
  });

  const panelPositionStyle = useMemo(() => {
    const pos = panelPosition;
    return {
      ...(pos.top !== undefined
        ? { top: `${pos.top}px` }
        : { bottom: `${pos.bottom}px` }),
      ...(pos.right !== undefined
        ? { right: `${pos.right}px` }
        : { left: `${pos.left}px` }),
      ...(pos.width > 0 ? { minWidth: `${pos.width}px` } : {}),
    };
  }, [panelPosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className={`${STATUS_BAR_TEXT_20} ml-1 shrink-0 transform-gpu justify-center rounded-full px-2 tabular-nums disabled:cursor-not-allowed disabled:opacity-40 ${
          isOpen
            ? "bg-fill-3 text-primary-6"
            : `text-text-2 ${SURFACE_TOKENS.hover} hover:text-primary-6`
        }`}
      >
        {`${value}x`}
      </button>
      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.menuPanelBase} fixed min-w-[80px]`}
            style={panelPositionStyle}
          >
            <div
              className={`flex flex-col ${DROPDOWN_PANEL.itemsGapClass}`}
              role="listbox"
            >
              {REPLAY_SPEED_OPTIONS.map((speed) => {
                const selected = speed === value;
                return (
                  <button
                    key={speed}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`${DROPDOWN_CLASSES.item} ${
                      selected
                        ? DROPDOWN_CLASSES.itemSelected
                        : DROPDOWN_CLASSES.itemHover
                    } w-full justify-between tabular-nums`}
                    onClick={() => {
                      onChange(speed);
                      close();
                    }}
                  >
                    <span>{`${speed}x`}</span>
                    {selected && <DropdownSelectedCheck />}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

// ── Pill ──

const KanbanReplayStatusPill: React.FC = memo(() => {
  const { t, i18n } = useTranslation("sessions");
  const [replayMode, setReplayMode] = useAtom(kanbanReplayModeAtom);
  const cursor = useAtomValue(kanbanReplayCursorAtom);
  const bounds = useAtomValue(kanbanReplayBoundsAtom);
  const eventCount = useAtomValue(kanbanReplayEventCountAtom);
  const currentIndex = useAtomValue(currentKanbanReplayEventIndexAtom);
  const setCursor = useSetAtom(kanbanReplayCursorAtom);
  const setCursorTimestamp = useSetAtom(setKanbanCursorTimestampAtom);
  const navigatePrev = useSetAtom(navigatePrevKanbanEventAtom);
  const navigateNext = useSetAtom(navigateNextKanbanEventAtom);
  const [isPlaying, setIsPlaying] = useAtom(kanbanReplayPlayingAtom);
  const [playbackSpeed, setPlaybackSpeed] = useAtom(kanbanReplaySpeedAtom);

  const span = bounds.end - bounds.start;
  const disabled = span <= 0;

  // Replay mode: prefer the cursor, fall back to the *current event's*
  // timestamp when the cursor is `null` (mode transitioned but cursor
  // hasn't been written yet). Follow mode no longer renders a timestamp.
  const currentTimestamp = useMemo(() => {
    if (replayMode !== "replay") return "";
    const ts = cursor ?? bounds.end;
    if (!ts || ts <= 0) return "";
    return formatReplayDateLabel(ts, {
      todayLabel: t("common:relativeDate.today"),
      yesterdayLabel: t("common:relativeDate.yesterday"),
      locale: toIntlLocaleTag(i18n.resolvedLanguage),
    });
  }, [replayMode, cursor, bounds.end, t, i18n.resolvedLanguage]);

  // Park a hair before `end` so the bar's "dropped at right edge =
  // follow" snap doesn't fire on the next drag.
  const handleEnterReplay = useCallback(() => {
    if (disabled) return;
    const parkTs = Math.max(bounds.start, bounds.end - 1000);
    setCursorTimestamp(parkTs);
  }, [disabled, bounds.start, bounds.end, setCursorTimestamp]);

  const handleReturnToFollow = useCallback(() => {
    setIsPlaying(false);
    setCursor(null);
    setReplayMode("follow");
  }, [setIsPlaying, setCursor, setReplayMode]);

  const handlePlayPause = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, [setIsPlaying]);

  // Autoplay loop — same shape as `FloatingReplayContainer`.
  const currentIndexRef = useRef(currentIndex);
  const eventCountRef = useRef(eventCount);
  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    eventCountRef.current = eventCount;
  }, [eventCount]);

  useEffect(() => {
    if (!isPlaying || eventCount === 0) return;
    if (currentIndexRef.current >= eventCountRef.current - 1) {
      const timerId = setTimeout(() => setIsPlaying(false), 0);
      return () => clearTimeout(timerId);
    }
    const interval = AUTOPLAY_BASE_INTERVAL_MS / playbackSpeed;
    const timerId = setInterval(() => {
      if (currentIndexRef.current >= eventCountRef.current - 1) {
        setIsPlaying(false);
        return;
      }
      navigateNext();
    }, interval);
    return () => clearInterval(timerId);
  }, [isPlaying, playbackSpeed, eventCount, navigateNext, setIsPlaying]);

  useEffect(() => {
    return () => {
      setIsPlaying(false);
    };
  }, [setIsPlaying]);

  useEffect(() => {
    if (replayMode === "follow" && isPlaying) setIsPlaying(false);
  }, [replayMode, isPlaying, setIsPlaying]);

  const pillBgClass =
    replayMode === "follow" ? "bg-primary-5" : SURFACE_TOKENS.surface;

  return (
    <div
      className={`relative inline-flex h-8 transform-gpu items-center overflow-hidden rounded-full shadow-md ring-1 ring-border-2 [isolation:isolate] ${pillBgClass}`}
    >
      <div className="inline-flex h-8 items-center gap-1.5 px-1.5">
        {replayMode === "follow" ? (
          <>
            <span className="inline-flex h-5 shrink-0 items-center pl-1.5 text-[11px] font-medium leading-none text-white">
              {t("kanban.followLabel")}
            </span>
            <div className="ml-1 h-4 w-px shrink-0 bg-white/25" />
            <Tooltip
              content={t("simulator.replay.freeBrowse")}
              position="top"
              mouseEnterDelay={200}
            >
              <button
                type="button"
                onClick={handleEnterReplay}
                disabled={disabled}
                aria-label={t("simulator.replay.freeBrowse")}
                className="flex h-5 w-5 transform-gpu items-center justify-center rounded-full text-white hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {React.createElement(MousePointer2, {
                  size: 12,
                  strokeWidth: 1.75,
                })}
              </button>
            </Tooltip>
          </>
        ) : (
          <>
            {currentTimestamp && (
              <span
                className={`${STATUS_BAR_TEXT_20} shrink-0 pl-2.5 tabular-nums leading-none text-text-2`}
              >
                {currentTimestamp}
              </span>
            )}
            <button
              type="button"
              onClick={() => navigatePrev()}
              disabled={eventCount === 0}
              className={`ml-0.5 ${STATUS_BAR_ICON_BTN_20}`}
              title={t("simulator.replay.previousEvent")}
              aria-label={t("simulator.replay.previousEvent")}
            >
              {React.createElement(ChevronLeft, {
                size: 14,
                strokeWidth: 1.5,
              })}
            </button>
            <button
              type="button"
              onClick={handlePlayPause}
              disabled={eventCount === 0}
              className={
                isPlaying
                  ? STATUS_BAR_ICON_BTN_20_CIRCLE_NEUTRAL
                  : STATUS_BAR_ICON_BTN_20_CIRCLE_PRIMARY
              }
              title={
                isPlaying
                  ? t("simulator.replay.pause")
                  : t("simulator.replay.play")
              }
              aria-label={
                isPlaying
                  ? t("simulator.replay.pause")
                  : t("simulator.replay.play")
              }
            >
              {React.createElement(isPlaying ? Pause : Play, {
                size: 12,
                fill: "currentColor",
                strokeWidth: 0,
              })}
            </button>
            <button
              type="button"
              onClick={() => navigateNext()}
              disabled={eventCount === 0}
              className={STATUS_BAR_ICON_BTN_20}
              title={t("simulator.replay.nextEvent")}
              aria-label={t("simulator.replay.nextEvent")}
            >
              {React.createElement(ChevronRight, {
                size: 14,
                strokeWidth: 1.5,
              })}
            </button>
            <PlaybackSpeedInline
              value={playbackSpeed}
              onChange={setPlaybackSpeed}
              disabled={eventCount === 0}
            />
            <div className="ml-1 h-4 w-px shrink-0 bg-border-2" />
            <button
              type="button"
              onClick={handleReturnToFollow}
              title={t("simulator.replay.follow")}
              aria-label={t("simulator.replay.follow")}
              className={`${STATUS_BAR_TEXT_20} shrink-0 transform-gpu rounded-full px-2 font-medium text-text-2 ${SURFACE_TOKENS.hover} hover:text-primary-6`}
            >
              {t("simulator.replay.follow")}
            </button>
          </>
        )}
      </div>
    </div>
  );
});

KanbanReplayStatusPill.displayName = "KanbanReplayStatusPill";

export default KanbanReplayStatusPill;
