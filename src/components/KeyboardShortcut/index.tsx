import { type ReactNode, memo } from "react";

import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  CornerDownLeftIcon,
  HugeiconsIcon,
} from "@src/icons";

export const KEYBOARD_SHORTCUT_VARIANT = {
  default: "default",
  workStation: "workStation",
  dropdown: "dropdown",
  spotlightFooter: "spotlightFooter",
} as const;

export type KeyboardShortcutVariant =
  (typeof KEYBOARD_SHORTCUT_VARIANT)[keyof typeof KEYBOARD_SHORTCUT_VARIANT];

export type KeyboardShortcutSize = "default" | "sm";

export interface KeyboardShortcutProps {
  shortcut: string;
  className?: string;
  variant?: KeyboardShortcutVariant;
  size?: KeyboardShortcutSize;
}

interface KeyboardShortcutTooltipRow {
  label: ReactNode;
  shortcut: string;
}

interface KeyboardShortcutTooltipContentProps {
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

function ModifierKey({ modifier }: { modifier: ModifierType }) {
  const character = {
    cmd: "⌘",
    shift: "⇧",
    option: "⌥",
    ctrl: IS_MAC ? "⌃" : "Ctrl",
  }[modifier];

  return <span className="leading-none">{character}</span>;
}

function SpecialKey({
  special,
  iconSize,
}: {
  special: SpecialKeyType;
  iconSize: number;
}) {
  if (special === "arrowUp" || special === "arrowDown") {
    return (
      <HugeiconsIcon
        icon={special === "arrowUp" ? ArrowUp02Icon : ArrowDown02Icon}
        size={iconSize}
        strokeWidth={2}
        data-icon={special === "arrowUp" ? "arrow-up" : "arrow-down"}
      />
    );
  }

  if (special === "enter") {
    return (
      <HugeiconsIcon
        icon={CornerDownLeftIcon}
        size={iconSize}
        strokeWidth={2}
        data-icon="corner-down-left"
      />
    );
  }

  const character = {
    backspace: "⌫",
    esc: "esc",
    tab: "⇥",
  }[special];

  return <span className="leading-none">{character}</span>;
}

// A shortcut chord is one joined pill, matching the compact presentation used
// by Codex. Individual tokens only own their typography; the shared `kbd`
// owns the background, height, padding, and rounded capsule shape.
const KEY_CAP_BASE =
  "inline-flex shrink-0 items-center justify-center rounded-full font-normal leading-none";
const KEY_TOKEN_BASE =
  "inline-flex h-full items-center justify-center align-middle";

const KEY_CAP_SIZES: Record<
  KeyboardShortcutSize,
  { cap: string; glyph: string; text: string; iconSize: number }
> = {
  default: {
    cap: "h-[18px] px-1.5",
    glyph: "text-[13px]",
    text: "text-[12px]",
    iconSize: 13,
  },
  sm: {
    cap: "h-4 px-1",
    glyph: "text-[11px]",
    text: "text-[10px]",
    iconSize: 11,
  },
};

const KEY_CAP_STYLES: Record<KeyboardShortcutVariant, { kbd: string }> = {
  default: {
    kbd: "bg-fill-2 text-text-2",
  },
  workStation: {
    kbd: "bg-fill-2 text-text-2",
  },
  dropdown: {
    kbd: "bg-fill-2 text-text-2",
  },
  // Used on the Spotlight footer hint strip — the surrounding surface
  // panel is already `fill-2`, so pills bump one shade up to `fill-3` to
  // stay readable against it.
  spotlightFooter: {
    kbd: "bg-fill-3 text-text-2",
  },
};

export const KeyboardShortcut = memo<KeyboardShortcutProps>(
  ({
    shortcut,
    className = "",
    variant = KEYBOARD_SHORTCUT_VARIANT.default,
    size = "default",
  }) => {
    const tokens = parseShortcut(shortcut);
    const cap = KEY_CAP_STYLES[variant];
    const capSize = KEY_CAP_SIZES[size];
    const isArrowPair =
      tokens.length === 2 &&
      tokens.every(
        (token) =>
          token.type === "special" &&
          (token.special === "arrowUp" || token.special === "arrowDown")
      );

    return (
      <div className={`flex items-center ${className}`}>
        <kbd
          className={`${KEY_CAP_BASE} ${capSize.cap} ${
            isArrowPair ? "gap-0" : "gap-0.5"
          } ${cap.kbd}`}
        >
          {tokens.map((token, index) => {
            const isTextToken =
              (token.type === "modifier" &&
                token.modifier === "ctrl" &&
                !IS_MAC) ||
              (token.type === "special" &&
                (token.special === "esc" || token.special === "tab")) ||
              (token.type === "key" && token.label.length > 1);
            return (
              <span
                key={index}
                className={`${KEY_TOKEN_BASE} ${
                  isTextToken ? capSize.text : capSize.glyph
                }`}
              >
                {token.type === "modifier" && (
                  <ModifierKey modifier={token.modifier} />
                )}
                {token.type === "special" && (
                  <SpecialKey
                    special={token.special}
                    iconSize={capSize.iconSize}
                  />
                )}
                {token.type === "key" && token.label}
              </span>
            );
          })}
        </kbd>
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
            className={`flex max-w-full min-w-0 items-center gap-3 ${className}`}
          >
            <span className="min-w-0 wrap-break-word">{row.label}</span>
            <KeyboardShortcut
              shortcut={row.shortcut}
              variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
            />
          </div>
        );
      }

      if (resolvedRows.length > 1) {
        return (
          <div
            className={`flex max-w-full min-w-0 flex-col gap-2 ${className}`}
          >
            {resolvedRows.map((row) => (
              <div
                key={`${row.label}-${row.shortcut}`}
                className="flex min-w-0 items-center justify-between gap-3"
              >
                <span className="min-w-0 wrap-break-word">{row.label}</span>
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
          <span
            className={`inline-block max-w-full wrap-break-word ${className}`}
          >
            {label}
          </span>
        );
      }

      return null;
    }
  );

KeyboardShortcutTooltipContent.displayName = "KeyboardShortcutTooltipContent";

export default KeyboardShortcut;
