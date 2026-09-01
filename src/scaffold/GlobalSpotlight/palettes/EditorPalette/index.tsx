/**
 * EditorPalette Component
 *
 * VS Code-style command palette for the editor page with prefix-based modes:
 * - (no prefix) - Go to file
 * - > - Commands
 * - : - Go to line
 * - @ - Symbols
 */
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { File01Icon } from "@src/icons";

import { PaletteBody, SpotlightShell } from "../../shell";
import type { PathSegment } from "../../types";
import { EDITOR_PALETTE_CONFIG } from "../config";
import { useSelectorKernel } from "../core";
import { ModeIndicator } from "./components/ModeIndicator";
import useEditorPalette from "./hooks/useEditorPalette";
import type { EditorPaletteMode } from "./types";

const EDITOR_PALETTE_MODES = EDITOR_PALETTE_CONFIG.modes;

// ============ PROPS ============

interface EditorPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  /** Repository path (for file operations) */
  repoPath: string;
  /** Initial mode (optional) */
  initialMode?: EditorPaletteMode;
  /** Initial query (optional) */
  initialQuery?: string;
  topSlot?: React.ReactNode;
  /** When true, render only the palette body without an enclosing
   *  SpotlightShell. The caller provides one stable shell around all
   *  palettes to avoid tab-switch flashing. Default false. */
  asBody?: boolean;
  /** Optional parent-return callback used when embedded in the main Spotlight. */
  onGoBackToParent?: () => void;
  hideFileModeHints?: boolean;
}

// ============ COMPONENT ============

export const EditorPalette: React.FC<EditorPaletteProps> = ({
  isOpen,
  onClose,
  repoPath,
  initialMode = "file",
  initialQuery = "",
  topSlot,
  asBody = false,
  onGoBackToParent,
  hideFileModeHints = false,
}) => {
  const { t } = useTranslation();
  const { state, handleQueryChange, handleItemSelect } = useEditorPalette({
    repoPath,
    initialMode,
    initialQuery,
    isOpen,
    onClose,
  });

  const prefixByMode: Partial<Record<EditorPaletteMode, string>> = {
    command: ">",
    symbol: "@",
  };
  const activePrefix = prefixByMode[state.mode];
  const isPrefixQuery = !!activePrefix && state.query.startsWith(activePrefix);

  const handleGoBack = useCallback(() => {
    if (state.mode !== "file" && state.searchTerm.trim() !== "") {
      handleQueryChange(isPrefixQuery && activePrefix ? activePrefix : "");
      return;
    }

    if (onGoBackToParent) {
      onGoBackToParent();
      return;
    }

    onClose();
  }, [
    activePrefix,
    isPrefixQuery,
    state.mode,
    state.searchTerm,
    handleQueryChange,
    onClose,
    onGoBackToParent,
  ]);
  const showModePill =
    state.mode !== "file" || (state.mode === "file" && hideFileModeHints);
  const displayedQuery = isPrefixQuery ? state.searchTerm : state.query;

  const handleDisplayedQueryChange = useCallback(
    (value: string) => {
      if (isPrefixQuery && activePrefix) {
        handleQueryChange(`${activePrefix}${value}`);
        return;
      }
      handleQueryChange(value);
    },
    [activePrefix, handleQueryChange, isPrefixQuery]
  );

  const handleModePillKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLInputElement>,
      internal: (e: React.KeyboardEvent<HTMLInputElement>) => void
    ) => {
      const removesPill = event.key === "Backspace" || event.key === "Delete";
      if (showModePill && removesPill && displayedQuery === "") {
        event.preventDefault();
        event.stopPropagation();
        handleGoBack();
        return;
      }
      internal(event);
    },
    [displayedQuery, handleGoBack, showModePill]
  );

  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items: state.items,
    hasModalState: showModePill,
    onGoBack: handleGoBack,
    externalSearchQuery: displayedQuery,
    externalSetSearchQuery: handleDisplayedQueryChange,
    externalHandleKeyDown: handleModePillKeyDown,
    externalHandleItemClick: handleItemSelect,
    isItemSelectable: (item) => !item.data?.isHeader && !item.data?.disabled,
    onReset: () => handleQueryChange(""),
  });

  const modeConfig = EDITOR_PALETTE_MODES[state.mode];
  const isHintMode =
    state.query === "" && state.mode === "file" && !hideFileModeHints;
  const placeholder = isHintMode
    ? t("selectors.editorSpotlight.searchPlaceholder")
    : t(`selectors.editorSpotlight.modes.${state.mode}.placeholder`, {
        defaultValue: t("selectors.editorSpotlight.fallbackPlaceholder"),
      });

  const modeIndicator =
    state.mode !== "file" && !showModePill ? (
      <ModeIndicator mode={state.mode} />
    ) : undefined;
  const modePathSegment: PathSegment = {
    type: "action",
    id: state.mode,
    label: t(`selectors.editorSpotlight.modes.${state.mode}.pillLabel`, {
      defaultValue: t(`selectors.editorSpotlight.modes.${state.mode}.label`),
    }),
    // SpotlightModeConfig.icon is optional, so fall through to the File
    // glyph the `file` mode itself uses rather than widening PathSegment.
    icon: modeConfig?.icon ?? EDITOR_PALETTE_MODES.file.icon ?? File01Icon,
    color: modeConfig?.color ?? "primary",
    data: {
      pillLabelKey: `selectors.editorSpotlight.modes.${state.mode}.pillLabel`,
      labelKey: `selectors.editorSpotlight.modes.${state.mode}.label`,
    },
  };

  const hideListUntilSearch =
    state.mode === "file" && state.query.trim() === "";

  const inputIconElement = modeConfig?.icon && (
    <AnyIcon icon={modeConfig.icon} size={14} className="text-text-2" />
  );

  const body = (
    <PaletteBody
      kernel={kernel}
      items={state.items}
      searchQuery={displayedQuery}
      placeholder={placeholder}
      inputVariant={showModePill ? "searchBar" : "simple"}
      path={showModePill ? [modePathSegment] : []}
      onRemoveSegment={showModePill ? handleGoBack : undefined}
      inputIconElement={!showModePill ? inputIconElement : undefined}
      isLoading={state.isLoading}
      containerHeight={400}
      inputTrailingSlot={showModePill ? undefined : modeIndicator}
      topSlot={state.mode === "file" ? topSlot : undefined}
      contentOverride={hideListUntilSearch ? false : undefined}
    />
  );

  if (asBody) return body;

  return (
    <SpotlightShell
      isOpen={isOpen}
      onClose={onClose}
      hasActiveAction={state.mode !== "file"}
    >
      {body}
    </SpotlightShell>
  );
};

export default EditorPalette;
