/**
 * Human title for a session reference, resolved from data the viewer
 * ALREADY has.
 *
 * A reference carries no title, and fetching one would answer "does this
 * session exist" for someone who may have no right to know. But a member
 * has the org's listing loaded already, and the owner has the session
 * locally — so the name is free exactly when the viewer is entitled to it,
 * and absent exactly when they are not. No request is made either way.
 *
 * The generic fallback is therefore not a degradation: it is what a viewer
 * without access is supposed to see.
 */
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type { CloudSessionReference } from "./cloudSessionReference";

interface ResolveSessionReferenceTitleInput {
  reference: CloudSessionReference;
  /** Rows already cached for the reference's org; never fetched for this. */
  orgRows: readonly RemoteTeammateSessionMetadata[] | undefined;
  /** Title of a local session with the same id, when one exists. */
  localTitle?: string | null;
}

export function resolveSessionReferenceTitle({
  reference,
  orgRows,
  localTitle,
}: ResolveSessionReferenceTitleInput): string | null {
  const local = localTitle?.trim();
  if (local) return local;

  const row = orgRows?.find(
    (candidate) =>
      candidate.sourceSessionId === reference.sourceSessionId &&
      candidate.ownerUserId === reference.ownerUserId
  );
  const remote = row?.title?.trim();
  return remote || null;
}
