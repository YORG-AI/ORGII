import React from "react";

import { getToolIcon } from "@src/config/toolIcons";
import { resolveToolName } from "@src/engines/SessionCore/rendering/registry/toolAliases";

import { resolveFileOperationPayload } from "../resolveFilePayload";
import { FILE_OPERATION_TYPE, type FileOperationEntry } from "../types";

export const SIDEBAR_ICON_PROPS = {
  size: 14,
  className: "shrink-0 text-text-3",
} as const;

export function getWriteStatusBadge(op: FileOperationEntry): {
  label: string;
  colorClass: string;
} | null {
  if (op.type === FILE_OPERATION_TYPE.DELETE) {
    return { label: "D", colorClass: "text-danger-6" };
  }
  if (op.type !== FILE_OPERATION_TYPE.WRITE) return null;
  const hasBaseline =
    op.writeHasBaselineContent !== undefined
      ? op.writeHasBaselineContent
      : Boolean(resolveFileOperationPayload(op).oldContent);
  return hasBaseline
    ? { label: "M", colorClass: "text-warning-6" }
    : { label: "A", colorClass: "text-success-6" };
}

/**
 * Content keys for the read/write file sidebar projections.
 *
 * `readItems` / `writeItems` are memoized on these strings rather than on the
 * operation arrays, because those arrays get a fresh identity on every replay
 * step. The key must therefore encode *every* field the projection renders --
 * including `filePath`, which is not stable per event id.
 *
 * `filePath` is re-derived from the event's `args` on every streaming patch
 * (`SessionEventPatch` can patch `args` and re-runs `maybe_recompute_extracted`,
 * but carries no `created_at`). For an `apply_patch` "Add File" the path is
 * parsed out of the patch blob itself, so it grows character-by-character while
 * `eventId`, `createdAt`, `editCount` and the A/M baseline flag all stay fixed.
 * Omitting the path froze the tree on the first, truncated filename.
 *
 * Both keys use `JSON.stringify` rather than a delimiter join: a file path may
 * legitimately contain `:` or `,`, so a delimited key would be ambiguous.
 */
export function buildReadFileKey(readOperations: FileOperationEntry[]): string {
  return JSON.stringify(
    readOperations.map((op) => [
      op.eventId,
      op.event?.createdAt ?? "",
      op.filePath,
    ])
  );
}

export function buildWriteFileKey(
  writeOperations: FileOperationEntry[]
): string {
  return JSON.stringify(
    writeOperations.map((op) => {
      if (op.type === FILE_OPERATION_TYPE.DELETE) {
        return ["D", op.eventId, op.event?.createdAt ?? "", op.filePath];
      }
      // Mirrors getWriteStatusBadge's A/M decision so a baseline flip
      // invalidates the key.
      const hasBaseline =
        op.writeHasBaselineContent !== undefined
          ? op.writeHasBaselineContent
          : Boolean(resolveFileOperationPayload(op).oldContent);
      return [
        hasBaseline ? "M" : "A",
        op.eventId,
        op.event?.createdAt ?? "",
        op.editCount ?? 1,
        op.filePath,
      ];
    })
  );
}

export function sidebarToolIcon(functionName?: string): React.ReactNode {
  return getToolIcon(resolveToolName(functionName ?? ""), SIDEBAR_ICON_PROPS);
}
