/**
 * Diff Session Replay Types
 *
 * Shared types for the Diff simulator app — a dedicated viewer for
 * file-edit / patch events surfaced from the session timeline.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { SimulatorAppBaseState } from "@src/engines/Simulator/apps/core/types";

/**
 * One row in the Diff app's left list — corresponds to a single edit /
 * apply_patch / create / overwrite / delete event.
 */
export interface DiffEntry {
  /** Stable id, mirrors the underlying event id. */
  entryId: string;
  /** Original event powering this row. */
  event: SessionEvent;
  /** Resolved file path (may be empty for malformed events). */
  filePath: string;
  /** Last path segment used as a display label. */
  fileName: string;
  /** True if the row corresponds to the current replay cursor. */
  isCurrent: boolean;
}

/** Top-level tabs surfaced in the Diff app chrome. */
export type DiffReplayTab = "all" | "diff" | "submissions" | "requirements";

/**
 * State derived from filtered events; consumed by the index component.
 */
export interface SimulatorDiffState extends SimulatorAppBaseState {
  entries: DiffEntry[];
  selectedEntry: DiffEntry | null;
}
