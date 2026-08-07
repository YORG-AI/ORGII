/**
 * Fork→thread provenance resolution for the "Addressing comment: …" header
 * chip (agent-pickup design §4 UI-5). Pure — the component feeds it the two
 * possible carriers and it picks one:
 *
 * 1. The fork-relay registry `taskContext` (the RUNNER's machine — the fork
 *    was created locally by the comment-task runner). Carries the bounded
 *    thread-head excerpt, so the chip can quote the comment.
 * 2. The pushed row's wire `addressesComment` (a TEAMMATE's machine — they
 *    imported the runner's pushed fork). The wire payload is minimal by
 *    design ({commentId, sourceSessionId}, no excerpt), so the chip renders
 *    the generic variant. The remote rows come from the sidebar's cached
 *    `org2CloudRemoteSessionsAtom` entry — a passive read: header renders
 *    must not add a fetch surface, so freshness rides the sidebar fetch the
 *    teammate necessarily made to import the row in the first place.
 */
import type { CloudOrgRemoteSessionsEntry } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import type { SessionImportedFrom } from "@src/store/session/sessionAtom/types";

import type { ForkTaskContext } from "../../forkSession";
import { pickImportedRemoteSession } from "../../useForkImportedSession";

type ImportedOrigin = Pick<
  SessionImportedFrom,
  "orgId" | "sourceSessionId" | "ownerMemberId"
>;

export interface AddressingCommentProvenance {
  orgId: string;
  /** Bare session id (owner-side) the comment thread is anchored to. */
  sourceSessionId: string;
  /** Top-level comment (thread head) id the fork addresses. */
  commentId: string;
  /**
   * Bounded one-line thread-head excerpt (registry carrier only — the wire
   * `addressesComment` deliberately carries no comment content).
   */
  excerpt?: string;
}

export function resolveAddressingComment(params: {
  /** `getSessionTaskContext(session)` — the durable registry carrier. */
  taskContext: ForkTaskContext | undefined;
  /** `session.importedFrom` — set on imported teammate replay copies. */
  importedFrom: ImportedOrigin | undefined;
  /** `org2CloudRemoteSessionsAtom` value (cached sidebar rows per org). */
  remoteEntries: Record<string, CloudOrgRemoteSessionsEntry>;
}): AddressingCommentProvenance | undefined {
  const { taskContext, importedFrom, remoteEntries } = params;

  if (taskContext) {
    const excerpt = taskContext.excerpt.trim();
    return {
      orgId: taskContext.orgId,
      sourceSessionId: taskContext.sourceSessionId,
      commentId: taskContext.commentId,
      excerpt: excerpt.length > 0 ? excerpt : undefined,
    };
  }

  if (!importedFrom) return undefined;
  const rows = remoteEntries[importedFrom.orgId]?.rows;
  if (!rows || rows.length === 0) return undefined;
  const remote = pickImportedRemoteSession(rows, importedFrom);
  const addresses = remote?.addressesComment;
  if (!addresses) return undefined;
  return {
    orgId: importedFrom.orgId,
    sourceSessionId: addresses.sourceSessionId,
    commentId: addresses.commentId,
  };
}
