export interface HttpUrlPillReference {
  url: string;
  displayName: string;
}

/**
 * Parse a clipboard value only when the entire trimmed payload is one safe,
 * round-trippable HTTP(S) URL. The serialized pill grammar uses square
 * brackets as delimiters, so bracket-bearing URLs stay as plain text.
 */
export function parseHttpUrlPill(value: string): HttpUrlPillReference | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    /\s/.test(trimmed) ||
    trimmed.includes("[") ||
    trimmed.includes("]")
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;

  const hostname = parsed.hostname.toLowerCase();
  const isLocalhost =
    hostname === "localhost" || hostname.endsWith(".localhost");
  const isIpLiteral =
    hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname);
  if (!isLocalhost && !isIpLiteral && !hostname.includes(".")) return null;

  const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return {
    url: trimmed,
    displayName: suffix === "/" ? parsed.host : `${parsed.host}${suffix}`,
  };
}
