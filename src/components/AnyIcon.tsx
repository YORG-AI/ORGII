/**
 * Safe renderer for an icon whose shape is not known at the call site.
 *
 * Most icons in this app are hugeicons glyph data (`IconSvgElement`) rendered
 * directly with `<HugeiconsIcon icon={Search} />`. Those call sites do NOT need
 * this component and should keep using `HugeiconsIcon`.
 *
 * Use `AnyIcon` where the icon arrives dynamically — from a registry lookup, a
 * prop, a ternary, a menu-item model. Three things can show up there:
 *
 *   - hugeicons glyph data            -> rendered via `HugeiconsIcon`
 *   - a hand-authored SVG component   -> brand marks (GitHub, MCP) that no icon
 *                                        set provides
 *   - `""`                            -> the deliberate "no icon here" spelling
 *                                        used by item models (renders nothing)
 *
 * ...and a fourth: nothing at all. `HugeiconsIcon` does `[...icon]` internally,
 * so an `undefined` icon throws
 * "Spread syntax requires ...iterable[Symbol.iterator] to be a function"
 * and takes down the entire render tree — a whole screen lost to one missing
 * icon, with nothing in the message identifying which. `Record` lookups make
 * this easy to hit: `noUncheckedIndexedAccess` is off, so `ICONS[key]` is typed
 * as present while returning `undefined` for any key that is not.
 *
 * This component degrades that to a missing icon: it renders `null`, and in dev
 * it warns once with whatever context the caller supplied via `data-icon`.
 */
import React, { type ComponentType } from "react";

import { createLogger } from "@src/hooks/logger";
import { HugeiconsIcon, type IconSvgElement } from "@src/icons";

const log = createLogger("AnyIcon");

/**
 * An icon that is either hugeicons glyph data or a component (brand mark,
 * hand-authored SVG). Use this for registry values and props that can hold
 * both shapes — and render them through `AnyIcon`, never `HugeiconsIcon`
 * directly (a component crashes its internal `[...icon]` spread).
 */
export type RenderableIcon =
  | IconSvgElement
  | ComponentType<Record<string, unknown>>;

/**
 * A `RenderableIcon`, or a string.
 *
 * The only meaningful string is `""` — several item models (notably the
 * spotlight items) spell "no icon" that way, and `AnyIcon` renders it as
 * nothing. Non-empty strings are NOT icons anymore: the icon-font pathway
 * died with the lucide→hugeicons migration (name-keyed registries such as
 * `ICON_NAME_MAP` / `WORKSTATION_TAB_ICONS` resolve their strings to glyph
 * data BEFORE rendering). `AnyIcon` renders an unexpected non-empty string
 * as nothing, with a dev-only warning.
 */
export type AnyIconSource = string | RenderableIcon;

export interface AnyIconProps {
  icon: AnyIconSource | undefined | null;
  size?: number;
  strokeWidth?: number;
  className?: string;
  [key: string]: unknown;
}

const warned = new Set<string>();

/**
 * True for anything React can render as a component.
 *
 * `typeof v === "function"` is NOT enough: `forwardRef()` and `memo()` return
 * OBJECTS carrying a `$$typeof` symbol, and `config/agentIcons.tsx` wraps every
 * brand mark in `forwardRef` before casting it to IconSvgElement. Testing only
 * for a function silently dropped every model icon in the sidebar.
 *
 * `react-is` exports exactly this predicate but ships no type declarations, so
 * it is inlined rather than adding a `@types/react-is` dependency for one check.
 */
function isComponentLike(value: unknown): boolean {
  if (typeof value === "function") return true;
  return typeof value === "object" && value !== null && "$$typeof" in value;
}

const AnyIcon: React.FC<AnyIconProps> = ({
  icon,
  size,
  strokeWidth,
  className,
  ...rest
}) => {
  // An empty string is how several call sites (notably the spotlight item
  // model) spell "no icon".
  // `""` is deliberate ("no icon here"), so it is silent; a missing icon is a
  // mistake worth surfacing.
  if (icon === "") return null;

  if (icon === undefined || icon === null) {
    if (process.env.NODE_ENV !== "production") {
      const key = String(rest["data-icon"] ?? "unknown");
      if (!warned.has(key)) {
        warned.add(key);

        log.warn(
          `no icon resolved (data-icon="${key}"). Rendering nothing ` +
            `instead of throwing. Check the registry or prop feeding this site.`
        );
      }
    }
    return null;
  }

  // A NON-empty string is not an icon: the icon-font pathway is gone, and
  // every name-keyed registry resolves its strings to glyph data before
  // rendering. Degrade like an unresolved icon rather than emitting a dead
  // <i> tag that still takes layout space.
  if (typeof icon === "string") {
    if (process.env.NODE_ENV !== "production") {
      log.warn(
        `got the string "${icon}" instead of an icon. Icon-font ` +
          `classes are no longer rendered; resolve names to glyph data ` +
          `before the render boundary.`
      );
    }
    return null;
  }

  // Glyph data is an array; check it BEFORE treating the value as a component.
  if (Array.isArray(icon)) {
    return (
      <HugeiconsIcon
        icon={icon}
        size={size}
        strokeWidth={strokeWidth}
        className={className}
        {...rest}
      />
    );
  }

  // A hand-authored SVG component — brand marks like the model/agent icons.
  // `typeof icon === "function"` is NOT sufficient here: `forwardRef()` and
  // `memo()` return OBJECTS, and `config/agentIcons.tsx` wraps every brand mark
  // in `forwardRef` before casting it to IconSvgElement. Testing for a function
  // silently dropped every model icon in the sidebar.
  if (isComponentLike(icon)) {
    return React.createElement(icon as ComponentType<Record<string, unknown>>, {
      size,
      strokeWidth,
      className,
      ...rest,
    });
  }

  if (process.env.NODE_ENV !== "production") {
    log.warn("icon is neither glyph data nor a component", icon);
  }
  return null;
};

export default AnyIcon;
