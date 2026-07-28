/**
 * UI Atoms - Barrel Export
 *
 * Pure UI state (theme, modals, navigation, etc.)
 *
 * Note: Session creator atoms live in @src/store/session
 *
 * Logical grouping:
 * - Sidebar: sidebarAtom, hoverSidebarAtom, collapseStateAtom
 * - Editor: editorSettingsAtom, fileTreeSelectionAtom, searchResultSelectionAtom
 * - Settings: settingsPanelAtoms (panel-internal side-channel state),
 *   settingsSyncAtom
 * - Tabs: navigationSidebarTabsAtom, globalSelectorAtom
 */

// Sidebar
export * from "./sidebarAtom";
export * from "./hoverSidebarAtom";
export * from "./collapseStateAtom";

// Editor
export * from "./editorSettingsAtom";
export * from "./fileTreeSelectionAtom";
export * from "./searchResultSelectionAtom";

// Settings
export * from "./settingsPanelAtoms";
export * from "./settingsSyncAtom";
export * from "./languageAtom";

// Tabs
export * from "./navigationSidebarTabsAtom";
export * from "./globalTabsActions";
export * from "./globalSelectorAtom";

// Other UI state
export * from "./uiAtom";
export * from "./backgroundConfigAtom";
export * from "./overlayLayerAtom";
export * from "./timezoneAtom";
export * from "./notificationAtom";
export * from "./inboxAtom";
export * from "./workStationAtom";
export * from "./routeToolbarAtom";
export * from "./dragDropAtom";
export * from "./todoAtom";
export * from "./workflowEditorAtom";
export * from "./addToAgentAtom";
export * from "./integrationsToolbarAtom";
export * from "./kanbanViewStateAtom";
export * from "./kanbanReplayAtom";
export * from "./workManagementCreatorAtom";
export * from "./modelSelectorAtom";
export * from "./settingsToolbarAtom";
export * from "./globalTabsTypes";
export * from "./guideHighlightAtom";

// WorkStation / Chat / Simulator / Workspace Folders (formerly workspaceAtom barrel)
export * from "./simulatorAtom";
export * from "./overlayAtom";
export * from "./chatPanelAtom";
export * from "./chatImageAtom";
export * from "./messageQueueAtom";
export * from "./sessionPaginationAtom";
export * from "./uploadsAtom";
export * from "./draftAtom";
export * from "./workStationLayout";
export * from "./workspace";
