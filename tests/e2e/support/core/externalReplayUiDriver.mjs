/**
 * Stable facade for rendered bounded-replay E2E actions.
 *
 * Browser bridge calls remain serialized in bridge.mjs; the other modules
 * separate rendered controls, sidebar setup, navigation, and viewport checks.
 */
export * from "./externalReplayUiDriver/bridge.mjs";
export * from "./externalReplayUiDriver/renderedControls.mjs";
export * from "./externalReplayUiDriver/setupAndSidebar.mjs";
export * from "./externalReplayUiDriver/navigation.mjs";
export * from "./externalReplayUiDriver/viewport.mjs";
