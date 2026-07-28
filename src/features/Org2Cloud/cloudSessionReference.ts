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

/** One valid reference found in free text, with where it sits. */
export interface CloudSessionReferenceSpan {
  /** Index of the scheme in the original string. */
  start: number;
  /** Exclusive end of the reference text (after punctuation trimming). */
  end: number;
  /** The exact reference substring, usable as a link target. */
  url: string;
  reference: CloudSessionReference;
}

/**
 * Case-insensitive to match `parseCloudSessionReference`, which compares a
 * lowercased scheme and host per the URL spec. A case-sensitive scan here
 * would find `[label](ORGII://…)` but not the same reference written bare.
 * Matched on the original string so indices need no remapping.
 */
const REFERENCE_SCHEME_PATTERN = /orgii:\/\//giu;

/**
 * Trailing characters stripped before validation so a reference ending a
 * sentence still matches. Backtick is included because a reference typed as
 * `` `ref` `` ends its whitespace-free run on the closing backtick, which
 * would otherwise survive into the session id and chip an id nobody wrote.
 * Consequence (same trade GFM autolinks make): a session id whose last
 * character is one of these cannot be found in bare text — it stays plain
 * rather than matching a truncated id.
 */
const TRAILING_PUNCTUATION = /[.,;:!?"'\]})>`]+$/u;

/**
 * Upper bound on a candidate's length. The grammar's fixed part is ~128
 * characters plus a session id, so this is generous for any real
 * reference; anything longer fails closed instead of being truncated.
 */
const MAX_REFERENCE_LENGTH = 512;

/**
 * Hoisted out of `candidateEnd`: a regex literal inside the loop allocates
 * a fresh RegExp per character, which is what made adversarial pastes
 * (dense scheme hits in whitespace-free runs) cost tens of ms per scan.
 */
const WHITESPACE = /\s/u;

/** Exclusive end of the whitespace-free run containing `start`. */
function runEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length && !WHITESPACE.test(value[index])) {
    index += 1;
  }
  return index;
}

/**
 * Find every valid reference in free text, in order. This is the single
 * scanner behind both the markdown linkifier and composer previews, so what
 * an editing surface previews is exactly what the rendered body will chip.
 */
export function scanCloudSessionReferences(
  value: string
): CloudSessionReferenceSpan[] {
  const spans: CloudSessionReferenceSpan[] = [];
  const scan = new RegExp(REFERENCE_SCHEME_PATTERN);
  // Exclusive end of the run containing the previous hit. Later hits inside
  // the same whitespace-free run share it, so a run is walked once no
  // matter how many scheme hits it packs — an adversarial single-line paste
  // costs one pass over the text, not hits × run length.
  let knownRunEnd = -1;

  for (;;) {
    const match = scan.exec(value);
    if (!match) break;
    const at = match.index;

    const end = at < knownRunEnd ? knownRunEnd : runEnd(value, at);
    knownRunEnd = end;
    // Candidates longer than any legitimate reference fail closed rather
    // than truncating: a truncated candidate can still PARSE, which would
    // surface a valid-looking reference to a session id nobody wrote.
    if (end - at > MAX_REFERENCE_LENGTH) continue;

    const trimmed = value.slice(at, end).replace(TRAILING_PUNCTUATION, "");
    if (!trimmed) continue;
    const reference = parseCloudSessionReference(trimmed);
    if (!reference) continue;

    spans.push({
      start: at,
      end: at + trimmed.length,
      url: trimmed,
      reference,
    });
    scan.lastIndex = at + trimmed.length;
  }
  return spans;
}

/**
 * Code regions the markdown renderer keeps literal, so a composer preview
 * must not chip references inside them. Fences first: an inline-span pass
 * running before it would pair the fence's own backticks. An unpaired
 * backtick stays literal in GFM too, so it is left alone here as well.
 */
const CODE_FENCE = /^(```|~~~).*?^\1.*?$/gmsu;
const INLINE_CODE_SPAN = /`[^`\n]*`/gu;

/**
 * Unique references in markdown-bound composer text, first-appearance
 * order — what a composer preview shows for the text as typed so far.
 * References inside code spans/fences are excluded to match the rendered
 * body, where code stays literal and never chips.
 */
export function collectUniqueCloudSessionReferences(
  value: string
): CloudSessionReference[] {
  const scannable = value
    .replace(CODE_FENCE, " ")
    .replace(INLINE_CODE_SPAN, " ");
  const seen = new Set<string>();
  const references: CloudSessionReference[] = [];
  for (const span of scanCloudSessionReferences(scannable)) {
    const key = `${span.reference.orgId}\u001f${span.reference.ownerUserId}\u001f${span.reference.sourceSessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(span.reference);
  }
  return references;
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
