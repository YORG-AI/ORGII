import { invoke } from "@tauri-apps/api/core";

/**
 * Backend plan for reopening an imported external session in the vendor's
 * own app via a per-session deep link (`claude://resume?session=…`,
 * `codex://threads/…`). Mirrors `ExternalHistoryAppOpenPlanWire` in
 * `src-tauri/src/orgtrack/history_commands/scan.rs` (camelCase JSON).
 *
 * The link itself is informational here — {@link externalHistoryOpenInApp}
 * rebuilds it in Rust rather than accepting a URL from the webview, so the
 * frontend never gets to name what the OS opens.
 */
export interface ExternalHistoryAppOpenPlan {
  /** Imported-history source id (`claude_code` / `codex_app`). */
  source: string;
  /** Name of the app the deep link opens, for labels and tooltips. */
  appDisplayName: string;
  /** The deep link the backend would fire. */
  deepLink: string;
  /** The session id the app itself addresses. */
  nativeSessionId: string;
  /**
   * Whether the source transcript behind the import is still on disk. Both
   * apps resolve the conversation from it, so a missing transcript means the
   * link lands on an error state inside the app.
   */
  sourceAvailable: boolean;
}

/**
 * `null` when the session is unknown to the imported-history cache, is a
 * subagent child, or its source has no verified per-session app deep link
 * (everything but Claude Code and Codex today).
 */
export async function externalHistoryAppOpenPlan(
  sessionId: string
): Promise<ExternalHistoryAppOpenPlan | null> {
  return invoke<ExternalHistoryAppOpenPlan | null>(
    "external_history_app_open_plan",
    { sessionId }
  );
}

/**
 * Open the imported session in the app that owns it. Rejects when the
 * session has no deep link or the OS refuses the URL; a link that routes
 * nowhere cannot be detected, so callers must not treat resolution as proof
 * the app surfaced the conversation.
 */
export async function externalHistoryOpenInApp(
  sessionId: string
): Promise<void> {
  return invoke<void>("external_history_open_in_app", { sessionId });
}
