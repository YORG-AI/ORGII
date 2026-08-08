/**
 * Splitting a posted channel body into prose and reference cards.
 *
 * Four kinds of reference are promoted OUT of the sentence and rendered as
 * cards below the prose — local sessions, cloud sessions, work items, and
 * GitHub issues/PRs. Local references are stored as ordinary pill syntax; a
 * cloud reference keeps its canonical `orgii://cloud/session/ref?...` tuple
 * because its source session id is not globally unique. The other references
 * are stored inside the body as ordinary pill syntax (`title [session:<id>]`,
 * `title [workitem:workitem://<slug>/<shortId>/<ts>]`,
 * `owner/repo#1 [pr:https://github.com/...]`) because that is what the
 * composer serializes.
 *
 * The split runs through `parsePillTextToSnapshot` rather than a bespoke
 * regex: that parser already owns the tricky "where does the display label
 * end" rule (last whitespace-delimited token, with a CJK fallback), and
 * re-deciding it here is how the prose and the card would drift apart. The
 * leftover parts are re-serialized with `serializePillNode`, the exact
 * inverse, so any OTHER pill type (file, folder, generic link…) survives
 * untouched and still renders through the read-only composer.
 *
 * GitHub references get a SECOND pass. `pasteHandlers` only mints a pill when
 * a GitHub URL is pasted on its own — a URL the author typed, or pasted in the
 * middle of a sentence, stays plain text — so the prose that survives pill
 * extraction is scanned for bare issue/PR URLs too. That scan never decides
 * what a GitHub URL looks like: it tokenizes URL-shaped runs and hands every
 * candidate to `parseGitHubPillUrl`, the same parser the composer uses, so the
 * two can never disagree about what is renderable. Anything it declines (a
 * repo root, a commit, a profile) stays in the prose as ordinary text rather
 * than being swallowed into a card that could not say anything about it.
 */
import { serializePillNode } from "@src/components/ComposerInput";
import { parseGitHubPillUrl } from "@src/components/ComposerInput/githubUrl";
import { parsePillTextToSnapshot } from "@src/engines/ChatPanel/InputArea/utils/pillContentParser";
import {
  type CloudSessionReference,
  parseCloudSessionReference,
  scanCloudSessionReferences,
} from "@src/features/Org2Cloud/cloudSessionReference";

export interface ChannelSessionReference {
  kind: "session";
  sessionId: string;
  /** Title snapshot as posted — the fallback when the session is gone. */
  title: string;
}

export interface ChannelCloudSessionReference {
  kind: "cloudSession";
  /** Full org + owner + source identity; a bare source id is not global. */
  reference: CloudSessionReference;
  /** Present on legacy pill-shaped references, absent on canonical bare refs. */
  title?: string;
}

export interface ChannelWorkItemReference {
  kind: "workItem";
  projectSlug: string;
  shortId: string;
  /** Title snapshot as posted — the fallback when the item cannot be read. */
  title: string;
}

export interface ChannelGitHubReference {
  kind: "github";
  /** Canonical URL from `parseGitHubPillUrl`, never the raw typed string. */
  url: string;
  /** `owner/repo#123`. */
  displayName: string;
  resource: "issue" | "pr";
}

export type ChannelMessageReference =
  | ChannelSessionReference
  | ChannelCloudSessionReference
  | ChannelWorkItemReference
  | ChannelGitHubReference;

export interface ChannelMessageBodyParts {
  /** Body with the references removed; may be empty. */
  text: string;
  /** Referenced targets, in the order they appeared, de-duplicated. */
  references: ChannelMessageReference[];
}

/** Stable identity for de-duplication and React keys. */
export function channelReferenceKey(
  reference: ChannelMessageReference
): string {
  if (reference.kind === "session") return `session:${reference.sessionId}`;
  if (reference.kind === "cloudSession") {
    const { orgId, ownerUserId, sourceSessionId } = reference.reference;
    return `cloudSession:${orgId}/${ownerUserId}/${sourceSessionId}`;
  }
  if (reference.kind === "workItem") {
    return `workItem:${reference.projectSlug}/${reference.shortId}`;
  }
  return `github:${reference.url}`;
}

/** `session://<id>/<ts>`, `<id>::<blob>` and a bare id all name one session. */
export function sessionIdFromPillPath(path: string): string {
  const withoutScheme = path.startsWith("session://")
    ? path.slice("session://".length)
    : path;
  return withoutScheme.split("::")[0].split("/")[0];
}

/**
 * `workitem://<projectSlug>/<shortId>/<ts>` — the shape both the tab-drop path
 * (`insertPillFromTabPayload`) and the `@` menu (`useAtMention`) produce. The
 * trailing timestamp only exists to keep two pills naming one item distinct;
 * a `::<base64>` tail carries the agent-side expansion and is not identity.
 */
export function workItemFromPillPath(
  path: string
): { projectSlug: string; shortId: string } | null {
  const withoutScheme = path.startsWith("workitem://")
    ? path.slice("workitem://".length)
    : path;
  const [projectSlug, shortId] = withoutScheme.split("::")[0].split("/");
  if (!projectSlug || !shortId) return null;
  return { projectSlug, shortId };
}

/** A pill whose path is a GitHub issue/PR, whatever pill type carries it. */
function gitHubReferenceFromUrl(url: string): ChannelGitHubReference | null {
  const parsed = parseGitHubPillUrl(url);
  // A repo root has no number, no state, and nothing a card could add over
  // the link text itself — leave it inline.
  if (!parsed || parsed.iconType === "repo") return null;
  return {
    kind: "github",
    url: parsed.url,
    displayName: parsed.displayName,
    resource: parsed.iconType,
  };
}

/**
 * URL-shaped runs in prose. Deliberately NOT a GitHub matcher — it only says
 * where a URL starts and ends, and `parseGitHubPillUrl` alone decides whether
 * that URL is something this surface can render. Brackets and parentheses are
 * excluded so a markdown link's delimiters stay out of the token.
 */
const PROSE_URL_TOKEN_REGEX = /https?:\/\/[^\s<>()[\]]+/gu;

/** Sentence punctuation that trails a typed URL and is not part of it. */
const URL_TRAILING_PUNCTUATION_REGEX = /[.,;:!?'"]+$/u;

/**
 * True when the token is a markdown link's target or its label, or a markdown
 * autolink. Lifting either would tear the surrounding syntax in half and leave
 * `[]()` behind, so linked URLs are left alone entirely and only BARE URLs
 * become cards.
 */
function isMarkdownLinkPart(
  prose: string,
  start: number,
  end: number
): boolean {
  if (prose.slice(Math.max(0, start - 2), start) === "](") return true;
  if (prose[start - 1] === "[" && prose.slice(end, end + 2) === "](") {
    return true;
  }
  return prose[start - 1] === "<" && prose[end] === ">";
}

/**
 * Pulls bare cloud-session and GitHub issue/PR references out of one prose
 * segment, appending each to `collect` in source order. Returns the segment
 * with the lifted references removed.
 */
function liftReferencesFromProse(
  prose: string,
  collect: (reference: ChannelMessageReference) => void
): string {
  const cloudSpans = scanCloudSessionReferences(prose)
    .filter((span) => !isMarkdownLinkPart(prose, span.start, span.end))
    .map((span) => ({
      start: span.start,
      // Match the existing GitHub-card behavior: punctuation that merely
      // terminates a bare reference leaves with the promoted attachment.
      end:
        span.end +
        (prose.slice(span.end).match(/^[.,;:!?'\u0022]+/u)?.[0].length ?? 0),
      reference: {
        kind: "cloudSession" as const,
        reference: span.reference,
      },
    }));
  const githubSpans: Array<{
    start: number;
    end: number;
    reference: ChannelGitHubReference;
  }> = [];

  for (const match of prose.matchAll(PROSE_URL_TOKEN_REGEX)) {
    const start = match.index;
    if (start === undefined) continue;
    const raw = match[0];
    const end = start + raw.length;
    if (isMarkdownLinkPart(prose, start, end)) continue;

    const reference = gitHubReferenceFromUrl(
      raw.replace(URL_TRAILING_PUNCTUATION_REGEX, "")
    );
    if (reference) githubSpans.push({ start, end, reference });
  }

  const spans = [...cloudSpans, ...githubSpans].sort(
    (left, right) => left.start - right.start
  );
  let result = "";
  let lastIndex = 0;

  for (const span of spans) {
    if (span.start < lastIndex) continue;
    result += prose.slice(lastIndex, span.start);
    lastIndex = span.end;
    collect(span.reference);
  }

  return result + prose.slice(lastIndex);
}

/** One accumulated run of the rebuilt body. */
interface BodySegment {
  text: string;
  /**
   * True for a re-serialized pill. Its path may itself be a URL, and the
   * prose scan must not reach inside pill syntax to lift it.
   */
  fromPill: boolean;
}

/**
 * `parsePillTextToSnapshot` splits a pill's label off the prose at the last
 * whitespace before the bracket. When there is none — the pill sits at the
 * start of the message, which is the normal shape for a dropped reference —
 * it gives up and uses the PATH's basename as the label, leaving the real
 * label behind as ordinary text.
 *
 * `session` and `link` have a dedicated branch there; `workitem` and the
 * GitHub types do not, so their basename is a disambiguating timestamp
 * (`workitem://auth/AUTH-12/1700000000000`) or a bare issue number
 * (`.../pull/606`) — never something to render, and the leftover `AUTH-12` /
 * `org2AI/ORG2#` would otherwise be stranded in the prose next to a card that
 * repeats it.
 *
 * Rather than widen the shared parser's whitespace rule — which is load-
 * bearing for file pills and for CJK prose that runs straight into a pill —
 * the label is reclaimed HERE, and only when the leftover can be positively
 * identified: the segment must end without whitespace (so the parser really
 * did fall back rather than split cleanly), and the caller must confirm the
 * reclaimed token belongs to this pill.
 */
function reclaimPillLabel(
  segments: BodySegment[],
  confirm: (label: string) => boolean
): string | null {
  const previous = segments[segments.length - 1];
  if (!previous || previous.fromPill) return null;
  if (/\s$/u.test(previous.text)) return null;
  const match = /(\S+)$/u.exec(previous.text);
  if (!match || !confirm(match[1])) return null;
  previous.text = previous.text.slice(0, match.index);
  return match[1];
}

/** Last path segment, ignoring any `::<base64>` payload. */
function pillPathBasename(path: string): string {
  return path.split("::")[0].split("/").filter(Boolean).pop() ?? "";
}

export function splitChannelMessageBody(body: string): ChannelMessageBodyParts {
  const { parts } = parsePillTextToSnapshot(body);
  const references: ChannelMessageReference[] = [];
  const seen = new Set<string>();
  const segments: BodySegment[] = [];

  const collect = (reference: ChannelMessageReference) => {
    const key = channelReferenceKey(reference);
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  };

  const referenceFromPill = (
    attrs: Parameters<typeof serializePillNode>[0]
  ): ChannelMessageReference | null => {
    const label = attrs.fileName.trim();
    const basename = pillPathBasename(attrs.filePath);
    const usedPathAsLabel = label === basename;

    if (attrs.iconType === "session") {
      // Older channel posts serialized a teammate drag through the LOCAL
      // session-pill branch, producing `[session:orgii://cloud/…]`. Preserve
      // the full tuple before the local-id parser can truncate it to `orgii:`.
      const cloudReference = parseCloudSessionReference(attrs.filePath);
      if (cloudReference) {
        return {
          kind: "cloudSession",
          reference: cloudReference,
          title: label || undefined,
        };
      }
      const sessionId = sessionIdFromPillPath(attrs.filePath);
      if (!sessionId) return null;
      return { kind: "session", sessionId, title: label || sessionId };
    }

    if (attrs.iconType === "workitem") {
      const target = workItemFromPillPath(attrs.filePath);
      if (!target) return null;
      // A work-item path always ends in the timestamp that keeps two pills
      // for one item distinct, so an all-digit basename as the label is
      // conclusive proof the parser fell back.
      const reclaimed =
        usedPathAsLabel && /^\d+$/u.test(basename)
          ? reclaimPillLabel(segments, () => true)
          : null;
      return {
        kind: "workItem",
        ...target,
        title: reclaimed ?? (usedPathAsLabel ? target.shortId : label),
      };
    }

    // `pr`/`issue` come from the paste handler; a generic `link` pill can name
    // an issue too when the URL arrived by some other route.
    if (
      attrs.iconType === "pr" ||
      attrs.iconType === "issue" ||
      attrs.iconType === "link"
    ) {
      const reference = gitHubReferenceFromUrl(attrs.filePath);
      if (!reference) return null;
      // The card's label comes from the URL, so nothing needs reclaiming —
      // but the head of the stranded label does need removing, and only when
      // it provably reassembles into this reference's own display name.
      if (usedPathAsLabel) {
        reclaimPillLabel(
          segments,
          (head) => `${head}${label}` === reference.displayName
        );
      }
      return reference;
    }

    return null;
  };

  for (const part of parts) {
    if (part.kind === "newline") {
      segments.push({ text: "\n", fromPill: false });
      continue;
    }
    if (part.kind === "text") {
      segments.push({ text: part.text, fromPill: false });
      continue;
    }
    const reference = referenceFromPill(part.attrs);
    if (!reference) {
      segments.push({ text: serializePillNode(part.attrs), fromPill: true });
      continue;
    }
    collect(reference);
  }

  const text = segments
    .map((segment) =>
      segment.fromPill
        ? segment.text
        : liftReferencesFromProse(segment.text, collect)
    )
    .join("");

  // Pulling a reference out of the middle of a sentence leaves the gap it
  // used to fill; collapse it so the prose does not read with a hole in it.
  return { text: text.replace(/[^\S\n]{2,}/gu, " ").trim(), references };
}
