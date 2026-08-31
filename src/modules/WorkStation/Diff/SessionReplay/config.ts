/**
 * Diff Simulator App Configuration
 *
 * Registers the Diff app with the simulator registry. Diff events are
 * identified by the chat-block dispatch ("diff" — covers edit_file,
 * apply_patch, delete_file, create, overwrite) so the matcher mirrors the
 * Chat Panel's filter for inline diff cards.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { SimulatorAppConfig } from "@src/engines/Simulator/apps/core/types";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { isDiffRoutedEvent } from "@src/engines/Simulator/utils/simulatorEventRouting";
import { getFileName, normalizeDiffFilePath } from "@src/util/file/pathUtils";

import type { DiffEntry, SimulatorDiffState } from "./types";

/** True when this event should be surfaced as a diff entry. */
export function isDiffEvent(event: SessionEvent): boolean {
  const toolName = event.uiCanonical || event.functionName;
  if (!toolName) return false;
  const rawAction = event.args?.action;
  const action = typeof rawAction === "string" ? rawAction : undefined;
  return isDiffRoutedEvent(toolName, action);
}

function resolveFilePath(event: SessionEvent): string {
  const args = event.args ?? {};
  const candidates = [args.file_path, args.path, args.target_file, args.file];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** Build a DiffEntry from a SessionEvent — keeps index.tsx slim. */
export function buildDiffEntry(
  event: SessionEvent,
  isCurrent: boolean
): DiffEntry {
  const filePath = normalizeDiffFilePath(resolveFilePath(event));
  const fileName = filePath ? getFileName(filePath) : event.functionName;
  return {
    entryId: event.id,
    event,
    filePath,
    fileName,
    isCurrent,
  };
}

function deriveDiffState(
  events: SessionEvent[],
  currentEventId: string | null
): Omit<
  SimulatorDiffState,
  keyof import("@src/engines/Simulator/apps/core/types").SimulatorAppBaseState
> {
  const entries: DiffEntry[] = [];

  for (const event of events) {
    // The simulator's matchesEvent runs at the tool level; double-check
    // here so events that share a tool but route to a non-diff chat block
    // (e.g. `read_file` actions on edit_file) never leak into the list.
    if (!isDiffEvent(event)) continue;
    entries.push(buildDiffEntry(event, event.id === currentEventId));
  }

  const selectedEntry =
    entries.find((entry) => entry.entryId === currentEventId) ??
    entries[entries.length - 1] ??
    null;

  return { entries, selectedEntry };
}

/**
 * Tool-level matcher used by the simulator framework. The exact per-event
 * filter (which understands `args.action`) lives in `deriveDiffState`
 * above — the factory matcher only sees `eventFunction`.
 */
function matchesDiffTool(eventFunction: string): boolean {
  return isDiffRoutedEvent(eventFunction);
}

export const DIFF_APP_CONFIG: Omit<
  SimulatorAppConfig<SimulatorDiffState>,
  "component"
> = {
  id: AppType.DIFF,
  name: "Diff",
  icon: "file-diff",
  matchesEvent: matchesDiffTool,
  deriveState: deriveDiffState,
};
