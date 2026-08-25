/**
 * Read-side projection for a posted discussion-channel message.
 *
 * Sessions are attachments, so local and cloud session references are lifted
 * into cards. Every other serialized composer reference is projected into a
 * normal Markdown link; the persisted body and its agent-facing pill syntax
 * remain unchanged.
 */
import { parseGitHubPillUrl } from "@src/components/ComposerInput/githubUrl";
import { resolvePostedReferenceHref } from "@src/components/ComposerInput/postedReferenceHref";
import { projectMarkdownSessionReferences } from "@src/components/MarkDown/sessionReferenceProjection";
import type { PillType } from "@src/config/pillTokens";
import { parsePillTextToSnapshot } from "@src/engines/ChatPanel/InputArea/utils/pillContentParser";
import type { CloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

export interface ChannelSessionReference {
  kind: "session";
  sessionId: string;
  title: string;
}

export interface ChannelCloudSessionReference {
  kind: "cloudSession";
  reference: CloudSessionReference;
  title?: string;
}

export type ChannelMessageReference =
  | ChannelSessionReference
  | ChannelCloudSessionReference;

export interface ChannelMessageBodyParts {
  text: string;
  references: ChannelMessageReference[];
}

export function channelReferenceKey(
  reference: ChannelMessageReference
): string {
  if (reference.kind === "session") return `session:${reference.sessionId}`;
  const { orgId, ownerUserId, sourceSessionId } = reference.reference;
  return `cloudSession:${orgId}/${ownerUserId}/${sourceSessionId}`;
}

interface BodySegment {
  text: string;
  fromPill: boolean;
}

function reclaimPillLabel(
  segments: BodySegment[],
  confirm: (label: string) => boolean
): string | null {
  const previous = segments[segments.length - 1];
  if (!previous || previous.fromPill || /\s$/u.test(previous.text)) return null;
  const match = /(\S+)$/u.exec(previous.text);
  if (!match || !confirm(match[1])) return null;
  previous.text = previous.text.slice(0, match.index);
  return match[1];
}

function workItemIdentity(path: string): { shortId: string } | null {
  const withoutScheme = path.startsWith("workitem://")
    ? path.slice("workitem://".length)
    : path;
  const [, shortId] = withoutScheme.split("::")[0].split("/");
  return shortId ? { shortId } : null;
}

function pathWithoutEmbeddedContext(path: string, pillType: PillType): string {
  if (
    pillType === "browser" ||
    pillType === "dom-element" ||
    pillType === "dom-component" ||
    pillType === "issue" ||
    pillType === "paste" ||
    pillType === "pr" ||
    pillType === "terminal" ||
    pillType === "workitem"
  ) {
    return path.split("::")[0];
  }
  return path;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\]/gu, "\\]");
}

function markdownDestination(value: string): string {
  return /[\s()]/u.test(value) ? `<${value}>` : value;
}

function pillAsMarkdownLink(
  attrs: {
    fileName: string;
    filePath: string;
    iconType: PillType;
  },
  segments: BodySegment[]
): string {
  const tokenPath = pathWithoutEmbeddedContext(attrs.filePath, attrs.iconType);
  const destination = resolvePostedReferenceHref(
    attrs.filePath,
    attrs.iconType
  );
  const basename = destination.split("/").filter(Boolean).pop() ?? "";
  const usedPathAsLabel = attrs.fileName.trim() === basename;
  let label = attrs.fileName.trim() || basename || destination;

  if (attrs.iconType === "workitem") {
    const identity = workItemIdentity(destination);
    const reclaimed =
      identity && usedPathAsLabel && /^\d+$/u.test(basename)
        ? reclaimPillLabel(segments, () => true)
        : null;
    label = reclaimed ?? identity?.shortId ?? label;
  } else {
    const github = parseGitHubPillUrl(destination);
    if (github) {
      const internalGitHubToken =
        /^pr:\/\//u.test(tokenPath) || /^issue:\/\//u.test(tokenPath);
      const reclaimed =
        usedPathAsLabel && internalGitHubToken
          ? reclaimPillLabel(segments, () => true)
          : null;
      if (!reclaimed && usedPathAsLabel) {
        reclaimPillLabel(
          segments,
          (head) => `${head}${label}` === github.displayName
        );
      }
      label = reclaimed ?? github.displayName;
    }
  }

  return `[${escapeMarkdownLabel(label)}](${markdownDestination(destination)})`;
}

export function splitChannelMessageBody(body: string): ChannelMessageBodyParts {
  const projected = projectMarkdownSessionReferences(body);
  const references: ChannelMessageReference[] = projected.references.map(
    (reference) =>
      reference.kind === "cloud"
        ? {
            kind: "cloudSession" as const,
            reference: reference.reference,
            title: reference.title,
          }
        : {
            kind: "session" as const,
            sessionId: reference.sessionId,
            title: reference.title,
          }
  );
  const { parts } = parsePillTextToSnapshot(projected.text);
  const segments: BodySegment[] = [];

  for (const part of parts) {
    if (part.kind === "newline") {
      segments.push({ text: "\n", fromPill: false });
    } else if (part.kind === "text") {
      segments.push({ text: part.text, fromPill: false });
    } else {
      const iconType = part.attrs.iconType;
      if (!iconType || iconType === "member") {
        segments.push({ text: part.attrs.fileName, fromPill: false });
        continue;
      }
      segments.push({
        text: pillAsMarkdownLink({ ...part.attrs, iconType }, segments),
        fromPill: true,
      });
    }
  }

  return {
    text: segments
      .map((segment) => segment.text)
      .join("")
      .replace(/[^\S\n]{2,}/gu, " ")
      .trim(),
    references,
  };
}
