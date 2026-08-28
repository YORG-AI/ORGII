/**
 * FloatingReplayContainer Component
 *
 * Floating status bar pill for replay controls (play/pause, prev/next, speed).
 * The progress slider is now handled by MusicPlayerReplayBar on the dock border.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  currentEventAtom,
  currentSimulatorEventIndexAtom,
  navigateNextSimulatorEventAtom,
  simulatorEventCountAtom,
} from "@src/engines/SessionCore";
import { getToolDisplayBehavior } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { useHousekeeperConfig } from "@src/hooks/housekeeper";
import { BotIcon, HugeiconsIcon, KeyboardIcon } from "@src/icons";
import { chatVisibleAtom } from "@src/store/ui/chatPanelAtom";
import {
  type SimulatorPlaybackSpeed,
  simulatorInlineChatInputCollapsedAtom,
  simulatorMiniCPMStepExplanationVisibleAtom,
  simulatorPlaybackSpeedAtom,
  simulatorSessionPlaybackPlayingAtom,
} from "@src/store/ui/simulatorAtom";
import { deriveToolAction } from "@src/util/ui/rendering/toolAction";

import SimulatorStatusBar from "../SimulatorStatusBar";
import {
  getFinalResultHoldRemainingMs,
  shouldHoldFinalToolResult,
} from "./autoplayBehavior";

const AUTOPLAY_BASE_INTERVAL_MS = 2000;

/**
 * `simulatorSessionPlaybackPlayingAtom` is the single source of truth for
 * autoplay. This component both reads from it (to drive the `setInterval`
 * stepping the cursor) and writes to it (via the Play/Pause button). Do NOT
 * add a local `isReplaying` mirror — it desyncs from the atom when external
 * callers write.
 */
const FloatingReplayContainer: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  const [isReplaying, setIsReplaying] = useAtom(
    simulatorSessionPlaybackPlayingAtom
  );
  const navigateNext = useSetAtom(navigateNextSimulatorEventAtom);
  const currentEvent = useAtomValue(currentEventAtom);
  const currentIndex = useAtomValue(currentSimulatorEventIndexAtom);
  const eventCount = useAtomValue(simulatorEventCountAtom);
  const chatVisible = useAtomValue(chatVisibleAtom);
  const housekeeper = useHousekeeperConfig();
  const miniCPMStepExplanationVisible = useAtomValue(
    simulatorMiniCPMStepExplanationVisibleAtom
  );
  const showMiniCPMStepExplanation = useSetAtom(
    simulatorMiniCPMStepExplanationVisibleAtom
  );
  const simulatorInputCollapsed = useAtomValue(
    simulatorInlineChatInputCollapsedAtom
  );
  const setSimulatorInlineChatCollapsed = useSetAtom(
    simulatorInlineChatInputCollapsedAtom
  );

  const [playbackSpeed, setPlaybackSpeedAtom] = useAtom(
    simulatorPlaybackSpeedAtom
  );

  const setPlaybackSpeed = useCallback(
    (speed: number) => {
      setPlaybackSpeedAtom(speed as SimulatorPlaybackSpeed);
    },
    [setPlaybackSpeedAtom]
  );

  // Keep refs in sync so the interval callback always sees the latest values
  const currentEventRef = useRef(currentEvent);
  const currentIndexRef = useRef(currentIndex);
  const eventCountRef = useRef(eventCount);
  const finalSeenAtRef = useRef<{ eventId: string; seenAtMs: number } | null>(
    null
  );
  useEffect(() => {
    currentEventRef.current = currentEvent;
  }, [currentEvent]);
  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    eventCountRef.current = eventCount;
  }, [eventCount]);

  const handlePlayPause = useCallback(() => {
    setIsReplaying((prev) => !prev);
  }, [setIsReplaying]);

  // Drive event stepping while playing; auto-stops when last event is reached
  useEffect(() => {
    if (!isReplaying || eventCount === 0) return;

    // If already at the end when play is pressed, stop immediately via next tick
    if (currentIndexRef.current >= eventCountRef.current - 1) {
      const timerId = setTimeout(() => setIsReplaying(false), 0);
      return () => clearTimeout(timerId);
    }

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const interval = AUTOPLAY_BASE_INTERVAL_MS / playbackSpeed;

    const scheduleNextStep = (delayMs: number) => {
      timerId = setTimeout(() => {
        if (cancelled) return;

        if (currentIndexRef.current >= eventCountRef.current - 1) {
          setIsReplaying(false);
          return;
        }

        const event = currentEventRef.current;
        const action = deriveToolAction(event?.functionName ?? "", event?.args);
        const behavior = getToolDisplayBehavior(
          event?.functionName ?? "",
          action
        );

        if (shouldHoldFinalToolResult(event, behavior)) {
          const nowMs = Date.now();
          const seenAtMs =
            event && finalSeenAtRef.current?.eventId === event.id
              ? finalSeenAtRef.current.seenAtMs
              : undefined;
          const remainingMs = getFinalResultHoldRemainingMs(nowMs, seenAtMs);
          if (event && seenAtMs === undefined) {
            finalSeenAtRef.current = { eventId: event.id, seenAtMs: nowMs };
          }
          if (remainingMs > 0) {
            scheduleNextStep(remainingMs);
            return;
          }
        }

        navigateNext();
        scheduleNextStep(interval);
      }, delayMs);
    };

    scheduleNextStep(interval);

    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [isReplaying, playbackSpeed, eventCount, navigateNext, setIsReplaying]);

  // Ensure autoplay halts when the container unmounts (e.g. session switch).
  useEffect(() => {
    return () => {
      setIsReplaying(false);
    };
  }, [setIsReplaying]);

  return (
    <div className="pointer-events-none absolute bottom-2 left-0 right-0 z-30 flex flex-col items-center gap-2 px-2">
      <div className="pointer-events-auto flex w-max max-w-full items-center gap-1.5">
        <SimulatorStatusBar
          isReplaying={isReplaying}
          onPlayPause={handlePlayPause}
          playbackSpeed={playbackSpeed}
          onPlaybackSpeedChange={setPlaybackSpeed}
        />
        {housekeeper.enabled &&
        housekeeper.features.stepExplain &&
        !miniCPMStepExplanationVisible ? (
          <Button
            variant="secondary"
            size="default"
            shape="circle"
            iconOnly
            icon={
              <HugeiconsIcon
                icon={BotIcon}
                data-icon="bot"
                size={16}
                strokeWidth={1.75}
                className="text-primary-6"
              />
            }
            className="shadow-md"
            onClick={() => showMiniCPMStepExplanation(true)}
            aria-label="显示 MiniCPM 步骤解析"
            title="显示 MiniCPM 步骤解析"
          />
        ) : null}
        {!chatVisible ? (
          <Button
            variant="secondary"
            size="default"
            shape="circle"
            iconOnly
            icon={
              <HugeiconsIcon
                icon={KeyboardIcon}
                data-icon="keyboard"
                size={16}
                strokeWidth={1.75}
                className={
                  simulatorInputCollapsed ? undefined : "text-primary-6"
                }
              />
            }
            className="shadow-md"
            onClick={() =>
              setSimulatorInlineChatCollapsed(!simulatorInputCollapsed)
            }
            aria-label={t("simulator.replay.dockShowChatInput")}
            title={t("simulator.replay.dockShowChatInput")}
          />
        ) : null}
      </div>
    </div>
  );
});

FloatingReplayContainer.displayName = "FloatingReplayContainer";

export default FloatingReplayContainer;
