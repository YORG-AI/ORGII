import {
  type CloudSessionReference,
  parseCloudSessionReference,
  scanCloudSessionReferences,
} from "@src/features/Org2Cloud/cloudSessionReference";
import {
  SESSION_PREFIX_REGISTRY,
  createSessionIdTextPattern,
} from "@src/util/session/sessionDispatch";

export type MarkdownSessionReference =
  | {
      kind: "local";
      sessionId: string;
      title: string;
    }
  | {
      kind: "cloud";
      reference: CloudSessionReference;
      title?: string;
    };

export interface MarkdownSessionProjection {
  /** Markdown with session references removed. Non-session links are untouched. */
  text: string;
  /** Session attachments in first-appearance order, de-duplicated. */
  references: MarkdownSessionReference[];
  /** True when the source contained only session attachments and whitespace. */
  referenceOnly: boolean;
}

interface ReferenceSpan {
  start: number;
  end: number;
  reference: MarkdownSessionReference;
}

const SERIALIZED_SESSION_PILL = /([^\n[]+?)\s*\[session:([^\]]+)\]/gu;
const MARKDOWN_LOCAL_SESSION_LINK =
  /\[([^\]\r\n]+)\]\((session:\/\/[^)\r\n]+)\)/giu;
const TRAILING_REFERENCE_PUNCTUATION = /^[.,;:!?]+/u;
const MAX_SESSION_REFERENCE_CARDS = 4;

function sessionIdFromPath(path: string): string {
  const withoutScheme = path.startsWith("session://")
    ? path.slice("session://".length)
    : path;
  return withoutScheme.split("::")[0].split("/")[0];
}

function referenceKey(reference: MarkdownSessionReference): string {
  if (reference.kind === "local") return `local:${reference.sessionId}`;
  const { orgId, ownerUserId, sourceSessionId } = reference.reference;
  return `cloud:${orgId}\u001f${ownerUserId}\u001f${sourceSessionId}`;
}

/**
 * Replace Markdown code ranges with spaces while preserving string offsets.
 * Session-looking examples in inline code or fences must remain literal.
 */
function maskMarkdownCode(source: string): string {
  // Regex/string offsets are UTF-16 code units. `split("")` preserves those
  // offsets even when prose before a reference contains emoji.
  const chars = source.split("");
  const lines = source.split(/(?<=\n)/u);
  let offset = 0;
  let fenceMarker: "```" | "~~~" | null = null;

  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    const marker = trimmed.startsWith("```")
      ? "```"
      : trimmed.startsWith("~~~")
        ? "~~~"
        : null;

    if (fenceMarker) {
      mask(offset, offset + line.length);
      if (marker === fenceMarker) fenceMarker = null;
      offset += line.length;
      continue;
    }

    if (marker) {
      fenceMarker = marker;
      mask(offset, offset + line.length);
      offset += line.length;
      continue;
    }

    for (const match of line.matchAll(/(`+)[^\n]*?\1/gu)) {
      const start = offset + (match.index ?? 0);
      mask(start, start + match[0].length);
    }
    offset += line.length;
  }

  return chars.join("");
}

function markdownWrapperSpan(
  source: string,
  referenceStart: number,
  referenceEnd: number
): { start: number; end: number; title?: string } | null {
  if (source[referenceStart - 1] === "<" && source[referenceEnd] === ">") {
    return { start: referenceStart - 1, end: referenceEnd + 1 };
  }

  if (source.slice(referenceStart - 2, referenceStart) !== "](") return null;
  if (source[referenceEnd] !== ")") return null;

  const labelStart = source.lastIndexOf("[", referenceStart - 3);
  if (labelStart < 0) return null;
  const title = source.slice(labelStart + 1, referenceStart - 2);
  if (!title || /[\r\n]/u.test(title)) return null;
  return { start: labelStart, end: referenceEnd + 1, title };
}

function overlaps(left: ReferenceSpan, right: ReferenceSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function cleanProjectedText(text: string): string {
  return text
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/^[ \t]+|[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Classify session references at the shared read boundary.
 *
 * Persisted content stays untouched. On render, ordinary Markdown links stay
 * inline while local and cloud session references are removed from prose and
 * returned as structured attachments.
 */
export function projectMarkdownSessionReferences(
  source: string
): MarkdownSessionProjection {
  const mayContainBareSessionId =
    source.includes("agent-") ||
    SESSION_PREFIX_REGISTRY.some(({ prefix }) => source.includes(prefix));
  // Nearly every message contains no session attachment. Avoid building the
  // code mask and candidate arrays on that hot path.
  if (
    !source.includes("[session:") &&
    !source.includes("session://") &&
    !source.includes("orgii://cloud/session/ref") &&
    !mayContainBareSessionId
  ) {
    return { text: source, references: [], referenceOnly: false };
  }

  const masked = maskMarkdownCode(source);
  const candidates: ReferenceSpan[] = [];

  for (const match of masked.matchAll(SERIALIZED_SESSION_PILL)) {
    const matchStart = match.index;
    if (matchStart === undefined) continue;
    const rawLabel = match[1];
    const lastSpaceIndex = rawLabel.search(/\s[^\s]*$/u);
    const title = (
      lastSpaceIndex >= 0 ? rawLabel.slice(lastSpaceIndex + 1) : rawLabel
    ).trim();
    const start = matchStart + (lastSpaceIndex >= 0 ? lastSpaceIndex + 1 : 0);
    const path = match[2].trim();
    const cloudReference = parseCloudSessionReference(path);

    if (cloudReference) {
      candidates.push({
        start,
        end: matchStart + match[0].length,
        reference: {
          kind: "cloud",
          reference: cloudReference,
          title: title || undefined,
        },
      });
      continue;
    }

    const sessionId = sessionIdFromPath(path);
    if (!sessionId) continue;
    candidates.push({
      start,
      end: matchStart + match[0].length,
      reference: { kind: "local", sessionId, title: title || sessionId },
    });
  }

  for (const match of masked.matchAll(MARKDOWN_LOCAL_SESSION_LINK)) {
    const start = match.index;
    if (start === undefined) continue;
    const sessionId = sessionIdFromPath(match[2]);
    if (!sessionId) continue;
    candidates.push({
      start,
      end: start + match[0].length,
      reference: {
        kind: "local",
        sessionId,
        title: match[1].trim() || sessionId,
      },
    });
  }

  for (const match of masked.matchAll(createSessionIdTextPattern())) {
    const start = match.index;
    if (start === undefined) continue;
    const sessionId = match[0];
    candidates.push({
      start,
      end: start + sessionId.length,
      reference: { kind: "local", sessionId, title: sessionId },
    });
  }

  for (const span of scanCloudSessionReferences(masked)) {
    const wrapper = markdownWrapperSpan(source, span.start, span.end);
    const punctuationLength = wrapper
      ? 0
      : (source.slice(span.end).match(TRAILING_REFERENCE_PUNCTUATION)?.[0]
          .length ?? 0);
    candidates.push({
      start: wrapper?.start ?? span.start,
      end: wrapper?.end ?? span.end + punctuationLength,
      reference: {
        kind: "cloud",
        reference: span.reference,
        title: wrapper?.title,
      },
    });
  }

  candidates.sort(
    (left, right) => left.start - right.start || right.end - left.end
  );

  const accepted: ReferenceSpan[] = [];
  for (const candidate of candidates) {
    if (accepted.some((span) => overlaps(span, candidate))) continue;
    accepted.push(candidate);
  }
  accepted.sort((left, right) => left.start - right.start);

  if (accepted.length === 0) {
    return { text: source, references: [], referenceOnly: false };
  }

  const references: MarkdownSessionReference[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  let projected = "";
  for (const span of accepted) {
    projected += source.slice(cursor, span.start);
    cursor = span.end;
    const key = referenceKey(span.reference);
    if (seen.has(key)) continue;
    if (references.length >= MAX_SESSION_REFERENCE_CARDS) {
      projected += source.slice(span.start, span.end);
      continue;
    }
    seen.add(key);
    references.push(span.reference);
  }
  projected += source.slice(cursor);
  const text = cleanProjectedText(projected);

  return {
    text,
    references,
    referenceOnly: references.length > 0 && text.length === 0,
  };
}
