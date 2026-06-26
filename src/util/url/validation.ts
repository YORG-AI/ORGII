const INVALID_AUTHORITY_CHARACTER_PATTERN = /[$`{}<>"'\\\s]/;
const IPV6_AUTHORITY_PATTERN = /^\[[0-9a-f:.]+\](?::\d+)?$/i;
function getRawAuthority(candidate: string): string | null {
  const authorityMatch = candidate.match(/^https?:\/\/([^/?#]*)/i);
  return authorityMatch?.[1] ?? null;
}

function hasInvalidAuthority(authority: string): boolean {
  if (!authority) return true;
  if (IPV6_AUTHORITY_PATTERN.test(authority)) return false;
  return INVALID_AUTHORITY_CHARACTER_PATTERN.test(authority);
}

function hasInvalidParsedHost(hostname: string): boolean {
  return !hostname || INVALID_AUTHORITY_CHARACTER_PATTERN.test(hostname);
}

function hasInvalidParsedPort(port: string): boolean {
  if (!port) return false;
  const portNumber = Number(port);
  return !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535;
}

export function normalizeHttpUrlCandidate(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const rawAuthority = getRawAuthority(trimmed);
  if (!rawAuthority || hasInvalidAuthority(rawAuthority)) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (hasInvalidParsedHost(parsed.hostname)) return null;
    if (hasInvalidParsedPort(parsed.port)) return null;

    return parsed.toString();
  } catch {
    return null;
  }
}
