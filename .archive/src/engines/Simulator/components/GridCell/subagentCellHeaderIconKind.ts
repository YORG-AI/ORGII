/**
 * Header icon for IndependentGridCell — delegate subagent vs terminal-heavy clip.
 *
 * DB `session_type` (Rust `session_type` module) may later distinguish PTY/shell
 * children; until then we fall back to event-shape heuristics.
 */
import type { SessionEvent } from "@src/engines/SessionCore";

import { getEventTypeForColor } from "../../utils/eventSegments";

/** Wire values that should show the terminal (shell) icon when persisted. */
const TERMINAL_SESSION_TYPE = new Set<string>(["terminal", "shell"]);

export type SubagentHeaderIconKind = "agent" | "terminal";

export function resolveSubagentHeaderIconKind(
  events: SessionEvent[],
  sessionType?: string | null
): SubagentHeaderIconKind {
  const normalized = sessionType?.trim().toLowerCase() ?? "";
  if (normalized && TERMINAL_SESSION_TYPE.has(normalized)) {
    return "terminal";
  }

  if (events.length === 0) {
    return "agent";
  }

  let shellCount = 0;
  for (const event of events) {
    if (getEventTypeForColor(event) === "shell") {
      shellCount += 1;
    }
  }

  return shellCount * 2 >= events.length ? "terminal" : "agent";
}
