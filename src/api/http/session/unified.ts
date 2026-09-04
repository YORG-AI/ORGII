/**
 * Unified Session API
 *
 * The "source=market" URL flag is the hosted-key entry point.
 */

export function isHostedFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get("source") === "market";
}

export function isHostedFromSearchParams(
  searchParams: URLSearchParams
): boolean {
  return searchParams.get("source") === "market";
}

export const unifiedSessionApi = {
  isHostedFromUrl,
  isHostedFromSearchParams,
};

export default unifiedSessionApi;
