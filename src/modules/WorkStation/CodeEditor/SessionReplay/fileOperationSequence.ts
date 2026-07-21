import type { FileOperationEntry } from "./types";

export interface FileOperationSequenceInfo {
  sequenceLabel: string;
  pathHint: string;
}

interface RankedOperation {
  eventId: string;
  createdAt: string;
  fallbackOrder: number;
}

function getOperationEvents(
  operation: FileOperationEntry
): FileOperationEntry[] {
  return operation.relatedOperations?.length
    ? operation.relatedOperations
    : [operation];
}

function getParentPathHint(operation: FileOperationEntry): string {
  const normalized = operation.directory.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normalized) return "/";
  return normalized.split("/").filter(Boolean).pop() ?? "/";
}

/**
 * Assign chronological sequence numbers to the visible file rows. Consolidated
 * operations retain the full range of their underlying reads/edits.
 */
export function buildFileOperationSequenceInfo(
  operations: FileOperationEntry[]
): Map<string, FileOperationSequenceInfo> {
  const rankedOperations: RankedOperation[] = [];
  let fallbackOrder = 0;

  for (const operation of operations) {
    for (const related of getOperationEvents(operation)) {
      rankedOperations.push({
        eventId: related.eventId,
        createdAt: related.event?.createdAt ?? "",
        fallbackOrder,
      });
      fallbackOrder += 1;
    }
  }

  rankedOperations.sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    if (a.createdAt !== b.createdAt) return a.createdAt ? -1 : 1;
    return a.fallbackOrder - b.fallbackOrder;
  });

  const rankByEventId = new Map(
    rankedOperations.map((operation, index) => [operation.eventId, index + 1])
  );
  const result = new Map<string, FileOperationSequenceInfo>();

  for (const operation of operations) {
    const ranks = getOperationEvents(operation)
      .map((related) => rankByEventId.get(related.eventId))
      .filter((rank): rank is number => rank !== undefined)
      .sort((a, b) => a - b);
    const firstRank = ranks[0] ?? 1;
    const lastRank = ranks[ranks.length - 1] ?? firstRank;

    result.set(operation.eventId, {
      sequenceLabel:
        firstRank === lastRank ? `#${firstRank}` : `#${firstRank}–#${lastRank}`,
      pathHint: getParentPathHint(operation),
    });
  }

  return result;
}
