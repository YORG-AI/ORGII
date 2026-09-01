import type { EventDisplayStatus } from "@src/engines/SessionCore/core/types";

export type PreviewMode = "ui" | "tool" | "input" | "session-link";

export type PlaygroundVariant = "chat" | "simulator";

export type PlaygroundListSelectionMode = "single" | "multiple";

/** Shared English labels for default Completed / Running / Failed sidebar radios. */
interface PlaygroundStatusPresetRow {
  key: string;
  label: string;
  status: EventDisplayStatus;
}

export interface StatusPreset extends PlaygroundStatusPresetRow {
  resultPatch?: Record<string, unknown>;
  argsPatch?: Record<string, unknown>;
}

export const DEFAULT_PLAYGROUND_STATUS_PRESETS: StatusPreset[] = [
  { key: "completed", label: "Completed", status: "completed" },
  { key: "running", label: "Running", status: "running" },
  { key: "failed", label: "Failed", status: "failed" },
];
