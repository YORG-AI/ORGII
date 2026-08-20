import type { CanvasInlinePayload } from "./types";

export const CANVAS_CREATE_TOOL_NAME = "render_inline_canvas";
export const CANVAS_REVISION_TOOL_NAME = "revise_inline_canvas";
export const CANVAS_REVISION_TARGET_EVENT_ID_ARG = "target_event_id";
export const LEGACY_CANVAS_REVISION_EVENT_ID_ARG = "revises_event_id";
export const CANVAS_REVISION_EDITS_ARG = "edits";
export const CANVAS_REVISION_AGENT_STEPS_ARG = "agent_steps";

export interface CanvasRevisionTextEdit {
  /** Exact literal text to find in the current materialized Canvas source. */
  find: string;
  /** Literal replacement text. */
  replace: string;
  /** Replace every occurrence instead of requiring exactly one match. */
  all?: boolean;
}

const MAX_CANVAS_REVISION_EDITS = 16;
const MAX_CANVAS_REVISION_EDIT_CHARS = 32_768;
export const MAX_CANVAS_REVISION_AGENT_STEPS = 6;
export const MAX_CANVAS_REVISION_AGENT_STEP_CHARS = 80;

export function isCanvasToolName(value: string | undefined): boolean {
  return (
    value === CANVAS_CREATE_TOOL_NAME || value === CANVAS_REVISION_TOOL_NAME
  );
}

export function isCanvasRevisionToolName(value: string | undefined): boolean {
  return value === CANVAS_REVISION_TOOL_NAME;
}

export function getCanvasRevisionTargetId(
  args: Record<string, unknown> | undefined
): string | null {
  for (const key of [
    CANVAS_REVISION_TARGET_EVENT_ID_ARG,
    LEGACY_CANVAS_REVISION_EVENT_ID_ARG,
  ]) {
    const value = args?.[key];
    if (typeof value !== "string") continue;
    const targetId = value.trim();
    if (targetId.length > 0) return targetId;
  }
  return null;
}

export function isCanvasRevisionPayload(payload: CanvasInlinePayload): boolean {
  return Boolean(payload.revisesEventId?.trim());
}

export function getCanvasRevisionTextEdits(
  args: Record<string, unknown> | undefined
): CanvasRevisionTextEdit[] | null {
  const raw = args?.[CANVAS_REVISION_EDITS_ARG];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length > MAX_CANVAS_REVISION_EDITS) return null;

  const edits: CanvasRevisionTextEdit[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") return null;
    const edit = candidate as Record<string, unknown>;
    if (
      typeof edit.find !== "string" ||
      edit.find.length === 0 ||
      edit.find.length > MAX_CANVAS_REVISION_EDIT_CHARS ||
      typeof edit.replace !== "string" ||
      edit.replace.length > MAX_CANVAS_REVISION_EDIT_CHARS ||
      edit.find === edit.replace ||
      (edit.all !== undefined && typeof edit.all !== "boolean")
    ) {
      return null;
    }
    edits.push({
      find: edit.find,
      replace: edit.replace,
      ...(edit.all === true ? { all: true } : {}),
    });
  }
  return edits;
}

export function getCanvasRevisionAgentSteps(
  args: Record<string, unknown> | undefined
): string[] | null {
  const raw = args?.[CANVAS_REVISION_AGENT_STEPS_ARG];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_CANVAS_REVISION_AGENT_STEPS
  ) {
    return null;
  }

  const steps: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "string") return null;
    const label = candidate.trim();
    if (
      label.length === 0 ||
      Array.from(label).length > MAX_CANVAS_REVISION_AGENT_STEP_CHARS
    ) {
      return null;
    }
    steps.push(label);
  }
  return steps;
}

function countLiteralOccurrences(source: string, find: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - find.length) {
    const index = source.indexOf(find, offset);
    if (index < 0) break;
    count += 1;
    offset = index + find.length;
  }
  return count;
}

/**
 * Materialize a compact revision against the previous immutable Canvas args.
 *
 * The backend runs the same exact-match policy before accepting the tool call.
 * Returning `null` keeps the last valid Canvas visible when a malformed or
 * stale patch somehow reaches replay (for example from an older client).
 */
export function materializeCanvasRevisionArgs(
  targetArgs: Record<string, unknown> | undefined,
  revisionArgs: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!targetArgs || !revisionArgs) return null;
  if (!(CANVAS_REVISION_EDITS_ARG in revisionArgs)) return revisionArgs;

  const edits = getCanvasRevisionTextEdits(revisionArgs);
  const source = targetArgs.content;
  if (!edits || typeof source !== "string") return null;

  const targetMode = targetArgs.mode;
  const requestedMode = revisionArgs.mode;
  if (
    typeof targetMode !== "string" ||
    (typeof requestedMode === "string" && requestedMode !== targetMode)
  ) {
    return null;
  }

  let content = source;
  for (const edit of edits) {
    const matches = countLiteralOccurrences(content, edit.find);
    if (matches === 0 || (!edit.all && matches !== 1)) return null;
    content = edit.all
      ? content.split(edit.find).join(edit.replace)
      : content.replace(edit.find, edit.replace);
  }

  return {
    ...targetArgs,
    ...revisionArgs,
    mode: targetMode,
    content,
    title:
      typeof revisionArgs.title === "string"
        ? revisionArgs.title
        : targetArgs.title,
  };
}

export function isSameLogicalCanvas(
  previous: CanvasInlinePayload,
  next: CanvasInlinePayload
): boolean {
  const previousEventId = previous.eventId;
  if (!previousEventId) return false;
  return (
    previousEventId === next.eventId ||
    previousEventId === next.revisesEventId?.trim()
  );
}
