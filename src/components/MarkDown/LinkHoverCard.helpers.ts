import { normalizeHttpUrlCandidate } from "@src/util/url/validation";

export interface HttpLinkPreview {
  url: string;
  host: string;
  displayUrl: string;
}

const DISPLAY_URL_MAX_LENGTH = 88;

function formatDisplayUrl(url: string): string {
  const withoutProtocol = url.replace(/^https?:\/\//i, "");
  const compact = withoutProtocol.endsWith("/")
    ? withoutProtocol.slice(0, -1)
    : withoutProtocol;
  if (compact.length <= DISPLAY_URL_MAX_LENGTH) return compact;
  return `${compact.slice(0, DISPLAY_URL_MAX_LENGTH - 1).trimEnd()}…`;
}

export function getHttpLinkPreview(candidate: string): HttpLinkPreview | null {
  const url = normalizeHttpUrlCandidate(candidate);
  if (!url) return null;

  const parsed = new URL(url);
  return {
    url,
    host: parsed.host.replace(/^www\./i, ""),
    displayUrl: formatDisplayUrl(url),
  };
}
