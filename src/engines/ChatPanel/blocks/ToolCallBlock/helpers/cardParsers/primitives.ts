/**
 * Shared primitive coercion helpers used by the card parsers.
 */
export function parseObjectFromContent(
  result: Record<string, unknown>
): Record<string, unknown> | null {
  const content =
    (typeof result.content === "string" ? result.content : null) ??
    (typeof result.output === "string" ? result.output : null) ??
    (typeof result.observation === "string" ? result.observation : null);
  if (!content) return null;

  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.substring(0, max)}…` : text;
}
