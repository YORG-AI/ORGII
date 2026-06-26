/**
 * Agent Icon Registry
 *
 * Maps Lucide icon slugs (from backend `iconId`) to React components.
 * Backend stores standard Lucide kebab-case names (e.g. "omega", "code", "brain")
 * matching lucide.dev slugs — same convention as the tools system.
 *
 * Only icons actually used by agents need to be registered here.
 * When adding a new agent in Rust, use an existing Lucide slug for icon_id
 * and add it here if not already present.
 *
 * ## Brand-icon adapter
 *
 * For sessions that should render a vendor brand mark (e.g. Cursor IDE
 * history rows), we wrap the brand `<svg>` in a Lucide-shaped adapter so
 * the existing `HoverAnimatedIcon` consumer (which expects
 * `(size, strokeWidth, color, className) → ReactNode`) renders the brand
 * at the right pixel size. Brand SVGs use `viewBox` + `currentColor` and
 * ignore `strokeWidth` (they're filled, not stroked).
 */
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Brain,
  ChartColumn,
  ClipboardList,
  Code,
  DraftingCompass,
  HandMetal,
  Monitor,
  MousePointerClick,
  Network,
  Omega,
  Sprout,
  Terminal,
  User,
  Users,
} from "lucide-react";
import React, { forwardRef } from "react";

import {
  ClaudeCodeIcon,
  CodeBuddyIcon,
  CodexIcon,
  CopilotIcon,
  CursorIcon,
  GeminiIcon,
  KimiIcon,
  KiroIcon,
  OpenCodeIcon,
} from "@src/assets/modelIcons/agentIcons";

/**
 * Wrap a brand `<svg>` (React.FC<SVGProps>) so it satisfies the
 * `LucideIcon` shape expected by `HoverAnimatedIcon`. We only need to
 * translate Lucide's `size` prop into raw SVG `width` / `height`; brand
 * SVGs use `currentColor` so `color` and `className` flow through
 * unchanged. `strokeWidth` is intentionally ignored — brand marks are
 * filled, not stroked, and applying it would be a no-op at best.
 */
function brandIcon(
  Brand: React.FC<React.SVGProps<SVGSVGElement>>,
  displayName: string
): LucideIcon {
  const Wrapped = forwardRef<
    SVGSVGElement,
    React.SVGProps<SVGSVGElement> & { size?: number | string }
  >(({ size = 24, ...rest }, ref) => (
    <Brand width={size} height={size} ref={ref} {...rest} />
  ));
  Wrapped.displayName = displayName;
  return Wrapped as unknown as LucideIcon;
}

// Vendor brand marks. Keys here MUST match the `IconProvider` slugs returned
// by `getIconProvider(modelType)` in `src/components/ModelIcon/config.ts`,
// because `resolveSessionRowIcon` looks them up by that slug for CLI sessions.
// If a CLI agent type has no brand registered here, the resolver falls back
// to the prefix-based generic icon (`Terminal`) which is fine.
const CursorBrandIcon = brandIcon(CursorIcon, "CursorBrandIcon");
const ClaudeCodeBrandIcon = brandIcon(ClaudeCodeIcon, "ClaudeCodeBrandIcon");
const CodexBrandIcon = brandIcon(CodexIcon, "CodexBrandIcon");
const CopilotBrandIcon = brandIcon(CopilotIcon, "CopilotBrandIcon");
const GeminiBrandIcon = brandIcon(GeminiIcon, "GeminiBrandIcon");
const KiroBrandIcon = brandIcon(KiroIcon, "KiroBrandIcon");
const KimiBrandIcon = brandIcon(KimiIcon, "KimiBrandIcon");
const OpenCodeBrandIcon = brandIcon(OpenCodeIcon, "OpenCodeBrandIcon");
const WorkBuddyBrandIcon = brandIcon(CodeBuddyIcon, "WorkBuddyBrandIcon");

const ICON_MAP: Record<string, LucideIcon> = {
  omega: Omega,
  code: Code,
  monitor: Monitor,
  network: Network,
  brain: Brain,
  "chart-column": ChartColumn,
  "clipboard-list": ClipboardList,
  "drafting-compass": DraftingCompass,
  users: Users,
  user: User,
  "hand-metal": HandMetal,
  "mouse-pointer-click": MousePointerClick,
  sprout: Sprout,
  terminal: Terminal,
  bot: Bot,
  cursor: CursorBrandIcon,
  claude_code: ClaudeCodeBrandIcon,
  codex: CodexBrandIcon,
  copilot: CopilotBrandIcon,
  gemini: GeminiBrandIcon,
  kiro: KiroBrandIcon,
  kimi: KimiBrandIcon,
  opencode: OpenCodeBrandIcon,
  workbuddy: WorkBuddyBrandIcon,
};

const DEFAULT_ICON: LucideIcon = Bot;

export function resolveAgentIcon(
  iconId: string | undefined | null
): LucideIcon {
  if (iconId && ICON_MAP[iconId]) return ICON_MAP[iconId];
  return DEFAULT_ICON;
}
