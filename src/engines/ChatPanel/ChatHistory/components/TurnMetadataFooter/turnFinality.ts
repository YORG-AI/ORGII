import type { TurnStatus } from "@src/engines/SessionCore/storage/sqliteCache";

const TERMINAL_TURN_STATUSES = new Set<TurnStatus>([
  "completed",
  "interrupted",
  "failed",
]);

export function isTerminalTurnStatus(status: TurnStatus): boolean {
  return TERMINAL_TURN_STATUSES.has(status);
}
