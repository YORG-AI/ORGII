/**
 * Window identity for multi-window gating.
 *
 * The app now opens secondary OS windows (detached session windows,
 * `app-window-session-<id>`), and every window runs the same bundle through
 * the same `RootLayout`/`AppBootstrap` hook stack. App-wide singletons —
 * deep-link navigation, the updater, git auto-fetch, cloud sync — must run
 * in exactly one window, and "which window am I" is the gate.
 *
 * `getCurrentWindow().label` is synchronous in Tauri v2, so the label is
 * resolved once at first call and cached for the document's lifetime (a
 * window's label can never change).
 *
 * Outside Tauri (browser dev, unit tests) there is only one document, so it
 * plays every role: `isMainAppWindow()` returns true there. That keeps
 * existing unit tests and browser dev behavior unchanged.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

export const MAIN_WINDOW_LABEL = "main";

/**
 * Deliberately NOT imported from `./index`: that barrel runs
 * `patchTauriInternals()` at module scope, which arms a self-rescheduling
 * real-timer retry chain (10ms→1s). Pulling it into a module graph makes any
 * fake-timer test that loads this file inherit a stray timeout in its fake
 * clock (observed as a flaky `getTimerCount()` off-by-one). This module must
 * stay side-effect-free, so it detects Tauri directly off the injected
 * internals instead. (`isTauriDesktop()` in the barrel is also hardcoded to
 * `true`, so it never actually guarded anything.)
 */
function hasTauriInternals(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

let cachedLabel: string | null | undefined;

/** The current Tauri window's label, or null outside Tauri. Cached. */
export function getCurrentWindowLabel(): string | null {
  if (cachedLabel !== undefined) return cachedLabel;
  if (!hasTauriInternals()) {
    cachedLabel = null;
    return cachedLabel;
  }
  try {
    cachedLabel = getCurrentWindow().label;
  } catch {
    cachedLabel = null;
  }
  return cachedLabel;
}

/**
 * Whether this document should own app-wide singleton behavior.
 * True in the Tauri main window and in non-Tauri environments
 * (browser dev / unit tests), where the single document is "the app".
 */
export function isMainAppWindow(): boolean {
  const label = getCurrentWindowLabel();
  return label === null || label === MAIN_WINDOW_LABEL;
}

/** Test hook: clear the cached label so a test can vary the environment. */
export function resetWindowIdentityForTests(): void {
  cachedLabel = undefined;
}
