/**
 * Import cookies (saved logins) from other installed browsers into the app's
 * built-in browser.
 *
 * Thin wrappers over the `browser::cookie_import` Tauri commands. Decrypted
 * cookie values never cross this boundary: the preview returns per-site counts
 * only, and the import happens entirely in Rust.
 *
 * Platform support mirrors the backend — macOS: Chromium family + Firefox;
 * Windows/Linux: Firefox only.
 */
import { open as shellOpen } from "@tauri-apps/plugin-shell";

import { invokeTauri } from "@src/util/platform/tauri/init";

/** Browser engine family of a source. */
export type CookieSourceKind = "chromium" | "firefox" | "safari";

/**
 * Why a discovered source cannot be read yet. Safari's store sits in a folder
 * macOS gates behind Full Disk Access, so it is listed with this reason
 * instead of being hidden.
 */
export type CookieSourceUnavailableReason = "needs_full_disk_access";

/** macOS pane where the user grants the app Full Disk Access. */
const FULL_DISK_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/**
 * Coarse site category used only to choose a default-checked state. Sites that
 * handle money, mail, or single sign-on start unchecked.
 */
export type CookieSiteCategory = "general" | "email" | "banking" | "sso";

/** One importable browser profile found on this machine. */
export interface CookieImportSource {
  /** Opaque id for the follow-up preview / import calls. */
  id: string;
  kind: CookieSourceKind;
  /** Machine id for the browser family, e.g. `chrome`, `firefox`. */
  browserId: string;
  /** Display name, e.g. `Google Chrome`. */
  browserLabel: string;
  /** Display name of the profile, e.g. `Personal · you@example.com`. */
  profileLabel: string | null;
  /** Set when the source exists but cannot be read yet. */
  unavailableReason: CookieSourceUnavailableReason | null;
}

/** One site (registrable domain) worth of cookies in a preview. */
export interface CookieSiteGroup {
  /** Registrable domain, e.g. `github.com`. */
  domain: string;
  cookieCount: number;
  category: CookieSiteCategory;
  /** Whether the row starts checked. */
  defaultSelected: boolean;
  /** A few concrete host names under the domain, for display. */
  sampleHosts: string[];
}

/** Result of previewing a source. */
export interface CookieImportPreview {
  sourceId: string;
  totalCookies: number;
  sites: CookieSiteGroup[];
  /** Non-fatal note, e.g. some values could not be decrypted. */
  warning: string | null;
}

/** Outcome of an import. */
export interface CookieImportResult {
  requestedDomains: number;
  importedCookies: number;
  skippedCookies: number;
}

/** Open the macOS Full Disk Access pane so the user can allow the app. */
export function openFullDiskAccessSettings(): Promise<void> {
  return shellOpen(FULL_DISK_ACCESS_SETTINGS_URL);
}

/** List importable browser profiles found on this machine. */
export function listCookieImportSources(): Promise<CookieImportSource[]> {
  return invokeTauri<CookieImportSource[]>("list_cookie_import_sources");
}

/**
 * Preview the sites a source holds logins for. For a Chromium source this
 * triggers the OS keychain consent prompt the first time.
 */
export function previewCookieImport(
  sourceId: string
): Promise<CookieImportPreview> {
  return invokeTauri<CookieImportPreview>("preview_cookie_import", {
    sourceId,
  });
}

/** Import the cookies for the chosen sites into the app's browser store. */
export function importBrowserCookies(
  sourceId: string,
  domains: string[]
): Promise<CookieImportResult> {
  return invokeTauri<CookieImportResult>("import_browser_cookies", {
    sourceId,
    domains,
  });
}
