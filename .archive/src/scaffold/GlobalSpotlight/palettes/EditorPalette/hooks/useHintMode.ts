/**
 * useHintMode Hook
 *
 * Shows VS Code-style mode hints when the spotlight opens with an empty query.
 * Displays available modes with their prefixes and keyboard shortcuts.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";

import type { SpotlightItem } from "../../../shared";
import { EDITOR_PALETTE_CONFIG } from "../../config";

export interface UseHintModeOptions {
  enabled: boolean;
  onSelectHint: (prefix: string) => void;
}

export interface UseHintModeReturn {
  items: SpotlightItem[];
  isLoading: boolean;
}

/** Hint item definition */
interface HintDefinition {
  id: string;
  /** i18n key suffix under `selectors.editorSpotlight.modes.<modeKey>`. */
  labelKey: "label" | "hintLabel";
  prefix: string;
  shortcut: string;
  modeKey: string;
}

/** VS Code-style hint definitions */
const HINT_DEFINITIONS: HintDefinition[] = [
  {
    id: "hint-file",
    labelKey: "label",
    prefix: "",
    shortcut: getShortcutKeys("quick_open"),
    modeKey: "file",
  },
  {
    id: "hint-command",
    labelKey: "hintLabel",
    prefix: ">",
    shortcut: getShortcutKeys("spotlight_open"),
    modeKey: "command",
  },
  {
    id: "hint-symbol",
    labelKey: "label",
    prefix: "@",
    shortcut: getShortcutKeys("go_to_symbol"),
    modeKey: "symbol",
  },
];

/**
 * Hook to generate hint items when spotlight is opened with empty query
 */
export function useHintMode({
  enabled,
  onSelectHint,
}: UseHintModeOptions): UseHintModeReturn {
  const { t } = useTranslation();

  const items: SpotlightItem[] = useMemo(() => {
    if (!enabled) {
      return [];
    }

    const modes = EDITOR_PALETTE_CONFIG.modes;

    return HINT_DEFINITIONS.map((hint) => {
      const modeConfig = modes[hint.modeKey];
      const ModeIcon = modeConfig?.icon;
      const label = t(
        `selectors.editorSpotlight.modes.${hint.modeKey}.${hint.labelKey}`
      );

      return {
        id: hint.id,
        // Include prefix right after label (e.g., "Show and Run Commands  >")
        label: hint.prefix ? `${label}  ${hint.prefix}` : label,
        icon: ModeIcon,
        type: "hint" as const,
        shortcut: hint.shortcut,
        data: {
          prefix: hint.prefix,
        },
        action: () => onSelectHint(hint.prefix),
      };
    });
  }, [enabled, onSelectHint, t]);

  return {
    items,
    isLoading: false,
  };
}

export default useHintMode;
