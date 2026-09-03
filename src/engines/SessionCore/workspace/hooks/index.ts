/**
 * Workspace Hooks Index
 *
 * Re-exports focused workspace hooks.
 */

export { useRepositoryInfo } from "./useRepositoryInfo";

// Note: Chat/Socket hooks were removed (2026-03-30) as they duplicated
// ChatContext/SocketContext. Use useChatContext() from contexts/workspace/
// for chat UI state instead.
