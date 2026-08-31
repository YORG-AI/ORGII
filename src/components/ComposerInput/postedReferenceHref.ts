import { type PillType, readPillText } from "@src/config/pillTokens";

const INTERNAL_COMPOSER_REFERENCE_HREF =
  /^(?:branch|browser|dom-element|folder|issue|paste|pr|project|repo|skill|terminal|workitem):\/\//iu;

/** Safe read-side links projected from ORGII's serialized composer grammar. */
export function isInternalComposerReferenceHref(value: string): boolean {
  return INTERNAL_COMPOSER_REFERENCE_HREF.test(value);
}

export function isSafePostedReferenceHref(value: string): boolean {
  if (isInternalComposerReferenceHref(value)) return true;
  if (safeHttpUrl(value)) return true;
  return !/^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function decodedEmbeddedContext(path: string): string | null {
  const separator = path.indexOf("::");
  if (separator < 0 || typeof atob !== "function") return null;
  try {
    return decodeURIComponent(atob(path.slice(separator + 2)));
  } catch {
    return null;
  }
}

function cachedGitHubHref(
  path: string,
  pillType: PillType,
  embeddedContext?: string
): string | null {
  if (pillType !== "pr" && pillType !== "issue") return null;
  const stored =
    embeddedContext ??
    (typeof window === "undefined" ? undefined : readPillText(path));
  if (!stored) return null;
  try {
    const payload = JSON.parse(stored) as Record<string, unknown>;
    return safeHttpUrl(pillType === "pr" ? payload.prUrl : payload.issueUrl);
  } catch {
    return null;
  }
}

function browserHref(path: string): string | null {
  if (!path.startsWith("browser://")) return null;
  const payload = path.slice("browser://".length);
  const timestampStart = payload.lastIndexOf("/");
  const candidate =
    timestampStart > 0 && /^\d{12,17}$/u.test(payload.slice(timestampStart + 1))
      ? payload.slice(0, timestampStart)
      : payload;
  return safeHttpUrl(candidate);
}

/**
 * Resolve a persisted composer token to the destination used by its ordinary
 * read-side link. The token remains the fallback identity when it has no web
 * destination (for example, a work-item or terminal reference).
 */
export function resolvePostedReferenceHref(
  path: string,
  pillType: PillType,
  embeddedContext?: string
): string {
  const withoutContext = path.split("::")[0];
  return (
    safeHttpUrl(withoutContext) ??
    cachedGitHubHref(
      withoutContext,
      pillType,
      embeddedContext ?? decodedEmbeddedContext(path) ?? undefined
    ) ??
    browserHref(withoutContext) ??
    withoutContext
  );
}
