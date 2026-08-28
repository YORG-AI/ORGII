/**
 * Agent Icon Registry
 *
 * Resolves agent icon ids to renderable icon sources:
 *
 * - Slug ids (from backend `iconId`) map to hugeicons glyph data
 *   (`IconSvgElement` arrays, rendered via `HugeiconsIcon`).
 * - Provider ids (claude, codex, cursor, …) resolve to brand-mark
 *   components via the `brandIcon` adapter (e.g. for Cursor IDE history
 *   rows).
 *
 * The backend contract is unchanged: `icon_id` values are still
 * Lucide-style kebab-case slugs (e.g. "omega", "code", "brain") — the
 * same convention as the tools system. Only the frontend rendering moved
 * to hugeicons.
 *
 * Because the registry hands out a mix of glyph data and components,
 * consumers must render the result through `AnyIcon` — see the
 * `AgentIconSource` doc comment below for the shape distinction.
 *
 * Only icons actually used by agents need to be registered here. When
 * adding a new agent in Rust, use an existing Lucide-style slug for
 * `icon_id` and add it here if not already present.
 */
import React, { forwardRef } from "react";

import { type RenderableIcon } from "@src/components/AnyIcon";
import {
  type IconProvider,
  getIconComponent,
  getIconProviderFromType,
  isIconProvider,
} from "@src/components/ModelIcon/config";
import {
  AiGenerativeIcon,
  AiProgrammingIcon,
  BookEditIcon,
  BotIcon,
  BrainIcon,
  ChartColumnIcon,
  CodeIcon,
  ComputerTerminal01Icon,
  CursorPointer02Icon,
  HierarchyCircle01Icon,
  type IconSvgElement,
  MonitorIcon,
  Plant01Icon,
  RecordIcon,
  Shaka01Icon,
  TestTubeIcon,
  UserIcon,
  UserMultipleIcon,
} from "@src/icons";

/**
 * What the agent-icon registry actually hands out: hugeicons glyph data
 * for slug ids, or a brand-mark COMPONENT for provider ids (claude,
 * codex, …). The two shapes are NOT interchangeable — glyph data must be
 * rendered via `HugeiconsIcon`, components via JSX — so consumers must
 * render through `AnyIcon`, which dispatches on the runtime shape.
 * Never pass this union to `<HugeiconsIcon icon={…}>` directly: a brand
 * component crashes its internal `[...icon]` spread.
 */
export type AgentIconSource = RenderableIcon;

/**
 * Wrap a brand `<svg>` (React.FC<SVGProps>) into a size-aware component.
 * We only need to translate the icon-style `size` prop into raw SVG
 * `width` / `height`; brand SVGs use `currentColor` so `color` and
 * `className` flow through unchanged. `strokeWidth` is intentionally
 * ignored — brand marks are filled, not stroked, and applying it would
 * be a no-op at best.
 */
function brandIcon(
  Brand: React.FC<React.SVGProps<SVGSVGElement>>,
  displayName: string
): React.ComponentType<Record<string, unknown>> {
  const Wrapped = forwardRef<
    SVGSVGElement,
    React.SVGProps<SVGSVGElement> & { size?: number | string }
  >(({ size = 24, ...rest }, ref) => (
    <Brand width={size} height={size} ref={ref} {...rest} />
  ));
  Wrapped.displayName = displayName;
  // The wrapper spreads arbitrary props onto the SVG at runtime; the cast
  // narrows only the prop bag, never the data-vs-component distinction.
  return Wrapped as unknown as React.ComponentType<Record<string, unknown>>;
}

const canonicalBrandIconCache = new Map<
  IconProvider,
  React.ComponentType<Record<string, unknown>>
>();

function resolveCanonicalBrandIcon(
  iconId: string
): React.ComponentType<Record<string, unknown>> | undefined {
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

const ICON_MAP: Record<string, IconSvgElement> = {
  omega: RecordIcon,
  "ai-programming": AiProgrammingIcon,
  code: CodeIcon,
  monitor: MonitorIcon,
  network: HierarchyCircle01Icon,
  brain: BrainIcon,
  "chart-column": ChartColumnIcon,
  "clipboard-list": BookEditIcon,
  "drafting-compass": AiGenerativeIcon,
  "flask-conical": TestTubeIcon,
  users: UserMultipleIcon,
  user: UserIcon,
  "hand-metal": Shaka01Icon,
  "mouse-pointer-click": CursorPointer02Icon,
  sprout: Plant01Icon,
  terminal: ComputerTerminal01Icon,
  bot: BotIcon,
};

const DEFAULT_ICON: IconSvgElement = BotIcon;

export function resolveAgentIcon(
  iconId: string | undefined | null
): AgentIconSource {
  if (!iconId) return DEFAULT_ICON;

  const canonicalBrandIcon = resolveCanonicalBrandIcon(iconId);
  if (canonicalBrandIcon) return canonicalBrandIcon;

  return ICON_MAP[iconId] ?? DEFAULT_ICON;
}
