/**
 * Sidebar Route Helpers
 *
 * Maps routes to sidebar IDs via simple prefix matching.
 * Both sidebars share identical behaviour (macOS-only, resizable, collapsible)
 * so no per-sidebar config object is needed — just the ID for layout decisions.
 */
import { ROUTES } from "./routes";

export type SidebarId = "settings-sidebar" | "session-sidebar";

const SIDEBAR_PREFIXES: [SidebarId, string][] = [
  ["settings-sidebar", ROUTES.app.settings.path],
  ["session-sidebar", ROUTES.workStation.base.path],
];

/** Return the sidebar ID for a route, or null if the route has no sidebar. */
export function getSidebarId(pathname: string): SidebarId | null {
  for (const [id, prefix] of SIDEBAR_PREFIXES) {
    if (pathname.startsWith(prefix)) return id;
  }
  return null;
}
