/**
 * Browser webview mount window policy.
 *
 * Only the active browser session plus the `MAX_WARM_INACTIVE_WEBVIEWS` most
 * recently active ones keep their `BrowserSessionWebview` mounted. Everything
 * else unmounts, which is what actually destroys the native webview:
 * `useInlineWebview` calls `destroy()` from its unmount cleanup only, so a
 * session that merely goes inactive is not released — it is parked offscreen
 * at `(-10000, -10000)` sized `1x1` and keeps running (see
 * `useInlineWebviewNativeVisibility`). A parked webview is a full live page:
 * its own WebContent process on macOS, holding page JS, timers, and media.
 *
 * `recentIdWindow.ts` already named browser-tab webviews as an intended
 * consumer; until this module, the terminal pane window was its only caller.
 *
 * A window rather than a blanket unmount-on-deactivate, because the tradeoff
 * differs from terminals. A terminal remounts losslessly from Rust
 * (`attach_pty_stream` snapshot plus the serialized client buffer). A webview
 * has no such restore: unmounting drops in-page state — scroll position, form
 * input, media playback — and the tab reloads from `session.url` on return.
 * Keeping a few recent tabs warm preserves that for the ones a user actually
 * flips between, which is the same tradeoff a browser makes when it discards
 * background tabs.
 *
 * The warm count is smaller than the terminal window's because a WKWebView is
 * far more expensive than an xterm instance.
 */
import { pushRecentId } from "@src/util/core/recentIdWindow";

/**
 * How many *inactive* browser sessions keep a live webview in addition to the
 * active one.
 */
export const MAX_WARM_INACTIVE_WEBVIEWS = 3;

/**
 * Push `activeId` to the front of the most-recently-active list, bounded to
 * the active slot plus `maxWarm` inactive slots. Returns the same array
 * reference when nothing changes so React state updates stay no-ops.
 */
export function pushRecentWebviewId(
  prev: readonly string[],
  activeId: string,
  maxWarm: number = MAX_WARM_INACTIVE_WEBVIEWS
): readonly string[] {
  return pushRecentId(prev, activeId, maxWarm + 1);
}

/**
 * Select which sessions keep their webview mounted: the active one always,
 * plus any still inside the recent window.
 *
 * A session that has never been activated is not in the recent window and so
 * is not mounted — which costs nothing, because `BrowserSessionWebview` defers
 * native creation until a session is actually shown. Restored-from-storage
 * tabs therefore stay free until first visit, exactly as before.
 */
export function selectMountedBrowserSessions<T extends { id: string }>(
  sessions: readonly T[],
  activeSessionId: string,
  recentWebviewIds: readonly string[]
): T[] {
  const warm = new Set(recentWebviewIds);
  return sessions.filter(
    (session) => session.id === activeSessionId || warm.has(session.id)
  );
}
