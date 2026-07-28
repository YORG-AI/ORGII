/**
 * Stable, non-secret ORG2 Cloud session references for issue trackers,
 * pull requests, logs, and other text surfaces.
 *
 * A sourceSessionId alone is not globally unique: two ORGII users can publish
 * the same external session seen on a shared machine. The reference therefore
 * carries the cloud row's full identity tuple: org + owner user + source
 * session. It deliberately uses `/session/ref`, not the capability-bearing
 * `/session?share=...` path, so references cannot be mistaken for access
 * grants.
 */
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

const CLOUD_SESSION_REFERENCE_SCHEME = "orgii:";
const CLOUD_SESSION_REFERENCE_HOST = "cloud";
const CLOUD_SESSION_REFERENCE_PATH = "session/ref";

const CLOUD_SESSION_REFERENCE_VERSION = 1 as const;

export interface CloudSessionReference {
  version: typeof CLOUD_SESSION_REFERENCE_VERSION;
  orgId: string;
  ownerUserId: string;
  sourceSessionId: string;
}

type CloudSessionReferenceSource = Pick<
  RemoteTeammateSessionMetadata,
  "orgId" | "ownerUserId" | "sourceSessionId"
>;

function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Cannot build cloud session reference without ${field}`);
  }
  return normalized;
}

/**
 * Build the canonical v1 text reference.
 *
 * Example:
 * `orgii://cloud/session/ref?v=1&org=<uuid>&owner=<uuid>&session=<id>`
 */
export function buildCloudSessionReference(
  source: CloudSessionReferenceSource
): string {
  const params = new URLSearchParams({
    v: String(CLOUD_SESSION_REFERENCE_VERSION),
    org: requireIdentifier(source.orgId, "orgId"),
    owner: requireIdentifier(source.ownerUserId, "ownerUserId"),
    session: requireIdentifier(source.sourceSessionId, "sourceSessionId"),
  });
  return `${CLOUD_SESSION_REFERENCE_SCHEME}//${CLOUD_SESSION_REFERENCE_HOST}/${CLOUD_SESSION_REFERENCE_PATH}?${params.toString()}`;
}

function readSingleRequiredParam(
  params: URLSearchParams,
  key: string
): string | null {
  const values = params.getAll(key);
  if (values.length !== 1) return null;
  const normalized = values[0].trim();
  return normalized || null;
}

/** Parse one exact ORG2 session reference; malformed or future versions fail closed. */
export function parseCloudSessionReference(
  value: string
): CloudSessionReference | null {
  const trimmed = value.trim();
  if (
    !trimmed.toLowerCase().startsWith(`${CLOUD_SESSION_REFERENCE_SCHEME}//`)
  ) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/^\/+|\/+$/gu, "").toLowerCase();
    if (
      parsed.protocol.toLowerCase() !== CLOUD_SESSION_REFERENCE_SCHEME ||
      parsed.hostname.toLowerCase() !== CLOUD_SESSION_REFERENCE_HOST ||
      path !== CLOUD_SESSION_REFERENCE_PATH ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    ) {
      return null;
    }

    const version = readSingleRequiredParam(parsed.searchParams, "v");
    const orgId = readSingleRequiredParam(parsed.searchParams, "org");
    const ownerUserId = readSingleRequiredParam(parsed.searchParams, "owner");
    const sourceSessionId = readSingleRequiredParam(
      parsed.searchParams,
      "session"
    );
    if (
      version !== String(CLOUD_SESSION_REFERENCE_VERSION) ||
      !orgId ||
      !ownerUserId ||
      !sourceSessionId
    ) {
      return null;
    }

    return {
      version: CLOUD_SESSION_REFERENCE_VERSION,
      orgId,
      ownerUserId,
      sourceSessionId,
    };
  } catch {
    return null;
  }
}
