/**
 * Chat Panel tab surface registry.
 *
 * The single source of truth mapping each `ChatPanelTabType` to how it renders.
 * Typing the constant as `ChatPanelTabSurfaceRegistry`
 * (`Record<ChatPanelTabType, …>`) makes the map exhaustive at compile time:
 * adding a new tab type is a type error until it has an entry — the same
 * guarantee the WorkStation `REGISTRY` provides.
 *
 * Session and Launchpad share the "chat column" (transcript / creators,
 * still contentMode-driven inside that column). Kanban and
 * terminals render in their own keep-alive layers. Every other surface renders
 * a dedicated, self-sufficient component that reads its tab payload directly.
 */
import {
  ChannelSurfaceRenderer,
  ExploreSurfaceRenderer,
  GitHubIssueSurfaceRenderer,
  GitHubPrSurfaceRenderer,
  OrganizationSurfaceRenderer,
  ProjectSurfaceRenderer,
  RunGroupSurfaceRenderer,
  RuntimeSurfaceRenderer,
  WorkItemSurfaceRenderer,
  WorkspaceSurfaceRenderer,
} from "./surfaceRenderers";
import type {
  ChatPanelTabSurfaceEntry,
  ChatPanelTabSurfaceRegistry,
} from "./types";

export const CHAT_PANEL_TAB_SURFACE_REGISTRY: ChatPanelTabSurfaceRegistry = {
  session: { render: "chat-column", debugLabel: "session" },
  "start-page": { render: "chat-column", debugLabel: "start-page" },
  runtime: {
    render: "component",
    Component: RuntimeSurfaceRenderer,
    debugLabel: "runtime",
  },
  "team-inbox": {
    render: "work-management",
    debugLabel: "team-inbox",
  },
  "work-management": {
    render: "work-management",
    debugLabel: "work-management",
  },
  terminal: { render: "terminal", debugLabel: "terminal" },
  workspace: {
    render: "component",
    Component: WorkspaceSurfaceRenderer,
    debugLabel: "workspace",
  },
  organization: {
    render: "component",
    Component: OrganizationSurfaceRenderer,
    debugLabel: "organization",
  },
  "work-item": {
    render: "component",
    Component: WorkItemSurfaceRenderer,
    debugLabel: "work-item",
  },
  "github-issue": {
    render: "component",
    Component: GitHubIssueSurfaceRenderer,
    debugLabel: "github-issue",
  },
  "github-pr": {
    render: "component",
    Component: GitHubPrSurfaceRenderer,
    debugLabel: "github-pr",
  },
  project: {
    render: "component",
    Component: ProjectSurfaceRenderer,
    debugLabel: "project",
  },
  explore: {
    render: "component",
    Component: ExploreSurfaceRenderer,
    debugLabel: "explore",
  },
  channel: {
    render: "component",
    Component: ChannelSurfaceRenderer,
    debugLabel: "channel",
  },
  "run-group": {
    render: "component",
    Component: RunGroupSurfaceRenderer,
    debugLabel: "run-group",
  },
};

/**
 * Resolve the surface entry for a tab type. Returns `null` for a value that is
 * not a known `ChatPanelTabType` (e.g. corrupted persisted state) so callers
 * can render an explicit placeholder rather than a misleading default surface.
 */
export function resolveChatPanelTabSurfaceEntry(
  type: string
): ChatPanelTabSurfaceEntry | null {
  return (
    (
      CHAT_PANEL_TAB_SURFACE_REGISTRY as Record<
        string,
        ChatPanelTabSurfaceEntry | undefined
      >
    )[type] ?? null
  );
}
