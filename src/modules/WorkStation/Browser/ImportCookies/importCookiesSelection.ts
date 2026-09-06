/**
 * Pure selection helpers for the cookie-import checklist.
 *
 * The site list comes from the backend already sorted (most cookies first) with
 * a safe `defaultSelected` per row (money / mail / SSO start unchecked). These
 * helpers manage the user's checkbox state on top of that.
 */
import type {
  CookieImportPreview,
  CookieSiteCategory,
  CookieSiteGroup,
} from "@src/api/tauri/browserCookies";

/** Categories whose rows start unchecked, in the order we explain them. */
export const CAUTION_CATEGORIES: readonly CookieSiteCategory[] = [
  "banking",
  "email",
  "sso",
];

/** Domains checked by default for a fresh preview. */
export function initialSelectedDomains(
  preview: CookieImportPreview
): Set<string> {
  return new Set(
    preview.sites
      .filter((site) => site.defaultSelected)
      .map((site) => site.domain)
  );
}

/** Filter preview rows by domain, ignoring case and surrounding whitespace. */
export function filterSitesByDomain(
  sites: readonly CookieSiteGroup[],
  query: string
): readonly CookieSiteGroup[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return sites;
  return sites.filter((site) =>
    site.domain.toLowerCase().includes(normalizedQuery)
  );
}

/** Toggle one domain, returning a new set (never mutates the input). */
export function toggleDomain(
  selected: ReadonlySet<string>,
  domain: string
): Set<string> {
  const next = new Set(selected);
  if (next.has(domain)) {
    next.delete(domain);
  } else {
    next.add(domain);
  }
  return next;
}

/** Select all sites, or clear the selection entirely. */
export function setAllDomains(
  sites: readonly CookieSiteGroup[],
  selected: boolean
): Set<string> {
  return selected ? new Set(sites.map((site) => site.domain)) : new Set();
}

/** Total cookies across the currently selected sites. */
export function selectedCookieCount(
  sites: readonly CookieSiteGroup[],
  selected: ReadonlySet<string>
): number {
  return sites.reduce(
    (total, site) =>
      selected.has(site.domain) ? total + site.cookieCount : total,
    0
  );
}

/** Tri-state for a "select all" control. */
export type SelectAllState = "all" | "none" | "some";

export function selectAllState(
  sites: readonly CookieSiteGroup[],
  selected: ReadonlySet<string>
): SelectAllState {
  if (sites.length === 0 || selected.size === 0) return "none";
  if (selected.size >= sites.length) return "all";
  return "some";
}
