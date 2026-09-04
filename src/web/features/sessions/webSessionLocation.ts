import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

type WebSessionIdentity = Pick<
  RemoteTeammateSessionMetadata,
  "id" | "orgId" | "sourceSessionId"
>;

/** Cloud APIs and Web routes are keyed by the authoritative session row id.
 * sourceSessionId belongs to the originating desktop and is display/runtime
 * metadata, not the remote row locator. */
export function cloudSessionEventTarget(session: WebSessionIdentity) {
  return { orgId: session.orgId, sessionRowId: session.id };
}

export function webSessionPath(
  session: WebSessionIdentity,
  options?: { openNotes?: boolean }
): string {
  const base = `/sessions/${encodeURIComponent(session.orgId)}/${encodeURIComponent(session.id)}`;
  return options?.openNotes ? `${base}?notes=1` : base;
}

export function webSessionHasOpenNotes(search: string): boolean {
  return new URLSearchParams(search).get("notes") === "1";
}

export function matchesWebSessionPath(
  session: WebSessionIdentity,
  orgId: string | undefined,
  sessionRowId: string | undefined
): boolean {
  return session.orgId === orgId && session.id === sessionRowId;
}
