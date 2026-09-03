/**
 * Spotlight Action Definitions
 *
 * Static action constants and their typed definitions for the spotlight
 * palette. Each constant is a pure data table — no React, no hooks. This
 * file is a thin barrel: the tables/types/builders live in sibling
 * `spotlightActionDefinitions.*.ts` modules and are re-exported here so the
 * public import path stays stable.
 *
 * - `spotlightActionDefinitions.types.ts`      — `SpotlightStaticActionId`,
 *   `SpotlightStaticActionFallback`, `SpotlightEditorActionId`,
 *   `SpotlightStaticActionDefinition`, `SpotlightEditorActionDefinition`.
 * - `spotlightActionDefinitions.navigation.ts` — `AGENT_SESSION_ACTIONS`,
 *   `WORKSPACE_ACTIONS`, `ORGANIZATION_ACTIONS`, `STATION_MODE_ACTIONS`, `APP_ACTIONS`,
 *   `EDITOR_ACTIONS`, `QUICK_NAVIGATION_ACTIONS`.
 * - `spotlightActionDefinitions.settings.ts`   — `buildChatPanelSettingsActions`.
 * - `spotlightActionDefinitions.view.ts`       — `buildViewActions`, the
 *   view-toggle actions whose label flips based on the current collapsed
 *   state of each sidebar/panel.
 */

export * from "./spotlightActionDefinitions.types";
export * from "./spotlightActionDefinitions.navigation";
export * from "./spotlightActionDefinitions.settings";
export * from "./spotlightActionDefinitions.view";
