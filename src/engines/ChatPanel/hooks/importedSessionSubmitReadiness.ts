import type { CloudSessionDownloadProgress } from "@src/features/Org2Cloud/cloudSessionDownloadProgressAtom";
import { isImportedSessionId } from "@src/features/TeamCollaboration/engine/collabImportIdentity";
import type { Session } from "@src/store/session";

/**
 * An imported replay is writable only after both transfer and Session
 * provenance hydration finish. This one predicate gates the rendered button
 * and the submit override so mouse, keyboard, and stale-render races agree.
 */
export function isImportedSessionSubmitBlocked(params: {
  sessionId: string;
  session: Session | undefined;
  progress: CloudSessionDownloadProgress | undefined;
}): boolean {
  if (!isImportedSessionId(params.sessionId)) return false;
  if (params.progress && params.progress.phase !== "completed") return true;
  return !params.session?.importedFrom;
}
