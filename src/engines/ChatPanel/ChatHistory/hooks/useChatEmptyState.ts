import { useAtomValue } from "jotai";
import {
  type MutableRefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { sessionHydrationByIdAtom } from "@src/engines/SessionCore";
import {
  isPendingCancelAtom,
  isSessionActiveAtom,
  sessionRolledBackAtom,
} from "@src/store/session/cliSessionStatusAtom";

export interface UseChatEmptyStateOptions {
  activeSessionId: string | null;
  sessionLoadStatus: string;
  optimizedLen: number;
  /** Grace period in ms before confirming the "load failed" empty state. */
  gracePeriodMs?: number;
}

export interface UseChatEmptyStateReturn {
  shouldShowEmpty: boolean;
  emptyConfirmed: boolean;
  isRolledBack: boolean;
  isPendingCancel: boolean;
  isPendingCancelRef: MutableRefObject<boolean>;
}

/**
 * Manages the empty-state grace period and related flags for ChatHistory.
 *
 * A newly-created session may briefly report loadStatus="loaded" with zero
 * events before the market sync fetches data. This hook delays the "load
 * failed" placeholder by `gracePeriodMs` so real data has time to arrive.
 */
export function useChatEmptyState({
  activeSessionId,
  sessionLoadStatus,
  optimizedLen,
  gracePeriodMs = 5_000,
}: UseChatEmptyStateOptions): UseChatEmptyStateReturn {
  const isAgentWorking = useAtomValue(isSessionActiveAtom);
  const isPendingCancel = useAtomValue(isPendingCancelAtom);
  const isRolledBack = useAtomValue(sessionRolledBackAtom);
  const sessionHydration = useAtomValue(
    sessionHydrationByIdAtom(activeSessionId ?? "")
  );
  const isHydrating = (sessionHydration?.count ?? 0) > 0;

  const isPendingCancelRef = useRef(false);
  useLayoutEffect(() => {
    isPendingCancelRef.current = isPendingCancel;
  }, [isPendingCancel]);

  // While a user-initiated cancel is pending treat the session as "not
  // working" for empty-state purposes: the eventStore has already been
  // truncated but Rust hasn't sent a terminal status event yet.
  const shouldShowEmpty =
    (sessionLoadStatus === "loaded" || isHydrating) &&
    optimizedLen === 0 &&
    (!isAgentWorking || isPendingCancel);

  const [emptyConfirmed, setEmptyConfirmed] = useState(false);

  useEffect(() => {
    if (!shouldShowEmpty || isHydrating) return;
    const timer = setTimeout(() => setEmptyConfirmed(true), gracePeriodMs);
    return () => {
      clearTimeout(timer);
      setEmptyConfirmed(false);
    };
  }, [shouldShowEmpty, isHydrating, isPendingCancel, gracePeriodMs]);

  return {
    shouldShowEmpty,
    emptyConfirmed,
    isRolledBack,
    isPendingCancel,
    isPendingCancelRef,
  };
}
