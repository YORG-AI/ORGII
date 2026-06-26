import {
  ArrowBigUp,
  ArrowDown,
  ArrowUp,
  ChevronUp,
  Command,
  CornerDownLeft,
  Delete,
  Option,
} from "lucide-react";
import { type ReactNode, memo } from "react";

export const KEYBOARD_SHORTCUT_VARIANT = {
  default: "default",
  workStation: "workStation",
  dropdown: "dropdown",
  spotlightFooter: "spotlightFooter",
} as const;

export type KeyboardShortcutVariant =
  (typeof KEYBOARD_SHORTCUT_VARIANT)[keyof typeof KEYBOARD_SHORTCUT_VARIANT];

export interface KeyboardShortcutProps {
  shortcut: string;
  className?: string;
  variant?: KeyboardShortcutVariant;
}

export interface KeyboardShortcutTooltipRow {
  label: ReactNode;
  shortcut: string;
}

export interface KeyboardShortcutTooltipContentProps {
  label?: ReactNode;
  shortcut?: string;
  rows?: KeyboardShortcutTooltipRow[];
  noShortcut?: boolean;
  className?: string;
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /\bMacintosh\b|\bMac OS X\b/.test(navigator.userAgent);

type ModifierType = "cmd" | "shift" | "option" | "ctrl";
type SpecialKeyType =
  | "arrowUp"
  | "arrowDown"
  | "enter"
  | "backspace"
  | "esc"
  | "tab";

type KeyToken =
  | { type: "modifier"; modifier: ModifierType }
  | { type: "special"; special: SpecialKeyType }
  | { type: "key"; label: string };

function normalizeModifier(key: string): ModifierType | null {
  const lower = key.toLowerCase();
  if (
    lower === "cmd" ||
    lower === "command" ||
    lower === "⌘" ||
    lower === "meta"
  ) {
    return "cmd";
  }
  if (lower === "shift" || lower === "⇧") {
    return "shift";
  }
  if (
    lower === "option" ||
    lower === "opt" ||
    lower === "alt" ||
    lower === "⌥"
  ) {
    return "option";
  }
  if (lower === "ctrl" || lower === "control" || lower === "⌃") {
    return "ctrl";
  }
  return null;
}

function normalizeSpecial(key: string): SpecialKeyType | null {
  const lower = key.toLowerCase();
  if (lower === "up" || lower === "arrowup" || lower === "↑") return "arrowUp";
  if (lower === "down" || lower === "arrowdown" || lower === "↓") {
    return "arrowDown";
  }
  if (
    lower === "enter" ||
    lower === "return" ||
    lower === "↵" ||
    lower === "⏎"
  ) {
    return "enter";
  }
  if (lower === "backspace" || lower === "delete" || lower === "⌫") {
    return "backspace";
  }
  if (lower === "esc" || lower === "escape") return "esc";
  if (lower === "tab" || lower === "⇥") return "tab";
  return null;
}

function tokenizePart(part: string): KeyToken {
  const modifier = normalizeModifier(part);
  if (modifier) return { type: "modifier", modifier };
  const special = normalizeSpecial(part);
  if (special) return { type: "special", special };
  return { type: "key", label: part.toUpperCase() };
}

function parseShortcut(shortcut: string): KeyToken[] {
  const tokens: KeyToken[] = [];

  if (shortcut.includes("+")) {
    const parts = shortcut.split("+").map((key) => key.trim());
    let hasQueuedPlusKey = false;

    for (const part of parts) {
      if (part === "") {
        hasQueuedPlusKey = true;
        continue;
      }

      if (hasQueuedPlusKey) {
        tokens.push({ type: "key", label: "+" });
        hasQueuedPlusKey = false;
      }

      tokens.push(tokenizePart(part));
    }

    if (hasQueuedPlusKey) {
      tokens.push({ type: "key", label: "+" });
    }

    return tokens;
  }

  // Whitespace-separated chord, e.g. "esc" or "enter" or "up down". Multi-char
  // specials (esc, enter, backspace) only resolve when they are a standalone
  // token — falling back to per-character parsing for legacy callers like
  // "⌘N" or "⇧⌘F".
  const trimmed = shortcut.trim();
  const whitespaceParts = trimmed.split(/\s+/).filter(Boolean);
  if (whitespaceParts.length > 1 || normalizeSpecial(trimmed)) {
    for (const part of whitespaceParts) {
      tokens.push(tokenizePart(part));
    }
    return tokens;
  }

  let index = 0;
  while (index < shortcut.length) {
    const char = shortcut[index];
    tokens.push(tokenizePart(char));
    index++;
  }

  return tokens;
}

function ModifierKey({
  modifier,
  iconSize,
}: {
  modifier: ModifierType;
  iconSize: number;
}) {
  const iconProps = { size: iconSize, strokeWidth: 2 };

  switch (modifier) {
    case "cmd":
      return <Command {...iconProps} />;
    case "shift":
      return <ArrowBigUp {...iconProps} />;
    case "option":
      return <Option {...iconProps} />;
    case "ctrl":
      return IS_MAC ? <ChevronUp {...iconProps} /> : <span>Ctrl</span>;
  }
}

function SpecialKey({
  special,
  iconSize,
}: {
  special: SpecialKeyType;
  iconSize: number;
}) {
  const iconProps = { size: iconSize, strokeWidth: 2 };

  switch (special) {
    case "arrowUp":
      return <ArrowUp {...iconProps} />;
    case "arrowDown":
      return <ArrowDown {...iconProps} />;
    case "enter":
      return <CornerDownLeft {...iconProps} />;
    case "backspace":
      return <Delete {...iconProps} />;
    case "esc":
      return <span className="leading-none">esc</span>;
    case "tab":
      // Unicode horizontal-tab glyph. macOS shows this on Tab keys; keeps
      // the chip narrow and avoids translating the word "Tab".
      return <span className="leading-none">⇥</span>;
  }
}

// All variants render a chip with the glyph centered both axes. Icon glyphs
// (modifier + single-char special) get a fixed 18×18 square so ⌘/⇧/⌥/⌃ stay
// uniform with letter keys; multi-character text labels (`esc`, `⇥`) keep
// horizontal padding so they don't get clipped. Per-variant differences are
// limited to background shade and text color.
//
// Letter chips bump to 13px / semibold so a glyph like "N" matches the
// optical weight of the adjacent 13px Lucide icons (otherwise "⌘N" reads
// as a big symbol next to a tiny letter). `leading-none` + flex centering
// keeps the cap-height glyph perfectly centered in the 18×18 box.
const KEY_CAP_BASE =
  "inline-flex h-[18px] shrink-0 items-center justify-center rounded font-medium leading-none";
const KEY_CAP_SQUARE = "w-[18px] text-[13px] font-semibold";
const KEY_CAP_TEXT = "min-w-[18px] px-1 text-[12px]";
const KEY_CAP_ICON_SIZE = 13;

const KEY_CAP_STYLES: Record<
  KeyboardShortcutVariant,
  { kbd: string; iconSize: number }
> = {
  default: {
    kbd: `${KEY_CAP_BASE} bg-fill-2 text-text-2`,
    iconSize: KEY_CAP_ICON_SIZE,
  },
  workStation: {
    kbd: `${KEY_CAP_BASE} bg-fill-2 text-text-2`,
    iconSize: KEY_CAP_ICON_SIZE,
  },
  dropdown: {
    kbd: `${KEY_CAP_BASE} bg-fill-2 text-text-2`,
    iconSize: KEY_CAP_ICON_SIZE,
  },
  // Used on the Spotlight footer hint strip — the surrounding Glass
  // panel is already `fill-2`, so pills bump one shade up to `fill-3` to
  // stay readable against it.
  spotlightFooter: {
    kbd: `${KEY_CAP_BASE} bg-fill-3 text-text-2`,
    iconSize: KEY_CAP_ICON_SIZE,
  },
};

export const KeyboardShortcut = memo<KeyboardShortcutProps>(
  ({
    shortcut,
    className = "",
    variant = KEYBOARD_SHORTCUT_VARIANT.default,
  }) => {
    const tokens = parseShortcut(shortcut);
    const cap = KEY_CAP_STYLES[variant];

    return (
      <div className={`flex items-center gap-0.5 ${className}`}>
        {tokens.map((token, index) => {
          const isTextCtrl =
            token.type === "modifier" && token.modifier === "ctrl" && !IS_MAC;
          const isSquareGlyph =
            (token.type === "modifier" && !isTextCtrl) ||
            (token.type === "special" &&
              token.special !== "esc" &&
              token.special !== "tab") ||
            (token.type === "key" && token.label.length === 1);
          const shapeClass = isSquareGlyph ? KEY_CAP_SQUARE : KEY_CAP_TEXT;
          return (
            <kbd key={index} className={`${cap.kbd} ${shapeClass}`}>
              {token.type === "modifier" && (
                <ModifierKey
                  modifier={token.modifier}
                  iconSize={cap.iconSize}
                />
              )}
              {token.type === "special" && (
                <SpecialKey special={token.special} iconSize={cap.iconSize} />
              )}
              {token.type === "key" && token.label}
            </kbd>
          );
        })}
      </div>
    );
  }
);

KeyboardShortcut.displayName = "KeyboardShortcut";

export const KeyboardShortcutTooltipContent =
  memo<KeyboardShortcutTooltipContentProps>(
    ({ label, shortcut, rows, noShortcut = false, className = "" }) => {
      const resolvedRows =
        rows ?? (label && shortcut && !noShortcut ? [{ label, shortcut }] : []);

      if (resolvedRows.length === 1) {
        const [row] = resolvedRows;
        return (
          <div
            className={`flex items-center gap-3 whitespace-nowrap ${className}`}
          >
            <span>{row.label}</span>
            <KeyboardShortcut
              shortcut={row.shortcut}
              variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
            />
          </div>
        );
      }

      if (resolvedRows.length > 1) {
        return (
          <div className={`flex flex-col gap-2 whitespace-nowrap ${className}`}>
            {resolvedRows.map((row) => (
              <div
                key={`${row.label}-${row.shortcut}`}
                className="flex items-center justify-between gap-3"
              >
                <span>{row.label}</span>
                <KeyboardShortcut
                  shortcut={row.shortcut}
                  variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
                />
              </div>
            ))}
          </div>
        );
      }

      if (label) {
        return (
          <span className={`whitespace-nowrap ${className}`}>{label}</span>
        );
      }

      return null;
    }
  );

KeyboardShortcutTooltipContent.displayName = "KeyboardShortcutTooltipContent";

export default KeyboardShortcut;
