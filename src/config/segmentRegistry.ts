/**
 * Segment Registry — single source of truth for URL segment labels + icons.
 *
 * Extracted from mainAppPaths.ts to keep that file under the config line limit.
 * All consumers should import from mainAppPaths.ts (which re-exports everything
 * here) so import paths are stable.
 */
import { type RenderableIcon } from "@src/components/AnyIcon";
import {
  Activity01Icon as Activity,
  HierarchyCircle01Icon as AgentTeams,
  DeliveryBox01Icon as Box,
  FirstBracketIcon as Braces,
  InternetIcon as Chromium,
  CloudIcon as Cloud,
  CodeXmlIcon as Code,
  CursorMagicSelection04Icon as ComputerUse,
  ContentWritingIcon as ContentWriting,
  ContrastIcon as Contrast,
  DatabaseIcon as Database,
  FolderGitTwoIcon as FolderGit2,
  FolderOpenIcon as FolderOpen,
  LegalHammerIcon as Hammer,
  InboxIcon as Inbox,
  Key01Icon as Key,
  McpServerIcon,
  HierarchyCircle01Icon as Network,
  PackageIcon as Package,
  PaintBrush01Icon as Paintbrush,
  TwentyFourHoursClockIcon as RoutineClock,
  RulerDimensionLineIcon as RulerDimensionLine,
  Settings02Icon as Settings2,
  Settings01Icon as SettingsIcon,
  SecurityCheckIcon as ShieldCheck,
  SparklesIcon as Sparkles,
  ToolboxIcon as Toolbox,
  UnplugIcon as Unplug,
  UserRoundCogIcon as UserRoundCog,
} from "@src/icons";

// ============================================================================
// Registry Entry Type
// ============================================================================

/**
 * Registry entry for every URL segment that can appear in a MainApp route.
 * `labelKey` is a namespaced i18n key (`"<ns>:<key>"`).
 * `icon` is the shared visual identity for that segment, reused across
 * Agent Teams sidebar, Settings sidebar, Global Spotlight, breadcrumbs, etc.
 */
export interface SegmentRegistryEntry {
  labelKey: string;
  /**
   * Either hugeicons glyph data or a brand component (e.g. the MCP logo).
   * Render through `AnyIcon` — never `HugeiconsIcon` directly.
   */
  icon: RenderableIcon;
}

// ============================================================================
// Registry
// ============================================================================

export const SEGMENT_REGISTRY: Record<string, SegmentRegistryEntry> = {
  // settings top-level tabs — Settings / Agent / Org. The Settings tab
  // flat-merges classic app-settings sections and integrations categories
  // under one URL namespace (/settings/<id>).
  "core-settings": {
    labelKey: "navigation:labels.coreSettings",
    icon: SettingsIcon,
  },
  agents: { labelKey: "navigation:labels.agentOrgs", icon: AgentTeams },
  org: { labelKey: "settings:sections.agentOrg", icon: Network },
  orgs: { labelKey: "settings:sections.agentOrg", icon: Network },
  clis: { labelKey: "integrations:agentOrgs.tableTabs.clis", icon: Code },

  // integrations categories (match sidebar labels)
  models: { labelKey: "integrations:categories.models", icon: Key },
  myRoles: {
    labelKey: "integrations:categories.myRoles",
    icon: UserRoundCog,
  },
  "my-roles": {
    labelKey: "integrations:categories.myRoles",
    icon: UserRoundCog,
  },
  housekeeper: {
    labelKey: "integrations:categories.housekeeper",
    icon: Sparkles,
  },
  tools: { labelKey: "integrations:categories.tools", icon: Hammer },
  computerUse: {
    labelKey: "integrations:categories.computerUse",
    icon: ComputerUse,
  },
  connections: {
    labelKey: "integrations:categories.connections",
    icon: Unplug,
  },
  git: { labelKey: "integrations:categories.git", icon: FolderGit2 },
  databases: { labelKey: "integrations:categories.databases", icon: Database },
  // Internal category key for the Rules / Memory / Evolution surface,
  // plus its public URL slug (see RULES_MEMORY_EVOLUTION_URL_SEGMENT in
  // mainAppPaths/integrations). Both entries resolve to the same label.
  rulesMemoryEvolution: {
    labelKey: "integrations:categories.rulesMemoryEvolution",
    icon: RulerDimensionLine,
  },
  "rules-memory-and-evolution": {
    labelKey: "integrations:categories.rulesMemoryEvolution",
    icon: RulerDimensionLine,
  },
  routines: {
    labelKey: "integrations:categories.routines",
    icon: RoutineClock,
  },
  devtools: { labelKey: "integrations:categories.devtools", icon: Braces },

  // Skills, MCPs, Plugins
  externalSkillsets: {
    labelKey: "integrations:categories.externalSkillsets",
    icon: Package,
  },
  "skills-mcps-plugins": {
    labelKey: "integrations:categories.externalSkillsets",
    icon: Package,
  },
  // mcp / skills (legacy segment keys + per-agent labels)
  mcp: {
    labelKey: "integrations:toolsArea.mcp",
    icon: McpServerIcon,
  },
  skills: { labelKey: "integrations:categories.skills", icon: Toolbox },
  // settings root — the unified surface header
  settings: { labelKey: "navigation:labels.settings", icon: SettingsIcon },

  // settings subpages
  "editor-appearance": {
    labelKey: "settings:editor.codeEditorAppearanceTitle",
    icon: Paintbrush,
  },

  // settings sections
  general: { labelKey: "settings:sections.general", icon: Settings2 },
  collaboration: {
    labelKey: "settings:sections.collaboration",
    icon: Cloud,
  },
  appearance: { labelKey: "settings:sections.appearance", icon: Contrast },
  editor: { labelKey: "settings:sections.editorAndWorkspace", icon: Code },
  security: { labelKey: "settings:sections.security", icon: ShieldCheck },
  update: { labelKey: "settings:sections.appUpdate", icon: Package },
  monitor: { labelKey: "settings:sections.monitor", icon: Activity },

  // work-station roots
  workstation: { labelKey: "navigation:labels.workspace", icon: FolderOpen },
  code: { labelKey: "navigation:labels.codeEditor", icon: ContentWriting },
  browser: { labelKey: "navigation:labels.browser", icon: Chromium },
  project: {
    labelKey: "navigation:labels.projectManager",
    icon: Box,
  },
  inbox: { labelKey: "navigation:labels.inbox", icon: Inbox },
  "select-repo": {
    labelKey: "navigation:routes.selectProject",
    icon: FolderOpen,
  },
};

// ============================================================================
// Breadcrumb Utilities
// ============================================================================

/**
 * Segments that should never appear in a user-visible breadcrumb.
 * These are route-structural artifacts — the next meaningful segment
 * carries the user-visible label.
 */
const BREADCRUMB_HIDDEN_SEGMENTS = new Set<string>([
  "orgii",
  "app",
  "subpage",
  "integrations",
  "agent-orgs",
]);

/** Returns the icon for a given URL segment, or `null`. */
export function getSegmentIcon(segment: string): RenderableIcon | null {
  return SEGMENT_REGISTRY[segment]?.icon ?? null;
}

/** Returns the canonical i18n key for a URL segment, or `null`. */
export function getSegmentLabelKey(segment: string): string | null {
  return SEGMENT_REGISTRY[segment]?.labelKey ?? null;
}

/**
 * Derive the icon for a full pathname — returns the icon of the deepest
 * visible segment (Spotlight uses this so entries match sidebar glyphs).
 */
export function getPathIcon(pathname: string): RenderableIcon | null {
  const cleaned = pathname.split("?")[0].split("#")[0];
  const parts = cleaned.split("/").filter((s) => s.length > 0);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (BREADCRUMB_HIDDEN_SEGMENTS.has(parts[i])) continue;
    const icon = SEGMENT_REGISTRY[parts[i]]?.icon;
    if (icon) return icon;
  }
  return null;
}

/**
 * Derive an ordered list of i18n keys from a path, skipping hidden segments
 * and segments with no registered label.
 */
export function deriveBreadcrumbKeys(pathname: string): string[] {
  const cleaned = pathname.split("?")[0].split("#")[0];
  const parts = cleaned.split("/").filter((s) => s.length > 0);
  const keys: string[] = [];
  for (const part of parts) {
    if (BREADCRUMB_HIDDEN_SEGMENTS.has(part)) continue;
    const entry = SEGMENT_REGISTRY[part];
    if (entry) keys.push(entry.labelKey);
  }
  return keys;
}

const BREADCRUMB_JOINER = " \u203a ";

/**
 * Render a breadcrumb string like `Agents › Integrations › MCP`.
 * Callers pass their own translate fn (usually `t` from react-i18next).
 */
export function buildBreadcrumbString(
  pathname: string,
  translate: (key: string) => string
): string {
  return deriveBreadcrumbKeys(pathname)
    .map((key) => translate(key))
    .join(BREADCRUMB_JOINER);
}

/**
 * Derive both the leaf label and the full breadcrumb path from a URL.
 * Used by Spotlight items so `label` and `description` never diverge.
 */
export function buildBreadcrumbLabels(
  pathname: string,
  translate: (key: string) => string
): { label: string; path: string } {
  const keys = deriveBreadcrumbKeys(pathname);
  if (keys.length === 0) return { label: pathname, path: "" };
  const translated = keys.map((key) => translate(key));
  return {
    label: translated[translated.length - 1],
    path: translated.join(BREADCRUMB_JOINER),
  };
}
