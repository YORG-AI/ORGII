/**
 * Services Layer - Singleton APIs
 *
 * These services provide capabilities shared by both AI and UI.
 * They are the single source of truth for operations.
 *
 * Architecture:
 *   Services → Tauri/Backend APIs + Jotai Atoms
 *   Actions → Services (registered at app init)
 *   UI → dispatch(action) or Service.method()
 */

export { AppViewService } from "./app";
export { EditorService } from "./workStation";
export { FileService } from "./file";
export { GitService } from "./git";
export { NavigationService } from "./navigation";
export { PanelService } from "./panel";
export { SessionService } from "@src/engines/SessionCore/services/SessionService";
export { SearchService } from "./search";
export { TerminalService } from "./terminal";
