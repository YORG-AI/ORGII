/**
 * Shell-search converter.
 *
 * Agent CLIs often run code searches through the shell (`grep -rn "x" src |
 * head -20`) instead of a dedicated grep tool. Those events arrive with the
 * SHELL subtool and would land in the terminal "Commands" section as opaque
 * `grep, head` rows. This module reroutes them: a shell operation whose
 * command is a pure search pipeline (see `parseShellSearchCommand`) becomes
 * an ExploreOperationEntry, so the replay sidebar, tab strip, and search
 * panel treat it exactly like a native grep event.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { parseShellSearchCommand } from "@src/util/terminal/searchCommandParser";

import type { ExploreOperationEntry, ShellOperationEntry } from "../types";
import { EXPLORE_TYPE } from "../types";
import { toSlimExploreEvent } from "./exploreConverter";
import { parseTextSearchResults } from "./exploreDataHelpers";

/**
 * Whether an event's shell command is really a code search. Used by surfaces
 * that only have the event (not a converted operation), e.g. the replay IDE
 * deciding the current event's panel mode.
 */
export function isShellSearchEvent(
  event: Pick<SessionEvent, "command" | "args"> | null | undefined
): boolean {
  if (!event) return false;
  const command =
    event.command ||
    (typeof event.args?.command === "string" ? event.args.command : "");
  return parseShellSearchCommand(command) !== null;
}

/**
 * Convert an already-extracted shell operation into an explore operation.
 * Returns null when the command is not a pure search pipeline — the caller
 * keeps it as a terminal entry.
 */
export function convertShellSearchOperation(
  shellOp: ShellOperationEntry
): ExploreOperationEntry | null {
  const parsed = parseShellSearchCommand(shellOp.command);
  if (!parsed) return null;

  const outputText = shellOp.output ?? shellOp.streamOutput ?? "";
  const { results, files } = outputText
    ? parseTextSearchResults(outputText)
    : { results: [], files: [] as string[] };

  return {
    query: parsed.pattern || shellOp.command,
    exploreType: EXPLORE_TYPE.CODE_SEARCH,
    // "grep" keys the per-action icon and the "Grep" sidebar label.
    exploreAction: "grep",
    results,
    files,
    totalMatches: results.length > 0 ? results.length : files.length,
    hasResultPayload: outputText.length > 0,
    directory: parsed.paths.join(", ") || undefined,
    event: toSlimExploreEvent(shellOp.event),
    eventId: shellOp.eventId,
    isCurrent: shellOp.isCurrent,
    isLoading: shellOp.isLoading,
    isFailed: shellOp.isFailed,
  };
}
