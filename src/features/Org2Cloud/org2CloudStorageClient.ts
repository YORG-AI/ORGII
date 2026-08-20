/**
 * Supabase Storage REST helpers for the replay-segment offload (H5).
 *
 * Frozen segments upload/download as raw gzip objects in the private
 * `replay` bucket — no base64 leg, no supabase-js. Access control is
 * server-side storage RLS delegating to the session read/write ladder;
 * the anon key plus the user JWT are the only credentials. Object paths
 * are bucket-relative (`{orgId}/{sessionId}/{epoch}/{seq}-{hash}.gz`),
 * immutable-by-name, and idempotent to re-upload (`x-upsert`).
 */
import { type CloudEndpoint, getCloudEndpoint } from "./config";
import { fetchWithTransportRetry } from "./org2CloudFetchRetry";

const REPLAY_BUCKET = "replay";

/** Storage request failure carrying the HTTP status when one was received. */
export class Org2CloudStorageError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudStorageError";
    this.status = status;
  }
}

/** Bucket-relative object key of one frozen segment (no bucket prefix). */
export function buildReplayObjectPath(
  orgId: string,
  sessionId: string,
  epoch: number,
  seq: number,
  segmentHash: string
): string {
  return `${orgId}/${sessionId}/${epoch}/${seq}-${segmentHash}.gz`;
}

function objectUrl(path: string, endpoint: CloudEndpoint): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${endpoint.supabaseUrl}/storage/v1/object/${REPLAY_BUCKET}/${encodedPath}`;
}

function objectHeaders(
  accessToken: string,
  endpoint: CloudEndpoint
): Record<string, string> {
  return {
    apikey: endpoint.anonKey,
    authorization: `Bearer ${accessToken}`,
  };
}

export async function uploadReplayObject(
  accessToken: string,
  path: string,
  bytes: Uint8Array,
  endpoint: CloudEndpoint = getCloudEndpoint(),
  signal?: AbortSignal
): Promise<void> {
  const response = await fetchWithTransportRetry(objectUrl(path, endpoint), {
    method: "POST",
    headers: {
      ...objectHeaders(accessToken, endpoint),
      "content-type": "application/gzip",
    },
    // Copy into a fresh ArrayBuffer-backed view: the DOM typings reject
    // Uint8Array<ArrayBufferLike> as a BodyInit.
    body: new Uint8Array(bytes),
    signal,
  });
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  // Replay objects are content-addressed (segment hash in the key), so a
  // duplicate-name rejection means the exact bytes are already stored —
  // resume treats it as success without a read-back: the member read path
  // walks the session read ladder, which denies replay reads on
  // metadata-only shares, so an existence probe cannot confirm objects the
  // uploader is not allowed to read and would fail this path forever.
  if (isDuplicateObjectRejection(response.status, body)) return;
  // A 400/403 RLS denial is ambiguous: the policy blocks the implied
  // update on an existing name with the same text as a genuine
  // authorization failure. Only here does the read-back decide.
  if (mayBeMaskedDuplicate(response.status, body)) {
    const exists = await replayObjectExists(
      accessToken,
      path,
      endpoint,
      signal
    );
    if (exists) return;
  }
  throw new Org2CloudStorageError(
    `replay object upload failed with ${response.status}` +
      (body ? `: ${body.slice(0, 300)}` : ""),
    response.status
  );
}

/** Rejections that unambiguously mean "this object name is already stored". */
function isDuplicateObjectRejection(status: number, body: string): boolean {
  if (status === 409) return true;
  if (status !== 400 && status !== 403) return false;
  return (
    body.includes("Duplicate") ||
    body.includes("KeyAlreadyExists") ||
    body.includes("already exists")
  );
}

/** RLS denials that may be masking an insert onto an existing name. */
function mayBeMaskedDuplicate(status: number, body: string): boolean {
  return (
    (status === 400 || status === 403) &&
    body.includes("row-level security policy")
  );
}

/** HEAD probe used only to confirm an upload rejection was a duplicate. */
async function replayObjectExists(
  accessToken: string,
  path: string,
  endpoint: CloudEndpoint,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetchWithTransportRetry(objectUrl(path, endpoint), {
      method: "HEAD",
      headers: objectHeaders(accessToken, endpoint),
      signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function downloadReplayObject(
  accessToken: string,
  path: string,
  endpoint: CloudEndpoint = getCloudEndpoint(),
  signal?: AbortSignal
): Promise<Uint8Array> {
  const response = await fetchWithTransportRetry(objectUrl(path, endpoint), {
    method: "GET",
    headers: objectHeaders(accessToken, endpoint),
    signal,
  });
  if (!response.ok) {
    throw new Org2CloudStorageError(
      `replay object download failed with ${response.status}`,
      response.status
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
