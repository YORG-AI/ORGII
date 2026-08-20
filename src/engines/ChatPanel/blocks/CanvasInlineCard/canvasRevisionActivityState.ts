import {
  getCanvasRevisionAgentSteps,
  getCanvasRevisionTextEdits,
} from "./canvasRevision";

export type CanvasRevisionActivityPhase =
  | "receiving"
  | "applying"
  | "completed"
  | "failed"
  | "cancelled";

export type CanvasRevisionStepState =
  | "complete"
  | "active"
  | "pending"
  | "failed";

export type CanvasRevisionChangeKind =
  | "targeted"
  | "replacement"
  | "url"
  | "unknown";

export interface CanvasRevisionActivitySummary {
  title?: string;
  changeKind: CanvasRevisionChangeKind;
  editCount: number;
  payloadCharacters: number;
  agentSteps: string[];
}

export function getCanvasRevisionStepStates(
  phase: CanvasRevisionActivityPhase,
  stepCount: number
): CanvasRevisionStepState[] {
  if (stepCount <= 0) return [];

  switch (phase) {
    case "receiving":
    case "applying":
      return Array.from({ length: stepCount }, (_, index) =>
        index === 0 ? "active" : "pending"
      );
    case "completed":
      return Array.from({ length: stepCount }, () => "complete");
    case "failed":
    case "cancelled":
      return Array.from({ length: stepCount }, (_, index) =>
        index === 0 ? "failed" : "pending"
      );
  }
}

export function summarizeCanvasRevisionActivity(
  args: Record<string, unknown>
): CanvasRevisionActivitySummary {
  const edits = getCanvasRevisionTextEdits(args);
  const content = typeof args.content === "string" ? args.content : undefined;
  const url = typeof args.url === "string" ? args.url : undefined;

  return {
    title:
      typeof args.title === "string"
        ? args.title.trim() || undefined
        : undefined,
    changeKind: edits
      ? "targeted"
      : content !== undefined
        ? "replacement"
        : url
          ? "url"
          : "unknown",
    editCount: edits?.length ?? 0,
    payloadCharacters: content?.length ?? 0,
    agentSteps: getCanvasRevisionAgentSteps(args) ?? [],
  };
}
