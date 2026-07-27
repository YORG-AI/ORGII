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
  FlaskConical,
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
  type IconProvider,
  getIconComponent,
  getIconProviderFromType,
  isIconProvider,
} from "@src/components/ModelIcon/config";

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

const canonicalBrandIconCache = new Map<IconProvider, LucideIcon>();

function resolveCanonicalBrandIcon(iconId: string): LucideIcon | undefined {
  const iconProvider = isIconProvider(iconId)
    ? iconId
    : getIconProviderFromType(iconId);
  if (iconProvider === "unknown") return undefined;

  const cached = canonicalBrandIconCache.get(iconProvider);
  if (cached) return cached;

  const IconComponent = getIconComponent(iconProvider);
  if (!IconComponent) return undefined;

  const BrandIcon = brandIcon(IconComponent, `${iconProvider}BrandIcon`);
  canonicalBrandIconCache.set(iconProvider, BrandIcon);
  return BrandIcon;
}

const ICON_MAP: Record<string, LucideIcon> = {
  omega: Omega,
  code: Code,
  monitor: Monitor,
  network: Network,
  brain: Brain,
  "chart-column": ChartColumn,
  "clipboard-list": ClipboardList,
  "drafting-compass": DraftingCompass,
  "flask-conical": FlaskConical,
  users: Users,
  user: User,
  "hand-metal": HandMetal,
  "mouse-pointer-click": MousePointerClick,
  sprout: Sprout,
  terminal: Terminal,
  bot: Bot,
};

const DEFAULT_ICON: LucideIcon = Bot;

export function resolveAgentIcon(
  iconId: string | undefined | null
): LucideIcon {
  if (!iconId) return DEFAULT_ICON;

  const canonicalBrandIcon = resolveCanonicalBrandIcon(iconId);
  if (canonicalBrandIcon) return canonicalBrandIcon;

  return ICON_MAP[iconId] ?? DEFAULT_ICON;
}
