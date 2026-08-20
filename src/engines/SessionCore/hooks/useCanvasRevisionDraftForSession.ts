import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";

import {
  type CanvasRevisionDraft,
  canvasRevisionDraftsAtom,
} from "@src/store/session/canvasRevisionDraftAtom";

function stringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function draftEqual(
  left: CanvasRevisionDraft | null,
  right: CanvasRevisionDraft | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.toolCallId === right.toolCallId &&
    left.targetEventId === right.targetEventId &&
    left.mode === right.mode &&
    left.title === right.title &&
    stringArraysEqual(left.agentSteps, right.agentSteps) &&
    left.receivedCharacters === right.receivedCharacters &&
    left.phase === right.phase
  );
}

/** Subscribe only to one session's revision progress. */
export function useCanvasRevisionDraftForSession(
  sessionId: string | null | undefined
): CanvasRevisionDraft | null {
  const scopedAtom = useMemo(
    () =>
      selectAtom(
        canvasRevisionDraftsAtom,
        (drafts) => (sessionId ? (drafts.get(sessionId) ?? null) : null),
        draftEqual
      ),
    [sessionId]
  );
  return useAtomValue(scopedAtom);
}

export default useCanvasRevisionDraftForSession;
