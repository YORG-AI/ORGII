/**
 * Backend-agnostic teammate-session import/fork helpers + segments push
 * planning.
 *
 * `importRemoteSession` is THE consolidated teammate-session import (design
 * §7.4 + M5 dedup); `forkSession` (design §16.11) is its WRITABLE sibling.
 * Both are backend-agnostic — their only backend dependency is
 * `client.getSessionEventSegments`, satisfied on the managed cloud by
 * `org2CloudBackendAdapter`. The segments planning helpers
 * (`computeFrozenEventCount` / `splitFrozenIntoSegments`) and the shared OCC
 * conflict matcher (`isCollabConflictError`) serve the cloud push engine and
 * the ProjectSyncChannel. The self-hosted engine's pull-application/push
 * helpers were deleted with the in-app self-hosted track (cloud-parity
 * Phase E).
 *
 * This module is the stable public entry point; the implementation lives in:
 * - `collabImportIdentity.ts` — import id derivation / provenance lookup
 * - `collabSegmentPlanning.ts` — frozen line, segment packing, OCC matcher
 * - `collabRemoteFetch.ts`    — shared segments fetch + assembly/validation
 * - `collabSessionImport.ts`  — `importRemoteSession` (read-only replay copy)
 * - `collabSessionFork.ts`    — `forkSession` (writable relay copy)
 */
export type { ImportedSessionMetadata } from "./collabImportIdentity";
export {
  deriveImportedSessionId,
  findImportedSession,
  normalizeSourceEndpointUrl,
  parseImportedSessionMetadata,
  rewriteEventsForImportedSnapshot,
} from "./collabImportIdentity";
export type { RemoteSessionFetchOptions } from "./collabRemoteFetch";
export {
  computeFrozenEventCount,
  isCollabConflictError,
  splitFrozenIntoSegments,
} from "./collabSegmentPlanning";
export type {
  ForkExecutionSelection,
  ForkSessionOptions,
  ForkSessionResult,
} from "./collabSessionFork";
export {
  buildForkedSessionName,
  createForkedSessionId,
  forkSession,
} from "./collabSessionFork";
export type {
  ImportRemoteSessionOptions,
  ImportRemoteSessionResult,
} from "./collabSessionImport";
export { importRemoteSession } from "./collabSessionImport";
