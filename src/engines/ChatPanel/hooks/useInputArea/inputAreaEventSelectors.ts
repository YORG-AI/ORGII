import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";

import { countChatRounds } from "@src/engines/ChatPanel/InputArea/components/compactFileChangesHelpers";
import { sortedEventsAtom } from "@src/engines/SessionCore/core/atoms/events";
import { sessionHasComposerStopBlockingWork } from "@src/engines/SessionCore/core/runningEventGate";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isPlanDisplayEvent } from "@src/engines/SessionCore/derived/planDisplayEvents";
import { getPlanDocViewModel } from "@src/modules/WorkStation/Chat/Communication/MessageViewer/planDocViewModel";

export interface PlanMentionSourceItem {
  planPath: string;
  title: string;
}

function chatRoundCountEqual(left: number, right: number): boolean {
  return left === right;
}

function booleanEqual(left: boolean, right: boolean): boolean {
  return left === right;
}

function planMentionSourceEqual(
  left: readonly PlanMentionSourceItem[],
  right: readonly PlanMentionSourceItem[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].planPath !== right[index].planPath ||
      left[index].title !== right[index].title
    ) {
      return false;
    }
  }
  return true;
}

function getPlanMentionPath(event: SessionEvent): string | null {
  const planPath = getPlanDocViewModel(event).planPath;
  return planPath && planPath.trim() ? planPath : null;
}

export function extractPlanMentionSource(
  events: ReadonlyArray<SessionEvent>
): PlanMentionSourceItem[] {
  const result: PlanMentionSourceItem[] = [];
  const seenPaths = new Set<string>();

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isPlanDisplayEvent(event)) continue;
    const planPath = getPlanMentionPath(event);
    if (!planPath || seenPaths.has(planPath)) continue;

    seenPaths.add(planPath);
    result.push({
      planPath,
      title: getPlanDocViewModel(event).title,
    });

    if (result.length >= 4) break;
  }

  return result;
}

export function useInputAreaChatRoundCount(): number {
  const chatRoundCountAtom = useMemo(
    () =>
      selectAtom(
        sortedEventsAtom,
        (events) => countChatRounds(events),
        chatRoundCountEqual
      ),
    []
  );
  return useAtomValue(chatRoundCountAtom);
}

export function useInputAreaComposerStopBlockingWork(
  activeSessionId: string | undefined,
  runtimeStatus: string | undefined
): boolean {
  const composerStopBlockingAtom = useMemo(
    () =>
      selectAtom(
        sortedEventsAtom,
        (events) =>
          activeSessionId
            ? sessionHasComposerStopBlockingWork(
                events,
                activeSessionId,
                runtimeStatus
              )
            : false,
        booleanEqual
      ),
    [activeSessionId, runtimeStatus]
  );
  return useAtomValue(composerStopBlockingAtom);
}

export function useInputAreaPlanMentionSource(): readonly PlanMentionSourceItem[] {
  const planMentionSourceAtom = useMemo(
    () =>
      selectAtom(
        sortedEventsAtom,
        extractPlanMentionSource,
        planMentionSourceEqual
      ),
    []
  );
  return useAtomValue(planMentionSourceAtom);
}
