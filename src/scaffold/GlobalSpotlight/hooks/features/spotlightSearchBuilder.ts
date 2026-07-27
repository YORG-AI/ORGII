/**
 * Spotlight Search Builder
 *
 * Pure function that builds the flat list of `SpotlightItem`s shown when the
 * user types a query into the global palette. Handles three cases:
 *
 *  1. `>` prefix     — editor-command filter (only on editor routes).
 *  2. plain query    — fuzzy match across static actions, dynamic ACTIONS,
 *                      editor modes (if applicable), and nav destinations.
 *  3. empty effective query — same as plain query with no filter; lets the
 *     caller still surface every match path.
 */
import {
  ACTIONS,
  type NavDestination,
  searchNavDestinations,
} from "../../config";
import { EDITOR_PALETTE_CONFIG } from "../../palettes/config";
import type { ActionDefinition, SpotlightItem } from "../../types";
import type {
  SpotlightEditorActionId,
  SpotlightStaticActionDefinition,
} from "./spotlightActionDefinitions";
import { EDITOR_ACTIONS } from "./spotlightActionDefinitions";
import {
  type Translator,
  buildGroupedNavItems,
  resolveActionLabel,
} from "./spotlightItemBuilders";

interface BuildSearchModeItemsArgs {
  searchQuery: string;
  isEditorRoute: boolean;
  staticCommandActions: SpotlightStaticActionDefinition[];
  onSelectAction: (action: ActionDefinition) => void;
  onSelectStaticAction: (action: SpotlightStaticActionDefinition) => void;
  onSelectEditorAction: (actionId: SpotlightEditorActionId) => void;
  onSelectPath: (
    path: string,
    label: string,
    icon: SpotlightItem["icon"]
  ) => void;
  translate: Translator;
  devModeEnabled?: boolean;
}

export function buildSearchModeItems({
  searchQuery,
  isEditorRoute,
  staticCommandActions,
  onSelectAction,
  onSelectStaticAction,
  onSelectEditorAction,
  onSelectPath,
  translate,
  devModeEnabled = false,
}: BuildSearchModeItemsArgs): SpotlightItem[] {
  const commandFilterActive = searchQuery.startsWith(">");
  const effectiveSearchQuery = commandFilterActive
    ? searchQuery.slice(1).trimStart()
    : searchQuery;
  const queryLower = effectiveSearchQuery.toLowerCase();

  if (commandFilterActive) {
    if (!isEditorRoute) {
      return [];
    }
    return buildEditorMatches(queryLower, onSelectEditorAction, translate);
  }

  const results: SpotlightItem[] = [];
  results.push(
    ...buildStaticMatches(
      staticCommandActions,
      queryLower,
      onSelectStaticAction,
      translate
    )
  );
  results.push(
    ...buildDynamicActionMatches(queryLower, onSelectAction, translate)
  );

  if (isEditorRoute) {
    results.push(
      ...buildEditorMatches(queryLower, onSelectEditorAction, translate)
    );
  }

  // Surface navigation destinations directly in global search so users can
  // type e.g. "mcp" and jump straight to "Manage MCP" without having to pick
  // the "Navigate to a page" action first. `t` is passed so the search also
  // matches on the user-visible (translated) label.
  const matchedDestinations: NavDestination[] = searchNavDestinations(
    searchQuery,
    translate
  ).filter((destination) => devModeEnabled || !destination.devOnly);
  results.push(
    ...buildGroupedNavItems(matchedDestinations, onSelectPath, translate)
  );

  return results;
}

// ============================================
// Internal matchers (each is a pure function)
// ============================================

function buildEditorMatches(
  queryLower: string,
  onSelectEditorAction: (actionId: SpotlightEditorActionId) => void,
  translate: Translator
): SpotlightItem[] {
  const results: SpotlightItem[] = [];
  EDITOR_ACTIONS.forEach((action) => {
    const label = translate(
      `selectors.editorSpotlight.modes.${action.modeKey}.${action.labelKey}`
    );
    const modeLabel = translate(
      `selectors.editorSpotlight.modes.${action.modeKey}.label`
    );
    const labelMatch =
      !queryLower ||
      label.toLowerCase().includes(queryLower) ||
      modeLabel.toLowerCase().includes(queryLower);

    if (labelMatch) {
      const modeConfig = EDITOR_PALETTE_CONFIG.modes[action.modeKey];
      results.push({
        id: action.id,
        label,
        icon: modeConfig.icon,
        type: "action" as const,
        shortcut: action.shortcut,
        action: () => onSelectEditorAction(action.id),
      });
    }
  });
  return results;
}

function buildStaticMatches(
  staticCommandActions: SpotlightStaticActionDefinition[],
  queryLower: string,
  onSelectStaticAction: (action: SpotlightStaticActionDefinition) => void,
  translate: Translator
): SpotlightItem[] {
  const results: SpotlightItem[] = [];
  staticCommandActions.forEach((action) => {
    const label = translate(action.labelKey);
    const labelMatch = !queryLower || label.toLowerCase().includes(queryLower);
    const keywordMatch = action.keywords.some((keyword) =>
      keyword.toLowerCase().includes(queryLower)
    );

    if (labelMatch || keywordMatch) {
      results.push({
        id: action.id,
        label,
        icon: action.icon,
        type: "action" as const,
        shortcut: "shortcut" in action ? action.shortcut : undefined,
        data: {
          showDisclosureChevron: action.opensSecondLevel === true,
        },
        action: () => onSelectStaticAction(action),
      });
    }
  });
  return results;
}

function buildDynamicActionMatches(
  queryLower: string,
  onSelectAction: (action: ActionDefinition) => void,
  translate: Translator
): SpotlightItem[] {
  const results: SpotlightItem[] = [];
  ACTIONS.forEach((action) => {
    const label = resolveActionLabel(action, translate);
    const labelMatch =
      !queryLower ||
      action.label.toLowerCase().includes(queryLower) ||
      label.toLowerCase().includes(queryLower);
    const keywordMatch = action.keywords?.some((keyword) =>
      keyword.toLowerCase().includes(queryLower)
    );
    const aliasMatch = action.aliases?.some((alias) =>
      alias.toLowerCase().includes(queryLower)
    );

    if (labelMatch || keywordMatch || aliasMatch) {
      results.push({
        id: action.id,
        label,
        icon: action.icon,
        type: "action" as const,
        data: {
          showDisclosureChevron: action.requiredParams.length > 0,
        },
        action: () => onSelectAction(action),
      });
    }
  });
  return results;
}
