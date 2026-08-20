import type { CanvasRevisionDraft } from "@src/store/session/canvasRevisionDraftAtom";

export function formatCanvasRevisionCharacterCount(count: number): string {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount < 1_000) return String(safeCount);
  if (safeCount < 10_000) {
    return `${(safeCount / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `${Math.round(safeCount / 1_000)}K`;
}

export function isCanvasRevisionDraftRelevant(
  draft: CanvasRevisionDraft | null,
  sessionId: string | null | undefined,
  selectedEventId?: string | null
): draft is CanvasRevisionDraft {
  if (!draft || !sessionId || draft.sessionId !== sessionId) return false;
  return (
    !draft.targetEventId ||
    !selectedEventId ||
    draft.targetEventId === selectedEventId ||
    `tool-call-${draft.toolCallId}` === selectedEventId
  );
}
