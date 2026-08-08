/**
 * Agent desktop-permission and desktop-config API.
 *
 * The automation-rule wrappers that used to live here (list/add/update/
 * remove rule, engine status, webhook fire) were removed in Phase 1 of the
 * Orgtrack PM protocol migration — they had no production caller and their
 * TS payload shape was incompatible with the Rust `AutomationRule` schema.
 */
import { invokeTauri } from "@src/util/platform/tauri/init";

import type { DesktopPermission } from "./types";

export async function checkDesktopPermissions(): Promise<DesktopPermission[]> {
  return invokeTauri<DesktopPermission[]>("agent_check_desktop_permissions");
}

export async function requestDesktopPermissions(
  permission: string
): Promise<{ triggered: boolean; permissions: DesktopPermission[] }> {
  return invokeTauri<{ triggered: boolean; permissions: DesktopPermission[] }>(
    "agent_request_desktop_permissions",
    { permission }
  );
}

// ── Desktop sub-gates ───────────────────────────────────────────────

export interface DesktopConfig {
  hideBeforeAction: boolean;
  antiDetection: boolean;
  humanInputProfile: boolean;
  escapeAbort: boolean;
}

export async function getDesktopConfig(): Promise<DesktopConfig> {
  return invokeTauri<DesktopConfig>("agent_get_desktop_config");
}

export async function setDesktopConfig(config: DesktopConfig): Promise<void> {
  return invokeTauri<void>("agent_set_desktop_config", { config });
}
