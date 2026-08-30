/**
 * EventBlocks - Reusable Chat UI Components
 *
 * This module contains all reusable chat block components that can be used
 * in both Chat Panel and Event System contexts.
 *
 * Structure:
 * - primitives/: Base components (EventBlockHeader, useEventBlockHeader, etc.)
 * - Individual folders: Specific block implementations
 *
 * Block categories:
 * 1. **Collapsible blocks** — Use EventBlockHeader + useEventBlockHeader primitives.
 *    These have a consistent header with icon, label, collapse toggle, and optional
 *    eventId replay. Includes: TerminalBlock, ToolCallBlock, CodeBlock, SearchBlock,
 *    ExploreBlock, GlobBlock, ListDirBlock, AgentMessageBlock.
 *
 * 2. **Inline blocks** — Flat badge-style displays without collapse behavior.
 *
 * 3. **Custom blocks** — Use their own layout for specific UX needs.
 *    Includes: TodoBlock (compact card with progress counter).
 */

// Re-export primitives
export * from "./primitives";

// Core blocks
export { default as TerminalBlock } from "./TerminalBlock";
export { default as ToolCallBlock } from "./ToolCallBlock";
export { default as ChatCodeBlock } from "./CodeBlock";
export type { ChatCodeBlockProps } from "./CodeBlock";

// Todo / Planning blocks
export { default as TodoBlock } from "./TodoBlock";
export type { TodoBlockProps, TodoItem } from "./TodoBlock";

// Tool action blocks (transparent)
export { default as ExploreBlock } from "./ExploreBlock";
export type { ExploreBlockProps } from "./ExploreBlock";

export { default as SearchBlock } from "./SearchBlock";
export type { SearchBlockProps } from "./SearchBlock";

export { default as GlobBlock } from "./GlobBlock";
export type { GlobBlockProps } from "./GlobBlock";

export { default as ListDirBlock } from "./ListDirBlock";
export type { ListDirBlockProps } from "./ListDirBlock";

// Agent message block (collapsible wrapper for agent messages — excluded from collapse-all)
export {
  AgentMessageClampProvider,
  default as AgentMessageBlock,
} from "./AgentMessageBlock";
export type { AgentMessageBlockProps } from "./AgentMessageBlock";

// ChatBlock targets (consume UniversalEventProps directly via adapters)
export { default as ReadFileBlock } from "./ReadFileBlock";
export type { ReadFileBlockProps } from "./ReadFileBlock";

export { default as DiffBlock } from "./DiffBlock";
export type { DiffBlockProps } from "./DiffBlock";

export { default as ShellBlock } from "./ShellBlock";
export type { ShellBlockProps } from "./ShellBlock";

export { default as WebSearchBlock } from "./WebSearchBlock";
export type { WebSearchBlockProps } from "./WebSearchBlock";

export { default as WorktreeListBlock } from "./WorktreeListBlock";
export type {
  WorktreeEntryItem,
  WorktreeListBlockProps,
} from "./WorktreeListBlock";
