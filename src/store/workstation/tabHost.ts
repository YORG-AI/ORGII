/**
 * Maps a `WorkStationTabType` (or `WorkStationTabCategory`) onto the host
 * surface the AppShell uses to decide which content area should render the
 * active tab.
 *
 * The host projection is a UI-routing concern, not a registry concern, which
 * is why it lives outside `tabs/atoms.ts`. The workstation uses a single flat
 * tab pool (`mainPane`), so dispatch to a content renderer is derived from the
 * active tab's type rather than from a separate per-host pane bucket.
 */
import type {
  WorkStationTab,
  WorkStationTabCategory,
  WorkStationTabType,
} from "./tabs/types";

export type WorkstationTabHost = "code" | "browser" | "data" | "project";

/**
 * Map a tab category onto its content host. Categories are the canonical
 * discriminator already used by the renderer registry.
 *
 * Code-editor-family categories (file, git, terminal, search, settings, lint,
 * ai-impact, preview, subagent, chat, explorer, ops-control, launchpad) all
 * project onto `"code"` because they render inside the Code Editor surface.
 */
export function categoryToTabHost(
  category: WorkStationTabCategory | undefined
): WorkstationTabHost {
  switch (category) {
    case "browser":
      return "browser";
    case "db-table":
    case "db-query":
    case "db-schema":
      return "data";
    case "project":
      return "project";
    default:
      return "code";
  }
}

/**
 * Map a tab type onto its host. Convenience for callers that have the raw
 * `tab.type` literal rather than the category. Mirrors `categoryToTabHost` via
 * the tab-type → category default mapping in `tabFactory.ts`.
 */
export function tabTypeToTabHost(type: WorkStationTabType): WorkstationTabHost {
  switch (type) {
    case "browser-session":
    case "token-category":
    case "devtools":
      return "browser";
    case "table":
    case "query":
    case "schema":
    case "add-connection":
      return "data";
    case "project-dashboard":
    case "project-work-items":
    case "project-linear-projects":
    case "project-linear-work-items":
    case "project-settings":
    case "project-org":
    case "project-org-settings":
    case "project-git-sync-review":
    case "session-journey":
    case "project-workitems":
    case "workItem-detail":
      return "project";
    default:
      return "code";
  }
}

/** Convenience: derive host from a tab. */
export function tabToHost(tab: WorkStationTab): WorkstationTabHost {
  return tab.category
    ? categoryToTabHost(tab.category)
    : tabTypeToTabHost(tab.type);
}
