/**
 * Session Module
 *
 * Session-related UI components (formerly in src/features/).
 * Physical implementation still in src/features/ — this barrel provides
 * the canonical module path for new imports.
 */
export { default as ChatPanel } from "@src/engines/ChatPanel";
export * from "@src/features/SessionCreator/exports";
