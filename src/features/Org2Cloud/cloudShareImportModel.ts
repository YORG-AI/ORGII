import { ZodError } from "zod/v4";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import { CloudShareEndpointMismatchError } from "./org2CloudShareEndpoint";
import {
  Org2CloudShareError,
  isOrg2ShareErrorCode,
} from "./org2CloudSharesClient";

export type CloudShareResolveErrorKind =
  | "invalid"
  | "endpoint_mismatch"
  | "connection"
  | "incompatible"
  | "server";

/** Keep capability failures opaque while making operational failures useful. */
export function classifyCloudShareResolveError(
  error: unknown
): CloudShareResolveErrorKind {
  if (error instanceof CloudShareEndpointMismatchError) {
    return "endpoint_mismatch";
  }
  if (isOrg2ShareErrorCode(error, "ORG2_UNAUTHORIZED")) return "invalid";
  if (error instanceof TypeError) return "connection";
  if (error instanceof ZodError) return "incompatible";
  if (error instanceof Org2CloudShareError && error.status === null) {
    return "connection";
  }
  return "server";
}

/**
 * A share resolving to a source session already present on this device is an
 * open operation, not an import. Matching the globally unique source id also
 * covers locally indexed Codex/Claude external-history sessions.
 */
export function findLocalCloudShareSource(
  sessions: readonly Session[],
  remoteSession: Pick<RemoteTeammateSessionMetadata, "sourceSessionId">
): Session | null {
  return (
    sessions.find(
      (session) => session.session_id === remoteSession.sourceSessionId
    ) ?? null
  );
}
