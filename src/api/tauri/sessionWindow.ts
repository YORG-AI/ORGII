/**
 * Detached session windows.
 *
 * `open_session_window` builds (or focuses) a native OS window whose label is
 * `app-window-session-<sessionId>` — inside the `app-window-*` capability
 * glob, so the window gets the full default permission set — and loads the
 * standalone `/orgii/app/session/<sessionId>` route. Window chrome (macOS
 * traffic lights, Win11 corners) is applied on the Rust side; a plain
 * `new WebviewWindow()` from JS cannot reach those post-build native calls.
 */
import { invokeTauri } from "@src/util/platform/tauri/init";

/** Create or focus the detached window for one session. Resolves to the
 *  window label. Rejects when the id is unsafe for a window label or the
 *  platform window build fails — callers keep their tab in that case. */
export async function openSessionWindow(
  sessionId: string,
  title?: string
): Promise<string> {
  return invokeTauri<string>("open_session_window", { sessionId, title });
}
