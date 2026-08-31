import type React from "react";

import type { ComposerModeEntry } from "@src/config/sessionCreatorConfig";
import type { SlashItem, SlashItemCategory } from "@src/types/extensions";

import type { FloatingPlacementStrategy } from "../floatingPlacement";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Input source for filtering the / menu.
 * - "inline": filter text comes from the editor (user typed `/` then a query).
 * - "header": dropdown owns a search input; used when opened via button click.
 */
export type SlashCommandSearchMode = "inline" | "header";

export interface SlashCommandPortalProps {
  visible: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  /** Optional descendant of containerRef to anchor the menu against. */
  anchorSelector?: string;
  placement?: FloatingPlacementStrategy;
  items: SlashItem[];
  loading: boolean;
  currentMode: ComposerModeEntry["id"];
  /** Pre-filtered query (slash items already filtered upstream). */
  searchQuery?: string;
  onClose: () => void;
  onSelect: (item: SlashItem) => void;
  onModeSelect: (mode: ComposerModeEntry["id"]) => void;
  keyboardHandlerRef: React.MutableRefObject<
    ((e: KeyboardEvent) => boolean) | null
  >;
  /** Defaults to "inline". */
  searchMode?: SlashCommandSearchMode;
  /** Header-mode only: called when the in-dropdown input changes. */
  onSearchQueryChange?: (query: string) => void;
  /**
   * When true (default for the + button menu), shows Mode flyout trigger
   * and Models flyout trigger. When false (inline / search mode), these are
   * hidden because they are already accessible via the toolbar pills.
   */
  showActionFlyouts?: boolean;
  /** When provided, renders an Image upload row. */
  onImageUpload?: () => void;
  /** When false, hides mode rows in inline search results for non-session editors. */
  showModeRows?: boolean;
  /** Offer the Project product mode alongside the exec modes (§5.2). */
  includeProjectMode?: boolean;
}

// ── Internal list-entry union ─────────────────────────────────────────────────

export interface ModeEntry {
  kind: "mode";
  mode: ComposerModeEntry;
  flatIndex: number;
}

export interface SlashEntry {
  kind: "item";
  item: SlashItem;
  flatIndex: number;
}

export interface SectionHeader {
  kind: "header";
  label: string;
  translationKey?: string;
}

/** Trigger row that opens a flyout submenu (for SlashItem categories). */
export interface FlyoutEntry {
  kind: "flyout";
  category: SlashItemCategory;
  label: string;
  items: SlashItem[];
  flatIndex: number;
}

/** Image upload shortcut row. */
export interface ImageEntry {
  kind: "image";
  flatIndex: number;
}

/** Logical break between sections, rendered as a compact inset rule. */
export interface DividerEntry {
  kind: "divider";
}

export type ListEntry =
  | ModeEntry
  | SlashEntry
  | SectionHeader
  | FlyoutEntry
  | ImageEntry
  | DividerEntry;

// ── Open-flyout state ─────────────────────────────────────────────────────────

export type FlyoutKind = "category";

export interface OpenFlyoutState {
  kind: FlyoutKind;
  anchorTop: number;
  /** Only set when kind === "category" */
  category?: SlashItemCategory;
  /** Only set when kind === "category" */
  items?: SlashItem[];
}
