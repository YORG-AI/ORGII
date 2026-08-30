import { stripMcpPrefix } from "@src/engines/SessionCore/core/interactiveTools";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

export interface PendingModeSwitch {
  eventId: string;
  targetMode: string;
  reason: string;
  createdAt?: string;
}

export function extractPendingModeSwitch(
  events: ReadonlyArray<SessionEvent>
): PendingModeSwitch | null {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    if (stripMcpPrefix(event.functionName ?? "") !== "suggest_mode_switch") {
      continue;
    }
    if (event.activityStatus === "processed") continue;

    return {
      eventId: event.id ?? "",
      targetMode:
        (event.args.target_mode as string | undefined) ??
        (event.args.targetModeId as string | undefined) ??
        "plan",
      reason:
        (event.args.reason as string | undefined) ??
        (event.args.explanation as string | undefined) ??
        "",
      createdAt: event.createdAt,
    };
  }
  return null;
}

export function pendingModeSwitchEqual(
  left: PendingModeSwitch | null,
  right: PendingModeSwitch | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.eventId === right.eventId &&
    left.targetMode === right.targetMode &&
    left.reason === right.reason &&
    left.createdAt === right.createdAt
  );
}
