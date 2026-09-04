import type { UIEvent } from "react";
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type {
  ShellReplayRef,
  ShellReplayState,
} from "@src/engines/SessionCore/core/types";
import {
  type ReplayWindowDirection,
  SHELL_REPLAY_RANGE_BYTES,
  SHELL_REPLAY_SETTLE_MS,
  SHELL_REPLAY_WINDOW_MAX_FRAME_BYTES,
  type ShellReplayRange,
  filterFramesToBookmark,
  mergeReplayFrameWindow,
  replayWindowBounds,
  shellReplayRangeCache,
  shellReplayRowsToText,
  shellReplayScopeKey,
} from "@src/engines/SessionCore/replay/shellReplayRange";
import {
  ShellReplayRequestGuard,
  readShellReplayRangeIfCurrent,
  scheduleShellReplayPrefetch,
  shouldShowShellReplayLoadingPlaceholder,
} from "@src/engines/SessionCore/replay/shellReplayRequestGuard";
import { TerminalCommand } from "@src/engines/TerminalCore/components/TerminalDisplay";
import { stripAnsiCodes } from "@src/engines/TerminalCore/components/TerminalDisplay/utils/ansiProcessor";
import { useTerminalSurfaceStyle } from "@src/hooks/terminal/useTerminalSurfaceStyle";

import "./index.scss";

interface ShellReplayOutputProps {
  command: string;
  replayRef: ShellReplayRef;
  replayState: ShellReplayState;
  cursorEventId?: string;
  exitCode?: number;
  hideCommandLine?: boolean;
  variant?: "simulator" | "chat";
  showStatus?: boolean;
}

interface FrameWindowState {
  identity: string;
  windowKey: string | null;
  earliestOffset: number;
  latestOffset: number;
  loading: boolean;
  loadingDirection: ReplayWindowDirection | null;
  error: boolean;
}

const EMPTY_FRAME_STATE: FrameWindowState = {
  identity: "",
  windowKey: null,
  earliestOffset: 0,
  latestOffset: 0,
  loading: false,
  loadingDirection: null,
  error: false,
};

function rangeIdentity(
  ref: ShellReplayRef,
  replayState: ShellReplayState,
  cursorEventId: string | undefined
): string {
  return JSON.stringify([
    cursorEventId ?? "live",
    ref.sessionId,
    ref.callId,
    replayState.bookmark.visibleThroughSequence,
    replayState.bookmark.visibleBytes,
  ]);
}

const ShellReplayOutputComponent: React.FC<ShellReplayOutputProps> = ({
  command,
  replayRef,
  replayState,
  cursorEventId,
  exitCode,
  hideCommandLine = false,
  variant = "simulator",
  showStatus = true,
}) => {
  const { t } = useTranslation("sessions");
  const {
    foreground,
    mutedForeground,
    errorForeground,
    typography,
    typographyVariables,
  } = useTerminalSurfaceStyle();
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestGuardRef = useRef(new ShellReplayRequestGuard());
  const loadingRef = useRef(false);
  const followTailRef = useRef(true);
  const prependScrollHeightRef = useRef<number | null>(null);
  const [frameState, setFrameState] =
    useState<FrameWindowState>(EMPTY_FRAME_STATE);
  const frameStateRef = useRef(frameState);
  frameStateRef.current = frameState;
  const cacheVersion = useSyncExternalStore(
    shellReplayRangeCache.subscribe,
    shellReplayRangeCache.getVersion,
    shellReplayRangeCache.getVersion
  );

  const identity = rangeIdentity(replayRef, replayState, cursorEventId);
  const replaySessionId = replayRef.sessionId;
  const replayCallId = replayRef.callId;
  const visibleThroughSequence = replayState.bookmark.visibleThroughSequence;
  const visibleBytes = replayState.bookmark.visibleBytes;
  requestGuardRef.current.setIdentity(identity);
  const stateForCursor = frameState.identity === identity;
  const cachedWindow = stateForCursor
    ? shellReplayRangeCache.peekWindow(frameState.windowKey)
    : undefined;
  const frames = cachedWindow?.frames ?? [];
  const visualRows = cachedWindow?.rows;
  const replayOutput = useMemo(
    () => shellReplayRowsToText(visualRows ?? []),
    [visualRows]
  );
  const loading = stateForCursor && frameState.loading;
  const hasEarlier =
    stateForCursor && frameState.earliestOffset > 0 && frames.length > 0;
  const hasLater =
    stateForCursor &&
    frameState.latestOffset < visibleBytes &&
    frames.length > 0;
  const scopeKey = shellReplayScopeKey(
    replaySessionId,
    replayCallId,
    visibleThroughSequence,
    visibleBytes
  );

  const loadRange = useCallback(
    async (offsetBytes: number, direction: ReplayWindowDirection) => {
      if (loadingRef.current || visibleBytes === 0) return;
      loadingRef.current = true;
      const requestTicket = requestGuardRef.current.beginRequest();
      const requestIdentity = identity;
      const limitBytes = Math.min(
        SHELL_REPLAY_RANGE_BYTES,
        visibleBytes - offsetBytes
      );
      if (limitBytes <= 0) {
        loadingRef.current = false;
        return;
      }

      if (direction === "prepend" && scrollRef.current) {
        prependScrollHeightRef.current = scrollRef.current.scrollHeight;
      }
      setFrameState((previous) => ({
        ...(previous.identity === requestIdentity
          ? previous
          : { ...EMPTY_FRAME_STATE, identity: requestIdentity }),
        loading: true,
        loadingDirection: direction,
        error: false,
      }));

      try {
        const requestedEnd = Math.min(visibleBytes, offsetBytes + limitBytes);
        const cached = shellReplayRangeCache.findCoveringWindow(
          scopeKey,
          offsetBytes,
          requestedEnd
        );
        if (
          cached &&
          frameStateRef.current.identity === requestIdentity &&
          !frameStateRef.current.windowKey
        ) {
          setFrameState({
            identity: requestIdentity,
            windowKey: cached.key,
            earliestOffset: cached.value.earliestOffset,
            latestOffset: cached.value.latestOffset,
            loading: false,
            loadingDirection: null,
            error: false,
          });
          return;
        }

        const response = await readShellReplayRangeIfCurrent(
          requestGuardRef.current,
          requestTicket,
          async () =>
            (cached
              ? {
                  frames: cached.value.frames,
                  nextOffsetBytes: cached.value.latestOffset,
                  eof: cached.value.latestOffset >= visibleBytes,
                }
              : undefined) ??
            (await rpc.sessionCore.shellReplay.readRange({
              sessionId: replaySessionId,
              callId: replayCallId,
              visibleThroughSequence,
              visibleBytes,
              offsetBytes,
              limitBytes,
            }))
        );
        if (!response) return;

        const safeResponse: ShellReplayRange = {
          ...response,
          frames: filterFramesToBookmark(response.frames, {
            visibleThroughSequence,
            visibleBytes,
          }),
        };
        const currentState = frameStateRef.current;
        const currentWindow =
          currentState.identity === requestIdentity
            ? shellReplayRangeCache.readWindow(currentState.windowKey)
            : undefined;
        const nextFrames = mergeReplayFrameWindow(
          currentWindow?.frames ?? [],
          safeResponse.frames,
          { visibleThroughSequence, visibleBytes },
          direction,
          SHELL_REPLAY_WINDOW_MAX_FRAME_BYTES
        );
        const bounds = replayWindowBounds(
          nextFrames,
          safeResponse,
          offsetBytes
        );
        const windowKey = shellReplayRangeCache.setWindow(scopeKey, {
          frames: nextFrames,
          earliestOffset: bounds.earliest,
          latestOffset: bounds.latest,
        });
        setFrameState({
          identity: requestIdentity,
          windowKey,
          earliestOffset: bounds.earliest,
          latestOffset: bounds.latest,
          loading: false,
          loadingDirection: null,
          error: windowKey === null,
        });
      } catch {
        if (requestGuardRef.current.isCurrent(requestTicket)) {
          setFrameState((previous) => ({
            ...(previous.identity === requestIdentity
              ? previous
              : { ...EMPTY_FRAME_STATE, identity: requestIdentity }),
            loading: false,
            loadingDirection: null,
            // Initial prefetch failures are user-visible durability failures,
            // not an expected empty-cache state. Keep the bounded Snapshot
            // preview rendered, but make it clear that older/full output is
            // unavailable instead of silently pretending replay succeeded.
            error: true,
          }));
        }
      } finally {
        if (requestGuardRef.current.isCurrent(requestTicket)) {
          loadingRef.current = false;
        }
      }
    },
    [
      identity,
      replayCallId,
      replaySessionId,
      scopeKey,
      visibleBytes,
      visibleThroughSequence,
    ]
  );

  useEffect(() => {
    loadingRef.current = false;
    followTailRef.current = true;
    prependScrollHeightRef.current = null;
    setFrameState({ ...EMPTY_FRAME_STATE, identity });

    if (visibleBytes === 0) return;
    return scheduleShellReplayPrefetch(() => {
      const offsetBytes = Math.max(0, visibleBytes - SHELL_REPLAY_RANGE_BYTES);
      void loadRange(offsetBytes, "initial");
    }, SHELL_REPLAY_SETTLE_MS);
  }, [identity, loadRange, visibleBytes]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !stateForCursor) return;
    if (prependScrollHeightRef.current !== null) {
      const previousHeight = prependScrollHeightRef.current;
      prependScrollHeightRef.current = null;
      element.scrollTop += Math.max(0, element.scrollHeight - previousHeight);
      return;
    }
    if (followTailRef.current) element.scrollTop = element.scrollHeight;
  }, [cacheVersion, frameState.windowKey, identity, stateForCursor]);

  const handleReplayInteraction = useCallback(() => {
    if (loadingRef.current || cachedWindow || visibleBytes === 0) {
      return;
    }
    const offsetBytes = Math.max(0, visibleBytes - SHELL_REPLAY_RANGE_BYTES);
    void loadRange(offsetBytes, "initial");
  }, [cachedWindow, loadRange, visibleBytes]);

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      followTailRef.current = distanceFromBottom < 48;

      if (element.scrollTop < 160 && hasEarlier && !loadingRef.current) {
        const nextOffset = Math.max(
          0,
          frameState.earliestOffset - SHELL_REPLAY_RANGE_BYTES
        );
        void loadRange(nextOffset, "prepend");
      } else if (distanceFromBottom < 160 && hasLater && !loadingRef.current) {
        void loadRange(frameState.latestOffset, "append");
      }
    },
    [
      frameState.earliestOffset,
      frameState.latestOffset,
      hasEarlier,
      hasLater,
      loadRange,
    ]
  );

  const preview = stripAnsiCodes(replayState.terminalPreview);
  const displayOutput = visualRows ? replayOutput : preview;
  const displayCommand =
    command.trim() || t("simulator.replay.ide.shell.noCommand");
  const terminalError =
    replayState.error ||
    replayState.status === "incomplete" ||
    (stateForCursor && frameState.error);
  const surfaceClassName =
    variant === "chat"
      ? "simulator-shell-surface min-h-0 min-w-0 overflow-y-auto overflow-x-auto px-2 py-1"
      : "simulator-shell-surface min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-[100px] pt-2";

  return (
    <div
      ref={scrollRef}
      className={surfaceClassName}
      style={{
        ...typographyVariables,
        ...(variant === "chat" ? { maxHeight: "min(320px, 30vh)" } : {}),
      }}
      onScroll={handleScroll}
      onWheel={handleReplayInteraction}
      onPointerDown={handleReplayInteraction}
      onFocus={handleReplayInteraction}
      role="log"
      tabIndex={0}
      aria-label={displayCommand}
    >
      {!hideCommandLine ? (
        <div className="mb-1 max-w-full min-w-0">
          <TerminalCommand
            command={displayCommand}
            prefix="$"
            highlighted={false}
            style={{ color: foreground, padding: 0, margin: 0 }}
          />
        </div>
      ) : null}

      {hasEarlier ||
      (loading &&
        shouldShowShellReplayLoadingPlaceholder(frameState.loadingDirection) &&
        frameState.loadingDirection === "prepend") ? (
        <div
          className="simulator-shell-range-placeholder py-2"
          style={{ color: mutedForeground, ...typography }}
          aria-live="polite"
        >
          {t("simulator.replay.ide.shell.outputInProgress")}
        </div>
      ) : null}

      {displayOutput ? (
        <pre
          className="simulator-shell-plain-pre m-0 max-w-full min-w-0 wrap-anywhere wrap-break-word whitespace-pre-wrap"
          style={{ color: foreground }}
        >
          {displayOutput}
        </pre>
      ) : null}

      {loading &&
      shouldShowShellReplayLoadingPlaceholder(frameState.loadingDirection) &&
      frameState.loadingDirection === "append" ? (
        <div
          className="simulator-shell-range-placeholder py-2"
          style={{ color: mutedForeground, ...typography }}
          aria-live="polite"
        >
          {t("simulator.replay.ide.shell.outputInProgress")}
        </div>
      ) : null}

      {terminalError ? (
        <div className="mt-2" style={{ color: errorForeground, ...typography }}>
          {typeof terminalError === "string"
            ? terminalError
            : "Replay unavailable"}
        </div>
      ) : null}

      {showStatus && replayState.status === "running" ? (
        <div
          className="simulator-shell-loading mt-1 inline-flex items-center gap-1.5"
          style={typography}
        >
          <span className="animate-shimmer-text bg-linear-to-r from-primary-6/60 via-primary-6 to-primary-6/60 bg-size-[260%_100%] bg-clip-text font-bold text-transparent">
            {t("simulator.replay.ide.shell.outputInProgress")}
          </span>
          <span className="simulator-shell-loading__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : showStatus && exitCode !== undefined ? (
        <div
          className="mt-2"
          style={{
            ...typography,
            color: exitCode === 0 ? mutedForeground : errorForeground,
          }}
        >
          {t("simulator.replay.ide.shell.exitCode", { code: exitCode })}
        </div>
      ) : null}
    </div>
  );
};

export const ShellReplayOutput = memo(ShellReplayOutputComponent);
ShellReplayOutput.displayName = "ShellReplayOutput";
