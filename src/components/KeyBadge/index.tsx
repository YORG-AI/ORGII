/**
 * KeyBadge - Renders keyboard shortcuts with icon glyphs for modifier keys
 *
 * Used in: Toolbar search bar, Settings Shortcuts page
 * Replaces text symbols (⌘, ⌥, etc.) with icon glyphs for consistency.
 */
import React from "react";

import {
  ArrowDown02Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  ArrowUpBigIcon,
  CommandIcon,
  CornerDownLeftIcon,
  Delete01Icon,
  HugeiconsIcon,
  OptionIcon,
  SaturnIcon,
} from "@src/icons";

const MAC_MODIFIERS = new Set(["⌘", "⌥", "⇧", "⌃"]);
const DEFAULT_ICON_SIZE = 14;

/**
 * Render special keys with icon glyphs
 */
function renderKeyContent(
  key: string,
  iconSize: number = DEFAULT_ICON_SIZE
): React.ReactNode {
  const normalizedKey = key.toLowerCase();

  switch (normalizedKey) {
    case "↑":
    case "arrowup":
      return (
        <HugeiconsIcon
          icon={ArrowUp02Icon}
          data-icon="arrow-up"
          size={iconSize}
        />
      );
    case "↓":
    case "arrowdown":
      return (
        <HugeiconsIcon
          icon={ArrowDown02Icon}
          data-icon="arrow-down"
          size={iconSize}
        />
      );
    case "←":
    case "arrowleft":
      return (
        <HugeiconsIcon
          icon={ArrowLeft02Icon}
          data-icon="arrow-left"
          size={iconSize}
        />
      );
    case "→":
    case "arrowright":
      return (
        <HugeiconsIcon
          icon={ArrowRight02Icon}
          data-icon="arrow-right"
          size={iconSize}
        />
      );
    case "enter":
    case "return":
    case "↵":
    case "⏎":
    case "⮐":
      return (
        <HugeiconsIcon
          icon={CornerDownLeftIcon}
          data-icon="corner-down-left"
          size={iconSize}
        />
      );
    case "⌫":
    case "backspace":
    case "delete":
      return (
        <HugeiconsIcon icon={Delete01Icon} data-icon="delete" size={iconSize} />
      );
    case "space":
      return (
        <HugeiconsIcon icon={SaturnIcon} data-icon="space" size={iconSize} />
      );
    case "⌘":
    case "command":
    case "cmd":
      return (
        <HugeiconsIcon icon={CommandIcon} data-icon="command" size={iconSize} />
      );
    case "⌥":
    case "option":
    case "opt":
    case "alt":
      return (
        <HugeiconsIcon icon={OptionIcon} data-icon="option" size={iconSize} />
      );
    case "esc":
    case "escape":
      return "Esc";
    case "tab":
      return "Tab";
    case "⇧":
    case "shift":
      return (
        <HugeiconsIcon
          icon={ArrowUpBigIcon}
          data-icon="arrow-big-up"
          size={iconSize}
        />
      );
    case "⌃":
    case "control":
    case "ctrl":
      return (
        <HugeiconsIcon
          icon={ArrowUp01Icon}
          data-icon="chevron-up"
          size={iconSize}
        />
      );
    default:
      return key;
  }
}

/**
 * Parse a key string into individual key parts.
 *
 * Accepts any of these chord encodings:
 *   - `+` separated:  `"Ctrl+Shift+Tab"`, `"⌘+⌥+→"`
 *   - Whitespace separated:  `"Ctrl L"`, `"⌘ ⌫"`
 *   - Glyph-packed Mac modifiers:  `"⇧⌘P"`  (each modifier glyph splits)
 *   - A mix of the above:  `"⌘⌥ →"`
 *   - Literal `+` key:  `"⌘++"` / `"Ctrl++"`  (double `+` = sep then literal `+`)
 */
function parseKeys(keyString: string): string[] {
  const trimmed = keyString.trim();
  if (!trimmed) return [];

  // Pass 1: tokenize. A run of `+` of length N contributes (N-1) literal `+`
  // keys plus one trailing separator. Whitespace runs are pure separators.
  // Everything else is part of the current token.
  const coarseParts: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      coarseParts.push(buf);
      buf = "";
    }
  };
  let index = 0;
  while (index < trimmed.length) {
    const char = trimmed[index];
    if (/\s/.test(char)) {
      flush();
      while (index < trimmed.length && /\s/.test(trimmed[index])) index += 1;
      continue;
    }
    if (char === "+") {
      let plusCount = 0;
      while (index < trimmed.length && trimmed[index] === "+") {
        plusCount += 1;
        index += 1;
      }
      // First `+` ends the current token; any extras are literal `+` keys.
      flush();
      for (let extra = 1; extra < plusCount; extra += 1) {
        coarseParts.push("+");
      }
      continue;
    }
    buf += char;
    index += 1;
  }
  flush();

  // Pass 2: within each coarse part, expand packed Mac modifier glyphs
  // (`⇧⌘P` → `⇧`, `⌘`, `P`). Non-modifier text is kept verbatim so we don't
  // shatter labels like `Tab` or `Esc`.
  const result: string[] = [];
  for (const part of coarseParts) {
    let currentKey = "";
    for (const char of part) {
      if (MAC_MODIFIERS.has(char)) {
        if (currentKey) {
          result.push(currentKey);
          currentKey = "";
        }
        result.push(char);
      } else {
        currentKey += char;
      }
    }
    if (currentKey) result.push(currentKey);
  }

  return result;
}

interface KeyBadgeProps {
  keys: string;
  /** Icon size for modifier keys */
  iconSize?: number;
  /** Compact inherited styling vs the settings-table presentation */
  variant?: "compact" | "default";
  /**
   * Render a visible `+` between tokens inside the joined shortcut pill.
   * Set `false` for the compact Codex-style chord presentation.
   */
  showSeparator?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const KeyBadge: React.FC<KeyBadgeProps> = ({
  keys,
  iconSize = DEFAULT_ICON_SIZE,
  variant = "default",
  showSeparator = true,
  className,
  style,
}) => {
  if (keys.includes(" / ")) {
    const alternatives = keys.split(" / ").map((alt) => alt.trim());
    return (
      <div className="inline-flex flex-wrap items-center gap-1">
        {alternatives.map((alt, altIndex) => (
          <React.Fragment key={altIndex}>
            <KeyBadge
              keys={alt}
              iconSize={iconSize}
              variant={variant}
              showSeparator={showSeparator}
              className={className}
              style={style}
            />
            {altIndex < alternatives.length - 1 && (
              <span className="mx-1 text-text-4">/</span>
            )}
          </React.Fragment>
        ))}
      </div>
    );
  }

  const keyParts = parseKeys(keys);
  if (keyParts.length === 0) return null;

  if (variant === "compact") {
    return (
      <kbd className={className} style={style}>
        <span className="inline-flex items-center gap-0.5">
          {keyParts.map((part, index) => (
            <span
              key={index}
              className="inline-flex items-center justify-center"
            >
              {renderKeyContent(part, iconSize)}
            </span>
          ))}
        </span>
      </kbd>
    );
  }

  return (
    <kbd
      className={`inline-flex h-6 shrink-0 items-center justify-center gap-0.5 rounded-full bg-fill-2 px-2 text-xs leading-none font-medium text-text-2 ${className ?? ""}`}
      style={style}
    >
      {keyParts.map((part, index) => (
        <React.Fragment key={index}>
          <span className="inline-flex items-center justify-center">
            {renderKeyContent(part, iconSize)}
          </span>
          {showSeparator &&
            index < keyParts.length - 1 &&
            keyParts[index + 1] !== "+" && (
              <span className="text-xs text-text-4 select-none">+</span>
            )}
        </React.Fragment>
      ))}
    </kbd>
  );
};

export default KeyBadge;
