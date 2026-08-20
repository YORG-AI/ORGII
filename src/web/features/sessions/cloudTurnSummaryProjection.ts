import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";
import type { CloudSessionTurnSummary } from "@src/features/Org2Cloud/org2CloudSyncClient";

/**
 * Maps owner-published cloud turn index rows into the TurnSummary shape the
 * shared Timeline / Changes views already consume. File-level metadata is
 * absent on the wire — those views degrade to empty changes, which is fine
 * for a read-only web surface.
 */
export function projectCloudTurnSummaries(
  sessionId: string,
  turns: readonly CloudSessionTurnSummary[]
): TurnSummary[] {
  return turns.map((turn, index) => ({
    sessionId,
    turnId: turn.turnId,
    startSequence: index,
    endSequence: null,
    nextTurnId: turn.nextTurnId ?? null,
    startedAt: turn.startedAt ?? turn.endedAt ?? "",
    endedAt: turn.endedAt ?? null,
    durationMs: turn.durationMs ?? null,
    userEventIds: [turn.turnId],
    userPreview: turn.prompt,
    eventCount: turn.eventCount,
    bodyEventCount: turn.bodyEventCount,
    status: "completed",
    interrupted: false,
    modifiedFiles: [],
    resourceInteractions: [],
    gitArtifacts: [],
  }));
}
