/**
 * Action Registration Modules (Zod-based)
 *
 * Each module registers actions for a specific category using Zod schemas.
 */

// Terminal
export { terminalZodActions } from "./terminalActions.zod";

// Panel
export { panelZodActions } from "./panelActions.zod";

// View
export { appViewZodActions } from "./appViewActions.zod";
export { workStationViewZodActions } from "./workStationViewActions.zod";

// Navigation
export { navigationZodActions } from "./navigationActions.zod";

// Search
export { createSearchZodActions, searchZodActions } from "./searchActions.zod";

// Editor
export { editorZodActions } from "./editorActions.zod";

// Editor Tab
export { editorTabZodActions } from "./editorTabActions.zod";

// File
export { createFileZodActions, fileTabZodActions } from "./file";

// Git
export { gitZodActions } from "./git";

// URL Preview
export { urlPreviewActions } from "./urlPreviewActions.zod";

// Repo / Workspace
export { repoZodActions } from "./repoActions.zod";

// Session comments
export { sessionCommentZodActions } from "./sessionCommentActions.zod";
